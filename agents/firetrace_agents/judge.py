"""The engine's verdict on a plan, and the safety rule: **no plan is published that predicts a crew casualty**, on the forecast or on a wrong wind.

``CrewSafety`` (backend) says a crew is caught if the ground it stands on burns while it is there. A plan is judged by its what-if run on the forecast fire
*and* on two runs of the same fire pushed by a wind that is wrong by ``WIND_ERROR_DEG`` degrees either way: the real wind is never exactly the forecast, and a crew
that is safe only when the forecast is right is not safe. The crews caught in any of the three runs have their stay cut to end before the fire reaches them
(``withdraw``), and the ones that would then have no time to do anything are not sent. A plan that still has a casualty after that is not safe: the caller does not publish it.

The three what-if runs are asked for together (a plan is published, simulated and deleted again for each: a candidate is never left in the operator's list).
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from typing import Any

from .alternatives import SAFETY_ROUNDS, WIND_ERROR_DEG, Evaluation, central_engine, drop_actions, evaluate, withdraw
from .campaign import scenario_at
from .client import ApiProblem, FiretraceClient

log = logging.getLogger("firetrace.judge")


def plan_fingerprint(plan: dict[str, Any]) -> str:
    """A hash of everything about a plan that changes what the engine does with it (its actions, where and on what basis), not of its prose."""
    relevant = {"locationId": plan.get("locationId"), "basis": plan.get("basis"), "actions": plan.get("actions")}
    return hashlib.sha256(json.dumps(relevant, sort_keys=True, default=str).encode()).hexdigest()


@dataclass
class Verdict:
    """What the engine says a plan does on the forecast and on the two wrong-wind fires."""

    forecast: Evaluation
    shifted: list[Evaluation] = field(default_factory=list)
    idle_ha: dict[float, float] = field(default_factory=dict)  # wind shift → area burned with no response at all (for the worst shift)

    @property
    def casualties(self) -> int:
        return self.forecast.casualties + sum(e.casualties for e in self.shifted)

    @property
    def worst_ha(self) -> float | None:
        return max((e.burned_ha for e in self.shifted), default=None)

    def exposures(self) -> list[dict[str, Any]]:
        """The crews caught in any of the runs, each once, with the earliest minute the fire reaches it."""
        first: dict[str, dict[str, Any]] = {}
        for evaluation in (self.forecast, *self.shifted):
            for exposure in evaluation.exposures:
                key = str(exposure["actionId"])
                if key not in first or float(exposure["firstMinute"]) < float(first[key]["firstMinute"]):
                    first[key] = exposure
        return list(first.values())


class Judge:
    """Judges plans of one baseline. The no-response runs on the shifted winds are made once and reused for every plan."""

    def __init__(self, client: FiretraceClient, baseline_id: str, snapshot: dict[str, Any], *, central_only: bool | None = None) -> None:
        self.client, self.baseline_id, self.snapshot = client, baseline_id, snapshot
        self._idle: dict[float, tuple[str, float]] = {}  # shift → (baseline simulation id, burned ha with no response)
        self._idle_lock = threading.Lock()
        self._evaluations: dict[tuple[str, str, bool], Evaluation] = {}  # (baseline, plan fingerprint, central only) → what the engine said
        self._evaluations_lock = threading.Lock()
        # The wrong-wind runs only give casualties and burned area, which the central run alone gives identically; the forecast run feeds the next decision
        # (its ensemble probabilities) and always keeps the whole ensemble. ``AGENTS_JUDGE_CENTRAL_ONLY=0`` turns the saving off.
        if central_only is None:
            central_only = os.environ.get("AGENTS_JUDGE_CENTRAL_ONLY", "1") not in {"0", "false", "no"}
        self._central: dict[str, Any] | None = central_engine(snapshot) if central_only else None

    def _idle_run(self, shift: float) -> tuple[str, float]:
        with self._idle_lock:  # two plans judged at once need the same two runs: made once
            if shift not in self._idle:
                total = int(self.snapshot["durationMinutes"])
                label = f"[lab] sem resposta {shift:+.0f}°"
                scenario = scenario_at(self.snapshot, 0, total, perimeter=None, interventions=[], name=label, wind_shift_deg=shift)
                if self._central is not None:
                    scenario["engine"] = copy.deepcopy(self._central)
                idle = self.client.run_scenario(scenario, label=label)
                self._idle[shift] = (str(idle["id"]), float((idle.get("stats") or {}).get("burnedHa") or 0.0))
            return self._idle[shift]

    def _evaluate(self, plan: dict[str, Any], baseline_id: str, *, wrong_wind: bool) -> Evaluation | None:
        """``evaluate`` with a memory: a plan the engine has already judged on this baseline is not published, simulated and deleted again.

        The same plan is judged several times (the forecast inside every full verdict, a wave's candidate after the cheap look at it); only a change to its actions
        changes the answer, and the engine is deterministic.
        """
        key = (baseline_id, plan_fingerprint(plan), wrong_wind)
        with self._evaluations_lock:
            hit = self._evaluations.get(key)
        if hit is not None:
            return replace(hit)  # a copy: callers fill in fields (units, fire...) on what they get
        result = evaluate(self.client, copy.deepcopy(plan), baseline_id, self._central if wrong_wind else None)
        if result is not None:
            with self._evaluations_lock:
                self._evaluations[key] = result
            return replace(result)
        return None

    def verdict(self, plan: dict[str, Any], *, wrong_wind: bool = True) -> Verdict | None:
        """Forecast and wrong-wind what-ifs of ``plan`` together (the forecast alone with ``wrong_wind=False``, a third of the cost); ``None`` if the forecast one did not succeed."""
        shifts = (-WIND_ERROR_DEG, WIND_ERROR_DEG) if wrong_wind else ()
        with ThreadPoolExecutor(max_workers=2 + 2 * len(shifts)) as pool:
            idle_futures = [pool.submit(self._idle_run, shift) for shift in shifts]  # no-ops once made
            forecast_future = pool.submit(self._evaluate, plan, self.baseline_id, wrong_wind=False)  # does not wait for the shifted baselines
            idle = [f.result() for f in idle_futures]
            wrong_futures = [pool.submit(self._evaluate, plan, base_id, wrong_wind=True) for base_id, _ha in idle]
            results = [forecast_future.result(), *(f.result() for f in wrong_futures)]
        forecast, wrong = results[0], [r for r in results[1:] if r is not None]
        if forecast is None:
            return None
        if len(wrong) < len(shifts):
            log.warning("baseline %s: %d of %d wrong-wind runs did not succeed", self.baseline_id, len(shifts) - len(wrong), len(shifts))
        worst = max(range(len(wrong)), key=lambda i: wrong[i].burned_ha, default=None)
        return Verdict(forecast, wrong, {} if worst is None else {shifts[worst]: idle[worst][1]})

    def keep_holds_safe(self, plan: dict[str, Any], decided_at: int, rounds: int = 2) -> tuple[int, int]:
        """Judge a plan that now has its standby crews (``hold-*``, added after the judge) and take out the ones the fire catches. Returns (holds taken out, casualties left).

        A hold does no suppression, so taking it out only sends that unit home: it never changes the fire, and one round is normally enough. Any other crew the
        engine still finds caught is cut or dropped as ``make_safe`` does. After ``rounds`` rounds every hold that is left goes too, as the last resort.
        """
        taken = 0
        verdict = self.verdict(plan, wrong_wind=False)
        for round_ in range(rounds + 1):
            if verdict is None:
                raise ApiProblem(0, {"code": "no_verdict", "title": "the what-if of the plan with its standby crews did not succeed"})
            if verdict.casualties == 0:
                return taken, 0
            caught = verdict.exposures()
            holds = {str(e["actionId"]) for e in caught if str(e["actionId"]).startswith("hold-")}
            if round_ == rounds:  # still caught after the rounds: no standby at all
                holds = {str(a["id"]) for a in plan["actions"] if str(a["id"]).startswith("hold-")}
            others = [e for e in caught if str(e["actionId"]) not in holds]
            taken += drop_actions(plan, holds) if holds else 0
            cut, gone = withdraw(plan, others, decided_at, remove_all=round_ >= 1) if others else (0, 0)
            if not holds and not cut and not gone:
                return taken, verdict.casualties
            verdict = self.verdict(plan, wrong_wind=False)
        return taken, verdict.casualties if verdict is not None else 0

    def make_safe(self, plan: dict[str, Any], decided_at: int, rounds: int = SAFETY_ROUNDS, *, wrong_wind: bool = True) -> tuple[Verdict | None, int, int]:
        """Judge ``plan`` and, while it predicts casualties, cut the stay of the crews caught (then drop them). Returns (last verdict, crews shortened, crews removed).

        The rounds that cut the crews run on the forecast alone (one what-if each); the wrong-wind runs (two more) are made once the forecast is safe, and the plan is
        trimmed again only for what they add. The plan is changed in place. The verdict may still carry casualties when the rounds run out: such a plan is not safe
        and must not be published.
        """
        shortened = removed = 0

        def trim(verdict: Verdict | None, attempts: int, label: str) -> tuple[Verdict | None, bool]:
            nonlocal shortened, removed
            for round_ in range(attempts):
                if verdict is None or verdict.casualties == 0:
                    return verdict, True
                cut, gone = withdraw(plan, verdict.exposures(), decided_at, remove_all=round_ >= 1)
                shortened, removed = shortened + cut, removed + gone
                log.info("baseline %s: %s round %d: %d casualties -> %d shortened, %d removed", self.baseline_id, label, round_ + 1, verdict.casualties, cut, gone)
                if not cut and not gone:
                    return verdict, False
                verdict = self.verdict(plan, wrong_wind=False)
            return verdict, verdict is not None and verdict.casualties == 0

        verdict, safe = trim(self.verdict(plan, wrong_wind=False), rounds, "forecast")
        if not safe or not wrong_wind:
            return verdict, shortened, removed
        full = self.verdict(plan)
        for round_ in range(3):  # what the wrong-wind runs add: first the crews leave earlier (the fire comes sooner there), then the ones still caught are not sent
            if full is None or full.casualties == 0:
                break
            cut, gone = withdraw(plan, full.exposures(), decided_at, remove_all=round_ >= 1)
            shortened, removed = shortened + cut, removed + gone
            log.info("baseline %s: wrong-wind round %d: %d casualties -> %d shortened, %d removed", self.baseline_id, round_ + 1, full.casualties, cut, gone)
            if not cut and not gone:
                break
            full = self.verdict(plan)
        return full, shortened, removed
