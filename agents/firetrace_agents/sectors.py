"""Where on the ground each unit works.

Every agent used to aim at the same point (the fire's head), so a dozen units stacked identical lines on one spot.
Here the orchestrator reads the spread vectors the backend predicts along the fire front (``GET /simulations/{id}/vectors``),
turns them into well-spaced *sectors* ranked by how dangerous they are, and hands each unit one sector (and, when people
are threatened, one place) so the effort is spread over the front instead of piled up.

Geometry follows the contract: GeoJSON ``[lon, lat]``, bearings in degrees with 0 = north, the bearing of a spread vector
is where the fire is heading to.
"""
from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from typing import Any

EARTH_RADIUS_M = 6_371_008.8

# Which share of the ranked sectors each tier may take: aircraft and trucks go where the fire is fastest, people on foot
# take the slower flanks (and every tier falls back to all sectors when there are few).
HELICOPTER_SHARE = 1 / 3
TRUCK_SHARE = 2 / 3
FIGHTABLE_FULL_KWM = 1700.0  # ``Rules.suppression.fullEffectUpToKwm``
FIGHTABLE_NONE_KWM = 4000.0  # ``Rules.suppression.noEffectFromKwm``
UNFIGHTABLE_SHARE = 0.05  # a stretch crews cannot fight still counts for this share (people may need it held later, aircraft and lines still help)
WORKABILITY_FLOOR = 0.35  # a stretch crews can barely work still counts for this share of its danger: a fast fire is not ignored because its ground is bad


def bearing_to(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial bearing (degrees, 0 = north) from the first point to the second."""
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def destination(lat: float, lon: float, bearing_deg: float, distance_m: float) -> tuple[float, float]:
    """Point ``distance_m`` from (lat, lon) along ``bearing_deg``; a negative distance goes the opposite way."""
    brg, ang = math.radians(bearing_deg), distance_m / EARTH_RADIUS_M
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(ang) + math.cos(p1) * math.sin(ang) * math.cos(brg))
    l2 = l1 + math.atan2(math.sin(brg) * math.sin(ang) * math.cos(p1), math.cos(ang) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2)


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


@dataclass(frozen=True)
class Sector:
    """A stretch of the fire front: where it is, where it is heading and how hard it is burning."""

    lat: float
    lon: float
    bearing_deg: float
    speed_mmin: float
    intensity_kwm: float  # what the crews here face: the fire's intensity in the direction this stretch spreads (see `plan_sectors`)
    crown: bool = False
    head_intensity_kwm: float = 0.0  # what its cells burn at in their head direction (the vector's own figure)
    workability: float = 1.0  # how much of their work a crew on foot does on this stretch's ground (``terrain.py``): 1 = flat and easy, less on steep, wooded ground

    @property
    def position(self) -> dict[str, float]:
        return {"lat": self.lat, "lon": self.lon}

    @property
    def danger(self) -> float:
        """How urgent the stretch is: how fast and how hard it burns, discounted where crews can do little (sending them there wastes them and puts them at risk)."""
        # Crews and drops stop flames only up to FIGHTABLE_FULL_KWM and not at all from FIGHTABLE_NONE_KWM (the engine's own limits): a stretch burning past what they can
        # fight counts for its speed at the limit and a fraction of that, so the effort goes where it can put the fire out (flanks, back) and not onto a head nobody can hold.
        fightable = min(max(self.intensity_kwm, 1.0), FIGHTABLE_FULL_KWM) * (UNFIGHTABLE_SHARE + (1.0 - UNFIGHTABLE_SHARE) * self.fightability)
        return self.speed_mmin * fightable * (WORKABILITY_FLOOR + (1.0 - WORKABILITY_FLOOR) * self.workability)

    @property
    def fightability(self) -> float:
        """1 where direct attack works in full, 0 where the flames are too intense for it (linear between), like the engine."""
        if self.intensity_kwm <= FIGHTABLE_FULL_KWM:
            return 1.0
        if self.intensity_kwm >= FIGHTABLE_NONE_KWM:
            return 0.0
        return (FIGHTABLE_NONE_KWM - self.intensity_kwm) / (FIGHTABLE_NONE_KWM - FIGHTABLE_FULL_KWM)


@dataclass(frozen=True)
class Assignment:
    """What the orchestrator tells one unit: its sector, how many units already share it, and the place it looks after."""

    sector: Sector | None = None
    slot: int = 0
    place: dict[str, Any] | None = None  # a threatened place/facility (`ThreatenedAsset`)
    segment_m: float | None = None  # how much line this unit can build this stage (None = the tier's fixed length)
    offset_m: float = 0.0  # where along the barrier its segment sits, from the sector's centre (laid end to end with the others)
    reserve: bool = False  # in an initial attack, a unit the fire's outline has no room for: it keeps to the usual tactic (blocks ahead)
    air_corridor: dict[str, Any] | None = None  # early air attack: the polygon an aircraft keeps dropping on, from its arrival until ``air_until`` (see orchestrator)
    air_line: dict[str, Any] | None = None  # direct drop line across the active fire front for this aircraft
    air_until: float | None = None  # minutes from the decision the early air attack lasts (the first crews' arrival)
    fuel_strip: Any = None  # a ``fuelbreak.Strip`` this crew can finish before the fire arrives: a squad clears fuel there, an engine lays a wet line (LineString)
    site: dict[str, float] | None = None  # where the crew stands (``placement.py``): inside the burned area for an attack from the black; None = the sector's front
    stay_minutes: int | None = None  # how long it may work there without the fire reaching it (None = the tactic's default; 0 = not sent: no safe spot, or not needed on the front)
    start_after: float | None = None  # minutes after the decision before which its effect does not start (an aircraft cooling the ground just before a crew goes in)


MAX_BARRIER_M = 400.0  # the longest one barrier of line on a stretch of front (a few units' worth): operations stay small, and the next stretch takes the rest
COVER_MIN_SPEED_MMIN = 0.3  # a stretch spreading slower than this (m/min) is not a front anyone needs to hold yet
OCTANTS = 8


def plan_sectors(vectors: dict[str, Any], *, zone_radius_m: float = 180.0, limit: int = 12, workability_of: Callable[[Sector], float] | None = None,
                 all_around: bool = True) -> list[Sector]:
    """Rank the spread vectors by danger and keep them at least two work-zones apart (a unit covers one zone).

    ``workability_of`` says how workable a stretch's ground is for a crew (``terrain.py``); it discounts the stretch's danger, so crews are not piled onto ground
    where they can do little while an easier stretch burns just as hard.

    ``all_around``: before filling by danger, the most dangerous stretch in each of the eight directions around the fire (where it is still spreading) is kept,
    one work-zone apart. A fire is not only its head: the flanks and the back grow too (a flank becomes a head when the wind turns), and the doctrine is to
    anchor and work the whole perimeter (anchor, flank and pinch), the slower stretches to the crews on foot (``assign_units`` gives them the lower share).
    Without it every unit went to the one stretch where the fire was fastest at the decision and nobody watched the other side.
    """
    candidates: list[Sector] = []
    for feature in (vectors or {}).get("features", []):
        geometry, props = feature.get("geometry") or {}, feature.get("properties") or {}
        if geometry.get("type") != "Point" or props.get("bearingDeg") is None or props.get("speedMmin") is None:
            continue
        lon, lat = geometry["coordinates"][:2]
        candidates.append(
            Sector(float(lat), float(lon), float(props["bearingDeg"]), float(props["speedMmin"]), float(props.get("intensityKwm") or 0.0), bool(props.get("crown")))
        )
    # A vector's intensity is what its cells burn at in their head direction; the fire there spreads at `speedMmin`. Byram's intensity is proportional to the
    # spread rate, so the stretch faces its head intensity scaled by how fast it moves next to the fastest stretch (the head): the backend fights it with that.
    head = max((s.speed_mmin for s in candidates), default=0.0)
    if head > 0:
        candidates = [replace(s, intensity_kwm=s.intensity_kwm * min(1.0, s.speed_mmin / head), head_intensity_kwm=s.intensity_kwm) for s in candidates]
    if workability_of is not None:
        candidates = [replace(s, workability=max(0.0, min(1.0, workability_of(s)))) for s in candidates]
    candidates.sort(key=lambda s: s.danger, reverse=True)
    kept: list[Sector] = []
    if all_around and len(candidates) > 1:
        lat0 = sum(s.lat for s in candidates) / len(candidates)
        lon0 = sum(s.lon for s in candidates) / len(candidates)
        covered: set[int] = set()
        for sector in candidates:  # by danger: the first of each direction is its most dangerous stretch
            octant = int(((bearing_to(lat0, lon0, sector.lat, sector.lon) + 180.0 / OCTANTS) % 360.0) // (360.0 / OCTANTS))
            if octant in covered or sector.speed_mmin < COVER_MIN_SPEED_MMIN:
                continue
            if all(distance_m(sector.lat, sector.lon, other.lat, other.lon) >= zone_radius_m for other in kept):
                kept.append(sector)
                covered.add(octant)
    for sector in candidates:
        if len(kept) >= limit:
            break
        if sector not in kept and all(distance_m(sector.lat, sector.lon, other.lat, other.lon) >= 2 * zone_radius_m for other in kept):
            kept.append(sector)
    kept.sort(key=lambda s: s.danger, reverse=True)  # the tiers take their share of the list by danger (`assign_units`)
    return kept[:limit]


FLANK_OFFSETS_DEG = (90.0, -90.0, 180.0)  # the two flanks and the back (heel) of a fire, from its head's bearing
OUTLINE_SAMPLE_M = 30.0  # the outline is walked about every cell
OUTLINE_CONE_DEG = 35.0  # a stretch of outline belongs to a flank (or the back) within this angle of it, seen from where the fire started
LENGTH_TO_BREADTH = (1.5, 6.0)  # the fire's length over its width, as the outline gives it, kept within what a wind-driven fire has (a coarse young outline can say anything)


def outline_sectors(perimeters: dict[str, Any], origin: dict[str, Any] | None, sectors: Sequence[Sector], *, near_m: float,
                    workability_of: Callable[[Sector], float] | None = None) -> list[Sector]:
    """The flanks and the back of the fire, read from its outline, for the directions the spread vectors leave empty.

    The backend sums the vectors over blocks of cells: a young fire fits in one or two of them, so the vectors show its head only, and every crew that arrived
    early was sent to a head burning past direct attack (and then kept away from it). The doctrine for that fire is to anchor at the back and work up the
    flanks from the burned side. Each flank (and the back) is the point of the outline farthest from where the fire started in that direction.

    How fast they spread comes from the elliptical fire (Anderson 1983, Alexander 1985, as FARSITE and BehavePlus use it): with the head's rate R and the
    fire's length-to-breadth ratio L (from the outline, along and across the head's bearing), the back spreads at R / HB with HB = (L + √(L²−1)) / (L − √(L²−1))
    and the flanks at (R + R/HB) / 2L. Each faces the head's intensity scaled by its rate (Byram: intensity is proportional to the spread rate, as in
    ``plan_sectors``; the engine too fights each cell with the intensity in the direction the fire enters it, "a flank is far weaker than the head").
    A direction that already has a vector, or whose point is within ``near_m`` of a stretch already kept, adds nothing.
    """
    head = max(sectors, key=lambda s: s.speed_mmin, default=None)
    if head is None or origin is None or head.speed_mmin <= 0:
        return []
    lat0, lon0 = float(origin["lat"]), float(origin["lon"])
    points: list[tuple[float, float]] = []
    for feature in (perimeters or {}).get("features") or []:
        geometry = feature.get("geometry") or {}
        polygons = geometry.get("coordinates") or []
        for polygon in polygons if geometry.get("type") == "MultiPolygon" else [polygons]:
            ring = polygon[0] if polygon else []
            for a, b in zip(ring, ring[1:]):
                steps = max(1, math.ceil(distance_m(a[1], a[0], b[1], b[0]) / OUTLINE_SAMPLE_M))
                points.extend((a[1] + (b[1] - a[1]) * k / steps, a[0] + (b[0] - a[0]) * k / steps) for k in range(steps))
    if not points:
        return []
    # the outline in metres, along (u) and across (v) the head's bearing
    to_m = 2.0 * math.pi * EARTH_RADIUS_M / 360.0
    sin_b, cos_b = math.sin(math.radians(head.bearing_deg)), math.cos(math.radians(head.bearing_deg))
    along, across = [], []
    for lat, lon in points:
        x, y = (lon - lon0) * to_m * math.cos(math.radians(lat0)), (lat - lat0) * to_m
        along.append(x * sin_b + y * cos_b)
        across.append(x * cos_b - y * sin_b)
    width = max(across) - min(across)
    ratio = (max(along) - min(along)) / width if width > 0 else LENGTH_TO_BREADTH[1]
    ratio = max(LENGTH_TO_BREADTH[0], min(LENGTH_TO_BREADTH[1], ratio))
    root = math.sqrt(ratio * ratio - 1.0)
    back_mmin = head.speed_mmin * (ratio - root) / (ratio + root)
    rate = {180.0: back_mmin, 90.0: (head.speed_mmin + back_mmin) / (2.0 * ratio), -90.0: (head.speed_mmin + back_mmin) / (2.0 * ratio)}
    head_kwm = head.head_intensity_kwm or head.intensity_kwm

    def off(bearing: float, want: float) -> float:
        return abs((bearing - want + 180.0) % 360.0 - 180.0)

    added: list[Sector] = []
    for offset in FLANK_OFFSETS_DEG:
        want = (head.bearing_deg + offset) % 360.0
        if any(off(bearing_to(lat0, lon0, s.lat, s.lon), want) <= OUTLINE_CONE_DEG for s in sectors if distance_m(lat0, lon0, s.lat, s.lon) > 1.0):
            continue  # the vectors already see this side of the fire
        best, reach = None, 0.0
        for lat, lon in points:
            d = distance_m(lat0, lon0, lat, lon)
            if d > reach and off(bearing_to(lat0, lon0, lat, lon), want) <= OUTLINE_CONE_DEG:
                best, reach = (lat, lon), d
        if best is None or any(distance_m(best[0], best[1], s.lat, s.lon) < near_m for s in [*sectors, *added]):
            continue
        share = rate[offset] / head.speed_mmin
        sector = Sector(best[0], best[1], want, rate[offset], head_kwm * share, crown=False, head_intensity_kwm=head_kwm)
        if workability_of is not None:
            sector = replace(sector, workability=max(0.0, min(1.0, workability_of(sector))))
        added.append(sector)
    return added


MAX_SLOT_SHIFT_M = 600.0  # a unit's place along the front never moves more than this from its sector: further out it is no longer on the fire


def slot_shift(slot: int, step_m: float) -> float:
    """Slot 0 stays put; 1, 2, 3, 4... move to alternate sides, one ``step_m`` further each pair, but never more than ``MAX_SLOT_SHIFT_M``.

    Past that the slots wrap back onto the stretch nearest the sector (the next unit stands beside an earlier one), instead of sliding kilometres off the fire.
    """
    if not step_m:
        return 0.0
    cap = max(1, int(MAX_SLOT_SHIFT_M // step_m))
    wrapped = (slot % (2 * cap))  # 0..2cap-1: a cycle over the places either side of the sector, nearest first
    steps = (wrapped + 1) // 2
    return steps * step_m * (-1 if wrapped % 2 == 0 and wrapped else 1) if wrapped else 0.0


def assign_units(
    units: Sequence[tuple[str, str]],
    sectors: Sequence[Sector],
    places: Sequence[dict[str, Any]],
    *,
    budgets: dict[str, float] | None = None,
    concentration: int | None = None,
    need_m_of: Callable[[Sector], float] | None = None,
    rank: dict[str, float] | None = None,
) -> dict[str, Assignment]:
    """``units`` are ``(agent_id, tier)``; helicopters pick first, then trucks, then squads (stable by id).

    Each unit takes the least-used sector of its tier's share; ``slot`` counts the units already there, so they can be
    laid side by side along the front. Threatened places are dealt round-robin within each tier, most urgent first.

    With ``budgets`` (metres of line per unit) every unit's line is as long as it can build. With ``concentration`` too, the
    metres are spent on the ``concentration`` most dangerous sectors, in proportion to their danger, and the units of a sector
    are laid end to end as **one barrier** instead of piled up in parallel. ``need_m_of`` (metres per sector) caps that: a sector
    takes units only until its line is as long as it needs, and the rest are not sent.

    ``rank`` (smaller first, e.g. minutes to arrive) orders the units within a tier before their id: the nearest units take the front, the farthest are the
    ones left over.
    """
    if budgets is not None and concentration:
        return _assign_barriers(units, sectors, places, budgets, concentration, need_m_of, rank)
    assigned = _assign_by_tier(units, sectors, places, rank)
    if budgets is None:
        return assigned
    return {
        agent_id: Assignment(a.sector, a.slot, a.place, segment_m=budgets.get(agent_id), offset_m=slot_shift(a.slot, budgets.get(agent_id) or 0.0))
        for agent_id, a in assigned.items()
    }


def with_preferences(
    assigned: dict[str, Assignment],
    units: Sequence[tuple[str, str]],
    sectors: Sequence[Sector],
    preferred: dict[str, int],
    *,
    budgets: dict[str, float] | None = None,
    concentration: int | None = None,
) -> dict[str, Assignment]:
    """``assigned`` with the units in ``preferred`` (unit id → index into ``sectors``) moved to the sector they were asked for, and every sector's units laid out again.

    A commander (``advisor.py``) may know better than the rules' round-robin where a unit is worth most (a crew on foot on the easy flank, an engine on the road above the
    slope), but the layout stays the rules' business: units of a sector are laid side by side (``slot``), or end to end as one barrier when ``concentration`` is set, in
    the same order as ``assign_units`` uses (helicopters, then trucks, then squads, stable by id). Units not in ``preferred`` keep the sector the rules gave them.
    """
    if not preferred:
        return assigned
    order = {"helicopter": 0, "truck": 1, "squad": 2}
    ranked = sorted(units, key=lambda u: (order.get(u[1], 9), u[0]))
    chosen: dict[str, Sector | None] = {}
    for agent_id, _tier in ranked:
        previous = assigned.get(agent_id)
        index = preferred.get(agent_id)
        chosen[agent_id] = sectors[index] if index is not None and 0 <= index < len(sectors) else (previous.sector if previous is not None else None)
    members: dict[Sector | None, list[str]] = {}
    for agent_id, _tier in ranked:
        members.setdefault(chosen[agent_id], []).append(agent_id)
    out: dict[str, Assignment] = {}
    barriers = budgets is not None and bool(concentration)
    for sector, group in members.items():
        total = sum((budgets or {}).get(a) or 0.0 for a in group) if barriers else 0.0
        cumulative = 0.0
        for slot, agent_id in enumerate(group):
            place = assigned[agent_id].place if agent_id in assigned else None
            segment = (budgets or {}).get(agent_id) or 0.0
            if sector is None:
                out[agent_id] = assigned.get(agent_id, Assignment(place=place))
            elif barriers:
                out[agent_id] = Assignment(sector, slot, place, segment_m=segment, offset_m=cumulative + segment / 2 - total / 2)
                cumulative += segment
            elif budgets is not None:
                out[agent_id] = Assignment(sector, slot, place, segment_m=budgets.get(agent_id), offset_m=slot_shift(slot, segment))
            else:
                out[agent_id] = Assignment(sector, slot, place)
    return out


def _assign_barriers(units: Sequence[tuple[str, str]], sectors: Sequence[Sector], places: Sequence[dict[str, Any]], budgets: dict[str, float], concentration: int,
                     need_m_of: Callable[[Sector], float] | None = None, rank: dict[str, float] | None = None) -> dict[str, Assignment]:
    order = {"helicopter": 0, "truck": 1, "squad": 2}
    ranked = sorted(units, key=lambda u: (order.get(u[1], 9), (rank or {}).get(u[0], math.inf), u[0]))
    top = list(sectors[: max(1, concentration)])
    out: dict[str, Assignment] = {}
    dealt: dict[str, int] = {}

    def place_for(tier: str) -> dict[str, Any] | None:
        if not places:
            return None
        place = places[dealt.get(tier, 0) % len(places)]
        dealt[tier] = dealt.get(tier, 0) + 1
        return place

    if not top:
        return {agent_id: Assignment(place=place_for(tier), segment_m=budgets.get(agent_id)) for agent_id, tier in ranked}
    total_danger = sum(s.danger for s in top) or 1.0
    weight = {s: max(s.danger / total_danger, 1e-6) for s in top}
    allocated = {s: 0.0 for s in top}
    members: dict[Sector, list[tuple[str, str]]] = {s: [] for s in top}
    need = {s: need_m_of(s) for s in top} if need_m_of is not None else None
    for agent_id, tier in ranked:
        b = budgets.get(agent_id) or 0.0
        open_sectors = [s for s in top if need is None or allocated[s] < need[s]]  # a stretch that already has the line it needs takes no more units
        if not open_sectors:
            out[agent_id] = Assignment(place=place_for(tier), stay_minutes=0)  # not needed on the front: it stays free for the next decision
            continue
        # a barrier is a few units' worth of line, not the whole front: a sector full (the line it can take) passes its units to the next one
        room = [s for s in open_sectors if allocated[s] + b <= MAX_BARRIER_M] or open_sectors
        sector = min(room, key=lambda s: ((allocated[s] + b) / weight[s], top.index(s)))  # fill each sector in proportion to its danger
        allocated[sector] += b
        members[sector].append((agent_id, tier))
    for sector, group in members.items():
        total, cumulative = allocated[sector], 0.0
        for slot, (agent_id, tier) in enumerate(group):
            segment = budgets.get(agent_id) or 0.0
            out[agent_id] = Assignment(sector, slot, place_for(tier), segment_m=segment, offset_m=cumulative + segment / 2 - total / 2)
            cumulative += segment
    return out


def _assign_by_tier(units: Sequence[tuple[str, str]], sectors: Sequence[Sector], places: Sequence[dict[str, Any]], rank: dict[str, float] | None = None) -> dict[str, Assignment]:
    n = len(sectors)
    pools: dict[str, Sequence[Sector]] = {
        "helicopter": sectors[: max(1, math.ceil(n * HELICOPTER_SHARE))],
        "truck": sectors[: max(1, math.ceil(n * TRUCK_SHARE))],
        "squad": sectors[n // 3 :] or sectors,
    }
    use: dict[Sector, int] = {}
    dealt: dict[str, int] = {}
    order = {"helicopter": 0, "truck": 1, "squad": 2}
    out: dict[str, Assignment] = {}
    for agent_id, tier in sorted(units, key=lambda u: (order.get(u[1], 9), (rank or {}).get(u[0], math.inf), u[0])):
        sector, slot = None, 0
        pool = pools.get(tier) or sectors
        if pool:
            sector = min(pool, key=lambda s: (use.get(s, 0), sectors.index(s)))
            slot = use.get(sector, 0)
            use[sector] = slot + 1
        place = None
        if places:
            place = places[dealt.get(tier, 0) % len(places)]
            dealt[tier] = dealt.get(tier, 0) + 1
        out[agent_id] = Assignment(sector=sector, slot=slot, place=place)
    return out


def _shifted(lat: float, lon: float, across_deg: float, slot: int, step_m: float) -> tuple[float, float]:
    """Slot 0 stays put; 1, 2, 3, 4... move to alternate sides along the front, one ``step_m`` further each pair."""
    shift = slot_shift(slot, step_m)
    return destination(lat, lon, across_deg, shift) if shift else (lat, lon)


def line_segment(lat: float, lon: float, bearing_deg: float, length_m: float, offset_m: float = 0.0) -> dict[str, Any]:
    """A piece of barrier across the fire's path: ``length_m`` long, its centre ``offset_m`` along the barrier from the sector."""
    across = (bearing_deg + 90.0) % 360.0
    c_lat, c_lon = destination(lat, lon, across, offset_m) if offset_m else (lat, lon)
    a_lat, a_lon = destination(c_lat, c_lon, across, length_m / 2)
    b_lat, b_lon = destination(c_lat, c_lon, across, -length_m / 2)
    return {"type": "LineString", "coordinates": [[a_lon, a_lat], [b_lon, b_lat]]}


def line_across(lat: float, lon: float, bearing_deg: float, half_length_m: float, slot: int = 0) -> dict[str, Any]:
    """A line across the fire's path (perpendicular to its heading): that is what actually stops it."""
    across = (bearing_deg + 90.0) % 360.0
    c_lat, c_lon = _shifted(lat, lon, across, slot, 2 * half_length_m)
    a_lat, a_lon = destination(c_lat, c_lon, across, half_length_m)
    b_lat, b_lon = destination(c_lat, c_lon, across, -half_length_m)
    return {"type": "LineString", "coordinates": [[a_lon, a_lat], [b_lon, b_lat]]}


def zone_around(lat: float, lon: float, bearing_deg: float, radius_m: float, slot: int = 0, vertices: int = 16) -> dict[str, Any]:
    """A closed counter-clockwise ring of ``radius_m`` (RFC 7946), laid beside the others along the front by ``slot``."""
    c_lat, c_lon = _shifted(lat, lon, (bearing_deg + 90.0) % 360.0, slot, 2 * radius_m)
    ring = []
    for i in range(vertices):
        p_lat, p_lon = destination(c_lat, c_lon, -360.0 * i / vertices, radius_m)
        ring.append([p_lon, p_lat])
    ring.append(ring[0])
    return {"type": "Polygon", "coordinates": [ring]}
