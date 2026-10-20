"""Buildings in the fire's way, grouped into zones a fire engine can defend.

``GET /simulations/{id}/threatened`` only names *places*; most houses lost in a rural fire belong to none (Penha: 0 places threatened, 30+
buildings burned). The buildings come from ``GET /locations/{id}/buildings`` (one point per grid cell, with a count) and the moment the fire
reaches each cell from the forecast's own ignition grid, so a zone is a patch of ground the forecast says will burn soon with houses on it.
"""
from __future__ import annotations

import array
import sys
from dataclasses import dataclass
from typing import Any, Sequence

from .sectors import distance_m, zone_around

DEFENDERS_PER_ZONE = 3  # assumption: three engines on one zone combine to ~0.7+ (the backend multiplies each engine's own factor)
MIN_ZONE_SEPARATION = 1.6  # zone centres at least this many radii apart, so the discs do not pile on the same houses


@dataclass(frozen=True)
class BuildingZone:
    """A patch of ground with houses on it that the fire reaches ``arrival_min`` after the decision."""

    lat: float
    lon: float
    buildings: int
    people: int
    arrival_min: float
    radius_m: float

    def asset(self, index: int) -> dict[str, Any]:
        """The zone as an ``assetType: building_zone`` item an agent can be assigned (it is not a backend place)."""
        arrival = max(self.arrival_min, 0.0)
        return {
            "id": f"zone-{index}",
            "assetType": "building_zone",
            "name": f"{self.buildings} edifícios a {self.lat:.4f},{self.lon:.4f}",
            "position": {"lat": self.lat, "lon": self.lon},
            "population": self.people,
            "buildings": self.buildings,
            "arrivalMinute": {"p10": arrival, "p50": arrival, "p90": arrival},
            "geometry": zone_around(self.lat, self.lon, 0.0, self.radius_m, 0, 12),
        }


def ignition_minutes(raw: bytes) -> Sequence[int]:
    """The ``ignition`` grid (int16 little-endian, minute the fire reaches each cell, -1 = never) from its bytes."""
    values = array.array("h")
    values.frombytes(raw)
    if sys.byteorder == "big":
        values.byteswap()
    return values


def building_cells(grid: dict[str, Any], features: Sequence[dict[str, Any]]) -> dict[int, tuple[float, float, int, int]]:
    """``{cell index: (lat, lon, buildings, people)}`` on the simulation's grid (row 0 = north)."""
    width, height = int(grid["width"]), int(grid["height"])
    cells: dict[int, tuple[float, float, int, int]] = {}
    for feature in features:
        lon, lat = feature["geometry"]["coordinates"]
        col, row = int((lon - grid["lonWest"]) / grid["dLon"]), int((grid["latNorth"] - lat) / grid["dLat"])
        if 0 <= col < width and 0 <= row < height:
            props = feature.get("properties") or {}
            cells[row * width + col] = (lat, lon, int(props.get("buildings") or 0), int(props.get("estimatedPeople") or 0))
    return cells


def zones_to_defend(
    cells: dict[int, tuple[float, float, int, int]],
    ignition: Sequence[int],
    *,
    after_min: float,
    until_min: float,
    radius_m: float,
    max_zones: int,
) -> list[BuildingZone]:
    """Zones over the buildings the forecast fire reaches in ``(after_min, until_min]``, the most houses (then the soonest) first."""
    burning = [c for i, c in cells.items() if i < len(ignition) and after_min < ignition[i] <= until_min and c[2] > 0]
    if not burning or max_zones <= 0:
        return []
    centres: list[tuple[float, float]] = []
    for lat, lon, count, _people in sorted(burning, key=lambda c: -c[2]):
        if all(distance_m(lat, lon, a, b) > MIN_ZONE_SEPARATION * radius_m for a, b in centres):
            centres.append((lat, lon))
    totals = [[0, 0, float("inf")] for _ in centres]  # buildings, people, earliest arrival
    for i, cell in cells.items():  # each burning cell counts for its nearest centre, if that is within the radius
        if not (i < len(ignition) and after_min < ignition[i] <= until_min and cell[2] > 0):
            continue
        nearest = min(range(len(centres)), key=lambda k: distance_m(cell[0], cell[1], *centres[k]))
        if distance_m(cell[0], cell[1], *centres[nearest]) <= radius_m:
            totals[nearest][0] += cell[2]
            totals[nearest][1] += cell[3]
            totals[nearest][2] = min(totals[nearest][2], float(ignition[i]) - after_min)
    zones = [
        BuildingZone(lat, lon, int(t[0]), int(t[1]), t[2], radius_m)
        for (lat, lon), t in zip(centres, totals)
        if t[0] > 0
    ]
    zones.sort(key=lambda z: (-z.buildings, z.arrival_min))
    return zones[:max_zones]
