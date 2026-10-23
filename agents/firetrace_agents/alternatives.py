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

import copy
import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

from .campaign import plan_effects, scenario_at
from .client import ApiProblem, FiretraceClient
from .firestate import fire_state
from .orchestrator import AgentIssue, CycleResult, OrchestratorAgent

log = logging.getLogger("firetrace.alternatives")

WIND_ERROR_DEG = 30.0  # the forecast wind is wrong by this much, either way
CANDIDATE_PREFIX = "[lab] "  # title of a plan published only to be judged and deleted (the UI hides these)
SAFETY_ROUNDS = 6
WITHDRAW_MARGIN_MIN = 5  # a crew leaves this long before the fire reaches its ground
MIN_USEFUL_WORK_MIN = 10  # a crew that could work less than this before the fire arrives is not sent
HOUSE_ZONES_FOR_B = 10
HOUSE_ZONES_FOR_A = 4  # A defends the houses the fire reaches first and sends the rest of the engines at the fire
DEFENDERS_PER_ZONE_B = 5  # plan B puts more engines on each patch of houses (A: buildings.DEFENDERS_PER_ZONE = 3)
RESERVE_SHARE_B = 0.25  # B keeps a quarter of its combat units at their stations, ready for the re-plans
CANDIDATES = 2  # candidates judged per plan before the best is kept (1 = the first, unjudged choice)
ALT_CONCENTRATION = 3  # the second candidate spends the barrier metres on fewer, stronger stretches


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
    fire: Any = None  # how the run ends (``firestate.FireState``): when the fire went out, if it did

    def line(self) -> str:
        text = f"{self.burned_ha:.1f} ha ardidos · {self.buildings} edifícios · {self.casualties} baixas de equipas · {self.units} meios"
        if self.fire is not None:
            text += f" · {self.fire.line()}"
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


def central_engine(snapshot: dict[str, Any]) -> dict[str, Any]:
    """The baseline's engine options with the ensemble cut to the central run (``members: 0``), for runs of which only ``stats`` and ``crewExposures`` are read.

    ``PlanSimulationRequest.engine`` replaces the baseline's options as a whole, so spotting, seed and the rest of the ensemble spec are carried over unchanged.
    The central run does not depend on how many members follow it, so those two figures are identical (checked on published plans); what a one-member run
    cannot give is the ensemble's probabilities (``/threatened``, ``/impact``...): never use it for a run the next decision is read from.
    """
    engine = copy.deepcopy(snapshot.get("engine") or {})
    ensemble = dict(engine.get("ensemble") or (snapshot.get("weather") or {}).get("ensemble") or {})
    ensemble["members"] = 0
    engine["ensemble"] = ensemble
    return engine


def evaluate(client: FiretraceClient, plan: dict[str, Any], baseline_id: str, engine: dict[str, Any] | None = None) -> Evaluation | None:
    """Publish ``plan``, run its what-if, read the result and delete the plan again. ``None`` if the what-if did not succeed.

    ``engine`` (see :func:`central_engine`) overrides the baseline's engine options for this run.

    The candidate is titled ``[lab] …`` (the repo's mark for throwaway objects): it lives a few seconds, and the UI must not offer it to the operator as a plan.
    """
    started = time.monotonic()
    title = str(plan.get("title") or "")
    # The candidate is created only to be simulated and deleted: without `basis.simulationId` the backend skips the smoke and crew-exposure warnings it
    # computes on the baseline (~30 s of a ~38 s create, measured on Penha) — the what-if below counts the crews the fire reaches itself, and gives the
    # same result (measured: identical area, buildings and casualties). The published plan keeps its basis and gets the full validation.
    created = client.create_plan({**plan, "title": title if title.startswith(CANDIDATE_PREFIX) else f"{CANDIDATE_PREFIX}{title}",
                                  "basis": {k: v for k, v in (plan.get("basis") or {}).items() if k != "simulationId"}})
    plan_id = str(created["id"])
    published_in = time.monotonic() - started
    try:
        run = client.simulate_plan(plan_id, baseline_simulation_id=baseline_id, wait_seconds=None, engine=engine)
        done = client.wait_for_simulation(str(run["id"]), timeout_seconds=300)
    finally:
        client.delete_plan(plan_id)
    log.info("evaluate: publish %.1f s, simulate+delete %.1f s (%d actions)", published_in, time.monotonic() - started - published_in, len(plan["actions"]))
    if done.get("status") != "succeeded":
        return None
    stats = done.get("stats") or {}
    exposures = list(done.get("crewExposures") or [])
    return Evaluation(float(stats.get("burnedHa") or 0.0), int(stats.get("buildingsAffected") or 0), int(stats.get("crewCasualties") or sum(int(e.get("casualties") or 0) for e in exposures)), exposures, run_id=str(done.get("id") or ""))


def _lives_cost(result: CycleResult) -> tuple[int, int]:
    """What the plan's evacuation decisions cost in the agents' lives model (``life.py``): people left in the fire's way, then people told to shelter in place because
    there were no responders to evacuate them in time. Lower is better; ``(0, 0)`` when nobody is at risk."""
    if not result.life:
        return (0, 0)
    report = result.life.report
    return (report.exposed, report.sheltered)


def _llm_outcome(advisor: Any, tried: list[tuple[bool, tuple[Any, ...], str | None, CycleResult]], winner: CycleResult) -> dict[str, Any]:
    """What to tell the operator about the LLM commander's candidate: what it decided (and what was thrown away), the engine's numbers for it and for the rules' plan,
    and which one is the plan. ``summary`` is prose for the plan, ``metadata`` the same facts for programs (``metadata["agents.llm"]``)."""
    llm = next(((score, line, result) for used, score, line, result in tried if used), None)
    rules = next(((score, line, result) for used, score, line, result in tried if not used), None)
    advice = llm[2].advice if llm is not None else None
    chosen = llm is not None and llm[2] is winner
    stats = advisor.stats() if hasattr(advisor, "stats") else {}
    metadata: dict[str, Any] = {
        "evaluated": llm is not None, "chosen": chosen, "applied": list(advice.applied) if advice else [], "discarded": list(advice.discarded)[:12] if advice else [],
        "comparison": {"llm": llm[1] if llm else None, "rules": rules[1] if rules else None}, **stats,
    }
    lines = ["### Comando LLM (Bombeiros, Proteção Civil, GNR, INEM)"]
    if llm is None:
        lines.append("- O comando LLM não chegou a propor um plano.")
    else:
        tied = llm[0] == (rules[0] if rules else None)
        if chosen:
            verdict_line = ("o motor mediu os dois planos e deu o mesmo resultado (não mede cortes, evacuações, abrigos nem a prevenção do INEM): ficou o do comando, que não deixa mais pessoas expostas nem abrigadas em vez de evacuadas."
                            if tied else "o motor avaliou os dois e ficou com o do comando (melhor).")
        else:
            verdict_line = "o motor avaliou os dois e ficou com o das regras (o do comando foi pior onde o motor consegue medir)."
        lines.append(f"- Este plano é {'**o do comando LLM**' if chosen else 'o das regras'}: {verdict_line}")
        lines.append(f"- Comando LLM: {llm[1] or 'sem avaliação'}")
        lines.append(f"- Regras: {rules[1] if rules and rules[1] else 'sem avaliação'}")
        if advice and advice.applied:
            lines.extend(f"- Decisão do comando: {a}" for a in advice.applied)
        if advice and advice.discarded:
            lines.append(f"- Escolhas do comando que foram descartadas por regra ({len(advice.discarded)}): " + "; ".join(advice.discarded[:3]))
        for note in [n for n in (advice.notes if advice else []) if n["agent"] != "Comando"][:8]:  # the commander's note is printed once, below
            lines.append(f"- **{note['agent']}**: {note['text']}")
        if advice and advice.review:
            lines.append(f"- **Nota do comandante**: {advice.review}")
    return {"metadata": metadata, "summary": "\n".join(lines) + "\n\n"}


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
            # the crew's work may be several stretches (refills, rest: `duty.py`): the ones after it leaves go, the one it leaves in is cut short
            ends = leaves + eta + stay
            kept: list[dict[str, Any]] = []
            for effect in action.get("simulationEffects") or []:
                start = (effect.get("start") or {}).get("offsetMinutes")
                if effect.get("type") != "crew_deployment" or start is None:
                    kept.append(effect)
                elif float(start) < ends:
                    effect["durationMinutes"] = max(1, int(min(float(effect.get("durationMinutes") or stay), ends - float(start))))
                    kept.append(effect)
            action["simulationEffects"] = kept
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


def agent_metrics(cycle: CycleResult, plan: dict[str, Any], evaluation: Evaluation | None, safety: tuple[int, int]) -> dict[str, Any]:
    """What each organization's agents did in a plan, for the operator: the numbers the engine does not give (it does not count evacuated people, for one).

    Stored in the plan's ``metadata["agents.metrics"]`` (the contract's free extension space) and written at the top of its summary. People come from the
    agents' own life model (``life.py``), not from the backend.
    """
    actions = plan["actions"]
    report = cycle.life.report if cycle.life else None
    closures = len(cycle.traffic.closures) if cycle.traffic else 0
    uncovered = sum(1 for issue in (cycle.traffic.issues if cycle.traffic else []) if "fica aberto" in issue or "not closed" in issue)
    standby = [r for a in actions if a.get("type") == "medical_standby" for r in a.get("resources") or []]
    transports = [r for a in actions if a.get("type") == "evacuation" for r in a.get("resources") or [] if r.get("responsibility") == "evacuation" and r.get("resourceType") == "vehicle"]
    fire = evaluation.fire if evaluation is not None else None
    return {
        "people": {
            "atRisk": report.people_at_risk if report else 0, "evacuatedInTime": report.evacuated_in_time if report else 0,
            "sheltered": report.sheltered if report else 0, "exposed": report.exposed if report else 0,
            "vulnerableAtRisk": report.vulnerable_at_risk if report else 0, "vulnerableEvacuated": report.vulnerable_evacuated if report else 0,
            "source": "agents life model (the backend does not count evacuations)",
        },
        "civilProtection": {"evacuations": sum(1 for a in actions if a.get("type") == "evacuation"), "withShelter": sum(1 for a in actions if a.get("type") == "evacuation" and a.get("shelters")),
                            "transports": len(transports), "publicAlerts": sum(1 for a in actions if a.get("type") == "public_alert"),
                            "commandPost": any(a.get("type") == "establish_command_post" for a in actions)},
        "gnr": {"roadsClosed": closures, "roadsWithoutPatrol": uncovered, "patrols": sum(1 for a in actions if a.get("type") == "traffic_control_point")},
        "inem": {"ambulancesOnStandby": len(standby), "hospitalsAlerted": sum(len(a.get("hospitalIds") or []) for a in actions if a.get("type") == "medical_standby")},
        "units": {"committed": committed_units(plan), "forwardReserve": len(cycle.held), "noSafeSpot": len(cycle.unsafe_units),
                  "safetyShortened": safety[0], "safetyRemoved": safety[1]},
        "fire": {"outAtMinute": fire.out_at if fire else None, "finalGrowthHaPerHour": fire.final_growth_ha_h if fire else None},
    }


def metrics_text(m: dict[str, Any]) -> str:
    people, pc, gnr, inem, units, fire = m["people"], m["civilProtection"], m["gnr"], m["inem"], m["units"], m["fire"]
    out = "fogo extinto às T+%d min" % fire["outAtMinute"] if fire.get("outAtMinute") is not None else "fogo ainda ativo no fim da simulação"
    return (
        "### Métricas dos agentes\n"
        f"- Fogo: {out}.\n"
        f"- Pessoas (modelo dos agentes): {people['atRisk']} em risco, {people['evacuatedInTime']} evacuadas a tempo, {people['sheltered']} abrigadas no local, {people['exposed']} expostas"
        f" ({people['vulnerableEvacuated']} de {people['vulnerableAtRisk']} vulneráveis evacuadas).\n"
        f"- Proteção Civil: {pc['evacuations']} evacuações ({pc['withShelter']} com abrigo e rota), {pc['transports']} transportes, {pc['publicAlerts']} avisos à população"
        f"{', posto de comando' if pc['commandPost'] else ''}.\n"
        f"- GNR: cerco à zona do incêndio, {gnr['roadsClosed']} acessos fechados, cada um com a sua patrulha ({gnr['patrols']} patrulhas); {gnr['roadsWithoutPatrol']} acessos ficam abertos por falta de patrulha a tempo.\n"
        f"- INEM: {inem['ambulancesOnStandby']} ambulâncias de prevenção, {inem['hospitalsAlerted']} hospitais de pré-aviso.\n"
        f"- Meios: {units['committed']} no terreno, {units['forwardReserve']} em reserva avançada, {units['noSafeSpot']} sem posição segura (não enviados); "
        f"segurança: {units['safetyShortened']} saem mais cedo, {units['safetyRemoved']} retirados.\n\n"
    )


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
    candidates: int = CANDIDATES,
    commander: Any = None,
    progress: Callable[[str, float, str], None] | None = None,
    plan_metadata: dict[str, Any] | None = None,
    **cycle: Any,
) -> Alternatives:
    """Plan A (maximum attack) and plan B (no casualties) for a baseline, each evaluated by the engine, then published.

    ``cycle`` is passed to ``OrchestratorAgent.run_cycle`` (``location_id``, ``at_minute``, ``horizon_minutes``, ``stage_minutes``...). After the first
    judgement the agents look at each plan's what-if every ``replan_minutes`` and add waves of actions where the fire is not under control (see ``adaptation.py``;
    0 turns it off, ``None`` is its default). ``progress(phase, percent, message)`` hears each step (an operator's request follows it in the UI);
    ``plan_metadata`` is added to the metadata of both plans.
    """
    report = progress or (lambda _phase, _percent, _message: None)
    decided_at = int(cycle.get("at_minute") or 0)
    # The safety rule (see judge.py): a plan is judged on the forecast and on a wrong wind, the crews caught are cut short or not sent, and a plan that still
    # predicts a casualty is not published.
    from .holding import HOLD_MARGIN_MIN, HoldingClock, drop_unreachable_holds, hold_idle_units  # noqa: PLC0415 — holding builds on adaptation, which builds on this module
    from .judge import Judge  # noqa: PLC0415 — judge builds on this module

    issues: list[str] = []
    judge: Judge | None = None
    snapshot: dict[str, Any] = {}
    try:
        snapshot = (client.get_simulation(simulation_id).get("scenarioSnapshot")) or {}
        judge = Judge(client, simulation_id, snapshot)
    except ApiProblem as error:
        issues.append(f"could not judge the plans [{error.code}]: {error}")

    # Both put lives first (crews and the people evacuated), then houses, then the burned area; they differ in how: A attacks the fire with everything that
    # can work safely and defends only the houses the fire reaches first, B defends people and houses first, attacks only where it is safe and keeps a reserve when the fire must be contained (never while it can still be put out).
    # Each is the best of a few candidates (how the barrier metres are spread, how many houses are defended), judged by the engine in that same order.
    # The LLM commander (when configured, see commander/): it reads the environment, retrieves the tactics that fit it and chooses the strategy of
    # each plan; its choice replaces the candidates below. Without it, or when it fails, the rules choose (the decision says which).
    decision = None
    if commander is not None:
        try:
            from .commander import build_brief  # noqa: PLC0415 — only needed with a commander

            brief = build_brief(orchestrator, client, simulation_id, location_id=str(cycle.get("location_id") or "guimaraes-concelho"), at_minute=decided_at,
                                horizon_minutes=int(cycle.get("horizon_minutes") or 60))
            decision = commander.decide(brief, house_zones_b=house_zones, concentration=cycle.get("concentration"))
            log.info("baseline %s: strategy chosen by %s%s", simulation_id, decision.source, f" ({decision.error})" if decision.error else "")
        except ApiProblem as error:
            issues.append(f"commander could not read the environment [{error.code}]: {error}")
    options = {
        "A": [{"building_zones": HOUSE_ZONES_FOR_A, "fuel_breaks": True}, {"building_zones": HOUSE_ZONES_FOR_A, "fuel_breaks": True, "concentration": ALT_CONCENTRATION}],
        # B's aircraft are timed with its crews too: on Penha that alone takes B from 176 ha to 8.6 ha (A: 9 ha)
        # B defends every patch of houses the fire reaches in the whole run, with more engines on each: it saves houses, A saves area
        "B": [{"building_zones": house_zones, "lean": True, "air_support": True, "reserve_share": RESERVE_SHARE_B, "defend_whole_run": True, "defenders_per_zone": DEFENDERS_PER_ZONE_B},
              {"building_zones": house_zones + 6, "lean": True, "air_support": True, "reserve_share": RESERVE_SHARE_B, "defend_whole_run": True, "defenders_per_zone": DEFENDERS_PER_ZONE_B}],
    }
    if decision is not None:
        options = {variant: [decision.plans[variant].cycle_kwargs()] for variant in ("A", "B")}
    chosen: dict[str, tuple[CycleResult, dict[str, Any], Any, int, int]] = {}
    # An LLM commander (``advisor.py``, ``llm/``) makes one more candidate, on top of the rules': the same plan as the first, with its choices where it has them. The
    # engine judges them all the same way and the best ships; a tie goes to the rules (they come first), so the LLM plan has to be better, not just different.
    advising = orchestrator.advisor.name != "rules"
    llm_outcome: dict[str, dict[str, Any]] = {}
    for variant, choices in options.items():
        report("composing", 10 if variant == "A" else 25, f"A compor o plano {variant} ({'ofensivo' if variant == 'A' else 'defensivo'})")
        if advising:
            choices = [choices[0], {**choices[0], "use_advisor": True}, *choices[1:]]
        wanted = max(1, candidates) + (1 if advising else 0)
        tried: list[tuple[bool, tuple[Any, ...], str | None, CycleResult]] = []
        best: tuple[tuple[Any, ...], CycleResult, dict[str, Any], Any, int, int] | None = None
        for overrides in choices[:wanted]:
            result = orchestrator.run_cycle(simulation_id, publish=False, validate=False, **{**cycle, **overrides})
            plan = result.plan_a  # the composition that sequences the evacuation first
            assert plan is not None
            set_stay(plan)
            try:
                taken = prune_unreachable(client, plan)
                if taken:
                    result.issues.append(AgentIssue("orchestrator", plan.get("title", ""), f"{taken} action(s) taken out because the backend finds no road to them"))
                verdict, shortened, removed = judge.make_safe(plan, decided_at, wrong_wind=False) if judge is not None and min(len(choices), wanted) > 1 else (None, 0, 0)
            except ApiProblem as error:
                issues.append(f"plan {variant}: could not judge a candidate [{error.code}]: {error}")
                verdict, shortened, removed = None, 0, 0
            # lives (no casualty), then houses, then a fire put out (the sooner the better), then burned area: the priorities, in that order
            state = fire_state(client, verdict.forecast.run_id) if verdict is not None else None
            out_at = state.out_at if state is not None and state.out_at is not None else math.inf
            score = (verdict is None, verdict.casualties if verdict else 0, verdict.forecast.buildings if verdict else 0, out_at, verdict.forecast.burned_ha if verdict else 0.0)
            if verdict is not None:
                verdict.forecast.units = committed_units(plan)  # so the line that compares the candidates says how many units each commits
            tried.append((bool(overrides.get("use_advisor")), score, verdict.forecast.line() if verdict is not None else None, result))
            # The engine judges what burns, not what a closure, a shelter or an ambulance's spot is worth: those decisions only reach a plan if the commander's candidate is
            # at least as good where the engine can tell (a tie goes to the commander) and does not leave more people exposed or sheltering instead of evacuated (``life.py``).
            tie_to_commander = bool(overrides.get("use_advisor")) and best is not None and score == best[0] and _lives_cost(result) <= _lives_cost(best[1])
            if best is None or score < best[0] or tie_to_commander:
                best = (score, result, plan, verdict, shortened, removed)
        assert best is not None
        chosen[variant] = best[1:]
        if len(choices) > 1 and wanted > 1 and best[3] is not None:
            log.info("baseline %s: plan %s: best of %d candidates: %s", simulation_id, variant, min(len(choices), wanted), best[3].forecast.line())
        if advising:
            llm_outcome[variant] = _llm_outcome(orchestrator.advisor, tried, best[1])

    cycle_a, plan_a = chosen["A"][0], chosen["A"][1]
    cycle_b, plan_b = chosen["B"][0], chosen["B"][1]
    out = Alternatives(plan_a, plan_b, cycle_a=cycle_a, cycle_b=cycle_b, issues=issues)

    relabel(plan_a, "A", "Plano A — ofensivo: parar o fogo", "Prioridades: 1.º vidas (equipas e população), 2.º casas, 3.º área ardida. Evacua quem está no caminho, defende as casas que o fogo atinge primeiro e ataca o fogo com todos os meios que podem trabalhar em segurança: equipas a partir do lado já ardido do perímetro, à medida que chegam, apoio aéreo e faixas corta-fogo à frente do fogo onde há tempo para as abrir. Zero baixas previstas, na previsão e com o vento errado em 30°.",
            [("protect_life", 1.0), ("protect_buildings", 0.7), ("minimize_burned_area", 0.6)])
    relabel(plan_b, "B", "Plano B — defensivo: proteger pessoas e casas", "Prioridades: 1.º vidas (equipas e população), 2.º casas, 3.º área ardida. Evacua e defende as povoações e as casas no caminho do fogo e ataca onde o perímetro deixa trabalhar com segurança. Enquanto o fogo se pode apagar, todos os meios que chegam a tempo atacam; se é forte demais e tem de ser contido, guarda um quarto dos meios em reserva avançada, para as reavaliações. Mais casas defendidas que o A e apoio aéreo coordenado com as equipas, sem faixas corta-fogo. Zero baixas previstas, na previsão e com o vento errado em 30°.",
            [("protect_life", 1.0), ("protect_buildings", 0.9), ("minimize_burned_area", 0.3)])
    if decision is not None and decision.source == "llm":  # the commander's own words for what each plan does and why
        for variant, plan in (("A", plan_a), ("B", plan_b)):
            chosen_plan = decision.plans[variant]
            plan["strategy"] = f"Prioridades: 1.º vidas (equipas e população), 2.º casas, 3.º área ardida. {chosen_plan.rationale}".strip()

    verdicts: dict[str, Any] = {}
    report("judging", 40, "O motor avalia a segurança das equipas nos dois planos (previsão e vento errado)")
    if judge is not None:
        def judge_variant(variant: str, plan: dict[str, Any]) -> tuple[Any, int, int, float]:
            started = time.monotonic()
            verdict, shortened, removed = judge.make_safe(plan, decided_at)  # the forecast again (cached if the plan has not changed) and the wrong wind
            return verdict, shortened, removed, time.monotonic() - started

        # A and B are independent plans judged by the same engine: asked together, the publishing, polling and deleting of one overlap the other's
        with ThreadPoolExecutor(max_workers=2) as pool:
            judging = {variant: pool.submit(judge_variant, variant, plan) for variant, plan in (("A", plan_a), ("B", plan_b))}
        for variant, future in judging.items():
            _result, _plan, _verdict, cut_before, gone_before = chosen[variant]
            try:
                verdict, shortened, removed, seconds = future.result()
                verdicts[variant] = verdict
                out.safety[variant] = (cut_before + shortened, gone_before + removed)
                log.info("baseline %s: plan %s judged in %.0f s: %s", simulation_id, variant, seconds,
                         f"{verdict.forecast.line()} · {verdict.casualties} baixas (previsão + vento errado)" if verdict else "no result")
            except ApiProblem as error:
                out.issues.append(f"could not judge plan {variant} [{error.code}]: {error}")
                log.warning("baseline %s: %s", simulation_id, out.issues[-1])

    # the agents look at the fire again as it evolves under each plan and send whoever is free where it is not under control
    if replan_minutes != 0 and judge is not None and any(v is not None and v.casualties == 0 for v in verdicts.values()):
        from .adaptation import MAX_WAVES, REPLAN_MINUTES, adapt  # noqa: PLC0415 — adaptation builds on this module

        report("adapting", 55, "Reavaliações ao longo do incêndio: enviar meios livres onde o fogo não está dominado")
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
        evaluation.fire = fire_state(client, evaluation.run_id) if evaluation.run_id else None
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

    # a unit that has finished its job holds where it is (ready, on a safe spot) instead of driving home hours before the run ends (see holding.py)
    run_end = int(snapshot.get("durationMinutes") or 0)
    location = str(cycle.get("location_id") or snapshot.get("locationId") or "guimaraes-concelho")
    ground = {str(a.observation.vehicle_id or a.agent_id): a for a in orchestrator.agents if a.tier.value in ("truck", "squad")}
    margin = float((((orchestrator._load_rules() or {}).get("safety") or {}).get("withdrawWhenFireArrivesInMinutes")) or HOLD_MARGIN_MIN)
    for variant, plan in (("A", plan_a), ("B", plan_b)):
        if variant not in out.unsafe:
            # the holds come after the judge, so they are held to its standard: a unit holds only where none of the fires the plan was judged on comes
            # (its own forecast what-if and the wrong-wind ones; a holding crew does no suppression, so these are the fires it would face)
            verdict = verdicts.get(variant)
            runs = [e.run_id for e in ((verdict.forecast, *verdict.shifted) if verdict is not None else ())]
            clocks = [orchestrator.fire_clock(run_id, location)[0] if run_id else None for run_id in runs]
            if len(runs) < 3:  # a wrong-wind run that did not succeed: the baseline's no-response fire stands in for it (it only burns more)
                clocks.append(orchestrator.fire_clock(simulation_id, location)[0])
            reasons: dict[str, int] = {}
            clock = HoldingClock([c for c in clocks if c is not None], margin) if clocks and all(c is not None for c in clocks) else None
            holding = hold_idle_units(plan, clock, run_end, ground, reasons, orchestrator.unit_routes)
            log.info("baseline %s: plan %s: %d units hold in the field after their job instead of going home (not held: %s; %d ground units known)", simulation_id, variant, holding, reasons or "-", len(ground))

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
    for variant, plan, result, evaluation in (("A", plan_a, cycle_a, out.eval_a), ("B", plan_b, cycle_b, out.eval_b)):
        metrics = agent_metrics(result, plan, evaluation, out.safety.get(variant, (0, 0)))
        plan["metadata"] = {**(plan.get("metadata") or {}), **(plan_metadata or {}), "agents.metrics": metrics}
        plan["summary"] = metrics_text(metrics) + plan.get("summary", "")
        plan["summary"] = f"### Avaliação do incêndio\n- {result.assessment(orchestrator._load_rules())}\n\n" + plan["summary"]  # noqa: SLF001 — the rules the cycle used
    for variant, plan in (("A", plan_a), ("B", plan_b)):  # the LLM commander: what it decided, and how the engine judged it against the rules
        if (outcome := llm_outcome.get(variant)) is not None:
            plan["metadata"] = {**(plan.get("metadata") or {}), "agents.llm": outcome["metadata"]}
            plan["summary"] = outcome["summary"] + plan["summary"]
    if decision is not None:
        for variant, plan in (("A", plan_a), ("B", plan_b)):
            plan["metadata"] = {**(plan.get("metadata") or {}), "agents.commander": decision.metadata(variant)}
            plan["summary"] = decision.summary(variant) + plan["summary"]
    if out.eval_a and out.eval_b:
        plan_a["summary"] = f"### A ou B?\n- A: {out.eval_a.line()}\n- B: {out.eval_b.line()}\n\n" + plan_a["summary"]
        plan_b["summary"] = f"### A ou B?\n- A: {out.eval_a.line()}\n- B: {out.eval_b.line()}\n\n" + plan_b["summary"]

    if publish:
        report("publishing", 75, "A validar e publicar os planos no backend")
        for variant, plan in (("A", plan_a), ("B", plan_b)):
            if variant in out.unsafe:
                continue
            validation = client.validate_plan(plan)
            if validation.get("valid") is False and (dropped := drop_unreachable_holds(plan, validation)):
                log.info("baseline %s: plan %s: %d holding actions dropped (their unit cannot drive to the waiting spot)", simulation_id, variant, dropped)
                validation = client.validate_plan(plan)
            if validation.get("valid") is False:
                out.issues.append(f"plan {variant} not published: the backend validation reports errors")
                continue
            out.published[variant] = str(client.create_plan(plan).get("id", ""))
    return out
