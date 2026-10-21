"""The GNR agent: closes the roads the fire is about to cut and puts a patrol at each end.

Bombeiros fight the fire; the GNR keeps people out of its way. From ``GET /simulations/{id}/road-status`` (when each road is cut and reopened) it:

1. picks the roads the fire cuts within the horizon, or has cut already, that are not reopened yet (not tracks, paths or driveways);
2. joins segments that touch into one closure (a road, not 40 pieces of it);
3. finds a GNR unit for **every end** of the closure, one that gets there in time (the routing, see ``travel.py``). **A road is closed only when, and from
   the moment, a patrol stands at each way in**: a closure nobody enforces is a closure no driver knows about. Without a patrol for every end the road is
   not closed (the plan says so);
4. closes it as a ``road_closure`` action with the reason (fire already on it, or predicted), the reopening time and a ``checkpoint`` at each end, triggered
   when the last patrol arrives; each patrol is a ``traffic_control_point`` action triggered so that it leaves in time to be there then.

**Emergency vehicles always pass** (``exemptions: [emergency_vehicles]``): the firefighters may use a closed road. Keeping crews away from fronts too intense to
work is the attack's job (where it sends them and the routes, which avoid the predicted fire), not the closure's.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Callable

from .sectors import distance_m

NOT_THROUGH_ROADS = frozenset({"track", "path", "service"})
CLASS_RANK = {"motorway": 0, "motorway_link": 0, "trunk": 1, "trunk_link": 1, "primary": 2, "primary_link": 2, "secondary": 3, "tertiary": 4, "unclassified": 5, "residential": 6}
MIN_CUT_PROBABILITY = 0.5
LEAD_MINUTES = 15  # a road is closed this long before the fire is predicted to cut it
MAX_CLOSURES = 60  # all the roads the fire reaches, most urgent first; a plan of more than this is not one an operator reads
MAX_CLOSURE_M = 1500.0  # a closure is a stretch two patrols can mind: longer roads are cut into pieces of at most this length
MAX_CUT_SPREAD_MIN = 30.0  # ...and pieces whose segments the fire cuts more than this far apart in time are separate closures
DEFAULT_NO_EFFECT_KWM = 4000.0
CHECKPOINT_PERSONNEL = 2
UNIT_CANDIDATES = 3  # nearest units tried per checkpoint before giving up on it


def _key(lon: float, lat: float) -> tuple[float, float]:
    return (round(lon, 5), round(lat, 5))


@dataclass
class Closure:
    """One road to close: connected segments, when the fire reaches them, and where the two ends are."""

    road_ids: list[str]
    name: str
    road_class: str
    cut_p10: float
    cut_p50: float
    reopen_p50: float
    reopen_p90: float
    probability: float
    ends: list[dict[str, float]]  # LatLon of the two ends (where the patrols stand)
    end_roads: list[str]  # the segment at each end
    length_m: float
    max_intensity_kwm: float = 0.0
    exempt_emergency: bool = True

    def already_cut(self, decided_at: float) -> bool:
        return self.cut_p50 <= decided_at


def _endpoints(feature: dict[str, Any]) -> tuple[tuple[float, float], tuple[float, float]] | None:
    coords = (feature.get("geometry") or {}).get("coordinates") or []
    if len(coords) < 2:
        return None
    return _key(*coords[0][:2]), _key(*coords[-1][:2])


def plan_closures(
    statuses: list[dict[str, Any]],
    roads: dict[str, dict[str, Any]],
    *,
    decided_at: float,
    horizon: float,
    intensity_at: Callable[[float], float],
    no_effect_kwm: float = DEFAULT_NO_EFFECT_KWM,
    max_closures: int = MAX_CLOSURES,
) -> list[Closure]:
    """The closures to make, the most urgent first. ``roads`` maps a road id to its GeoJSON feature."""
    chosen: dict[str, dict[str, Any]] = {}
    for status in statuses:
        feature = roads.get(str(status.get("roadId")))
        if feature is None or (status.get("class") or feature["properties"].get("class")) in NOT_THROUGH_ROADS:
            continue
        cut, reopen = status.get("cutAtMinute") or {}, status.get("reopenAtMinute") or {}
        if float(status.get("cutProbability") or 0) < MIN_CUT_PROBABILITY or cut.get("p50") is None:
            continue
        if float(reopen.get("p50", math.inf)) <= decided_at or float(cut.get("p10", cut["p50"])) > decided_at + horizon:
            continue  # back open already, or the fire is too far in the future to act on yet
        chosen[str(status["roadId"])] = status

    groups = [piece for stretch in _stretches(chosen, roads) for piece in _pieces(stretch, chosen, roads)]
    closures = [_closure(ids, chosen, roads, intensity_at, no_effect_kwm) for ids in groups]
    # most urgent first: already cut, then soonest; the bigger road breaks ties
    closures.sort(key=lambda c: (not c.already_cut(decided_at), c.cut_p50, CLASS_RANK.get(c.road_class, 9)))
    return closures[:max_closures]


def _connected(ids: list[str], roads: dict[str, dict[str, Any]]) -> list[list[str]]:
    """Split segments into groups that touch end to end (union-find over the end points)."""
    parent: dict[Any, Any] = {}

    def find(x: Any) -> Any:
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for road_id in ids:
        ends = _endpoints(roads[road_id])
        if ends:
            parent[find(ends[0])] = find(ends[1])
    groups: dict[Any, list[str]] = {}
    for road_id in ids:
        ends = _endpoints(roads[road_id])
        if ends:
            groups.setdefault(find(ends[0]), []).append(road_id)
    return list(groups.values())


def _stretches(chosen: dict[str, dict[str, Any]], roads: dict[str, dict[str, Any]]) -> list[list[str]]:
    """Each connected road, its segments in the order one walks them from a free end (so a long road can be cut into pieces along its length)."""
    ordered: list[list[str]] = []
    for ids in _connected(list(chosen), roads):
        at: dict[tuple[float, float], list[str]] = {}
        for road_id in ids:
            for end in _endpoints(roads[road_id]) or ():
                at.setdefault(end, []).append(road_id)
        start = next((node for node, segs in at.items() if len(segs) == 1), next(iter(at)))
        seen: set[str] = set()
        walk: list[str] = []
        stack = [start]
        while stack:
            node = stack.pop()
            for road_id in at.get(node, []):
                if road_id in seen:
                    continue
                seen.add(road_id)
                walk.append(road_id)
                a, b = _endpoints(roads[road_id]) or (node, node)
                stack.append(b if a == node else a)
        ordered.append(walk + [i for i in ids if i not in seen])
    return ordered


def _pieces(stretch: list[str], statuses: dict[str, dict[str, Any]], roads: dict[str, dict[str, Any]]) -> list[list[str]]:
    """Cut a road into closures a patrol can mind: at most ``MAX_CLOSURE_M`` long and cut within ``MAX_CUT_SPREAD_MIN`` of each other."""
    pieces: list[list[str]] = []
    current: list[str] = []
    length = 0.0
    first_cut = 0.0
    for road_id in stretch:
        seg_len = float(roads[road_id]["properties"].get("lengthM") or 0)
        cut = float(statuses[road_id]["cutAtMinute"]["p50"])
        if current and (length + seg_len > MAX_CLOSURE_M or abs(cut - first_cut) > MAX_CUT_SPREAD_MIN):
            pieces.append(current)
            current, length = [], 0.0
        if not current:
            first_cut = cut
        current.append(road_id)
        length += seg_len
    if current:
        pieces.append(current)
    # a piece taken from a branching road may not be in one part: keep each part a closure of its own
    return [part for piece in pieces for part in _connected(piece, roads)]


def _closure(ids: list[str], statuses: dict[str, dict[str, Any]], roads: dict[str, dict[str, Any]], intensity_at: Callable[[float], float], no_effect_kwm: float) -> Closure:
    degree: dict[tuple[float, float], int] = {}
    at_end: dict[tuple[float, float], str] = {}
    for road_id in ids:
        for end in _endpoints(roads[road_id]) or ():
            degree[end] = degree.get(end, 0) + 1
            at_end.setdefault(end, road_id)
    free = [p for p, n in degree.items() if n == 1] or list(degree)  # a loop has no free end: any two points will do
    pair = max(((a, b) for a in free for b in free), key=lambda ab: distance_m(ab[0][1], ab[0][0], ab[1][1], ab[1][0]), default=(free[0], free[0]))
    classes = [statuses[i].get("class") or roads[i]["properties"].get("class") or "" for i in ids]
    names = [roads[i]["properties"].get("name") for i in ids if roads[i]["properties"].get("name") and not str(roads[i]["properties"].get("name")).startswith("via (")]
    cut_p10 = min(float((statuses[i].get("cutAtMinute") or {}).get("p10", statuses[i]["cutAtMinute"]["p50"])) for i in ids)
    cut_p50 = min(float(statuses[i]["cutAtMinute"]["p50"]) for i in ids)
    reopen = [statuses[i].get("reopenAtMinute") or {} for i in ids]
    intensity = intensity_at(cut_p50)
    return Closure(
        road_ids=sorted(ids),
        name=max(set(names), key=names.count) if names else f"via ({min(classes, key=lambda c: CLASS_RANK.get(c, 9)) or 'sem classe'})",
        road_class=min(classes, key=lambda c: CLASS_RANK.get(c, 9)),
        cut_p10=cut_p10,
        cut_p50=cut_p50,
        reopen_p50=max(float(r.get("p50", math.inf)) for r in reopen),
        reopen_p90=max(float(r.get("p90", r.get("p50", math.inf))) for r in reopen),
        probability=min(float(statuses[i].get("cutProbability") or 0) for i in ids),
        ends=[{"lat": pair[0][1], "lon": pair[0][0]}, {"lat": pair[1][1], "lon": pair[1][0]}] if pair[0] != pair[1] else [{"lat": pair[0][1], "lon": pair[0][0]}],
        end_roads=[at_end[pair[0]], at_end[pair[1]]] if pair[0] != pair[1] else [at_end[pair[0]]],
        length_m=sum(float(roads[i]["properties"].get("lengthM") or 0) for i in ids),
        max_intensity_kwm=intensity,
        exempt_emergency=True,  # the firefighters may always use a closed road (see the module notes); the intensity is kept for the reason text
    )


def intensity_lookup(summary: dict[str, Any]) -> Callable[[float], float]:
    """The fire's maximum intensity (kW/m) at a minute, from the summary milestones (the last one at or before it)."""
    milestones = sorted(summary.get("milestones") or [], key=lambda m: m.get("tMin", 0))

    def at(minute: float) -> float:
        value = 0.0
        for m in milestones:
            if m.get("tMin", 0) > minute:
                break
            value = float(m.get("maxIntensityKwm") or 0.0)
        return value

    return at


# ---------------------------------------------------------------------------------------------------------------------
# the actions
# ---------------------------------------------------------------------------------------------------------------------
@dataclass
class GnrPlan:
    """What the GNR decided in one cycle: the actions and the closures behind them."""

    actions: list[dict[str, Any]] = field(default_factory=list)
    closures: list[Closure] = field(default_factory=list)
    issues: list[str] = field(default_factory=list)


def closure_reason(closure: Closure, decided_at: float, opens: float | None = None) -> str:
    when = f"já cortada pelo fogo desde ~T+{closure.cut_p50:.0f} min" if closure.already_cut(decided_at) else f"o fogo previsto corta-a em ~T+{closure.cut_p50:.0f} min (p10 T+{closure.cut_p10:.0f})"
    reopen = f", reabre em ~T+{closure.reopen_p50:.0f} min" if math.isfinite(closure.reopen_p50) else ""
    start = f" Fecha às T+{decided_at + opens:.0f} min, quando há uma patrulha em cada entrada." if opens is not None else ""
    who = "Fechada ao público; os veículos de emergência passam (isenção), para os bombeiros chegarem"
    return f"{closure.name} ({closure.road_class}, {closure.length_m:.0f} m): {when}{reopen}.{start} {who}."


def closure_action(closure: Closure, index: int, organization: str, decided_at: float, checkpoints: list[dict[str, Any]], opens: float | None = None) -> dict[str, Any]:
    cut_soon = closure.already_cut(decided_at)
    action: dict[str, Any] = {
        "id": f"gnr-closure-{index}",
        "type": "road_closure",
        "title": f"Cortar {closure.name}" + (f" ({len(closure.road_ids)} troços)" if len(closure.road_ids) > 1 else ""),
        "organizationId": organization,
        "priority": "critical" if cut_soon else "high",
        "rationale": closure_reason(closure, decided_at, opens),
        "roadIds": closure.road_ids,
        "kind": "full",
        "reason": "fire_active" if cut_soon else "fire_predicted",
        "exemptions": ["emergency_vehicles"],
        "checkpoints": checkpoints,
    }
    if math.isfinite(closure.reopen_p90):
        action["until"] = {"offsetMinutes": max(int(math.ceil(closure.reopen_p90 - decided_at)), 30)}
    if opens is not None:  # when the patrols are at every end (never before)
        start = int(math.ceil(opens))
    else:  # shut it ahead of the fire, not the moment it arrives
        start = 0 if cut_soon else max(int(closure.cut_p10 - decided_at - LEAD_MINUTES), 0)
    if start > 0:
        action["trigger"] = {"kind": "at_time", "at": {"offsetMinutes": start}}
    return action


def control_point_action(closure: Closure, closure_index: int, end_index: int, organization: str, decided_at: float, unit: dict[str, Any] | None, leaves: float = 0.0) -> dict[str, Any]:
    """The patrol at one end. ``leaves`` is when it sets off (minutes after the decision) to be there when the road closes; the closure waits for it, not the other way."""
    end = closure.ends[end_index]
    action: dict[str, Any] = {
        "id": f"gnr-point-{closure_index}-{end_index}",
        "type": "traffic_control_point",
        "title": f"Controlo de trânsito em {closure.name} ({'ponta' if len(closure.ends) > 1 else 'ponto'} {end_index + 1})",
        "organizationId": organization,
        "priority": "critical" if closure.already_cut(decided_at) else "high",
        "rationale": f"Impede o acesso ao troço cortado de {closure.name}: o corte só existe com um agente em cada entrada. Deixa passar os veículos de emergência.",
        "position": end,
        "roadId": closure.end_roads[end_index],
        "mode": "stop",
        "instructions": "Parar o trânsito do público; veículos de emergência passam com identificação.",
    }
    if leaves > 0:
        action["trigger"] = {"kind": "at_time", "at": {"offsetMinutes": int(leaves)}}
    if unit is not None:
        action["resources"] = [unit]
    return action


def unit_stub(vehicle: dict[str, Any]) -> SimpleNamespace:
    """What ``TravelPlanner.eta`` needs from a unit, for a GNR vehicle (it is not a firefighter agent)."""
    from .firefighter import Observation
    from .tiers import FirefighterTier

    observation = Observation(
        agent_id=str(vehicle["id"]), tier=FirefighterTier.TRUCK, vehicle_id=str(vehicle["id"]), organization_id=str(vehicle.get("organizationId") or ""), crew_onboard=int(vehicle.get("crewCapacity") or 0),
        water_capacity_l=0.0, passenger_capacity=int(vehicle.get("passengerCapacity") or 0), capabilities=frozenset(vehicle.get("capabilities") or []),
        station_id=vehicle.get("stationId"), vehicle_type=vehicle.get("type"), off_road=bool(vehicle.get("offRoad")),
    )
    return SimpleNamespace(agent_id=observation.agent_id, tier=FirefighterTier.TRUCK, observation=observation)


def nearest_units(units: list[dict[str, Any]], station_positions: dict[str, dict[str, float]], point: dict[str, float], taken: set[str], count: int = UNIT_CANDIDATES) -> list[dict[str, Any]]:
    """The free GNR vehicles whose station is closest in a straight line (the routing then says how long each really takes)."""
    free = [u for u in units if u["id"] not in taken and u.get("stationId") in station_positions]
    free.sort(key=lambda u: distance_m(station_positions[u["stationId"]]["lat"], station_positions[u["stationId"]]["lon"], point["lat"], point["lon"]))
    return free[:count]
