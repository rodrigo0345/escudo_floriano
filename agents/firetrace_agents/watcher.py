"""The agents as a service: plans A and B, and their what-if runs, for every baseline simulation, with no terminal involved.

    python -m firetrace_agents.watcher            # forever (what the docker compose ``agents`` service runs)
    python -m firetrace_agents.watcher --once     # one poll, then exit

Every ``AGENTS_POLL_SECONDS`` it asks ``GET /simulations?kind=baseline&status=succeeded&updatedAfter=…`` for baselines that finished
since the last look. For each one that has no plans yet (``GET /plans?simulationId=``) it runs the orchestrator, publishes plan A and
plan B (``POST /plans``, after ``/plans/validate``) and asks for the what-if of both (``POST /plans/{id}/simulate``). The operator then
finds the plans in the UI (tab Planos).

The operator can also ask for a new pair at any time (button in the Planos tab -> ``POST /simulations/{id}/plan-requests``), even for a baseline that already
has plans: each poll looks for ``queued`` requests first (``GET /plan-requests?status=queued``), claims the oldest (``POST /plan-requests/{id}/claim``),
reports every step (``PATCH /plan-requests/{id}``: composing -> judging -> publishing -> simulating) and closes it ``done`` with the plan ids, or ``failed``
with the reason. The UI follows the request, so the agents never need to be told a simulation id.

The API has no event channel (see the contract's description), so this is a poll on ``updatedAfter``. Settings come from the environment:

    FIRETRACE_BASE_URL          API root including /api/v1             (default http://localhost:8080/api/v1)
    AGENTS_POLL_SECONDS         seconds between polls                  (10)
    AGENTS_LOOKBACK_MINUTES     on start, also look this far back      (30; baselines that already have plans are skipped)
    AGENTS_AT_MINUTE            minute of the fire the plans decide on (0: as soon as it exists; direct attack only works while the fire is weak,
                                and 60 min in, in Penha, a plan gains about 1%; kept 30 min before the end of a shorter run)
    AGENTS_HORIZON_MINUTES      how far ahead the agents look          (60)
    AGENTS_STAGE_MINUTES        window the line budgets are sized for  (30)
    AGENTS_CONCENTRATION        sectors the barrier metres go to       (6)
    AGENTS_BUILDING_ZONES       patches of houses plan B's engines defend (0 = the default of 10)
    AGENTS_REPLAN_MINUTES       the agents look at the fire again this often and send free units where it is not under control (45; 0 = never)
    AGENTS_MAX_WAVES            most re-plans per plan                 (3)
    AGENTS_CANDIDATES           candidates judged per plan, the best kept (1 = no comparison; 2 = better plans, several minutes more)
    AGENTS_REVISE_SELECTED      when the operator selects or edits a plan, the agents check it again and send a revision (1; 0 = off)
    AGENTS_SKIP_LABEL_PREFIX   baselines whose label starts with this are left alone ([lab]: the experiments of the scripts)
    AGENTS_MAX_ATTEMPTS         tries per baseline before giving up    (3)
    AGENTS_SIMULATE_TIMEOUT     seconds to follow a what-if run        (900)
    AGENTS_NAME                 who claims the operator's requests     (firetrace-agents; shown in the UI)
    AGENTS_TERRAIN              scale each crew's effect by its ground: slope, fuel, the fire running uphill (1; 0 = off; see terrain.py)
    AGENTS_REAL_REFILL          an engine's refill trip is the real drive to water, not the backend's generic shuttle (1; 0 = off)
    AGENTS_JUDGE_CENTRAL_ONLY   the wrong-wind what-ifs run the central member only: same casualties and area, far less engine time (1; 0 = off)
    AGENTS_COMMANDER            rules (default) or llm: an LLM commander (Bombeiros, Proteção Civil, GNR, INEM) makes one more candidate plan that the
                                engine judges against the rules'; needs OPENAI_API_KEY and AGENTS_LLM_MODEL (see llm/config.py for the rest)
    AGENTS_SEED_DEMO            on start, register the demo resources of a maximum-alert day: aircraft, crews pre-positioned in the forest and
                                reinforcement groups (1; 0 = off). Runs ``scripts/seed_reinforcements.py`` and ``scripts/seed_air_and_prepositioning.py``,
                                which skip what is already there, so a ``docker compose up`` from scratch gets the same fleet the plans were tuned on.
"""
from __future__ import annotations

import argparse
import importlib.util
import logging
import os
import signal
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

from .alternatives import HOUSE_ZONES_FOR_B, build_alternatives
from .client import ApiProblem, FiretraceClient, NotReady
from .commander import commander_from_env
from .llm import build_advisor
from .orchestrator import OrchestratorAgent
from .revision import Reviser

log = logging.getLogger("firetrace.watcher")

DEFAULT_LOCATION = "guimaraes-concelho"
MIN_MINUTES_BEFORE_END = 30  # a plan decided at the very end of the run would have nothing left to change
SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
DEMO_SEEDS = ("seed_reinforcements", "seed_air_and_prepositioning")  # each skips what is already there


@dataclass(frozen=True)
class WatcherSettings:
    poll_seconds: float = 10.0
    lookback_minutes: int = 30
    at_minute: int = 0
    horizon_minutes: int = 60
    stage_minutes: int = 30
    concentration: int = 6
    building_zones: int = 0
    replan_minutes: int = 30  # re-plan along the fire every half hour, moving the crews to where it burns now (see adaptation.py)
    max_waves: int = 6
    candidates: int = 1  # 2 judges a second candidate per plan: better plans, but each costs a few backend validations (~75 s each, measured)
    revise_selected: bool = True
    skip_label_prefix: str = "[lab]"
    max_attempts: int = 3
    simulate_timeout_seconds: float = 900.0
    agent_name: str = "firetrace-agents"
    seed_demo: bool = True
    auto_plan: bool = False  # plans are made when the operator asks: planning every new baseline on its own spent the OpenAI tokens on plans nobody looked at
    keep_only_latest: bool = True  # once a request is done, every older plan and what-if run is deleted: one pair is stored

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
            replan_minutes=int(e.get("AGENTS_REPLAN_MINUTES", d.replan_minutes)),
            max_waves=int(e.get("AGENTS_MAX_WAVES", d.max_waves)),
            candidates=int(e.get("AGENTS_CANDIDATES", d.candidates)),
            revise_selected=str(e.get("AGENTS_REVISE_SELECTED", "1" if d.revise_selected else "0")).strip().lower() not in ("0", "false", "no"),
            skip_label_prefix=e.get("AGENTS_SKIP_LABEL_PREFIX", d.skip_label_prefix),
            max_attempts=int(e.get("AGENTS_MAX_ATTEMPTS", d.max_attempts)),
            simulate_timeout_seconds=float(e.get("AGENTS_SIMULATE_TIMEOUT", d.simulate_timeout_seconds)),
            agent_name=e.get("AGENTS_NAME", d.agent_name) or d.agent_name,
            seed_demo=str(e.get("AGENTS_SEED_DEMO", "1" if d.seed_demo else "0")).strip().lower() not in ("0", "false", "no"),
            auto_plan=str(e.get("AGENTS_AUTO_PLAN", "1" if d.auto_plan else "0")).strip().lower() in ("1", "true", "yes"),
            keep_only_latest=str(e.get("AGENTS_KEEP_ONLY_LATEST", "1" if d.keep_only_latest else "0")).strip().lower() not in ("0", "false", "no"),
        )


def _instant(value: str) -> datetime:
    return datetime.fromisoformat(value)


Progress = Callable[[str, float, str], None]


def _quiet(_phase: str, _percent: float, _message: str) -> None:
    return None


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
        self.retry: dict[str, dict[str, Any]] = {}  # baselines that failed and will be tried again (the `updatedAfter` window has moved past them)
        self.orphans_checked = False  # requests this agent had claimed before a restart are closed once, on the first poll
        s = self.settings
        self.reviser = Reviser(client, orchestrator, replan_minutes=s.replan_minutes, max_waves=s.max_waves, horizon_minutes=s.horizon_minutes,
                               stage_minutes=s.stage_minutes, concentration=s.concentration or None) if s.revise_selected else None
        self.commander = commander_from_env()  # None = the rules choose the strategy (AGENTS_COMMANDER=llm turns the LLM commander on)
        if self.commander is not None:
            log.info("LLM commander on: %s", self.commander.llm.model if self.commander.llm else "no model/key, the rules decide")

    # -- one look ----------------------------------------------------------------
    def poll_once(self) -> list[str]:
        """Serve the operator's oldest queued request, then plan every new finished baseline; returns the baseline ids it published plans for."""
        planned: list[str] = []
        try:
            served = self.serve_requests()
            if served:
                planned.append(served)
        except ApiProblem as error:  # an older backend without /plan-requests must not stop the automatic plans
            log.error("plan requests: %s", error)
        if not self.settings.auto_plan:
            if self.reviser is not None:
                self.reviser.poll()
            return planned
        found = self.client.list_simulations(kind="baseline", status="succeeded", updated_after=self.since.isoformat())
        found_ids = {str(s["id"]) for s in found}
        found = [*found, *(s for sim_id, s in self.retry.items() if sim_id not in found_ids)]
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
                self.retry.pop(sim_id, None)
            except Exception as error:  # noqa: BLE001 — one bad baseline must not stop the service
                tries = self.attempts[sim_id] = self.attempts.get(sim_id, 0) + 1
                log.error("baseline %s: attempt %d/%d failed: %s: %s", sim_id, tries, self.settings.max_attempts, type(error).__name__, error)
                if tries >= self.settings.max_attempts:
                    log.error("baseline %s: giving up", sim_id)
                    self.handled.add(sim_id)
                    self.retry.pop(sim_id, None)
                else:
                    self.retry[sim_id] = simulation  # the next poll tries it again, though `since` moves past it
        self.since = newest - timedelta(seconds=1)  # a second of overlap; `handled` keeps it from planning twice
        if self.reviser is not None:
            self.reviser.poll()  # the plans the operator chose: checked again when they change
        return planned

    # -- one baseline ------------------------------------------------------------
    def plan_for(self, simulation: dict[str, Any]) -> bool:
        """Publish plans A and B for a baseline and trigger both what-if runs. ``False`` if it already had plans."""
        sim_id = str(simulation["id"])
        if self.client.list_plans(sim_id):
            log.info("baseline %s: already has plans, skipped", sim_id)
            return False
        published, problems = self._publish(simulation)
        if not published and problems:
            log.error("baseline %s: %s", sim_id, problems[-1])
            return False
        self._simulate(sim_id, published)
        return True

    def _publish(self, simulation: dict[str, Any], *, at_minute: int | None = None, progress: Progress = _quiet,
                 metadata: dict[str, Any] | None = None) -> tuple[dict[str, str], list[str]]:
        """Plans A and B for a baseline, judged and published: ``(variant -> plan id, why nothing was published)``. Raises when the backend refused both."""
        sim_id = str(simulation["id"])
        snapshot = simulation.get("scenarioSnapshot") or {}
        location_id = snapshot.get("locationId") or simulation.get("locationId") or DEFAULT_LOCATION
        duration = int(snapshot.get("durationMinutes") or 0)
        wanted = self.settings.at_minute if at_minute is None else int(at_minute)
        at_minute = max(0, min(wanted, duration - MIN_MINUTES_BEFORE_END)) if duration else wanted
        progress("composing", 5, f"A recolher a frota e o estado do fogo em T+{at_minute} min")
        team = self.orchestrator.pull_fleet()  # the fleet changes between baselines
        log.info("baseline %s (%s): planning at T+%d with %d units", sim_id, simulation.get("label"), at_minute, team)
        # plans A (maximum attack) and B (no casualties), each judged by the engine before it is published (see alternatives.py)
        result = build_alternatives(
            self.orchestrator, self.client, sim_id, publish=True, house_zones=self.settings.building_zones or HOUSE_ZONES_FOR_B,
            horizon_minutes=self.settings.horizon_minutes, location_id=location_id, title_prefix="Plano", at_minute=at_minute,
            stage_minutes=self.settings.stage_minutes, concentration=self.settings.concentration or None,
            replan_minutes=self.settings.replan_minutes, max_waves=self.settings.max_waves, candidates=self.settings.candidates, commander=self.commander,
            progress=progress, plan_metadata=metadata,
        )
        for cycle in (result.cycle_a, result.cycle_b):
            for issue in (cycle.issues if cycle else []):
                log.warning("baseline %s: %s: %s", sim_id, issue.proposal_title, issue.problem)
        for problem in result.issues:
            log.warning("baseline %s: %s", sim_id, problem)
        if not result.published and len(result.unsafe) == 2:
            return {}, ["nenhum plano foi publicado: nenhum dos dois se mostrou seguro para as equipas (um plano que prevê baixas nunca é proposto)"]
        if not result.published:
            raise RuntimeError("neither plan was published (the backend validation rejected both)")
        log.info("baseline %s: published %s", sim_id, ", ".join(f"{v}={i}" for v, i in sorted(result.published.items())))
        log.info("baseline %s: A = %s | B = %s", sim_id, result.eval_a.line() if result.eval_a else "?", result.eval_b.line() if result.eval_b else "?")
        return dict(result.published), []

    # -- the operator's requests ---------------------------------------------------
    def serve_requests(self) -> str | None:
        """Claim the oldest queued request and plan it; returns its baseline id, or ``None`` when there was nothing to do."""
        if not self.orphans_checked:
            self.orphans_checked = True
            for request in self.client.list_plan_requests(status="planning,simulating"):
                if request.get("claimedBy") == self.settings.agent_name:  # ours, from before a restart: nobody is working on it any more
                    self._close(str(request["id"]), "failed", error="O serviço dos agentes reiniciou a meio deste pedido; peça um novo plano.")
        for request in sorted(self.client.list_plan_requests(status="queued"), key=lambda r: r.get("createdAt") or ""):
            try:
                claimed = self.client.claim_plan_request(str(request["id"]), self.settings.agent_name)
            except ApiProblem as error:
                if error.status_code in (404, 409):  # gone, or another agent was faster
                    continue
                raise
            self.handle_request(claimed)
            return str(claimed["simulationId"])
        return None

    def handle_request(self, request: dict[str, Any]) -> bool:
        """Plan a claimed request from start to end, reporting each step; ``True`` when it closed ``done``."""
        req_id, sim_id = str(request["id"]), str(request["simulationId"])
        status = {"value": "planning"}

        def report(phase: str, percent: float, message: str) -> None:
            try:
                self.client.patch_plan_request(req_id, {"status": status["value"], "progress": {"phase": phase, "percent": round(percent, 1), "message": message[:500]}})
            except ApiProblem as error:  # a lost progress line must not lose the plan
                log.warning("request %s: progress not recorded: %s", req_id, error)

        log.info("request %s: planning baseline %s for %s (%s)", req_id, sim_id, request.get("requestedBy") or "the operator", request.get("note") or "no note")
        try:
            simulation = self.client.get_simulation(sim_id)
            metadata = {"agents.request": req_id, **({"agents.requestNote": request["note"]} if request.get("note") else {})}
            published, problems = self._publish(simulation, at_minute=request.get("atMinute"), progress=report, metadata=metadata)
            if not published:
                raise RuntimeError(problems[-1] if problems else "nenhum plano foi publicado")
            self.handled.add(sim_id)  # the automatic poll leaves this baseline alone now
            plan_ids = [published[v] for v in sorted(published)]
            variants = ", ".join(sorted(published))
            status["value"] = "simulating"
            self.client.patch_plan_request(req_id, {"status": "simulating", "planIds": plan_ids,
                                                    "progress": {"phase": "simulating", "percent": 80, "message": f"Planos {variants} publicados; a correr o what-if de cada um"}})
            self._simulate(sim_id, published, progress=report)
            if self.settings.keep_only_latest:
                self.prune_to(plan_ids)
            self._close(req_id, "done", plan_ids=plan_ids, message=f"Planos {variants} prontos para comparar")
            return True
        except Exception as error:  # noqa: BLE001 — the operator must hear why, not wait for a request that never ends
            log.error("request %s: failed: %s: %s", req_id, type(error).__name__, error)
            self._close(req_id, "failed", error=f"{type(error).__name__}: {error}"[:2000])
            return False

    def prune_to(self, keep_plan_ids: list[str]) -> tuple[int, int]:
        """Delete every plan except ``keep_plan_ids`` and every what-if run that is not one of theirs (the baselines stay): the operator sees the latest pair only.

        An active plan is closed first (a plan under way cannot be deleted). Returns ``(plans, runs)`` deleted. Whatever cannot be deleted is left and logged.
        """
        keep = set(keep_plan_ids)
        plans_gone = runs_gone = 0
        try:
            for plan in self.client.list_all_plans():
                plan_id = str(plan["id"])
                if plan_id in keep:
                    continue
                try:
                    if plan.get("status") == "active":
                        self.client.close_plan(plan_id)
                    self.client.delete_plan(plan_id)
                    plans_gone += 1
                except ApiProblem as error:
                    log.warning("prune: plan %s kept [%s]: %s", plan_id, error.code, error)
            for run in self.client.list_simulations(kind="what_if", limit=200):
                if str(run.get("planId") or "") in keep:
                    continue
                try:
                    self.client.delete_simulation(str(run["id"]))
                    runs_gone += 1
                except ApiProblem as error:
                    log.warning("prune: run %s kept [%s]: %s", run.get("id"), error.code, error)
        except ApiProblem as error:
            log.warning("prune: %s", error)
        log.info("prune: %d old plans and %d old what-if runs deleted; %d plans kept", plans_gone, runs_gone, len(keep))
        return plans_gone, runs_gone

    def _close(self, req_id: str, status: str, *, plan_ids: list[str] | None = None, error: str | None = None, message: str | None = None) -> None:
        patch: dict[str, Any] = {"status": status, "progress": {"phase": status, "percent": 100, "message": (message or error or status)[:500]}}
        if plan_ids:
            patch["planIds"] = plan_ids
        if error:
            patch["error"] = error
        try:
            self.client.patch_plan_request(req_id, patch)
        except ApiProblem as problem:
            log.error("request %s: could not be closed %s: %s", req_id, status, problem)

    def _simulate(self, baseline_id: str, published: dict[str, str], progress: Progress = _quiet) -> None:
        """What-if of every published plan; both are asked for first so the backend runs them side by side."""
        runs: dict[str, str] = {}
        for variant, plan_id in sorted(published.items()):
            try:
                runs[variant] = str(self.client.simulate_plan(plan_id, baseline_simulation_id=baseline_id, wait_seconds=None)["id"])
            except ApiProblem as error:
                log.error("baseline %s plan %s: what-if refused [%s]: %s", baseline_id, variant, error.code, error)
        for n, (variant, run_id) in enumerate(runs.items()):
            progress("simulating", 82 + 16 * n / max(1, len(runs)), f"What-if do plano {variant} a correr no motor")
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

    def seed_demo(self) -> bool:
        """Register the demo resources (``AGENTS_SEED_DEMO``); ``True`` once every seed ran, ``False`` to try again on the next poll."""
        base_url = str(self.client._http.base_url).rstrip("/")  # noqa: SLF001 — the seeds talk to the same API
        for name in DEMO_SEEDS:
            path = SCRIPTS / f"{name}.py"
            if not path.exists():
                log.warning("demo resources: %s not found, skipped", path)
                continue
            try:
                spec = importlib.util.spec_from_file_location(name, path)
                module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
                spec.loader.exec_module(module)  # type: ignore[union-attr]
                module.main(["--base-url", base_url])
            except (Exception, SystemExit) as error:  # noqa: BLE001 — a seed that fails (backend still loading) is tried again, it never stops the plans
                log.error("demo resources: %s failed: %s: %s", name, type(error).__name__, error)
                return False
        log.info("demo resources ready (aircraft, pre-positioned crews, reinforcements)")
        return True

    def run_forever(self, stop: Callable[[], bool] = lambda: False) -> None:
        if not self.wait_for_backend(stop):
            log.error("the backend never answered; polling anyway")
        seeded = not self.settings.seed_demo
        log.info("watching for baselines updated since %s (every %.0f s)", self.since.isoformat(timespec="seconds"), self.settings.poll_seconds)
        while not stop():
            if not seeded:
                seeded = self.seed_demo()
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
    orchestrator = OrchestratorAgent(client)
    orchestrator.advisor = build_advisor()  # the LLM commander if it was asked for and answers; else the rules decide everything (never stops the service from starting)
    watcher = Watcher(client, orchestrator, WatcherSettings.from_env())
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
