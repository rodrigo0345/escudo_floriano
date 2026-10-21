"""The agents re-plan as the fire evolves: a plan is not one decision at minute 0, it is a chain of them.

A plan is judged by its what-if run, which is a whole simulation of the fire *with* the plan applied. That run is the situation a commander would be
looking at some time later, so the agents look at it at each checkpoint (``REPLAN_MINUTES``) and ask:

* **Is the fire under control?** If what is left to burn after the checkpoint is small (``CONTAINED_HA``, or ``CONTAINED_FRACTION`` of the final area), the
  plan holds and nothing is added.
* **If not, who is free?** Units the plan has not committed (the reserve, the ones that could not reach the fire in time and wait at a staging point), units
  whose work has ended and units still on the road (they have not started: their orders can change, see ``redirectable``). They decide again on the what-if
  run as it is at that minute: the same agents, with the fire as the plan left it (a fire that direct attack has beaten back is attacked again where it now
  burns, and a fire that went past it is blocked ahead or has its houses defended).
* **Did it help, and is it safe?** Every new wave is judged by the engine on the whole plan (``judge.py``: forecast and wrong wind, crews kept clear of the
  fire). A strategy that gains nothing, or that costs a crew casualty, is dropped and the other one is tried (attack the fire, then defend what is in its
  way); a wave that gains nothing stays out of the plan, so the plan never gets worse by adapting.

Each wave's actions start at the checkpoint (``trigger`` ``at_time`` and the effects' ``start``): the plan says what happens when.
"""
from __future__ import annotations

import copy
import logging
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator

from .alternatives import committed_units, drop_actions, prune_unreachable, set_stay
from .client import ApiProblem, FiretraceClient
from .judge import Judge, Verdict
from .orchestrator import OrchestratorAgent

log = logging.getLogger("firetrace.adaptation")

REPLAN_MINUTES = 45  # how often the agents look at the fire again
MAX_WAVES = 3
CONTAINED_HA = 3.0  # what the fire may still burn after a checkpoint and the plan count as holding...
CONTAINED_FRACTION = 0.1  # ...or this share of the final area, whichever is more
MIN_GAIN = 0.02  # a wave stays in the plan only if it takes at least this share (or MIN_GAIN_HA) off the burned area
MIN_GAIN_HA = 0.5
MIN_MINUTES_BEFORE_END = 30  # a wave at the very end of the run would have nothing left to change
STRATEGIES = ("atacar o fogo", "defender o que está no caminho")  # tried in this order; the second puts the engines on the houses in the fire's way


@dataclass
class Wave:
    """What the agents did at one checkpoint (and why), for the plan's summary and the logs."""

    minute: int
    outcome: str  # contained | no_free_units | no_actions | kept | rejected | failed
    note: str
    strategy: str = ""
    units: int = 0
    before_ha: float | None = None
    after_ha: float | None = None

    def line(self) -> str:
        head = f"T+{self.minute}: "
        if self.outcome == "kept":
            return head + f"{self.units} meios ({self.strategy}): {self.before_ha:.1f} → {self.after_ha:.1f} ha. {self.note}"
        return head + self.note


@dataclass
class Adapted:
    plan: dict[str, Any]
    verdict: Verdict | None
    waves: list[Wave] = field(default_factory=list)


def _start_minute(action: dict[str, Any]) -> float:
    """Minute an action's first effect starts (the unit is on the spot): ``inf`` when no effect says."""
    starts = [float((e.get("start") or {}).get("offsetMinutes")) for e in action.get("simulationEffects") or [] if (e.get("start") or {}).get("offsetMinutes") is not None]
    return min(starts) if starts else float("inf")


def _end_minute(action: dict[str, Any], run_minutes: int) -> float:
    """Minute an action's units stop being busy: the end of its longest effect; a unit waiting at a staging point is free; with no stated end, busy for the rest of the run."""
    if action.get("type") == "stage_resources":
        return 0.0
    ends: list[float] = []
    for effect in action.get("simulationEffects") or []:
        start = (effect.get("start") or {}).get("offsetMinutes")
        length = effect.get("durationMinutes") or effect.get("effectDurationMinutes")
        if start is not None and length:
            ends.append(float(start) + float(length))
    return max(ends) if ends else float(run_minutes)


def engaged_until(plan: dict[str, Any], run_minutes: int, minute: int) -> dict[str, float]:
    """Unit → minute it is free again, for every unit the plan commits.

    A unit still on the road at ``minute`` (its action starts later: it has not begun to work) is free to be sent elsewhere: a commander redirects a crew
    that has not arrived. Only the units with a single action are redirected, and the action they leave is taken out of the plan.
    """
    busy: dict[str, float] = {}
    for action in plan["actions"]:
        end = _end_minute(action, run_minutes)
        for resource in action.get("resources") or []:
            unit = str(resource.get("resourceId"))
            busy[unit] = max(busy.get(unit, 0.0), end)
    return busy


def redirectable(plan: dict[str, Any], minute: int) -> dict[str, list[str]]:
    """Units still on the road at ``minute`` → ids of the action(s) they would leave: only fire attacks whose effect has not started and that the unit alone holds."""
    waiting: dict[str, list[str]] = {}
    sole: dict[str, int] = {}
    for action in plan["actions"]:
        for resource in action.get("resources") or []:
            sole[str(resource.get("resourceId"))] = sole.get(str(resource.get("resourceId")), 0) + 1
    for action in plan["actions"]:
        if action.get("type") != "fire_attack" or _start_minute(action) <= minute or len(action.get("resources") or []) != 1:
            continue
        unit = str(action["resources"][0].get("resourceId"))
        if sole.get(unit) == 1:
            waiting.setdefault(unit, []).append(str(action["id"]))
    return waiting


def _unburned_after(client: FiretraceClient, run_id: str, minute: int) -> tuple[float, float] | None:
    """(area burned at ``minute``, final area) of a run, in hectares."""
    try:
        summary = client.get_summary(run_id, step_minutes=15)
    except ApiProblem:
        return None
    milestones = [m for m in summary.get("milestones") or [] if m.get("tMin") is not None]
    if not milestones:
        return None
    at = [m for m in milestones if m["tMin"] <= minute]
    final = summary.get("final") or milestones[-1]
    return float((at[-1] if at else milestones[0]).get("areaHa") or 0.0), float(final.get("areaHa") or 0.0)


@contextmanager
def only(orchestrator: OrchestratorAgent, unit_ids: set[str]) -> Iterator[None]:
    """The orchestrator plans with these units alone (the others are busy)."""
    everyone = orchestrator._registry  # noqa: SLF001 — the team is swapped and put back
    subset = type(everyone)()
    for agent in everyone.all():
        if agent.agent_id in unit_ids:
            subset.register(agent)
    orchestrator._registry = subset  # noqa: SLF001
    try:
        yield
    finally:
        orchestrator._registry = everyone  # noqa: SLF001


def merge_wave(plan: dict[str, Any], wave_plan: dict[str, Any], minute: int, decided_at: int, leaving: dict[str, list[str]] | None = None) -> tuple[int, set[str]]:
    """Add the wave's actions to ``plan`` (ids prefixed with the minute, triggered at that minute). Returns (actions added, units they commit).

    ``leaving`` is the redirectable units → the actions they leave; those actions go out of the plan when the unit is given a new one.
    """
    prefix = f"w{minute}-"
    have = {(a.get("type"), a.get("title")) for a in plan["actions"]}
    new = [a for a in copy.deepcopy(wave_plan["actions"]) if a.get("type") in ("fire_attack", "stage_resources", "dispatch_units", "air_support_request", "structure_protection") or (a.get("type"), a.get("title")) not in have]
    ids = {str(a["id"]) for a in new}
    for action in new:
        action["id"] = prefix + str(action["id"])
        action["title"] = f"[T+{minute}] {action.get('title', '')}"
        if action.get("dependsOn"):
            action["dependsOn"] = [prefix + str(d) for d in action["dependsOn"] if str(d) in ids]
            if not action["dependsOn"]:
                del action["dependsOn"]
        trigger = action.get("trigger")
        if trigger and trigger.get("kind") == "on_action_complete":
            if str(trigger.get("actionId")) in ids:
                action["trigger"] = {**trigger, "actionId": prefix + str(trigger["actionId"])}
            else:
                del action["trigger"]
        if "trigger" not in action:
            action["trigger"] = {"kind": "at_time", "at": {"offsetMinutes": minute - decided_at}}
    units = {str(r.get("resourceId")) for a in new if a.get("type") != "stage_resources" for r in a.get("resources") or [] if r.get("resourceType") in ("vehicle", "personnel_pool")}
    # a unit that waited at a staging point is now sent somewhere: it leaves the waiting action (which goes if nobody is left in it)
    emptied: set[str] = set()
    for action in plan["actions"]:
        if action.get("type") == "stage_resources":
            action["resources"] = [r for r in action.get("resources") or [] if str(r.get("resourceId")) not in units]
            if not action["resources"]:
                emptied.add(str(action["id"]))
    # a unit redirected on the road leaves the action it had not reached
    for unit, actions in (leaving or {}).items():
        if unit in units:
            emptied.update(actions)
    if emptied:
        drop_actions(plan, emptied)
    plan["actions"].extend(new)
    return len(new), units


def adapt(
    orchestrator: OrchestratorAgent,
    client: FiretraceClient,
    simulation_id: str,
    plan: dict[str, Any],
    verdict: Verdict,
    judge: Judge,
    *,
    decided_at: int,
    run_minutes: int,
    lean: bool,
    house_zones: int,
    replan_minutes: int = REPLAN_MINUTES,
    max_waves: int = MAX_WAVES,
    **cycle: Any,
) -> Adapted:
    """Look at the plan's what-if at each checkpoint and add a wave of actions where the fire is not under control and units are free.

    ``cycle`` is what ``OrchestratorAgent.run_cycle`` takes (``location_id``, ``horizon_minutes``, ``stage_minutes``, ``concentration``). A wave stays in the plan
    only if the engine says it helps and keeps the plan at zero casualties (``Judge``). ``plan`` is changed in place.
    """
    out = Adapted(plan, verdict)
    if not replan_minutes or not verdict.forecast.run_id:
        return out
    cycle = {k: v for k, v in cycle.items() if k not in ("at_minute", "building_zones", "lean", "traffic")}
    checkpoint = decided_at + replan_minutes
    waves = 0
    while waves < max_waves and checkpoint <= run_minutes - MIN_MINUTES_BEFORE_END and out.verdict is not None:
        current = out.verdict.forecast
        areas = _unburned_after(client, current.run_id, checkpoint)
        if areas is not None and areas[1] - areas[0] <= max(CONTAINED_HA, CONTAINED_FRACTION * areas[1]):
            out.waves.append(Wave(checkpoint, "contained", f"o fogo está controlado ({areas[0]:.1f} ha, sobram {areas[1] - areas[0]:.1f} ha): nada a acrescentar."))
            break
        busy = engaged_until(out.plan, run_minutes, checkpoint)
        leaving = redirectable(out.plan, checkpoint)
        free = {a.agent_id for a in orchestrator.agents if busy.get(a.agent_id, 0.0) <= checkpoint or a.agent_id in leaving}
        if not free:
            checkpoint += replan_minutes
            continue
        waves += 1
        out.waves.append(_try_wave(orchestrator, client, simulation_id, out, judge, free, leaving, checkpoint, decided_at, lean, house_zones, cycle))
        checkpoint += replan_minutes
    for wave in out.waves:
        log.info("baseline %s: %s", simulation_id, wave.line())
    return out


def _try_wave(
    orchestrator: OrchestratorAgent, client: FiretraceClient, simulation_id: str, out: Adapted, judge: Judge, free: set[str], leaving: dict[str, list[str]],
    minute: int, decided_at: int, lean: bool, house_zones: int, cycle: dict[str, Any],
) -> Wave:
    """Try the strategies in turn at ``minute``; the first that takes enough off the burned area, with no casualties, is kept."""
    assert out.verdict is not None
    current = out.verdict.forecast
    last = Wave(minute, "no_actions", "os meios livres não têm nada útil a fazer.")
    for index, strategy in enumerate(STRATEGIES):
        zones = house_zones if index == 1 else 0
        try:
            with only(orchestrator, free):
                wave_cycle = orchestrator.run_cycle(current.run_id, publish=False, at_minute=minute, building_zones=zones, lean=lean, traffic=False, **cycle)
        except (ApiProblem, RuntimeError) as error:
            last = Wave(minute, "failed", f"não foi possível decidir ({strategy}): {error}", strategy)
            continue
        if index == 1 and not wave_cycle.zones:
            continue  # no houses in the fire's way: the second strategy would be the first again
        wave_plan = wave_cycle.plan_a
        if wave_plan is None or not wave_plan["actions"]:
            continue
        candidate = copy.deepcopy(out.plan)
        added, units = merge_wave(candidate, wave_plan, minute, decided_at, leaving)
        if not added or not units:
            continue
        set_stay(candidate)
        try:
            prune_unreachable(client, candidate)
            judged, _cut, _gone = judge.make_safe(candidate, decided_at, wrong_wind=False)  # cheap look first: the forecast alone
            if judged is not None and not judged.casualties and current.burned_ha - judged.forecast.burned_ha >= max(MIN_GAIN_HA, MIN_GAIN * current.burned_ha):
                judged, _cut, _gone = judge.make_safe(candidate, decided_at)  # it helps: now the wrong-wind check, which may trim it
        except ApiProblem as error:
            last = Wave(minute, "failed", f"o motor não avaliou a vaga ({strategy}) [{error.code}]", strategy, len(units))
            continue
        if judged is None:
            last = Wave(minute, "failed", f"o motor não avaliou a vaga ({strategy})", strategy, len(units))
            continue
        gain = current.burned_ha - judged.forecast.burned_ha
        if judged.casualties:
            last = Wave(minute, "rejected", f"{len(units)} meios tentaram «{strategy}», mas com baixas previstas: fora do plano.", strategy, len(units), current.burned_ha, judged.forecast.burned_ha)
        elif gain >= max(MIN_GAIN_HA, MIN_GAIN * current.burned_ha):
            out.plan["actions"] = candidate["actions"]
            out.verdict = judged
            return Wave(minute, "kept", "sem baixas previstas.", strategy, len(units), current.burned_ha, judged.forecast.burned_ha)
        else:
            last = Wave(minute, "rejected", f"{len(units)} meios tentaram «{strategy}» e não ajudam ({current.burned_ha:.1f} → {judged.forecast.burned_ha:.1f} ha): fora do plano.", strategy, len(units), current.burned_ha, judged.forecast.burned_ha)
    return last
