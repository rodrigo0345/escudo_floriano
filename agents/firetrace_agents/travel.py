"""How long a unit takes to get where its action is, from the backend's own routing.

Until now every unit was on site at minute 0. ``POST /routing/route`` knows the road network, the closures and where the simulation predicts the
fire, so the time to arrive comes from there:

* a ground unit drives from its station (``fromStationId``) to the road end nearest the target, avoiding closures and the predicted fire;
* the stretch from the road end to the target is not on the network: a vehicle that can leave the road drives it at ``Rules.movement.offRoadSpeedKmh``,
  anyone else walks it (``WALK_SPEED_KMH``) and beyond ``MAX_LAST_MILE_M`` the target is not reachable. Both mirror the backend's own limits
  (``Routing.WalkKmh`` and ``Routing.MaxSnapM`` in appsettings), which it applies when it checks a plan: ``GET /routing/route`` returns the drive only,
  with ``no_road_access`` beyond that distance, so the walk is added here;
* a helicopter flies straight from its base at the cruise speed of ``Rules.aerial.helicopter``.

A unit that cannot arrive is not assigned. The backend uses the ``start`` of each effect it is given, so the orchestrator writes the ETA there.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .client import ApiProblem, FiretraceClient
from .firefighter import FirefighterAgent
from .sectors import distance_m
from .tiers import FirefighterTier

WALK_SPEED_KMH = 3.0  # = backend Routing.WalkKmh (appsettings); the contract does not expose it
MAX_LAST_MILE_M = 500.0  # = backend Routing.MaxSnapM (appsettings): farther from a road than this the backend answers no_road_access
DEFAULT_OFF_ROAD_KMH = 15.0
DEFAULT_HELICOPTER_KMH = 180.0
CACHE_LIMIT = 20000


@dataclass(frozen=True)
class Travel:
    """What it takes one unit to reach one point."""

    reachable: bool
    eta_minutes: float | None  # None: could not be computed (no base, routing unavailable): the plan says nothing about arrival
    reason: str
    from_station: str | None = None
    drive_minutes: float = 0.0
    last_mile_m: float = 0.0
    last_mile_minutes: float = 0.0
    geometry: dict[str, Any] | None = None
    """The road the backend routed the unit along (GeoJSON LineString): the plan carries it so the unit is shown on the road, not across the terrain."""

    def describe(self) -> str:
        if not self.reachable:
            return f"não chega: {self.reason}"
        if self.eta_minutes is None:
            return f"chegada desconhecida ({self.reason})"
        extra = f" + {self.last_mile_m:.0f} m ({self.last_mile_minutes:.0f} min) fora da estrada" if self.last_mile_m else ""
        return f"chega em ~{self.eta_minutes:.0f} min ({self.drive_minutes:.0f} min de estrada{extra})"


def centroid(geometry: dict[str, Any] | None) -> dict[str, float] | None:
    """The middle of a GeoJSON Point, LineString or Polygon as a ``LatLon``."""
    if not geometry:
        return None
    kind, coords = geometry.get("type"), geometry.get("coordinates")
    if kind == "Point":
        points = [coords]
    elif kind == "LineString":
        points = coords
    elif kind == "Polygon":
        points = coords[0][:-1] if coords and len(coords[0]) > 1 else (coords[0] if coords else [])
    else:
        return None
    points = [p for p in points if p and len(p) >= 2]
    if not points:
        return None
    return {"lat": sum(p[1] for p in points) / len(points), "lon": sum(p[0] for p in points) / len(points)}


class TravelPlanner:
    """Time to arrive for the units of one planning cycle. Routes are cached: candidates over the same forecast ask the same questions."""

    def __init__(
        self, client: FiretraceClient, *, location_id: str, simulation_id: str, at: str | None, rules: dict[str, Any] | None, cache: dict[Any, Travel] | None = None,
        avoid_fire: bool = True,
    ) -> None:
        """``avoid_fire=False`` leaves the predicted fire out of the route: how long the drive takes, for a target that is itself burning."""
        self.client, self.location_id, self.at = client, location_id, at
        self.avoid_fire = avoid_fire
        self.simulation_id = simulation_id if avoid_fire else ""
        movement = (rules or {}).get("movement") or {}
        helicopter = (((rules or {}).get("aerial") or {}).get("helicopter")) or {}
        self.off_road_kmh = float(movement.get("offRoadSpeedKmh") or DEFAULT_OFF_ROAD_KMH)
        self.helicopter_kmh = float(helicopter.get("cruiseSpeedKmh") or DEFAULT_HELICOPTER_KMH)
        self._cache = cache if cache is not None else {}
        self._stations: dict[str, dict[str, float] | None] = {}
        self._org_stations: dict[str, list[tuple[str, dict[str, float]]]] = {}
        self.unavailable = False  # set once the routing endpoint failed: the cycle goes on without ETAs instead of trying every unit

    def eta(self, agent: FirefighterAgent, target: dict[str, Any]) -> Travel:
        station = agent.observation.station_id or self._home_station(agent, target)
        key = (agent.tier.value, station, agent.observation.vehicle_type, round(float(target["lat"]), 3), round(float(target["lon"]), 3), self.simulation_id, self.at)
        if key not in self._cache:
            if len(self._cache) > CACHE_LIMIT:
                self._cache.clear()
            self._cache[key] = self._compute(agent, target, station)
        return self._cache[key]

    def _home_station(self, agent: FirefighterAgent, target: dict[str, Any]) -> str | None:
        """A crew registered to its organization and not to a station (the generic pool) leaves from the organization's station nearest the target."""
        organization = agent.observation.organization_id
        if agent.observation.vehicle_id or not organization or agent.tier is FirefighterTier.HELICOPTER:
            return None
        if organization not in self._org_stations:
            try:
                found = self.client.list_stations(organization)
            except ApiProblem:
                found = []
            self._org_stations[organization] = [(str(s["id"]), s["position"]) for s in found if s.get("position")]
        stations = self._org_stations[organization]
        if not stations:
            return None
        return min(stations, key=lambda s: distance_m(float(target["lat"]), float(target["lon"]), float(s[1]["lat"]), float(s[1]["lon"])))[0]

    # -- ways to get there -----------------------------------------------------------
    def _compute(self, agent: FirefighterAgent, target: dict[str, Any], station: str | None) -> Travel:
        if not station:
            return Travel(True, None, "a unidade não tem posto")
        if agent.tier is FirefighterTier.HELICOPTER:
            return self._fly(station, target)
        if self.unavailable:
            return Travel(True, None, "encaminhamento indisponível", station)
        request: dict[str, Any] = {"locationId": self.location_id, "fromStationId": station, "to": {"lat": float(target["lat"]), "lon": float(target["lon"])}}
        if self.avoid_fire:
            request["simulationId"] = self.simulation_id
        if self.at:
            request["at"] = self.at
        if agent.observation.vehicle_type:
            # the whole profile, as the backend's own checks use it (width, weight, slope...): a route that only knows the type may use a road the vehicle cannot
            request["vehicle"] = {"vehicleType": agent.observation.vehicle_type, **(agent.observation.profile or {})}
        try:
            route = self.client.route(request)
        except ApiProblem as error:
            self.unavailable = True
            return Travel(True, None, f"encaminhamento falhou [{error.code}]", station)
        if not route.get("found"):
            # why: what blocks the roads (closure, predicted fire), else the backend's own warning (no_road_access, no_route, no_safe_route)
            why = sorted({str(b.get("reason")) for b in route.get("blockedBy") or []}) or sorted({str(w.get("code")) for w in route.get("warnings") or [] if w.get("code")})
            return Travel(False, None, "sem rota" + (f" ({', '.join(why)})" if why else ""), station)
        drive = float(route.get("durationMin") or 0.0)
        gap = self._gap_m(route, target)
        if gap > MAX_LAST_MILE_M:
            return Travel(False, None, f"a estrada mais próxima fica a {gap:.0f} m do alvo", station, drive, gap)
        speed = self.off_road_kmh if agent.observation.off_road else WALK_SPEED_KMH
        walk = gap / 1000.0 / speed * 60.0
        return Travel(True, drive + walk, "estrada", station, drive, gap, walk, geometry=route.get("geometry"))

    def _fly(self, station: str, target: dict[str, Any]) -> Travel:
        base = self._station_position(station)
        if base is None:
            return Travel(True, None, "posição da base desconhecida", station)
        minutes = distance_m(base["lat"], base["lon"], float(target["lat"]), float(target["lon"])) / 1000.0 / self.helicopter_kmh * 60.0
        return Travel(True, minutes, "voo directo", station, minutes)

    def station_position(self, station_id: str) -> dict[str, float] | None:
        """Where a station is (cached): the GNR agent ranks its patrols by how near their station is."""
        return self._station_position(station_id)

    def _station_position(self, station_id: str) -> dict[str, float] | None:
        if station_id not in self._stations:
            try:
                self._stations[station_id] = self.client.get_station(station_id).get("position")
            except ApiProblem:
                self._stations[station_id] = None
        return self._stations[station_id]

    @staticmethod
    def _gap_m(route: dict[str, Any], target: dict[str, Any]) -> float:
        """How far the end of the route is from the target: the part nobody can drive on the network."""
        coordinates = (route.get("geometry") or {}).get("coordinates") or []
        if not coordinates:
            return 0.0
        lon, lat = coordinates[-1][0], coordinates[-1][1]
        gap = distance_m(lat, lon, float(target["lat"]), float(target["lon"]))
        return 0.0 if math.isnan(gap) else gap
