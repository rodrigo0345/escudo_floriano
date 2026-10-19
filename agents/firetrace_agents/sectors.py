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


def assign_units(units: Sequence[tuple[str, str]], sectors: Sequence[Sector], places: Sequence[dict[str, Any]]) -> dict[str, Assignment]:
    """``units`` are ``(agent_id, tier)``; helicopters pick first, then trucks, then squads (stable by id).

    Each unit takes the least-used sector of its tier's share; ``slot`` counts the units already there, so they can be
    laid side by side along the front. Threatened places are dealt round-robin within each tier, most urgent first.
    """
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
    shift = ((slot + 1) // 2) * step_m * (1 if slot % 2 else -1)
    return destination(lat, lon, across_deg, shift) if shift else (lat, lon)


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
