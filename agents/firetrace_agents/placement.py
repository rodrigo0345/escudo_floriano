"""Where a crew can stand without being caught: the placement is safe from the start, instead of trimming crews once the engine finds them in the fire.

The backend's own rule (``CrewSafety``) is the one to satisfy: a crew is caught if the cell it works from (the action's ``anchorPoint``) is burning while it is
there, from the minute the fire reaches the cell until the cell has burned out (``FuelCatalog.BurnMinutes``, at most 18 min in this landscape). Ground that has
already burned out is safe, and so is ground the fire does not reach until the crew has left. So, with the forecast's own ignition grid:

* **attack from the black** (initial attack): the crew stands just inside the burned area, behind the active edge, at the minute it arrives, close enough
  (within its work zone) to work the edge. It can stay as long as a crew can work: the black does not burn again;
* **work ahead of the fire** (lines, blocking): the crew stays only until ``MARGIN_MIN`` minutes before the fire reaches its spot; if that leaves less than
  ``MIN_STAY_MIN`` of useful work, the crew is not sent there at all.

The ignition grid is the baseline's (no response): with the plan the fire is slower, so a spot reached later in reality is reached no sooner than here.
The plan's what-if (``judge.py``) still has the last word.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .sectors import Sector, destination, distance_m

BURNED_OUT_MIN = 25  # a cell this long after the fire reached it has burned out (backend BurnMinutes ≤ 18, plus margin)
MARGIN_MIN = 10  # a crew working ahead of the fire leaves this long before it arrives
MIN_STAY_MIN = 15  # less useful work than this and the crew is not sent
STEP_M = 30.0  # search step inside the burned area (about a cell)


@dataclass(frozen=True)
class FireClock:
    """When the forecast fire reaches each cell of the simulation grid."""

    grid: dict[str, Any]  # the location's grid: width, height, lonWest, latNorth, dLon, dLat (row 0 = north)
    ignition: Sequence[int]  # minute the fire reaches each cell, -1 = never

    def reached(self, lat: float, lon: float) -> int | None:
        """Minute the fire reaches the point; ``None`` if never (or outside the grid)."""
        width, height = int(self.grid["width"]), int(self.grid["height"])
        col = int((lon - float(self.grid["lonWest"])) / float(self.grid["dLon"]))
        row = int((float(self.grid["latNorth"]) - lat) / float(self.grid["dLat"]))
        if not (0 <= col < width and 0 <= row < height):
            return None
        minute = int(self.ignition[row * width + col])
        return None if minute < 0 else minute

    def block_ignitions(self, lat: float, lon: float) -> list[int]:
        """The minute the fire reaches each cell of the 3×3 block around the point (its own cell included); the cells it never reaches are left out.

        A crew is not caught only when its own cell burns: fire at the next cell is flames and heat on top of it, and it cuts the way out. So the whole block counts,
        **each cell on its own clock**: a fire leaves islands that burn long after their neighbours (a cell that went at T+69 next to one that goes at T+135).
        """
        width, height = int(self.grid["width"]), int(self.grid["height"])
        col = int((lon - float(self.grid["lonWest"])) / float(self.grid["dLon"]))
        row = int((float(self.grid["latNorth"]) - lat) / float(self.grid["dLat"]))
        if not (0 <= col < width and 0 <= row < height):
            return []
        cells = [int(self.ignition[r * width + c]) for r in range(max(0, row - 1), min(height, row + 2)) for c in range(max(0, col - 1), min(width, col + 2))]
        return [m for m in cells if m >= 0]

    def reached_around(self, lat: float, lon: float) -> int | None:
        """The earliest minute the fire reaches the cell of the point or any of the 8 around it (``None`` if it reaches none).

        Only the *first* contact with the block: whether the block is burned out or clear later needs every cell (``clear_around``, ``stay_ahead``), because the
        earliest cell says nothing about the others.
        """
        cells = self.block_ignitions(lat, lon)
        return min(cells) if cells else None

    def clear_around(self, lat: float, lon: float, start: float, end: float) -> bool:
        """Is every cell of the block around the point free of fire from ``start`` to ``end``: burned out before ``start``, or reached only after ``end``?"""
        return all(m + BURNED_OUT_MIN <= start or m > end for m in self.block_ignitions(lat, lon))

    def safe(self, lat: float, lon: float, start: float, end: float) -> bool:
        """Is the point free of fire from ``start`` to ``end`` (burned out before, or reached after)?"""
        reached = self.reached(lat, lon)
        return reached is None or reached + BURNED_OUT_MIN <= start or reached > end


BURNING_MIN = 18  # a cell burns this long after the fire reaches it (backend `FuelCatalog.BurnMinutes`, at most 18 in this landscape)
ROUTE_STEP_M = 60.0  # the route is sampled about every cell
LAST_STRETCH_M = 300.0  # the end of a route may touch the fire: that is where the crew goes to work (the work spot itself is checked separately)


def route_in_fire(clock: FireClock, geometry: dict[str, Any] | None, depart: float, drive_minutes: float, *, last_stretch_m: float = LAST_STRETCH_M) -> float | None:
    """The first minute a unit driving ``geometry`` (a GeoJSON LineString, ``[lon, lat]``) from ``depart`` in ``drive_minutes`` is on a cell that is burning then,
    or ``None`` when the whole drive (but its last ``last_stretch_m``) is on ground that is not burning when it passes: not yet reached, or burned out.

    The unit moves along the route at an even pace, as the backend's unit simulator has it (``CrewSafety.PositionOn``).
    """
    coordinates = (geometry or {}).get("coordinates") or []
    if len(coordinates) < 2 or drive_minutes <= 0:
        return None
    legs = [distance_m(a[1], a[0], b[1], b[0]) for a, b in zip(coordinates, coordinates[1:])]
    total = sum(legs)
    if total <= last_stretch_m:
        return None
    walked = 0.0
    for (a, b), leg in zip(zip(coordinates, coordinates[1:]), legs):
        steps = max(1, int(leg // ROUTE_STEP_M))
        for k in range(steps):
            at = walked + leg * k / steps
            if total - at <= last_stretch_m:
                return None
            f = k / steps
            lon, lat = a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f
            minute = depart + drive_minutes * at / total
            reached = clock.reached(lat, lon)
            if reached is not None and reached <= minute < reached + BURNING_MIN:
                return minute
        walked += leg
    return None


def black_site(clock: FireClock, sector: Sector, arrive: float, stay: float, reach_m: float) -> dict[str, float] | None:
    """A spot inside the burned area, behind ``sector``'s front, from which a crew arriving at ``arrive`` reaches the edge and is safe for ``stay`` minutes.

    The search goes from the front back towards where the fire came from (against its heading), at most ``reach_m`` (the crew's work zone), and also a step
    to either side; the first spot that has burned out by the time the crew arrives is it. ``None`` if the black is not there yet (the fire is too young or
    the edge too intense to have burned out) or is beyond the crew's reach.
    """
    back = (sector.bearing_deg + 180.0) % 360.0
    distance = STEP_M
    while distance <= reach_m:
        for side in (0.0, -STEP_M * 2, STEP_M * 2):
            lat, lon = destination(sector.lat, sector.lon, back, distance)
            if side:
                lat, lon = destination(lat, lon, (sector.bearing_deg + 90.0) % 360.0, side)
            reached = clock.reached(lat, lon)
            if reached is not None and reached + BURNED_OUT_MIN <= arrive and clock.safe(lat, lon, arrive, arrive + stay):
                return {"lat": lat, "lon": lon}
        distance += STEP_M
    return None


def edge_site(clock: FireClock, sector: Sector, arrive: float, wanted: float, reach_m: float) -> tuple[dict[str, float], int] | None:
    """A spot just ahead of ``sector``'s edge from which a crew attacks it directly, and how long it may stay: ``None`` if there is none within ``reach_m``.

    A young fire has no black yet (nothing has burned out when the first crews arrive), but its back and weak flanks are attacked at the edge itself: the crew
    stands on the unburned side, within reach of the flames, and leaves ``MARGIN_MIN`` before the fire gets to its cell (the backend's ``CrewSafety`` looks at
    that cell only; ``stay_ahead`` also keeps clear of the cells around, which on a 60 m grid leaves no spot within reach of a young fire's edge). The search
    goes out from the edge along the stretch's own bearing, a step at a time, and a step to either side; the nearest spot with at least ``MIN_STAY_MIN`` of work
    is it.
    """
    distance = STEP_M
    while distance <= reach_m:
        for side in (0.0, -STEP_M * 2, STEP_M * 2):
            lat, lon = destination(sector.lat, sector.lon, sector.bearing_deg, distance)
            if side:
                lat, lon = destination(lat, lon, (sector.bearing_deg + 90.0) % 360.0, side)
            reached = clock.reached(lat, lon)
            if reached is not None and reached <= arrive:
                continue  # burning, or not yet burned out, when the crew gets there
            stay = int(min(wanted, reached - MARGIN_MIN - arrive)) if reached is not None else int(wanted)
            if stay >= MIN_STAY_MIN:
                return {"lat": lat, "lon": lon}, stay
        distance += STEP_M
    return None


def stay_ahead(clock: FireClock, position: dict[str, float], arrive: float, wanted: float) -> int:
    """How long a crew arriving at ``arrive`` can work at ``position`` ahead of the fire: up to ``wanted``, ending ``MARGIN_MIN`` before the fire gets there.

    0 when that is less than ``MIN_STAY_MIN`` (the crew is not sent), or when the spot is already burning.
    """
    here = clock.reached(float(position["lat"]), float(position["lon"]))
    if here is not None and here + BURNED_OUT_MIN <= arrive:
        return int(wanted)  # already burned out: nothing left to burn there
    # the block around the crew, not only its own cell, and each cell on its own clock: the cells that have burned out by then no longer count, the first of the
    # others (burning, or still to burn) sets when the crew must leave (the earliest cell of all said nothing of a cell that burns later, after its neighbours)
    ahead = [m for m in clock.block_ignitions(float(position["lat"]), float(position["lon"])) if m + BURNED_OUT_MIN > arrive]
    if not ahead:
        return int(wanted)
    room = min(ahead) - MARGIN_MIN - arrive
    return int(min(wanted, room)) if room >= MIN_STAY_MIN else 0
