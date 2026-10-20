"""The agents as a service: plans A and B, and their what-if runs, for every baseline simulation, with no terminal involved.

    python -m firetrace_agents.watcher            # forever (what the docker compose ``agents`` service runs)
    python -m firetrace_agents.watcher --once     # one poll, then exit

Every ``AGENTS_POLL_SECONDS`` it asks ``GET /simulations?kind=baseline&status=succeeded&updatedAfter=…`` for baselines that finished
since the last look. For each one that has no plans yet (``GET /plans?simulationId=``) it runs the orchestrator, publishes plan A and
plan B (``POST /plans``, after ``/plans/validate``) and asks for the what-if of both (``POST /plans/{id}/simulate``). The operator then
finds the plans in the UI (tab Planos).

The API has no event channel (see the contract's description), so this is a poll on ``updatedAfter``. Settings come from the environment:

    FIRETRACE_BASE_URL          API root including /api/v1             (default http://localhost:8080/api/v1)
    AGENTS_POLL_SECONDS         seconds between polls                  (10)
    AGENTS_LOOKBACK_MINUTES     on start, also look this far back      (30; baselines that already have plans are skipped)
    AGENTS_AT_MINUTE            minute of the fire the plans decide on (60; kept 30 min before the end of a shorter run)
    AGENTS_HORIZON_MINUTES      how far ahead the agents look          (60)
    AGENTS_STAGE_MINUTES        window the line budgets are sized for  (30)
    AGENTS_CONCENTRATION        sectors the barrier metres go to       (6)
    AGENTS_BUILDING_ZONES       patches of houses the engines defend   (0 = off)
    AGENTS_SKIP_LABEL_PREFIX    baselines whose label starts with this are left alone ([lab]: the experiments of the scripts)
    AGENTS_MAX_ATTEMPTS         tries per baseline before giving up    (3)
    AGENTS_SIMULATE_TIMEOUT     seconds to follow a what-if run        (900)
"""
from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Callable

from .client import ApiProblem, FiretraceClient, NotReady
from .orchestrator import OrchestratorAgent

log = logging.getLogger("firetrace.watcher")

DEFAULT_LOCATION = "guimaraes-concelho"
MIN_MINUTES_BEFORE_END = 30  # a plan decided at the very end of the run would have nothing left to change


@dataclass(frozen=True)
class WatcherSettings:
    poll_seconds: float = 10.0
    lookback_minutes: int = 30
    at_minute: int = 60
    horizon_minutes: int = 60
    stage_minutes: int = 30
    concentration: int = 6
    building_zones: int = 0
    skip_label_prefix: str = "[lab]"
    max_attempts: int = 3
    simulate_timeout_seconds: float = 900.0

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "WatcherSettings":
        e = os.environ if env is None else env
        d = cls()
        return cls(
            poll_seconds=float(e.get("AGENTS_POLL_SECONDS", d.poll_seconds)),
            lookback_minutes=int(e.get("AGENTS_LOOKBACK_MINUTES", d.lookback_minutes)),
            at_minute=int(e.get("AGENTS_AT_MINUTE", d.at_minute)),
            horizon_minutes=int(e.get("AGENTS_HORIZON_MINUTES", d.horizon_minutes)),
            stage_minutes=int(e.get("AGENTS_STAGE_MINUTES", d.stage_minutes)),
            concentration=int(e.get("AGENTS_CONCENTRATION", d.concentration)),
            building_zones=int(e.get("AGENTS_BUILDING_ZONES", d.building_zones)),
            skip_label_prefix=e.get("AGENTS_SKIP_LABEL_PREFIX", d.skip_label_prefix),
            max_attempts=int(e.get("AGENTS_MAX_ATTEMPTS", d.max_attempts)),
            simulate_timeout_seconds=float(e.get("AGENTS_SIMULATE_TIMEOUT", d.simulate_timeout_seconds)),
        )


def _instant(value: str) -> datetime:
    return datetime.fromisoformat(value)


class Watcher:
    def __init__(
        self,
        client: FiretraceClient,
        orchestrator: OrchestratorAgent,
        settings: WatcherSettings | None = None,
        *,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.client, self.orchestrator = client, orchestrator
        self.settings = settings or WatcherSettings()
        self._now = now
        self.since: datetime = now() - timedelta(minutes=self.settings.lookback_minutes)
        self.handled: set[str] = set()  # baselines done, skipped for good, or given up on
        self.attempts: dict[str, int] = {}

    # -- one look ----------------------------------------------------------------
    def poll_once(self) -> list[str]:
        """Plan every new finished baseline; returns the ids it published plans for."""
        found = self.client.list_simulations(kind="baseline", status="succeeded", updated_after=self.since.isoformat())
        planned: list[str] = []
        newest = self.since
        for simulation in sorted(found, key=lambda s: s.get("updatedAt") or ""):
            sim_id = str(simulation["id"])
            if simulation.get("updatedAt"):
                newest = max(newest, _instant(simulation["updatedAt"]))
            if sim_id in self.handled:
                continue
            if self.settings.skip_label_prefix and str(simulation.get("label") or "").startswith(self.settings.skip_label_prefix):
                self.handled.add(sim_id)
                continue
            try:
                if self.plan_for(simulation):
                    planned.append(sim_id)
                self.handled.add(sim_id)
            except Exception as error:  # noqa: BLE001 — one bad baseline must not stop the service
                tries = self.attempts[sim_id] = self.attempts.get(sim_id, 0) + 1
                log.error("baseline %s: attempt %d/%d failed: %s: %s", sim_id, tries, self.settings.max_attempts, type(error).__name__, error)
                if tries >= self.settings.max_attempts:
                    log.error("baseline %s: giving up", sim_id)
                    self.handled.add(sim_id)
        self.since = newest - timedelta(seconds=1)  # a second of overlap; `handled` keeps it from planning twice
        return planned

    # -- one baseline ------------------------------------------------------------
    def plan_for(self, simulation: dict[str, Any]) -> bool:
        """Publish plans A and B for a baseline and trigger both what-if runs. ``False`` if it already had plans."""
        sim_id = str(simulation["id"])
        if self.client.list_plans(sim_id):
            log.info("baseline %s: already has plans, skipped", sim_id)
            return False
        snapshot = simulation.get("scenarioSnapshot") or {}
        location_id = snapshot.get("locationId") or simulation.get("locationId") or DEFAULT_LOCATION
        duration = int(snapshot.get("durationMinutes") or 0)
        at_minute = max(0, min(self.settings.at_minute, duration - MIN_MINUTES_BEFORE_END)) if duration else self.settings.at_minute
        team = self.orchestrator.pull_fleet()  # the fleet changes between baselines
        log.info("baseline %s (%s): planning at T+%d with %d units", sim_id, simulation.get("label"), at_minute, team)
        result = self.orchestrator.run_cycle(
            sim_id, horizon_minutes=self.settings.horizon_minutes, location_id=location_id, title_prefix="Plano", publish=True, at_minute=at_minute,
            stage_minutes=self.settings.stage_minutes, concentration=self.settings.concentration or None, building_zones=self.settings.building_zones,
        )
        for issue in result.issues:
            log.warning("baseline %s: %s: %s", sim_id, issue.proposal_title, issue.problem)
        if not result.published:
            raise RuntimeError("neither plan was published (the backend validation rejected both)")
        log.info("baseline %s: published %s", sim_id, ", ".join(f"{v}={i}" for v, i in sorted(result.published.items())))
        self._simulate(sim_id, result.published)
        return True

    def _simulate(self, baseline_id: str, published: dict[str, str]) -> None:
        """What-if of every published plan; both are asked for first so the backend runs them side by side."""
        runs: dict[str, str] = {}
        for variant, plan_id in sorted(published.items()):
            try:
                runs[variant] = str(self.client.simulate_plan(plan_id, baseline_simulation_id=baseline_id, wait_seconds=None)["id"])
            except ApiProblem as error:
                log.error("baseline %s plan %s: what-if refused [%s]: %s", baseline_id, variant, error.code, error)
        for variant, run_id in runs.items():
            try:
                done = self.client.wait_for_simulation(run_id, timeout_seconds=self.settings.simulate_timeout_seconds)
                stats = done.get("stats") or {}
                log.info("baseline %s plan %s: what-if %s %s burnedHa=%s buildings=%s", baseline_id, variant, run_id, done.get("status"), stats.get("burnedHa"), stats.get("buildingsAffected"))
            except NotReady as error:
                log.warning("baseline %s plan %s: %s", baseline_id, variant, error)

    # -- the service -------------------------------------------------------------
    def wait_for_backend(self, stop: Callable[[], bool], timeout_seconds: float = 180.0) -> bool:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline and not stop():
            try:
                self.client.get_capabilities()
                return True
            except Exception as error:  # noqa: BLE001 — connection refused while the backend starts
                log.info("waiting for the backend (%s)", type(error).__name__)
                time.sleep(3)
        return False

    def run_forever(self, stop: Callable[[], bool] = lambda: False) -> None:
        if not self.wait_for_backend(stop):
            log.error("the backend never answered; polling anyway")
        log.info("watching for baselines updated since %s (every %.0f s)", self.since.isoformat(timespec="seconds"), self.settings.poll_seconds)
        while not stop():
            try:
                self.poll_once()
            except Exception as error:  # noqa: BLE001 — a backend restart or a bad page: look again next time
                log.error("poll failed: %s: %s", type(error).__name__, error)
            slept = 0.0
            while slept < self.settings.poll_seconds and not stop():
                time.sleep(0.5)
                slept += 0.5


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="firetrace_agents.watcher", description="Publish plans A and B (and their what-if runs) for every finished baseline simulation.")
    parser.add_argument("--base-url", default=None, help="API root including /api/v1 (default: $FIRETRACE_BASE_URL or http://localhost:8080/api/v1)")
    parser.add_argument("--once", action="store_true", help="poll once and exit")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per request would bury the watcher's own

    client = FiretraceClient(base_url=args.base_url)
    watcher = Watcher(client, OrchestratorAgent(client), WatcherSettings.from_env())
    stopping = False

    def _stop(*_: Any) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    if args.once:
        planned = watcher.poll_once()
        log.info("planned %d baseline(s): %s", len(planned), ", ".join(planned) or "-")
        return 0
    watcher.run_forever(lambda: stopping)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
