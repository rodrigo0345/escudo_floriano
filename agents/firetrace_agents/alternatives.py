"""Plans A and B as two real alternatives, each judged by the engine: the cost of the choice is in the numbers.

* **A — every unit.** All the units are committed, the reserve included (it blocks ahead of the fire): the most slack if the forecast is wrong, at the price of
  units and of whatever casualties the engine predicts for the crews.
* **B — only what is needed, no casualties.** Only the units the fire's outline has room for (the reserve stays at its stations). The backend's own rule
  (``CrewSafety``) says a crew is caught if the ground it stands on burns while it is there, so each crew's stay is cut to end before the fire reaches it
  (``withdraw``), and the engines that can be spared defend the houses. If a crew cannot do any useful work before the fire arrives it is not sent.

Each plan is judged three ways: on the forecast (burned area, buildings, casualties), by the units it commits, and on a fire pushed by a wind that is wrong by
``WIND_ERROR_DEG`` degrees either way (the worse of the two runs): so whether the lean plan's saving costs it robustness is a number, not a guess.

Both are published through the normal path. To know the cost of a plan the agent publishes it, asks for its what-if (``POST /plans/{id}/simulate``),
reads ``stats`` and ``crewExposures`` and deletes it again: a candidate is never left in the operator's list. A plan whose ``crewCasualties`` is not zero
is trimmed and tried again (a few rounds): the engine, not a rule of thumb here, decides when B is safe.
"""
from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field
from typing import Any

from .campaign import plan_effects, scenario_at
from .client import ApiProblem, FiretraceClient
from .orchestrator import CycleResult, OrchestratorAgent

log = logging.getLogger("firetrace.alternatives")

WIND_ERROR_DEG = 30.0  # the forecast wind is wrong by this much, either way
SAFETY_ROUNDS = 4
WITHDRAW_MARGIN_MIN = 5  # a crew leaves this long before the fire reaches its ground
MIN_USEFUL_WORK_MIN = 10  # a crew that could work less than this before the fire arrives is not sent
HOUSE_ZONES_FOR_B = 10


@dataclass
class Evaluation:
    """What the engine says a plan does."""

    burned_ha: float
    buildings: int
    casualties: int
    exposures: list[dict[str, Any]] = field(default_factory=list)
    units: int = 0  # units the plan commits
    worst_ha: float | None = None  # burned area in the worse of the wrong-wind runs
    worst_without_ha: float | None = None  # the same wind with no response at all
    run_id: str = ""  # the what-if simulation this was read from: the fire as the plan leaves it (the next wave decides on it)

    def line(self) -> str:
        text = f"{self.burned_ha:.1f} ha ardidos · {self.buildings} edifícios · {self.casualties} baixas de equipas · {self.units} meios"
        if self.worst_ha is not None:
            text += f" · com o vento a ±{int(WIND_ERROR_DEG)}°: pior caso {self.worst_ha:.1f} ha"
            if self.worst_without_ha:
                text += f" (sem resposta {self.worst_without_ha:.0f} ha)"
        return text


@dataclass
class Alternatives:
    plan_a: dict[str, Any]
    plan_b: dict[str, Any]
    eval_a: Evaluation | None = None
    eval_b: Evaluation | None = None
    published: dict[str, str] = field(default_factory=dict)
    issues: list[str] = field(default_factory=list)
    trimmed: int = 0  # crews whose stay was cut short in B
    removed: int = 0  # crews B does not send at all
    cycle_a: CycleResult | None = None
    cycle_b: CycleResult | None = None
    waves_a: list[Any] = field(default_factory=list)  # what the agents added at each checkpoint (see adaptation.py)
    waves_b: list[Any] = field(default_factory=list)
    safety: dict[str, tuple[int, int]] = field(default_factory=dict)  # variant → (crews whose stay was cut short, crews not sent), to keep the plan at zero casualties
    unsafe: set[str] = field(default_factory=set)  # variants that could not be shown safe: never published


def evaluate(client: FiretraceClient, plan: dict[str, Any], baseline_id: str) -> Evaluation | None:
    """Publish ``plan``, run its what-if, read the result and delete the plan again. ``None`` if the what-if did not succeed."""
    started = time.monotonic()
    created = client.create_plan(plan)
    plan_id = str(created["id"])
    published_in = time.monotonic() - started
    try:
        run = client.simulate_plan(plan_id, baseline_simulation_id=baseline_id, wait_seconds=None)
        done = client.wait_for_simulation(str(run["id"]), timeout_seconds=300)
    finally:
        client.delete_plan(plan_id)
    log.info("evaluate: publish %.1f s, simulate+delete %.1f s (%d actions)", published_in, time.monotonic() - started - published_in, len(plan["actions"]))
    if done.get("status") != "succeeded":
        return None
    stats = done.get("stats") or {}
    exposures = list(done.get("crewExposures") or [])
    return Evaluation(float(stats.get("burnedHa") or 0.0), int(stats.get("buildingsAffected") or 0), int(stats.get("crewCasualties") or sum(int(e.get("casualties") or 0) for e in exposures)), exposures, run_id=str(done.get("id") or ""))


def committed_units(plan: dict[str, Any]) -> int:
    """How many distinct units the plan puts to work (vehicles and crews on foot, whichever organization)."""
    return len({str(r.get("resourceId")) for action in plan["actions"] for r in action.get("resources") or [] if r.get("resourceType") in ("vehicle", "personnel_pool")})


def robustness(client: FiretraceClient, snapshot: dict[str, Any], plan: dict[str, Any], without: dict[float, float]) -> tuple[float, float]:
    """The plan's effects on a fire pushed by a wrong wind: (burned ha in the worse of the two runs, ha of that same wind with no response).

    The agents plan on the forecast; the real wind may differ. Each run is the baseline scenario with the wind turned ``WIND_ERROR_DEG`` degrees either
    way and the plan's own effects applied. ``without`` caches the no-response areas by shift (they do not depend on the plan).
    """
    total = int(snapshot["durationMinutes"])
    effects = plan_effects(plan)
    worst, worst_shift = 0.0, 0.0
    for shift in (-WIND_ERROR_DEG, WIND_ERROR_DEG):
        if shift not in without:
            idle = client.run_scenario(scenario_at(snapshot, 0, total, perimeter=None, interventions=[], name=f"[lab] sem resposta {shift:+.0f}°", wind_shift_deg=shift), label=f"[lab] sem resposta {shift:+.0f}°")
            without[shift] = float((idle.get("stats") or {}).get("burnedHa") or 0.0)
        shifted = client.run_scenario(scenario_at(snapshot, 0, total, perimeter=None, interventions=effects, name=f"[lab] plano {shift:+.0f}°", wind_shift_deg=shift), label=f"[lab] plano {shift:+.0f}°")
        ha = float((shifted.get("stats") or {}).get("burnedHa") or 0.0)
        if ha >= worst:
            worst, worst_shift = ha, shift
    return worst, without.get(worst_shift, 0.0)


def set_stay(plan: dict[str, Any]) -> None:
    """Tell the backend how long each crew really stays (``expectedDurationMinutes``): the effect's own duration. Without it the backend assumes a short default
    window and counts casualties over that instead of over the time the crew is actually there."""
    for action in plan["actions"]:
        stays = [e.get("durationMinutes") for e in action.get("simulationEffects") or [] if e.get("type") == "crew_deployment" and e.get("durationMinutes")]
        if stays and "expectedDurationMinutes" not in action:
            action["expectedDurationMinutes"] = int(max(stays))


def withdraw(plan: dict[str, Any], exposures: list[dict[str, Any]], decided_at: int, *, remove_all: bool = False) -> tuple[int, int]:
    """Cut the stay of every exposed crew to end before the fire reaches it; drop the crews that would have no time to do anything.

    ``remove_all`` drops every exposed crew instead (the last resort once cutting their stay has not been enough).
    Returns (crews shortened, crews removed). The plan is changed in place; actions that waited for a removed one go with it.
    """
    caught = {str(e["actionId"]): e for e in exposures}
    shortened = removed = 0
    gone: set[str] = set()
    for action in plan["actions"]:
        exposure = caught.get(str(action["id"]))
        if exposure is None:
            continue
        trigger = action.get("trigger") or {}
        leaves = decided_at + (int((trigger.get("at") or {}).get("offsetMinutes") or 0) if trigger.get("kind") == "at_time" else 0)
        eta = max((float(r.get("etaMinutes") or 0.0) for r in action.get("resources") or []), default=0.0)
        stay = int(math.floor(float(exposure["firstMinute"]) - (leaves + eta) - WITHDRAW_MARGIN_MIN))
        if stay >= MIN_USEFUL_WORK_MIN and not remove_all:
            action["expectedDurationMinutes"] = stay
            for effect in action.get("simulationEffects") or []:
                if effect.get("type") == "crew_deployment":
                    effect["durationMinutes"] = stay
            shortened += 1
        else:
            gone.add(str(action["id"]))
            removed += 1
    if gone:
        drop_actions(plan, gone)
    return shortened, removed


def drop_actions(plan: dict[str, Any], ids: set[str]) -> int:
    """Remove actions from a plan, and with them every action that waited for one of them (it cannot start). Returns how many went."""
    gone = set(ids)
    changed = True
    while changed:
        changed = False
        for action in plan["actions"]:
            if str(action["id"]) not in gone and any(str(d) in gone for d in action.get("dependsOn") or []):
                gone.add(str(action["id"]))
                changed = True
    before = len(plan["actions"])
    plan["actions"] = [a for a in plan["actions"] if str(a["id"]) not in gone]
    return before - len(plan["actions"])


def prune_unreachable(client: FiretraceClient, plan: dict[str, Any], rounds: int = 3) -> int:
    """Take out the actions the backend's own validation says no vehicle can reach (``target_unreachable``: no road to the target with the vehicle's real limits).

    The agents route each unit before they plan, but the backend checks again with the whole vehicle and the closures active then; where the two disagree the
    plan would be refused. Dropping the action keeps the rest publishable. Returns how many actions were taken out.
    """
    removed = 0
    for _ in range(rounds):
        issues = client.validate_plan(plan).get("issues") or []
        bad = {str(i["actionId"]) for i in issues if i.get("severity") == "error" and i.get("code") == "target_unreachable" and i.get("actionId")}
        if not bad:
            break
        removed += drop_actions(plan, bad)
    return removed


def relabel(plan: dict[str, Any], variant: str, title: str, strategy: str, objectives: list[tuple[str, float]]) -> None:
    plan["variant"] = variant
    plan["title"] = title
    plan["strategy"] = strategy
    plan["objectives"] = [{"objective": name, "weight": weight} for name, weight in objectives]


def build_alternatives(
    orchestrator: OrchestratorAgent,
    client: FiretraceClient,
    simulation_id: str,
    *,
    publish: bool = True,
    house_zones: int = HOUSE_ZONES_FOR_B,
    replan_minutes: int | None = None,
    max_waves: int | None = None,
    **cycle: Any,
) -> Alternatives:
    """Plan A (maximum attack) and plan B (no casualties) for a baseline, each evaluated by the engine, then published.

    ``cycle`` is passed to ``OrchestratorAgent.run_cycle`` (``location_id``, ``at_minute``, ``horizon_minutes``, ``stage_minutes``...). After the first
    judgement the agents look at each plan's what-if every ``replan_minutes`` and add waves of actions where the fire is not under control (see ``adaptation.py``;
    0 turns it off, ``None`` is its default).
    """
    decided_at = int(cycle.get("at_minute") or 0)
    cycle_a = orchestrator.run_cycle(simulation_id, publish=False, building_zones=0, fuel_breaks=True, **cycle)
    cycle_b = orchestrator.run_cycle(simulation_id, publish=False, building_zones=house_zones, lean=True, **cycle)
    plan_a, plan_b = cycle_a.plan_a, cycle_b.plan_a  # the composition that sequences the evacuation first; the two cycles differ in what the engines do
    assert plan_a is not None and plan_b is not None
    out = Alternatives(plan_a, plan_b, cycle_a=cycle_a, cycle_b=cycle_b)

    relabel(plan_a, "A", "Plano A — ofensivo, todos os meios", "Ataque ao fogo com todos os meios que podem trabalhar em segurança: equipas no perímetro enquanto o fogo ainda se deixa atacar, apoio aéreo, e as equipas a pé que sobram a abrir faixas corta-fogo à frente do fogo (em terreno por queimar, a acabar antes de ele chegar). Zero baixas previstas, na previsão e com o vento errado em 30°.",
            [("minimize_burned_area", 1.0), ("protect_buildings", 0.6), ("protect_life", 0.4)])
    relabel(plan_b, "B", "Plano B — defensivo, só o necessário", "Só os meios que a frente tem espaço para usar (a reserva fica nos postos, pronta para reagir), equipas a sair antes de o fogo as apanhar e os autotanques livres a defender casas: poucos meios e mais área ardida se a previsão falhar. Zero baixas previstas, na previsão e com o vento errado em 30°.",
            [("protect_life", 1.0), ("protect_buildings", 0.8), ("minimize_burned_area", 0.5)])
    set_stay(plan_a)
    set_stay(plan_b)
    try:
        for variant, plan in (("A", plan_a), ("B", plan_b)):
            taken = prune_unreachable(client, plan)
            if taken:
                out.issues.append(f"plan {variant}: {taken} action(s) taken out because the backend finds no road to them")
    except ApiProblem as error:
        out.issues.append(f"could not check the plans' access [{error.code}]: {error}")

    # The safety rule (see judge.py): a plan is judged on the forecast and on a wrong wind, the crews caught are cut short or not sent, and a plan that still
    # predicts a casualty is not published.
    from .judge import Judge  # noqa: PLC0415 — judge builds on this module

    verdicts: dict[str, Any] = {}
    judge: Judge | None = None
    try:
        snapshot = (client.get_simulation(simulation_id).get("scenarioSnapshot")) or {}
        judge = Judge(client, simulation_id, snapshot)
        for variant, plan in (("A", plan_a), ("B", plan_b)):
            started = time.monotonic()
            verdict, shortened, removed = judge.make_safe(plan, decided_at)
            verdicts[variant] = verdict
            out.safety[variant] = (shortened, removed)
            log.info("baseline %s: plan %s judged in %.0f s: %s", simulation_id, variant, time.monotonic() - started,
                     f"{verdict.forecast.line()} · {verdict.casualties} baixas (previsão + vento errado)" if verdict else "no result")
    except ApiProblem as error:
        out.issues.append(f"could not judge the plans [{error.code}]: {error}")
        log.warning("baseline %s: %s", simulation_id, out.issues[-1])

    # the agents look at the fire again as it evolves under each plan and send whoever is free where it is not under control
    if replan_minutes != 0 and judge is not None and any(v is not None and v.casualties == 0 for v in verdicts.values()):
        from .adaptation import MAX_WAVES, REPLAN_MINUTES, adapt  # noqa: PLC0415 — adaptation builds on this module

        try:
            run_minutes = int(snapshot.get("durationMinutes") or 0)
            steps = {"replan_minutes": REPLAN_MINUTES if replan_minutes is None else replan_minutes, "max_waves": MAX_WAVES if max_waves is None else max_waves}
            for variant, plan, lean in (("A", plan_a, False), ("B", plan_b, True)):
                verdict = verdicts.get(variant)
                if verdict is None or verdict.casualties:
                    continue  # an unsafe plan is not extended
                adapted = adapt(orchestrator, client, simulation_id, plan, verdict, judge, decided_at=decided_at, run_minutes=run_minutes, lean=lean, house_zones=house_zones, **steps, **cycle)
                verdicts[variant] = adapted.verdict
                (out.waves_a if variant == "A" else out.waves_b).extend(adapted.waves)
        except ApiProblem as error:
            out.issues.append(f"could not re-plan along the fire [{error.code}]: {error}")
            log.warning("baseline %s: %s", simulation_id, out.issues[-1])

    for variant, plan in (("A", plan_a), ("B", plan_b)):
        verdict = verdicts.get(variant)
        if verdict is None:
            continue
        evaluation = verdict.forecast
        evaluation.units = committed_units(plan)
        evaluation.worst_ha = verdict.worst_ha
        evaluation.worst_without_ha = next(iter(verdict.idle_ha.values()), None)
        setattr(out, "eval_a" if variant == "A" else "eval_b", evaluation)
        if verdict.casualties:
            out.unsafe.add(variant)
            out.issues.append(f"plan {variant} not published: the engine still predicts {verdict.casualties} crew casualties (forecast and wrong wind), and a plan with casualties is never offered")
    for variant in ("A", "B"):
        if verdicts.get(variant) is None:
            out.unsafe.add(variant)
            out.issues.append(f"plan {variant} not published: the engine could not show it is safe")

    for plan, evaluation in ((plan_a, out.eval_a), (plan_b, out.eval_b)):
        if evaluation is not None:
            plan["summary"] = f"### Resultado simulado pelo motor\n- {evaluation.line()}\n\n" + plan.get("summary", "")
    for plan, waves in ((plan_a, out.waves_a), (plan_b, out.waves_b)):
        if waves:
            plan["summary"] = "### Adaptação ao longo do incêndio\n" + "\n".join(f"- {w.line()}" for w in waves) + "\n\n" + plan.get("summary", "")
    for variant, plan in (("A", plan_a), ("B", plan_b)):
        shortened, removed = out.safety.get(variant, (0, 0))
        if shortened or removed:
            plan["summary"] = (f"### Segurança das equipas (zero baixas, na previsão e com o vento a ±{int(WIND_ERROR_DEG)}°)\n- {shortened} equipas saem antes de o fogo chegar; "
                               f"{removed} não são enviadas (sem tempo útil antes do fogo).\n\n") + plan["summary"]
    if out.eval_a and out.eval_b:
        plan_a["summary"] = f"### A ou B?\n- A: {out.eval_a.line()}\n- B: {out.eval_b.line()}\n\n" + plan_a["summary"]
        plan_b["summary"] = f"### A ou B?\n- A: {out.eval_a.line()}\n- B: {out.eval_b.line()}\n\n" + plan_b["summary"]

    if publish:
        for variant, plan in (("A", plan_a), ("B", plan_b)):
            if variant in out.unsafe:
                continue
            validation = client.validate_plan(plan)
            if validation.get("valid") is False:
                out.issues.append(f"plan {variant} not published: the backend validation reports errors")
                continue
            out.published[variant] = str(client.create_plan(plan).get("id", ""))
    return out
