"""Fuel breaks: crews open a strip of cleared ground *ahead* of the fire, where it has not yet arrived.

This is what plan A does with the squads that are not on the fire's outline. It is the safest way to fight a fire there is: the crew works on ground that is
not burning, and the strip is done before the fire gets to it. The engine applies a ``fuel_removal`` strip from minute 0 of the run, whatever the time a crew
needs to open it, so **the feasibility is the agent's job and is checked here**, with the backend's own numbers:

* the crew opens ``CREW_RATE_M_PER_H_PER_PERSON`` metres per person per hour (``Routing``-like setting in the backend's ``appsettings.json``, not in ``/rules``);
  the strip is as long as the crew can open in ``BUILD_MINUTES``;
* the crew must get there (``POST /routing/route``) and finish ``MARGIN_MIN`` minutes before the fire reaches the strip (the baseline's perimeters say when);
* the strip lies across the sector's heading, ahead of its head, as near as that allows.

A strip that cannot be done in time is not drawn: the squad keeps its handline.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from .sectors import Sector, destination

CREW_RATE_M_PER_H_PER_PERSON = 15.0  # = backend InterventionSettings.FuelRemoval.CrewRateMPerHourPerPerson (appsettings.json); the contract does not expose it
STRIP_WIDTH_M = 20.0  # = backend FuelRemoval.DefaultWidthM
BUILD_MINUTES = 90
MARGIN_MIN = 20  # the strip is finished this long before the fire reaches it
MIN_LENGTH_M = 80.0
MAX_LENGTH_M = 900.0
FIRST_AHEAD_M = 500.0  # nearest the strip may be to the head
STEP_AHEAD_M = 250.0
MAX_AHEAD_M = 4000.0


@dataclass(frozen=True)
class Strip:
    """A strip a crew can open before the fire arrives."""

    geometry: dict[str, Any]  # GeoJSON Polygon (the contract's InterventionFuelRemoval takes a polygon)
    center: dict[str, float]
    length_m: float
    build_minutes: int
    eta_minutes: float
    ahead_m: float
    route: dict[str, Any] | None = None
    from_station: str | None = None


def strip_polygon(lat: float, lon: float, bearing_deg: float, length_m: float, width_m: float = STRIP_WIDTH_M) -> dict[str, Any]:
    """A rectangle ``length_m`` long across ``bearing_deg`` (the way the fire heads) and ``width_m`` wide, centred on (lat, lon)."""
    across = (bearing_deg + 90.0) % 360.0
    corners = []
    for side, along in ((1, 1), (1, -1), (-1, -1), (-1, 1)):
        lat1, lon1 = destination(lat, lon, across, side * length_m / 2.0)
        lat2, lon2 = destination(lat1, lon1, bearing_deg, along * width_m / 2.0)
        corners.append([lon2, lat2])
    return {"type": "Polygon", "coordinates": [[*corners, corners[0]]]}


def inside(ring: list[list[float]], lat: float, lon: float) -> bool:
    """Ray casting: is (lat, lon) inside the ring (``[lon, lat]`` points)?"""
    hit = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def burning_in(perimeters: dict[str, Any], lat: float, lon: float) -> bool:
    """Is the point inside any of the burned-area outlines of a ``PerimeterCollection`` (the widest contour counts: the safe answer)?"""
    for feature in (perimeters or {}).get("features") or []:
        geometry = feature.get("geometry") or {}
        polygons = geometry.get("coordinates") or []
        for polygon in polygons if geometry.get("type") == "MultiPolygon" else [polygons]:
            if polygon and inside(polygon[0], lat, lon):
                return True
    return False


def plan_strip(
    sector: Sector,
    people: int,
    decided_at: float,
    *,
    travel: Callable[[dict[str, float]], Any],
    perimeters_at: Callable[[int], dict[str, Any]],
) -> Strip | None:
    """The nearest strip across ``sector``'s heading, ahead of its head, that ``people`` can open before the fire gets there; ``None`` if there is none.

    ``travel(point)`` answers like ``TravelPlanner.eta`` (``reachable``, ``eta_minutes``, ``from_station``, ``geometry``); ``perimeters_at(minute)`` is the baseline's
    burned area at that minute.
    """
    length = min(MAX_LENGTH_M, CREW_RATE_M_PER_H_PER_PERSON * max(people, 0) * BUILD_MINUTES / 60.0)
    if length < MIN_LENGTH_M:
        return None
    ahead = FIRST_AHEAD_M
    while ahead <= MAX_AHEAD_M:
        lat, lon = destination(sector.lat, sector.lon, sector.bearing_deg, ahead)
        center = {"lat": lat, "lon": lon}
        route = travel(center)
        if route.reachable and route.eta_minutes is not None:
            ready = int(round(decided_at + route.eta_minutes + BUILD_MINUTES + MARGIN_MIN))
            perimeters = perimeters_at(ready)
            polygon = strip_polygon(lat, lon, sector.bearing_deg, length)
            corners = polygon["coordinates"][0][:-1]
            if not burning_in(perimeters, lat, lon) and not any(burning_in(perimeters, c[1], c[0]) for c in corners):
                return Strip(polygon, center, round(length), BUILD_MINUTES, float(route.eta_minutes), ahead, getattr(route, "geometry", None), getattr(route, "from_station", None))
        ahead += STEP_AHEAD_M
    return None
