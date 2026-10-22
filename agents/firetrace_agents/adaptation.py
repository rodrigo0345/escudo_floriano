"""The agents re-plan as the fire evolves: a plan is not one decision at minute 0, it is a chain of them.

A plan is judged by its what-if run, which is a whole simulation of the fire *with* the plan applied. That run is the situation a commander would be
looking at some time later, so the agents look at it at each checkpoint (``REPLAN_MINUTES``) and ask:

* **Is the fire out?** The firefighters' goal is to put the fire out, not to hold it (``firestate.py``). If the plan's what-if shows the fire going out before
  the end of the run, nothing is added; otherwise the free units are sent to finish it.
* **If not, who is free?** Units the plan has not committed (the reserve, the ones that could not reach the fire in time and wait at a staging point), units
  whose work has ended, units still on the road (they have not started: their orders can change, see ``redirectable``) and **units whose fire has moved on**:
  a crew attacking a stretch of front that, in the what-if, no longer burns anywhere near it is moved to where the fire is now (``front_moved_away``); its
  job there ends at the checkpoint and it leaves from where it stands. A commander repositions crews along the fire all the time; they do not stay on a
  stretch that has gone quiet while another side runs. They decide again on the what-if
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
from typing import Any, Iterator, Sequence

from .buildings import ignition_minutes
from .alternatives import committed_units, drop_actions, prune_unreachable, set_stay
from .client import ApiProblem, FiretraceClient
from .judge import Judge, Verdict
from .firestate import fire_state
from .orchestrator import OrchestratorAgent
from .travel import centroid

log = logging.getLogger("firetrace.adaptation")

REPLAN_MINUTES = 30  # how often the agents look at the fire again
MAX_WAVES = 6
# a working crew is moved when nothing within this distance of it burns from a little before the checkpoint to an hour after it (assumptions)
RELOCATE_RADIUS_M = 300.0
RELOCATE_LOOKBACK_MIN = 15
RELOCATE_LOOKAHEAD_MIN = 60
DIRECT_EFFECTS = frozenset({"crew_deployment", "aerial_drop"})
MIN_GAIN = 0.02  # a wave stays in the plan only if it takes at least this share (or MIN_GAIN_HA) off the burned area
MIN_GAIN_HA = 0.5
MIN_MINUTES_BEFORE_END = 30  # a wave at the very end of the run would have nothing left to change
STRATEGIES = ("atacar o fogo", "defender o que está no caminho")  # tried in this order; the first is named after the fire's reading (attack or contain), the second puts the engines on the houses in the fire's way


@dataclass
class Wave:
    """What the agents did at one checkpoint (and why), for the plan's summary and the logs."""

    minute: int
    outcome: str  # extinguished | no_free_units | no_actions | kept | rejected | failed
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


def _where(action: dict[str, Any]) -> dict[str, float] | None:
    """Where an action's units are while they do it: its anchor, staging area or position, else the middle of its first effect."""
    for point in (action.get("anchorPoint"), (action.get("stagingArea") or {}).get("position"), action.get("position")):
        if isinstance(point, dict) and point.get("lat") is not None:
            return {"lat": float(point["lat"]), "lon": float(point["lon"])}
    for effect in action.get("simulationEffects") or []:
        if (middle := centroid(effect.get("geometry"))) is not None:
            return middle
    return None


def last_positions(plan: dict[str, Any], units: set[str], minute: int, run_minutes: int) -> dict[str, dict[str, float]]:
    """Where each of ``units`` is at ``minute``: the spot of its last job that has ended (or the staging point it waits at). Units at their station are left out."""
    found: dict[str, tuple[float, dict[str, float]]] = {}
    for action in plan["actions"]:
        end = _end_minute(action, run_minutes)
        if end > minute or (where := _where(action)) is None:
            continue
        for resource in action.get("resources") or []:
            unit = str(resource.get("resourceId"))
            if unit in units and (unit not in found or end >= found[unit][0]):
                found[unit] = (end, where)
    return {unit: where for unit, (_end, where) in found.items()}


def front_moved_away(plan: dict[str, Any], ignition: Sequence[int], grid: dict[str, Any], minute: int, run_minutes: int) -> dict[str, tuple[str, dict[str, float]]]:
    """Units at work at ``minute`` on a direct attack (crews, aircraft) where the what-if fire no longer burns nearby -> (the action, where they are).

    "Nearby" is ``RELOCATE_RADIUS_M`` around the job; "burns" is any cell there the fire reaches from ``RELOCATE_LOOKBACK_MIN`` before the checkpoint to
    ``RELOCATE_LOOKAHEAD_MIN`` after it. Lines and fuel breaks are left alone (a line ahead of the fire is waiting for it on purpose), and so is an action
    several units share (moving one would break the group).
    """
    width, height = int(grid["width"]), int(grid["height"])
    reach_rows = max(1, int(RELOCATE_RADIUS_M / (float(grid["dLat"]) * 111_000.0)))
    reach_cols = max(1, int(RELOCATE_RADIUS_M / (float(grid["dLon"]) * 111_000.0 * 0.75)))
    moved: dict[str, tuple[str, dict[str, float]]] = {}
    for action in plan["actions"]:
        effects = action.get("simulationEffects") or []
        resources = action.get("resources") or []
        if action.get("type") != "fire_attack" or len(resources) != 1 or not effects or any(e.get("type") not in DIRECT_EFFECTS for e in effects):
            continue
        if not (_start_minute(action) <= minute < _end_minute(action, run_minutes)) or (where := _where(action)) is None:
            continue
        col = int((where["lon"] - float(grid["lonWest"])) / float(grid["dLon"]))
        row = int((float(grid["latNorth"]) - where["lat"]) / float(grid["dLat"]))
        if not (0 <= col < width and 0 <= row < height):
            continue
        active = any(
            minute - RELOCATE_LOOKBACK_MIN < ignition[r * width + c] <= minute + RELOCATE_LOOKAHEAD_MIN
            for r in range(max(0, row - reach_rows), min(height, row + reach_rows + 1))
            for c in range(max(0, col - reach_cols), min(width, col + reach_cols + 1))
        )
        if not active:
            moved[str(resources[0].get("resourceId"))] = (str(action["id"]), where)
    return moved


def end_at(plan: dict[str, Any], action_ids: set[str], minute: int) -> None:
    """The jobs in ``action_ids`` end at ``minute``: their effects and stay are cut there (the unit has been moved elsewhere)."""
    for action in plan["actions"]:
        if str(action["id"]) not in action_ids:
            continue
        start = _start_minute(action)
        for effect in action.get("simulationEffects") or []:
            begin = float((effect.get("start") or {}).get("offsetMinutes") or start)
            length = max(1, int(minute - begin))
            if effect.get("durationMinutes"):
                effect["durationMinutes"] = min(int(effect["durationMinutes"]), length)
            if effect.get("effectDurationMinutes"):
                effect["effectDurationMinutes"] = min(int(effect["effectDurationMinutes"]), length)
        if action.get("expectedDurationMinutes") and start != float("inf"):
            action["expectedDurationMinutes"] = max(1, min(int(action["expectedDurationMinutes"]), int(minute - start)))
        action["title"] = f"{action.get('title', '')} (até T+{minute}: o fogo afastou-se, a equipa é reposicionada)"


@contextmanager
def only(orchestrator: OrchestratorAgent, unit_ids: set[str], origins: dict[str, dict[str, float]] | None = None) -> Iterator[None]:
    """The orchestrator plans with these units alone (the others are busy), each leaving from where it is (``origins``; its station otherwise)."""
    everyone, before = orchestrator._registry, orchestrator.origins  # noqa: SLF001 — the team is swapped and put back
    subset = type(everyone)()
    for agent in everyone.all():
        if agent.agent_id in unit_ids:
            subset.register(agent)
    orchestrator._registry = subset  # noqa: SLF001
    orchestrator.origins = dict(origins or {})
    try:
        yield
    finally:
        orchestrator._registry = everyone  # noqa: SLF001
        orchestrator.origins = before


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
        if trigger and trigger.get("kind") == "at_time":  # timed from the wave's decision (a reinforcement's arrival): moved onto the plan's clock
            action["trigger"] = {**trigger, "at": {"offsetMinutes": int((trigger.get("at") or {}).get("offsetMinutes") or 0) + minute - decided_at}}
        elif trigger and trigger.get("kind") == "on_action_complete":
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
        state = fire_state(client, current.run_id)
        if state is not None and state.out_at is not None:
            # the goal is to put the fire out: once the plan does, nothing more is sent (it would only stand where nothing burns)
            when = "já está extinto" if state.out_at <= checkpoint else f"o plano apaga-o às T+{state.out_at} min"
            out.waves.append(Wave(checkpoint, "extinguished", f"{when}: nada a acrescentar."))
            break
        busy = engaged_until(out.plan, run_minutes, checkpoint)
        leaving = redirectable(out.plan, checkpoint)
        moving = _moving(client, current.run_id, out.plan, checkpoint, run_minutes, cycle.get("location_id"))
        free = {a.agent_id for a in orchestrator.agents if busy.get(a.agent_id, 0.0) <= checkpoint or a.agent_id in leaving or a.agent_id in moving}
        if not free:
            checkpoint += replan_minutes
            continue
        waves += 1
        out.waves.append(_try_wave(orchestrator, client, simulation_id, out, judge, free, leaving, checkpoint, decided_at, run_minutes, lean, house_zones, cycle, moving))
        checkpoint += replan_minutes
    for wave in out.waves:
        log.info("baseline %s: %s", simulation_id, wave.line())
    return out


def _moving(client: FiretraceClient, run_id: str, plan: dict[str, Any], minute: int, run_minutes: int, location_id: str | None) -> dict[str, tuple[str, dict[str, float]]]:
    """``front_moved_away`` on the what-if as the plan leaves it; nothing when the grid or the fire's arrival times cannot be read."""
    if not location_id:
        return {}
    try:
        grid = client.get_location(location_id)["grid"]
        return front_moved_away(plan, ignition_minutes(client.get_ignition_grid(run_id)), grid, minute, run_minutes)
    except (ApiProblem, KeyError) as error:
        log.info("no repositioning at T+%s: %s", minute, error)
        return {}


def _helps(client: FiretraceClient, current: Any, judged: Any) -> bool:
    """A wave helps if it saves houses, puts out a fire the plan did not, brings forward when it goes out, or takes enough off the burned area.

    Houses come before hectares (the plans' priorities): a wave that defends buildings the fire would have burned is kept even if the burned area is the same."""
    if int(getattr(judged, "buildings", 0) or 0) < int(getattr(current, "buildings", 0) or 0):
        return True
    if current.burned_ha - judged.burned_ha >= max(MIN_GAIN_HA, MIN_GAIN * current.burned_ha):
        return True
    before, after = fire_state(client, current.run_id), fire_state(client, judged.run_id)
    if after is None or after.out_at is None:
        return False
    return before is None or before.out_at is None or after.out_at + 15 <= before.out_at


def _try_wave(
    orchestrator: OrchestratorAgent, client: FiretraceClient, simulation_id: str, out: Adapted, judge: Judge, free: set[str], leaving: dict[str, list[str]],
    minute: int, decided_at: int, run_minutes: int, lean: bool, house_zones: int, cycle: dict[str, Any],
    moving: dict[str, tuple[str, dict[str, float]]] | None = None,
) -> Wave:
    """Try the strategies in turn at ``minute``; the first that takes enough off the burned area, with no casualties, is kept."""
    assert out.verdict is not None
    current = out.verdict.forecast
    last = Wave(minute, "no_actions", "os meios livres não têm nada útil a fazer.")
    origins = last_positions(out.plan, free - set(leaving), minute, run_minutes)  # a crew that finished a job leaves from there, not from its station
    moving = moving or {}
    origins.update({unit: where for unit, (_action, where) in moving.items()})  # and a crew moved off a quiet stretch leaves from where it is
    for index, strategy in enumerate(STRATEGIES):
        zones = house_zones if index == 1 else 0
        try:
            with only(orchestrator, free, origins):
                wave_cycle = orchestrator.run_cycle(current.run_id, publish=False, validate=False, at_minute=minute, building_zones=zones, lean=lean, traffic=False, **cycle)
        except (ApiProblem, RuntimeError) as error:
            last = Wave(minute, "failed", f"não foi possível decidir ({strategy}): {error}", strategy)
            continue
        if index == 1 and not wave_cycle.zones:
            continue  # no houses in the fire's way: the second strategy would be the first again
        if index == 0:  # the firefighters read the fire as it is now: weak enough to attack and put out, or still to be contained
            strategy = "atacar para apagar" if wave_cycle.initial_attack else "conter (fogo forte demais para ataque direto)"
        wave_plan = wave_cycle.plan_a
        if wave_plan is None or not wave_plan["actions"]:
            continue
        candidate = copy.deepcopy(out.plan)
        added, units = merge_wave(candidate, wave_plan, minute, decided_at, leaving)
        if not added or not units:
            continue
        end_at(candidate, {action for unit, (action, _where) in moving.items() if unit in units}, minute)  # the moved crews stop their old job at the checkpoint
        set_stay(candidate)
        try:
            prune_unreachable(client, candidate)
            judged, _cut, _gone = judge.make_safe(candidate, decided_at, wrong_wind=False)  # cheap look first: the forecast alone
            if judged is not None and not judged.casualties and _helps(client, current, judged.forecast):
                judged, _cut, _gone = judge.make_safe(candidate, decided_at)  # it helps: now the wrong-wind check, which may trim it
        except ApiProblem as error:
            last = Wave(minute, "failed", f"o motor não avaliou a vaga ({strategy}) [{error.code}]", strategy, len(units))
            continue
        if judged is None:
            last = Wave(minute, "failed", f"o motor não avaliou a vaga ({strategy})", strategy, len(units))
            continue
        if judged.casualties:
            last = Wave(minute, "rejected", f"{len(units)} meios tentaram «{strategy}», mas com baixas previstas: fora do plano.", strategy, len(units), current.burned_ha, judged.forecast.burned_ha)
        elif _helps(client, current, judged.forecast):
            out.plan["actions"] = candidate["actions"]
            out.verdict = judged
            state = fire_state(client, judged.forecast.run_id)
            return Wave(minute, "kept", f"sem baixas previstas; {state.line() if state else 'estado do fogo desconhecido'}.", strategy, len(units), current.burned_ha, judged.forecast.burned_ha)
        else:
            last = Wave(minute, "rejected", f"{len(units)} meios tentaram «{strategy}» e não ajudam ({current.burned_ha:.1f} → {judged.forecast.burned_ha:.1f} ha): fora do plano.", strategy, len(units), current.burned_ha, judged.forecast.burned_ha)
    return last
