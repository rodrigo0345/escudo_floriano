"""The ground where a crew works: what slope, fuel and access do to its work, and whether the fire is running uphill at it.

The backend's engine slows a road trip on a steep road, but it does not slow a *crew* on a steep slope: a crew's effect is ``f(people, water)`` and nothing else.
A commander does not forget that. Fighting fire on a 30° slope is slow, tiring and dangerous (the fire runs up it faster than anyone can climb, and what burns
below rolls and falls above); in a eucalyptus plantation a direct attack gets spotting and crowning that grass never does; a hose reaches 80 m from the road, not 400.
So, here, the agents carry that knowledge themselves, where the backend does not: each crew's effect is scaled by how workable its ground is, and the plan
says why (``safetyNotes``), so an operator can see and argue with it.

Everything numeric below is a **starting assumption to calibrate with the corporations** (as in ``capacity.py`` and ``life.py``), kept in this one place.
The assessment itself (:func:`assess`) is a pure function of the backend's ``GET /locations/{id}/terrain-at`` answer, the fire's heading and the unit's kind.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any

from .client import ApiProblem, FiretraceClient

log = logging.getLogger("firetrace.terrain")

# ---- how slope slows a crew's work: (slope in degrees, share of its work it still does), linear in between
SLOPE_BANDS: tuple[tuple[float, float], ...] = ((10.0, 1.0), (20.0, 0.8), (30.0, 0.55), (40.0, 0.35), (60.0, 0.2))
ENGINE_SLOPE_SHARE = 0.7  # an engine works from the road with hose lines and pumps: it suffers the slope less than a crew climbing it
UPHILL_RUN_MIN_SLOPE_DEG = 12.0  # a fire heading up a slope at least this steep accelerates (about doubling its spread for every 10° or so) and outruns crews
UPHILL_ARC_DEG = 45.0  # the fire is "going up" the slope when its heading is within this of straight up
UPHILL_RUN_FACTOR = 0.8
STEEP_FAR_FROM_ROAD_DEG = 25.0  # steeper than this and farther from a road than ROAD_FAR_M, an engine's lines do not reach: it is working from too far
ROAD_FAR_M = 80.0
FAR_FROM_ROAD_FACTOR = 0.7
MIN_FACTOR = 0.30

# ---- how fuel changes what a direct attack can do (keys are the backend's land-cover classes, ``GET /locations/{id}/vegetation``)
FUEL_FACTOR: dict[str, float] = {
    "agua": 1.0, "rocha": 1.0, "pasto": 1.0, "agricola": 1.0,  # nothing to burn, or a light fuel that burns out and is put out quickly
    "urbano": 0.9, "mato": 0.8, "folhosas": 0.7, "pinheiro": 0.65, "floresta": 0.65, "eucalipto": 0.6,  # heavier fuel: more heat, spotting, crowning
}
DEFAULT_FUEL_FACTOR = 0.8

# ---- a hose and a pump need water: the refill cycle of an engine is a round trip by road to the source a truck reaches soonest, and the time to fill
# its tank at that source's flow (the backend's unit simulator does the same: ``UnitDuty``, ``OperationSimulator.FindTripAsync``)
REFILL_RADIUS_M = 25_000.0
REFILL_SOURCES = 8  # the nearest in a straight line, of which the soonest by road
DEFAULT_REFILL_KINDS = ("hydrant", "dry_hydrant", "tank", "reservoir", "pond")
ROAD_DETOUR = 1.4  # road distance over straight-line distance, for the estimate when the backend cannot route from the engine's spot
ESTIMATE_KMH = 35.0


@dataclass(frozen=True)
class RefillSource:
    """Where an engine working at a place fills up: the water point, the drive there (one way, min) and its flow (L/min)."""

    point_id: str
    name: str
    drive_minutes: float
    flow_lpm: float

    def gap_minutes(self, water_l: float, setup_minutes: float) -> float:
        """Minutes away from the fire per refill: there and back, the setup, and filling the tank at the point's flow."""
        return 2.0 * self.drive_minutes + setup_minutes + (water_l / self.flow_lpm if self.flow_lpm > 0 else 0.0)

    def note(self, water_l: float, setup_minutes: float) -> str:
        return (f"Reabastece água em {self.name} (~{self.drive_minutes:.0f} min por estrada, {water_l / self.flow_lpm + setup_minutes:.0f} min a encher): "
                f"fora do combate ~{self.gap_minutes(water_l, setup_minutes):.0f} min por tanque.")


@dataclass(frozen=True)
class TerrainAssessment:
    """What the ground at one point does to the work of one kind of unit."""

    slope_deg: float
    aspect_deg: float
    elevation_m: float
    fuel_key: str
    fuel_label: str
    road_distance_m: float | None
    uphill_bearing_deg: float
    fire_runs_uphill: bool  # the fire is heading up this slope: attack from the flanks or the burned side, never from above
    slope_factor: float
    fuel_factor: float
    factor: float  # share of its normal work a crew does here (1 = flat, light fuel, next to a road)
    flags: tuple[str, ...] = field(default_factory=tuple)  # what a commander would say about this ground, in plain Portuguese

    def note(self, applied: bool = True) -> str:
        """The terrain in one sentence, with what it does (empty when the ground is easy).

        ``applied`` says whether the crew's effect was scaled: an effect the backend models by work rate rather than by strength (a fuel strip) is not, and the note
        then says the work is slower than planned, for the operator to check, instead of claiming a scaling that did not happen.
        """
        if not self.flags:
            return ""
        if applied:
            return f"Terreno: {'; '.join(self.flags)}. Eficácia do meio no local ×{self.factor:.2f}."
        return f"Terreno: {'; '.join(self.flags)}. O trabalho no local avança mais devagar (×{self.factor:.2f}): confirmar que acaba antes de o fogo chegar."

    def facts(self) -> dict[str, Any]:
        """The same, as the facts an LLM commander reads (numbers and flags, no prose to paraphrase)."""
        return {
            "slopeDeg": round(self.slope_deg, 1), "uphillBearingDeg": round(self.uphill_bearing_deg), "elevationM": round(self.elevation_m),
            "fuel": self.fuel_key, "roadDistanceM": None if self.road_distance_m is None else round(self.road_distance_m),
            "fireRunsUphill": self.fire_runs_uphill, "workability": round(self.factor, 2), "flags": list(self.flags),
        }


def slope_factor(slope_deg: float) -> float:
    """Share of its work a crew does on a slope of ``slope_deg`` degrees (``SLOPE_BANDS``, linear between the bands, flat below the first)."""
    slope = max(0.0, slope_deg)
    previous_slope, previous_factor = 0.0, 1.0
    for band_slope, band_factor in SLOPE_BANDS:
        if slope <= band_slope:
            if band_slope == previous_slope:
                return band_factor
            return previous_factor + (band_factor - previous_factor) * (slope - previous_slope) / (band_slope - previous_slope)
        previous_slope, previous_factor = band_slope, band_factor
    return SLOPE_BANDS[-1][1]


def bearing_difference(a: float, b: float) -> float:
    """The smaller angle (0..180) between two bearings."""
    return abs((a - b + 180.0) % 360.0 - 180.0)


def assess(point: dict[str, Any], *, head_bearing_deg: float | None = None, tier: str = "squad") -> TerrainAssessment:
    """The ground at ``point`` (a ``TerrainPoint`` from ``GET /locations/{id}/terrain-at``) for a unit of ``tier`` (``squad``, ``truck``, ``helicopter``).

    ``head_bearing_deg`` is where the fire is heading to (0 = north): it decides whether the fire is running up this slope. Aircraft are not slowed by the ground
    (their limits are wind, smoke and daylight), so for them the factor is 1; the flags still say what the ground is.
    """
    slope = float(point.get("slopeDeg") or 0.0)
    aspect = float(point.get("aspectDeg") or 0.0)  # where the slope faces, i.e. downhill
    uphill = (aspect + 180.0) % 360.0
    vegetation = point.get("vegetation") or {}
    fuel_key = str(vegetation.get("key") or "")
    fuel_label = str(vegetation.get("label") or fuel_key or "desconhecido")
    road = (point.get("nearestRoad") or {}).get("distanceM")
    road_distance = None if road is None else float(road)

    runs_uphill = head_bearing_deg is not None and slope >= UPHILL_RUN_MIN_SLOPE_DEG and bearing_difference(head_bearing_deg, uphill) <= UPHILL_ARC_DEG
    on_foot_slope = slope_factor(slope)
    if tier == "truck":
        slope_part = 1.0 - (1.0 - on_foot_slope) * ENGINE_SLOPE_SHARE
    elif tier == "helicopter":
        slope_part = 1.0
    else:
        slope_part = on_foot_slope
    fuel_part = FUEL_FACTOR.get(fuel_key, DEFAULT_FUEL_FACTOR) if tier != "helicopter" else 1.0
    factor = slope_part * fuel_part

    flags: list[str] = []
    if slope >= 10.0:
        flags.append(f"encosta de {slope:.0f}°" + (" (muito íngreme: a pé é lento e perigoso)" if slope >= 30.0 else ""))
    if runs_uphill:
        flags.append("o fogo sobe esta encosta: atacar pelos flancos ou do lado já ardido, nunca por cima")
        if tier != "helicopter":
            factor *= UPHILL_RUN_FACTOR
    if tier == "truck" and slope >= STEEP_FAR_FROM_ROAD_DEG and road_distance is not None and road_distance > ROAD_FAR_M:
        flags.append(f"a {road_distance:.0f} m da estrada em encosta íngreme: as mangueiras não chegam")
        factor *= FAR_FROM_ROAD_FACTOR
    if fuel_part < 0.75 and tier != "helicopter":
        flags.append(f"combustível pesado ({fuel_label.lower()}): projeções e fogo de copas")
    if tier == "helicopter" and slope >= 25.0:
        flags.append(f"encosta de {slope:.0f}°: terreno difícil a pé, o meio aéreo é a melhor aposta aqui")
    return TerrainAssessment(slope, aspect, float(point.get("elevationM") or 0.0), fuel_key, fuel_label, road_distance, uphill, runs_uphill, slope_part, fuel_part,
                             max(MIN_FACTOR, factor) if tier != "helicopter" else 1.0, tuple(flags))


def apply_to_effect(effect: dict[str, Any], assessment: TerrainAssessment) -> bool:
    """Scale the ``effectiveness`` of a crew's effect by how workable its ground is. Returns True if the effect changed."""
    if effect.get("type") not in {"crew_deployment", "fire_line", "fuel_removal"} or assessment.factor >= 0.995 or effect.get("effectiveness") is None:
        return False
    effect["effectiveness"] = round(max(0.01, min(1.0, float(effect["effectiveness"]) * assessment.factor)), 2)
    return True


class TerrainReader:
    """``terrain-at`` for the places the plans work at, asked once each (candidate plans over one fire ask the same places again and again).

    A place the backend cannot describe (outside the map, an error) has no assessment: the crew's effect is then left as it was, never invented.
    """

    def __init__(self, client: FiretraceClient, location_id: str) -> None:
        self.client, self.location_id = client, location_id
        self._points: dict[tuple[float, float], dict[str, Any] | None] = {}
        self._refill: dict[tuple[float, float], RefillSource | None] = {}

    @staticmethod
    def _key(lat: float, lon: float) -> tuple[float, float]:
        return (round(lat, 4), round(lon, 4))  # ~10 m: the grid is 30-60 m

    def point(self, lat: float, lon: float) -> dict[str, Any] | None:
        key = self._key(lat, lon)
        if key not in self._points:
            try:
                self._points[key] = self.client.terrain_at(self.location_id, lat, lon)
            except ApiProblem as error:
                log.info("terrain at %.4f,%.4f not available [%s]: %s", lat, lon, error.code, error)
                self._points[key] = None
        return self._points[key]

    def assess(self, site: dict[str, float] | None, *, head_bearing_deg: float | None, tier: str) -> TerrainAssessment | None:
        if not site:
            return None
        point = self.point(float(site["lat"]), float(site["lon"]))
        return assess(point, head_bearing_deg=head_bearing_deg, tier=tier) if point else None

    def refill_source(self, site: dict[str, float] | None, rules: dict[str, Any] | None = None) -> RefillSource | None:
        """The water point an engine working at ``site`` refills at: of the sources a truck can use (``Rules.water.refill.sources``), the one it reaches soonest by
        road. ``None`` when there is none or the backend cannot say."""
        if not site:
            return None
        key = self._key(float(site["lat"]), float(site["lon"]))
        if key not in self._refill:
            refill = (((rules or {}).get("water") or {}).get("refill") or {})
            kinds = set(refill.get("sources") or DEFAULT_REFILL_KINDS)
            best: RefillSource | None = None
            try:
                near = self.client.water_points_near(self.location_id, float(site["lat"]), float(site["lon"]), truck_only=True, limit=REFILL_SOURCES,
                                                     radius_m=REFILL_RADIUS_M, route_from={"lat": float(site["lat"]), "lon": float(site["lon"])}, kinds=sorted(kinds))
                usable = [n for n in near if (n.get("point") or {}).get("kind") in kinds and (n.get("point") or {}).get("available", True)]
                routed = any(n.get("driveMinutes") is not None for n in usable)
                for n in usable:
                    drive = n.get("driveMinutes")
                    if drive is None and not routed:
                        # the backend's generic profile does not drive the forest track an engine parks on: a road-distance estimate instead (the backend's unit
                        # simulator routes the real trip with the engine's own profile)
                        drive = float(n.get("distanceM") or 0.0) * ROAD_DETOUR / 1000.0 / ESTIMATE_KMH * 60.0
                    if drive is None or math.isnan(float(drive)) or (best is not None and float(drive) >= best.drive_minutes):
                        continue
                    point = n["point"]
                    flow = float(point.get("flowLpm") or (refill.get("hydrantFlowLpm") if point.get("kind") == "hydrant" else refill.get("defaultFlowLpm")) or 1500.0)
                    best = RefillSource(str(point.get("id")), str(point.get("name") or "ponto de água"), float(drive), flow)
            except ApiProblem as error:
                log.info("no refill source near %.4f,%.4f [%s]: %s", site["lat"], site["lon"], error.code, error)
            self._refill[key] = best
        return self._refill[key]

    def refill_gap_minutes(self, site: dict[str, float] | None, *, setup_minutes: float, water_l: float = 0.0, rules: dict[str, Any] | None = None) -> float | None:
        """Minutes an engine working at ``site`` is away on each refill (``RefillSource.gap_minutes``). ``None`` when unknown."""
        source = self.refill_source(site, rules)
        return None if source is None else source.gap_minutes(water_l, setup_minutes)
