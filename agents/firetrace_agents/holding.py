"""Units that have finished their job do not drive home: they hold where they are, ready, until something needs them or the run ends.

The backend's unit simulator sends a unit back to its station the moment its last action ends. Plans used to end a crew's job early (a wet line built, the
fire gone past, a stay cut before the fire arrived) and with nothing after it the crew went home hours before the run was over, "for no apparent reason".
A commander does not do that: a crew that has finished stays out, engine running, on a safe spot near the fire, until it is needed, relieved or the shift ends.

So every ground unit of the fire service whose last action ends well before the run ends gets a ``stage_resources`` action from that minute: it holds at the
spot of its last job when the forecast fire does not reach it, else on the road it came by, as far forward as is still safe. The plan says so and why.
A standing reserve (``stage_resources`` with no stated stay) is held to the end of the run too, instead of the backend's 30 minute default.

The holds are added after the judge has made the plan safe, so they are held to the same standard here instead (``HoldingClock``): a spot is used only when
none of the fires the plan was judged on (its forecast what-if and the wrong-wind ones) reaches it or the cells around it before the run ends plus the
safety margin. A holding crew does no suppression, so those fires are the ones it would face. Without them, nobody holds: the unit goes home, as before.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from .adaptation import _where
from .placement import BURNED_OUT_MIN, FireClock

MIN_IDLE_MIN = 20  # a unit idle for less than this before the run ends just finishes
BACKEND_DEFAULT_STAY_MIN = 30  # `Limits.DefaultActionWindowMinutes`: how long the backend's unit simulator keeps a unit on an action that states no stay
HOLD_MARGIN_MIN = 15  # = Rules.safety.withdrawWhenFireArrivesInMinutes, the default when the backend's rules are not at hand


@dataclass(frozen=True)
class HoldingClock:
    """Every fire a holding spot must stay clear of: the plan's forecast what-if and its wrong-wind runs (the judge's runs)."""

    clocks: Sequence[FireClock]
    margin_min: float = HOLD_MARGIN_MIN

    def safe(self, lat: float, lon: float, start: float, end: float) -> bool:
        """Free of fire, in every run, in its cell and the 8 around it from ``start`` to ``end`` plus the margin (burned out before, or reached after)."""
        for clock in self.clocks:
            reached = clock.reached_around(lat, lon)
            if reached is not None and not (reached + BURNED_OUT_MIN <= start or reached > end + self.margin_min):
                return False
        return True


def backend_end(action: dict[str, Any], unit: str) -> float:
    """The minute the backend's unit simulator ends this unit's job: it sets off at the trigger, drives ``etaMinutes`` and stays ``expectedDurationMinutes``
    (30 min when the action says nothing; the effects' own windows do not move the unit). Then it drives home, which is what holding prevents."""
    trigger = action.get("trigger") or {}
    start = float((trigger.get("at") or {}).get("offsetMinutes") or 0) if trigger.get("kind") == "at_time" else 0.0
    eta = max((float(r.get("etaMinutes") or 0) for r in action.get("resources") or [] if str(r.get("resourceId")) == unit), default=0.0)
    return start + eta + float(action.get("expectedDurationMinutes") or BACKEND_DEFAULT_STAY_MIN)


def _route_points(action: dict[str, Any], unit: str, routes: Mapping[str, Any] | None = None) -> list[tuple[float, float]]:
    """The unit's own road to its job as ``(lat, lon)`` from the job back to the station (its way out): the plan's, else the one the agents routed it along."""
    for resource in action.get("resources") or []:
        if str(resource.get("resourceId")) == unit and (route := resource.get("route")):
            return [(float(lat), float(lon)) for lon, lat in reversed(route.get("coordinates") or [])]
    route = (routes or {}).get(unit)
    return [(float(lat), float(lon)) for lon, lat in reversed((route or {}).get("coordinates") or [])]


def drop_unreachable_holds(plan: dict[str, Any], validation: dict[str, Any]) -> int:
    """Take out the holding actions the backend says its unit cannot drive to (a heavy vehicle, the closures of the cordon): that unit goes home, as before. Returns how many.

    Only holding actions are touched: an error anywhere else is the plan's, and stays an error.
    """
    bad: set[int] = set()
    for issue in validation.get("issues") or []:
        if issue.get("severity") != "error":
            continue
        match = re.match(r"/actions/(\d+)/", str(issue.get("pointer") or ""))
        if match and 0 <= int(match.group(1)) < len(plan["actions"]) and str(plan["actions"][int(match.group(1))].get("id", "")).startswith("hold-"):
            bad.add(int(match.group(1)))
    if bad:
        plan["actions"] = [a for i, a in enumerate(plan["actions"]) if i not in bad]
    return len(bad)


def hold_idle_units(plan: dict[str, Any], clock: FireClock | HoldingClock | None, run_minutes: int, ground_units: Mapping[str, Any], why: dict[str, int] | None = None,
                    routes: Mapping[str, Any] | None = None) -> int:
    """Add the holding actions to ``plan`` (in place); returns how many units now hold. ``ground_units`` maps a unit id to its agent (fire engines and crews on foot).

    ``clock`` is where the fire goes; with none, no unit is held (a spot nobody can show is safe is not used) and only the standing reserves are extended."""
    if run_minutes <= 0:
        return 0
    held = 0
    why = why if why is not None else {}
    def trigger_minute(action: dict[str, Any]) -> float:
        return float(((action.get("trigger") or {}).get("at") or {}).get("offsetMinutes") or 0)

    for action in plan["actions"]:
        if action.get("type") == "stage_resources" and not action.get("expectedDurationMinutes"):
            start = trigger_minute(action) + max((float(r.get("etaMinutes") or 0) for r in action.get("resources") or []), default=0.0)
            # held to the end of the run, unless a later order (a re-planning wave) draws on the reserve: then until that order
            units = {str(r.get("resourceId")) for r in action.get("resources") or []}
            later = [trigger_minute(a) for a in plan["actions"] if a is not action and trigger_minute(a) > trigger_minute(action)
                     and units & {str(r.get("resourceId")) for r in a.get("resources") or []}]
            until = min([float(run_minutes), *later])
            action["expectedDurationMinutes"] = max(int(until - start), 1 if later else 30)
            action["holdUntil"] = {"offsetMinutes": int(until)}
    if clock is None:
        why["no fire data"] = why.get("no fire data", 0) + 1
        return 0

    last: dict[str, tuple[float, dict[str, Any]]] = {}
    for action in plan["actions"]:
        if action.get("type") == "stage_resources":
            continue
        for resource in action.get("resources") or []:
            unit = str(resource.get("resourceId"))
            end = backend_end(action, unit)
            if unit in ground_units and (unit not in last or end >= last[unit][0]):
                last[unit] = (end, action)
    extra: list[dict[str, Any]] = []
    for unit, (end, action) in sorted(last.items()):
        agent = ground_units[unit]
        if action.get("type") not in ("fire_attack", "dispatch_units", "structure_protection"):
            why["other action"] = why.get("other action", 0) + 1
            continue
        if end >= run_minutes - MIN_IDLE_MIN:
            why["stays to the end"] = why.get("stays to the end", 0) + 1
            continue
        spot = _where(action)
        if spot is None:
            why["no spot"] = why.get("no spot", 0) + 1
            continue
        stay = run_minutes - end
        origin = "do local da última tarefa"
        if not clock.safe(spot["lat"], spot["lon"], end, run_minutes):
            # the fire comes to that spot: wait on the road it drove in by, at the last point (towards the station) where it is safe for the rest of the run
            spot = next(({"lat": lat, "lon": lon} for lat, lon in _route_points(action, unit, routes) if clock.safe(lat, lon, end, run_minutes)), None)
            origin = "na estrada por onde chegou, fora do alcance do fogo previsto"
            if spot is None:
                why["nowhere safe"] = why.get("nowhere safe", 0) + 1
                continue  # nowhere near is safe: it goes home, and that is the reason
        resource: dict[str, Any] = {
            "resourceType": "vehicle" if agent.observation.vehicle_id else "personnel_pool", "resourceId": unit, "personnel": int(agent.observation.crew_onboard),
            "responsibility": "standby", "etaMinutes": 0,
        }
        if resource["resourceType"] == "personnel_pool" and agent.observation.station_id:
            resource["fromStationId"] = agent.observation.station_id
        extra.append({
            "id": f"hold-{unit}", "type": "stage_resources", "organizationId": action.get("organizationId") or agent.observation.organization_id,
            "title": f"Em prontidão no terreno: {getattr(agent.observation, 'callsign', None) or unit}",
            "priority": "normal",
            "rationale": (f"Acabou a tarefa às T+{end:.0f} min e não volta ao quartel: fica {origin}, com o motor ligado, a descansar e a reabastecer, pronto para a próxima reavaliação, "
                          f"para render uma equipa cansada ou para um novo foco. Fica até ao fim ({stay:.0f} min)."),
            "stagingArea": {"position": spot, "label": "Prontidão no terreno"},
            "readiness": "engine_running",
            "holdUntil": {"offsetMinutes": int(run_minutes)},
            "resources": [resource],
            "trigger": {"kind": "at_time", "at": {"offsetMinutes": int(math.ceil(end))}},
            "expectedDurationMinutes": int(stay),
        })
        held += 1
    plan["actions"].extend(extra)
    return held

