"""The engine's verdict on a plan, and the safety rule: **no plan is published that predicts a crew casualty**, on the forecast or on a wrong wind.

``CrewSafety`` (backend) says a crew is caught if the ground it stands on burns while it is there. A plan is judged by its what-if run on the forecast fire
*and* on two runs of the same fire pushed by a wind that is wrong by ``WIND_ERROR_DEG`` degrees either way: the real wind is never exactly the forecast, and a crew
that is safe only when the forecast is right is not safe. The crews caught in any of the three runs have their stay cut to end before the fire reaches them
(``withdraw``), and the ones that would then have no time to do anything are not sent. A plan that still has a casualty after that is not safe: the caller does not publish it.

The three what-if runs are asked for together (a plan is published, simulated and deleted again for each: a candidate is never left in the operator's list).
"""
from __future__ import annotations

import copy
import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from .alternatives import SAFETY_ROUNDS, WIND_ERROR_DEG, Evaluation, evaluate, withdraw
from .campaign import scenario_at
from .client import FiretraceClient

log = logging.getLogger("firetrace.judge")


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

    def __init__(self, client: FiretraceClient, baseline_id: str, snapshot: dict[str, Any]) -> None:
        self.client, self.baseline_id, self.snapshot = client, baseline_id, snapshot
        self._idle: dict[float, tuple[str, float]] = {}  # shift → (baseline simulation id, burned ha with no response)

    def _idle_run(self, shift: float) -> tuple[str, float]:
        if shift not in self._idle:
            total = int(self.snapshot["durationMinutes"])
            label = f"[lab] sem resposta {shift:+.0f}°"
            idle = self.client.run_scenario(scenario_at(self.snapshot, 0, total, perimeter=None, interventions=[], name=label, wind_shift_deg=shift), label=label)
            self._idle[shift] = (str(idle["id"]), float((idle.get("stats") or {}).get("burnedHa") or 0.0))
        return self._idle[shift]

    def verdict(self, plan: dict[str, Any], *, wrong_wind: bool = True) -> Verdict | None:
        """Forecast and wrong-wind what-ifs of ``plan`` together (the forecast alone with ``wrong_wind=False``, a third of the cost); ``None`` if the forecast one did not succeed."""
        shifts = (-WIND_ERROR_DEG, WIND_ERROR_DEG) if wrong_wind else ()
        with ThreadPoolExecutor(max_workers=1 + len(shifts)) as pool:
            idle = list(pool.map(self._idle_run, shifts))  # no-ops once made
            futures = [pool.submit(evaluate, self.client, copy.deepcopy(plan), self.baseline_id)]
            futures += [pool.submit(evaluate, self.client, copy.deepcopy(plan), base_id) for base_id, _ha in idle]
            results = [f.result() for f in futures]
        forecast, wrong = results[0], [r for r in results[1:] if r is not None]
        if forecast is None:
            return None
        if len(wrong) < len(shifts):
            log.warning("baseline %s: %d of %d wrong-wind runs did not succeed", self.baseline_id, len(shifts) - len(wrong), len(shifts))
        worst = max(range(len(wrong)), key=lambda i: wrong[i].burned_ha, default=None)
        return Verdict(forecast, wrong, {} if worst is None else {shifts[worst]: idle[worst][1]})

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
