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
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

EARTH_RADIUS_M = 6_371_008.8

# Which share of the ranked sectors each tier may take: aircraft and trucks go where the fire is fastest, people on foot
# take the slower flanks (and every tier falls back to all sectors when there are few).
HELICOPTER_SHARE = 1 / 3
TRUCK_SHARE = 2 / 3


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
    intensity_kwm: float
    crown: bool = False

    @property
    def position(self) -> dict[str, float]:
        return {"lat": self.lat, "lon": self.lon}

    @property
    def danger(self) -> float:
        return self.speed_mmin * max(self.intensity_kwm, 1.0)


@dataclass(frozen=True)
class Assignment:
    """What the orchestrator tells one unit: its sector, how many units already share it, and the place it looks after."""

    sector: Sector | None = None
    slot: int = 0
    place: dict[str, Any] | None = None  # a threatened place/facility (`ThreatenedAsset`)
    segment_m: float | None = None  # how much line this unit can build this stage (None = the tier's fixed length)
    offset_m: float = 0.0  # where along the barrier its segment sits, from the sector's centre (laid end to end with the others)
    reserve: bool = False  # in an initial attack, a unit the fire's outline has no room for: it keeps to the usual tactic (blocks ahead)
    fuel_strip: Any = None  # a ``fuelbreak.Strip`` this crew can open before the fire arrives: it clears fuel ahead of the fire instead of building a handline
    site: dict[str, float] | None = None  # where the crew stands (``placement.py``): inside the burned area for an attack from the black; None = the sector's front
    stay_minutes: int | None = None  # how long it may work there without the fire reaching it (None = the tactic's default; 0 = no safe spot: not sent)
    start_after: float | None = None  # minutes after the decision before which its effect does not start (an aircraft cooling the ground just before a crew goes in)


def plan_sectors(vectors: dict[str, Any], *, zone_radius_m: float = 180.0, limit: int = 12) -> list[Sector]:
    """Rank the spread vectors by danger and keep them at least two work-zones apart (a unit covers one zone)."""
    candidates: list[Sector] = []
    for feature in (vectors or {}).get("features", []):
        geometry, props = feature.get("geometry") or {}, feature.get("properties") or {}
        if geometry.get("type") != "Point" or props.get("bearingDeg") is None or props.get("speedMmin") is None:
            continue
        lon, lat = geometry["coordinates"][:2]
        candidates.append(
            Sector(float(lat), float(lon), float(props["bearingDeg"]), float(props["speedMmin"]), float(props.get("intensityKwm") or 0.0), bool(props.get("crown")))
        )
    candidates.sort(key=lambda s: s.danger, reverse=True)
    kept: list[Sector] = []
    for sector in candidates:
        if all(distance_m(sector.lat, sector.lon, other.lat, other.lon) >= 2 * zone_radius_m for other in kept):
            kept.append(sector)
        if len(kept) >= limit:
            break
    return kept


def slot_shift(slot: int, step_m: float) -> float:
    """Slot 0 stays put; 1, 2, 3, 4... move to alternate sides, one ``step_m`` further each pair (never zero for slot > 0)."""
    return ((slot + 1) // 2) * step_m * (1 if slot % 2 else -1)


def assign_units(
    units: Sequence[tuple[str, str]],
    sectors: Sequence[Sector],
    places: Sequence[dict[str, Any]],
    *,
    budgets: dict[str, float] | None = None,
    concentration: int | None = None,
) -> dict[str, Assignment]:
    """``units`` are ``(agent_id, tier)``; helicopters pick first, then trucks, then squads (stable by id).

    Each unit takes the least-used sector of its tier's share; ``slot`` counts the units already there, so they can be
    laid side by side along the front. Threatened places are dealt round-robin within each tier, most urgent first.

    With ``budgets`` (metres of line per unit) every unit's line is as long as it can build. With ``concentration`` too, the
    metres are spent on the ``concentration`` most dangerous sectors, in proportion to their danger, and the units of a sector
    are laid end to end as **one barrier** instead of piled up in parallel.
    """
    if budgets is not None and concentration:
        return _assign_barriers(units, sectors, places, budgets, concentration)
    assigned = _assign_by_tier(units, sectors, places)
    if budgets is None:
        return assigned
    return {
        agent_id: Assignment(a.sector, a.slot, a.place, segment_m=budgets.get(agent_id), offset_m=slot_shift(a.slot, budgets.get(agent_id) or 0.0))
        for agent_id, a in assigned.items()
    }


def _assign_barriers(units: Sequence[tuple[str, str]], sectors: Sequence[Sector], places: Sequence[dict[str, Any]], budgets: dict[str, float], concentration: int) -> dict[str, Assignment]:
    order = {"helicopter": 0, "truck": 1, "squad": 2}
    ranked = sorted(units, key=lambda u: (order.get(u[1], 9), u[0]))
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
    for agent_id, tier in ranked:
        b = budgets.get(agent_id) or 0.0
        sector = min(top, key=lambda s: ((allocated[s] + b) / weight[s], top.index(s)))  # fill each sector in proportion to its danger
        allocated[sector] += b
        members[sector].append((agent_id, tier))
    for sector, group in members.items():
        total, cumulative = allocated[sector], 0.0
        for slot, (agent_id, tier) in enumerate(group):
            segment = budgets.get(agent_id) or 0.0
            out[agent_id] = Assignment(sector, slot, place_for(tier), segment_m=segment, offset_m=cumulative + segment / 2 - total / 2)
            cumulative += segment
    return out


def _assign_by_tier(units: Sequence[tuple[str, str]], sectors: Sequence[Sector], places: Sequence[dict[str, Any]]) -> dict[str, Assignment]:
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
    for agent_id, tier in sorted(units, key=lambda u: (order.get(u[1], 9), u[0])):
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
