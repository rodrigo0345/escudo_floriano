"""Revisions: the agents keep watching the plan the operator chose, and send a revision when it needs one (``PATCH /plans/{id}``).

The operator selects plan A or B and may change it (``PATCH /plans/{id}``: take a unit off, move an action, change a time). A changed plan has not been through
the agents' checks, so whenever a ``selected`` or ``active`` plan changes, the agents look at it again, as they did before publishing it:

* **safety first**: the same rule as for A and B (``judge.py``): no crew caught by the fire, on the forecast or on a wrong wind; crews that would be are cut
  short or taken off;
* **then the fire**: the re-plans along the fire (``adaptation.py``) send the units that are free where the fire is not under control.

If that changes anything, the plan is revised with a merge-patch of its ``actions`` and a note at the top of its ``summary`` saying what changed and why; the
operator sees the revision in the plan. A plan the agents have already looked at (same ``updatedAt``) is not looked at again, and the plans already chosen when
the service starts are left as they are (only a change after that makes the agents look).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

from .alternatives import HOUSE_ZONES_FOR_B, set_stay
from .client import ApiProblem, FiretraceClient
from .orchestrator import OrchestratorAgent

log = logging.getLogger("firetrace.revision")

PLAN_INPUT_FIELDS = ("locationId", "title", "variant", "strategy", "summary", "basis", "objectives", "alertLevel", "horizon", "actions", "assumptions", "risks", "confidence", "tags", "metadata")
WATCHED_STATUSES = "selected,active"


def _minutes_between(later: str | None, earlier: str | None) -> int:
    try:
        return max(0, int((datetime.fromisoformat(str(later)) - datetime.fromisoformat(str(earlier))).total_seconds() // 60))
    except (TypeError, ValueError):
        return 0


class Reviser:
    """Looks at the operator's chosen plans and revises them when the checks change something."""

    def __init__(self, client: FiretraceClient, orchestrator: OrchestratorAgent, *, replan_minutes: int, max_waves: int, horizon_minutes: int, stage_minutes: int, concentration: int | None) -> None:
        self.client, self.orchestrator = client, orchestrator
        self.cycle = {"horizon_minutes": horizon_minutes, "stage_minutes": stage_minutes, "concentration": concentration, "title_prefix": "Plano"}
        self.replan_minutes, self.max_waves = replan_minutes, max_waves
        self.seen: dict[str, str] = {}  # plan id → the `updatedAt` last looked at (or written by the agents themselves)
        self.primed = False

    def poll(self) -> list[str]:
        """Revise every chosen plan that changed since the last look; returns the ids revised."""
        try:
            page = self.client._request("GET", "/plans", params={"status": WATCHED_STATUSES, "limit": 50})  # noqa: SLF001 — a filtered list the client has no helper for
        except ApiProblem as error:
            log.warning("revisions: could not list the chosen plans [%s]: %s", error.code, error)
            return []
        revised: list[str] = []
        if not self.primed:  # a restart does not rewrite the plans already chosen before it: only the ones that change from now on
            self.seen.update({str(s.get("id")): str(s.get("updatedAt") or "") for s in page.get("items") or []})
            self.primed = True
            return revised
        for summary in page.get("items") or []:
            plan_id, updated = str(summary.get("id")), str(summary.get("updatedAt") or "")
            if not plan_id or self.seen.get(plan_id) == updated:
                continue
            try:
                if self.revise(plan_id):
                    revised.append(plan_id)
            except Exception as error:  # noqa: BLE001 — one plan must not stop the service
                log.error("plan %s: revision failed: %s: %s", plan_id, type(error).__name__, error)
                self.seen[plan_id] = updated  # not again until it changes
        return revised

    def revise(self, plan_id: str) -> bool:
        from .adaptation import adapt  # noqa: PLC0415 — adaptation builds on the alternatives this module also uses
        from .judge import Judge  # noqa: PLC0415

        plan = self.client.get_plan(plan_id)
        updated = str(plan.get("updatedAt") or "")
        baseline_id = str((plan.get("basis") or {}).get("simulationId") or "")
        if not baseline_id:
            self.seen[plan_id] = updated
            return False
        simulation = self.client.get_simulation(baseline_id)
        snapshot = simulation.get("scenarioSnapshot") or {}
        decided_at = _minutes_between((plan.get("basis") or {}).get("situationAsOf"), snapshot.get("start"))
        candidate = {key: json.loads(json.dumps(plan[key])) for key in PLAN_INPUT_FIELDS if key in plan}
        before = json.dumps(candidate.get("actions"), sort_keys=True)
        set_stay(candidate)
        judge = Judge(self.client, baseline_id, snapshot)
        verdict, shortened, removed = judge.make_safe(candidate, decided_at)
        notes: list[str] = []
        if shortened or removed:
            notes.append(f"Segurança: {shortened} equipas passam a sair antes de o fogo chegar e {removed} deixam de ser enviadas (seriam apanhadas pelo fogo, na previsão ou com o vento errado em 30°).")
        if verdict is not None and verdict.casualties:
            notes.append(f"Atenção: o motor ainda prevê {verdict.casualties} baixas; reveja as ações das equipas no terreno.")
        if verdict is not None and not verdict.casualties and self.replan_minutes:
            self.orchestrator.pull_fleet()
            adapted = adapt(
                self.orchestrator, self.client, baseline_id, candidate, verdict, judge, decided_at=decided_at, run_minutes=int(snapshot.get("durationMinutes") or 0),
                lean=str(plan.get("variant") or "") == "B", house_zones=HOUSE_ZONES_FOR_B, replan_minutes=self.replan_minutes, max_waves=self.max_waves,
                location_id=plan.get("locationId") or snapshot.get("locationId"), at_minute=decided_at, **self.cycle,
            )
            notes.extend(f"Reavaliação: {wave.line()}" for wave in adapted.waves if wave.outcome == "kept")
            verdict = adapted.verdict
        if json.dumps(candidate.get("actions"), sort_keys=True) == before:
            self.seen[plan_id] = updated
            log.info("plan %s: checked again, nothing to revise", plan_id)
            return False
        result = verdict.forecast.line() if verdict is not None else "sem resultado do motor"
        header = "### Revisão dos agentes\n" + "".join(f"- {note}\n" for note in notes) + f"- Resultado simulado: {result}\n\n"
        patched = self.client.patch_plan(plan_id, {"actions": candidate["actions"], "summary": header + str(plan.get("summary") or "")})
        self.seen[plan_id] = str(patched.get("updatedAt") or updated)
        log.info("plan %s: revised (%s)", plan_id, "; ".join(notes) or "actions changed")
        return True
