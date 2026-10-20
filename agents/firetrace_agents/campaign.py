"""A firefighting *campaign*: the agents decide again and again as the fire evolves, not once.

The backend applies an intervention from the start of whatever simulation it is in (its start time and durations are
ignored), so a campaign is a chain of short simulations, each one starting when the response of that stage starts:

    state (fire outline at t, lines already built)
      -> forecast : simulate ahead from the state, no new response
      -> plan     : the agents read the forecast, the orchestrator publishes plans A and B
      -> choose   : a policy picks one (or the better one on the forecast)
      -> execute  : simulate the next stage with the chosen plan's effects: the "real" evolution
      -> new state: the fire outline at the end of the stage; fire lines (permanent) are kept, crews and drops are not

The forecast can be given a wrong wind (``forecast_wind_shift_deg``) while the execution uses the real weather, which
measures how the plan holds when the prediction is off. Resources are not tracked yet (water, fatigue): see the roadmap.
"""
from __future__ import annotations

import copy
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from .client import ApiProblem, FiretraceClient
from .orchestrator import CycleResult, OrchestratorAgent

SCENARIO_FIELDS = ("name", "description", "locationId", "purpose", "start", "durationMinutes", "ignitions", "weather", "resources", "engine")
MIN_WINDOW_MINUTES = 5  # the spec's minimum scenario duration
PERMANENT = frozenset({"fire_line"})
"""Interventions that stay on the ground after a stage: a built line holds; crews, drops and defences must be decided again."""


def scenario_at(
    snapshot: dict[str, Any],
    t0: int,
    duration: int,
    *,
    perimeter: dict[str, Any] | None,
    interventions: list[dict[str, Any]],
    name: str,
    wind_shift_deg: float = 0.0,
) -> dict[str, Any]:
    """The base scenario moved to ``t0`` minutes after the ignition, starting from ``perimeter`` (None at the ignition)."""
    start = datetime.fromisoformat(snapshot["start"]) + timedelta(minutes=t0)
    scenario = {key: copy.deepcopy(snapshot[key]) for key in SCENARIO_FIELDS if key in snapshot}
    scenario.update(start=start.isoformat(), durationMinutes=duration, name=name)
    if t0 > 0 and perimeter:
        scenario["initialFire"] = {"perimeter": perimeter, "asOf": start.isoformat(), "source": "estimated"}
    scenario["interventions"] = copy.deepcopy(interventions)
    if wind_shift_deg:
        weather = dict(scenario.get("weather") or {})
        weather["events"] = [*(weather.get("events") or []), {"type": "wind_shift", "start": {"offsetMinutes": 0}, "deltaDeg": wind_shift_deg}]
        scenario["weather"] = weather
    return scenario


def plan_effects(plan: dict[str, Any]) -> list[dict[str, Any]]:
    """What the plan does to the fire: the ``simulationEffects`` of its actions, as scenario interventions."""
    return [copy.deepcopy(effect) for action in plan.get("actions", []) for effect in action.get("simulationEffects", [])]


def carry_over(carried: list[dict[str, Any]], new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The lines that remain after a stage: the ones already there plus the permanent ones just built (no duplicates)."""
    out = list(carried)
    seen = {json.dumps(e, sort_keys=True) for e in out}
    for effect in new:
        key = json.dumps(effect, sort_keys=True)
        if effect.get("type") in PERMANENT and key not in seen:
            seen.add(key)
            out.append(effect)
    return out


@dataclass
class StageResult:
    k: int
    t0: int
    t1: int
    plan: str  # "A" / "B"
    area_ha: float
    crown_ha: float
    buildings: int
    baseline_ha: float | None
    actions: int
    new_lines: int
    carried_lines: int
    forecast_id: str
    execution_id: str
    issues: int
    why: str = ""
    life: str = ""  # the life planner's account for this stage: at risk, evacuated in time, sheltered, exposed (a model, not a backend measure)
    life_report: Any = None  # the same as a `LifeReport` (None when nobody was in the fire's way)


@dataclass
class CampaignResult:
    baseline_id: str
    stages: list[StageResult] = field(default_factory=list)
    stopped: str = ""

    @property
    def final_ha(self) -> float | None:
        return self.stages[-1].area_ha if self.stages else None


class Campaign:
    def __init__(
        self,
        client: FiretraceClient,
        orchestrator: OrchestratorAgent,
        baseline: dict[str, Any],
        *,
        stage_minutes: int = 30,
        horizon_minutes: int = 60,
        policy: str = "best",
        forecast_wind_shift_deg: float = 0.0,
        publish: bool = False,
        start_minute: int = 0,
        until_minute: int | None = None,
        capacity: bool = True,
        concentrations: tuple[int, ...] = (1, 3, 6),
        response: bool = True,
        life_horizon_minutes: int = 180,
        building_zones: tuple[int, ...] = (0,),
        building_weight_ha: float = 10.0,
    ) -> None:
        if policy not in {"A", "B", "best"}:
            raise ValueError("policy must be 'A', 'B' or 'best'")
        self.capacity, self.concentrations, self.response = capacity, tuple(concentrations), response
        self.building_zones = tuple(building_zones)  # candidate numbers of house zones the engines defend (0 = none)
        self.building_weight_ha = building_weight_ha  # how many hectares of burned area one building is worth when choosing between candidates
        self.life_horizon = life_horizon_minutes
        self.client, self.orchestrator, self.baseline = client, orchestrator, baseline
        self.snapshot = baseline["scenarioSnapshot"]
        self.total = int(self.snapshot["durationMinutes"])
        self.stage, self.horizon, self.policy = stage_minutes, horizon_minutes, policy
        self.forecast_shift, self.publish = forecast_wind_shift_deg, publish
        self.start, self.until = start_minute, min(until_minute or self.total, self.total)

    # -- helpers ---------------------------------------------------------------
    def _baseline_area_at(self, minute: int) -> float | None:
        try:
            milestones = self.client.get_summary(self.baseline["id"], step_minutes=self.stage)["milestones"]
        except ApiProblem:
            return None
        row = next((m for m in milestones if m["tMin"] == minute), None)
        return row["areaHa"] if row else None

    def _outline(self, simulation_id: str, minute: int) -> dict[str, Any] | None:
        for t in (minute, minute - 1):
            try:
                features = self.client.get_perimeters(simulation_id, t_min=t).get("features") or []
            except ApiProblem:
                continue
            if features:
                return features[0]["geometry"]
        return None

    def _burned(self, simulation: dict[str, Any]) -> float:
        return float((simulation.get("stats") or {}).get("burnedHa") or 0.0)

    def _new_buildings(self, simulation: dict[str, Any], already: float | None = None) -> float:
        """Buildings the window itself affected. A run restarted from an outline also counts the houses inside that outline, with
        none of the protection earlier windows gave them, so the count at minute 0 of the same run is taken off."""
        total = float((simulation.get("stats") or {}).get("buildingsAffected") or 0.0)
        if already is None:
            already = self._buildings_in_outline(simulation)
        return max(total - already, 0.0)

    def _buildings_in_outline(self, simulation: dict[str, Any]) -> float:
        try:
            first = self.client.get_summary(simulation["id"], step_minutes=self.stage)["milestones"][0]
        except (ApiProblem, KeyError, IndexError):
            return 0.0
        return float(first.get("buildingsAffected") or 0.0) if first.get("tMin") == 0 else 0.0

    def _plan(self, forecast: dict[str, Any], t0: int, perimeter: dict[str, Any] | None, carried: list[dict[str, Any]]) -> tuple[str, dict[str, Any], str, CycleResult]:
        """Candidate plans (concentration × A/B), each tried on the forecast; the one that burns least wins.

        Concentration = on how many of the most dangerous sectors the metres of line are spent (as one barrier each);
        0 = the older placement (units spread over the front) with the same budget; without ``capacity`` there is no budget.
        """
        horizon = min(self.horizon, self.total - t0)
        configs: list[int | None] = list(self.concentrations) if self.capacity else [None]
        candidates: list[tuple[str, str, dict[str, Any], CycleResult]] = []
        for conc in configs:
            for zones in self.building_zones:
                result = self.orchestrator.run_cycle(
                    forecast["id"], horizon_minutes=self.horizon, at_minute=0, location_id=self.snapshot["locationId"], title_prefix=f"[campanha T+{t0}] Plano",
                    publish=False, stage_minutes=self.stage if self.capacity else None, concentration=(conc or None) if self.capacity else None,
                    life_horizon_minutes=self.life_horizon, building_zones=zones,
                )
                if zones and not result.zones:
                    continue  # no houses to defend: the same plan as without zones
                tag = ("∞" if conc is None else ("L" if conc == 0 else f"K{conc}")) + (f"+D{zones}" if zones else "")
                for variant, plan in (("A", result.plan_a), ("B", result.plan_b)):
                    if self.policy in {"A", "B"} and variant != self.policy:
                        continue
                    candidates.append((f"{tag}/{variant}", variant, plan, result))
        if len(candidates) == 1:
            label, variant, plan, result = candidates[0]
            if self.publish and result.validation.get(variant, {}).get("valid") is not False:
                self.client.create_plan(plan)
            return label, plan, "único candidato", result
        # With house zones among the candidates the area alone no longer says which plan is best: each new building counts as
        # ``building_weight_ha`` hectares burned (an assumption, not a backend number).
        weighted = any(self.building_zones)
        scored: list[tuple[float, int, str, dict[str, Any], CycleResult]] = []
        for index, (label, _variant, plan, result) in enumerate(candidates):
            scenario = scenario_at(self.snapshot, t0, horizon, perimeter=perimeter, interventions=[*carried, *plan_effects(plan)], name=f"[lab] previsão {label}")
            sim = self.client.run_scenario(scenario, label=f"[lab] previsão {label} T+{t0}")
            if sim.get("status") != "succeeded":
                value = float("inf")
            elif weighted:
                value = self._burned(sim) + self.building_weight_ha * self._new_buildings(sim)
            else:
                value = self._burned(sim)
            scored.append((value, index, label, plan, result))
        best = min(scored, key=lambda s: (s[0], s[1]))
        unit = f"(ha + {self.building_weight_ha:g} ha por edifício, na previsão)" if weighted else "(ha na previsão)"
        why = " ".join(f"{s[2]}={s[0]:.0f}" for s in scored) + " " + unit
        if self.publish and best[4].validation.get(best[2][-1], {}).get("valid") is not False:
            self.client.create_plan(best[3])
        return best[2], best[3], why, best[4]

    # -- the campaign ----------------------------------------------------------
    def run(self, on_stage: Callable[[StageResult], None] | None = None) -> CampaignResult:
        out = CampaignResult(baseline_id=self.baseline["id"])
        if not self.orchestrator.agents:
            self.orchestrator.pull_fleet()
        carried: list[dict[str, Any]] = []
        perimeter: dict[str, Any] | None = None
        buildings_total = 0.0
        t0, k = self.start, 0
        if t0 > 0:
            perimeter = self._outline(self.baseline["id"], t0)  # joining a fire already burning: the baseline's outline is the state
        while t0 < self.until:
            window = min(self.stage, self.until - t0)
            if window < MIN_WINDOW_MINUTES:
                break
            if self.response:
                # 1. forecast: where the fire goes from here if nothing more is done (possibly with a wrong wind)
                forecast_len = min(max(self.horizon + 30, self.life_horizon), self.total - t0)  # long enough for the life planner to see the town burn
                forecast = self.client.run_scenario(
                    scenario_at(self.snapshot, t0, forecast_len, perimeter=perimeter, interventions=carried, name=f"[lab] previsão T+{t0}", wind_shift_deg=self.forecast_shift),
                    label=f"[lab] previsão T+{t0}",
                )
                if forecast.get("status") != "succeeded":
                    out.stopped = f"previsão T+{t0} {forecast.get('status')}"
                    break
                # 2. plans and 3. choice: the agents read the forecast (decision instant 0 of the forecast = now); the best candidate on it wins
                variant, plan, why, result = self._plan(forecast, t0, perimeter, carried)
            else:
                # the control: the same chain of stages, with no response at all (what the chaining itself does to the fire)
                forecast, variant, plan, why, result = {"id": "-"}, "-", {"actions": []}, "controlo: sem resposta, encadeado", None
            # 4. execute on the real weather
            effects = plan_effects(plan)
            executed = self.client.run_scenario(
                scenario_at(self.snapshot, t0, window, perimeter=perimeter, interventions=[*carried, *effects], name=f"[lab] execução T+{t0}"),
                label=f"[lab] execução T+{t0}",
            )
            if executed.get("status") != "succeeded":
                out.stopped = f"execução T+{t0} {executed.get('status')}"
                break
            new_lines = sum(1 for e in effects if e.get("type") in PERMANENT)
            carried = carry_over(carried, effects)
            stats = executed.get("stats") or {}
            buildings_total += self._new_buildings(executed)  # cumulative, counted window by window (see `_new_buildings`)
            stage = StageResult(
                k=k, t0=t0, t1=t0 + window, plan=variant, area_ha=self._burned(executed), crown_ha=float(stats.get("crownFireHa") or 0.0),
                buildings=int(round(buildings_total)), baseline_ha=self._baseline_area_at(t0 + window), actions=len(plan.get("actions", [])),
                new_lines=new_lines, carried_lines=len(carried), forecast_id=forecast["id"], execution_id=executed["id"],
                issues=sum(len(v.get("issues", [])) for v in result.validation.values()) if result else 0, why=why,
                life=result.life.report.line() if result and result.life else "",
                life_report=result.life.report if result and result.life else None,
            )
            out.stages.append(stage)
            if on_stage:
                on_stage(stage)
            # 5. new state
            perimeter = self._outline(executed["id"], window)
            if perimeter is None:
                out.stopped = "fogo extinto" if stage.area_ha < 1 else "sem perímetro"
                break
            t0 += window
            k += 1
        return out
