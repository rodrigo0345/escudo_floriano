"""The agents that support the firefighters: Proteção Civil and INEM.

**Proteção Civil** coordinates the people side and the command:

* every evacuation gets a **shelter** (a shelter, school or town hall the fire does not reach before the evacuation is long over, the nearest such), the
  **route** there (``POST /routing/route`` from the place, avoiding the predicted fire), the people and their priority groups, and Proteção Civil as the
  supporting organization;
* the people who need help to move (care homes, schools, places flagged vulnerable) get **transport**: ambulances that can carry them
  (``evacuation_transport``), the ones INEM does not keep on standby;
* a **public alert** for every place evacuated or sheltered (cell broadcast, SMS, door to door), and for the ones that shelter a second alert set to go out
  when the fire is about to arrive (``trigger: on_fire_arrival``);
* the **command post**, at the station nearest the fire that the fire does not reach.

**INEM** keeps two ambulances on **medical standby** where the crews work, far enough back that the fire never reaches them, with the nearest hospitals on
alert. The plans predict no casualty (the safety rule), so the hospitals are only asked to prepare.

Everything is checked against the forecast's ignition grid (``placement.FireClock``): nobody is sent to wait where the fire will be.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .client import ApiProblem, FiretraceClient
from .placement import FireClock
from .sectors import destination, distance_m, zone_around

SHELTER_KINDS = ("shelter", "school", "town_hall")  # buildings a population can be received in (facilities of the location)
SHELTER_SAFE_AFTER_MIN = 120  # a shelter the fire reaches less than this after the evacuation ends is not safe enough
MIN_SHELTER_DISTANCE_M = 800.0  # a shelter next door to the place being evacuated is in the same danger
STANDBY_AMBULANCES = 2
STANDBY_BACK_M = (600.0, 1000.0, 1500.0, 2500.0)  # how far behind the crews the ambulances wait, nearest first
COMMAND_POST_MIN_M = 1000.0
HOSPITALS_ON_ALERT = 2
VULNERABLE_KINDS = {"care_home": "care_home", "school": "school", "camp_site": "isolated"}


@dataclass
class SupportPlan:
    """What Proteção Civil and INEM add to a plan."""

    actions: list[dict[str, Any]] = field(default_factory=list)
    issues: list[str] = field(default_factory=list)
    ambulances_left: list[dict[str, Any]] = field(default_factory=list)  # for the evacuations of people who need help to move


def _centre(geometry: dict[str, Any] | None) -> dict[str, float] | None:
    if not geometry:
        return None
    ring = (geometry.get("coordinates") or [[]])[0] if geometry.get("type") == "Polygon" else []
    points = [p for p in ring[:-1] or ring if p and len(p) >= 2]
    if not points:
        return None
    return {"lat": sum(p[1] for p in points) / len(points), "lon": sum(p[0] for p in points) / len(points)}


class SupportAgents:
    """Proteção Civil and INEM for one planning cycle."""

    def __init__(self, client: FiretraceClient, *, location_id: str, simulation_id: str, at: str | None, clock: FireClock | None, run_minutes: int,
                 civil_org: str, medical_org: str, facilities: list[dict[str, Any]], ambulances: list[dict[str, Any]], station_position: Any, route: Any) -> None:
        self.client, self.location_id, self.simulation_id, self.at = client, location_id, simulation_id, at
        self.clock, self.run_minutes = clock, run_minutes
        self.civil_org, self.medical_org = civil_org, medical_org
        self.facilities, self.ambulances = facilities, ambulances
        self.station_position = station_position  # station id → LatLon | None
        self.route = route  # (vehicle dict, LatLon) → Travel (TravelPlanner.eta on a stub)

    def _safe_all_run(self, point: dict[str, float]) -> bool:
        return self.clock is None or self.clock.safe(float(point["lat"]), float(point["lon"]), 0, self.run_minutes)

    # -- INEM -------------------------------------------------------------------------
    def standby_options(self, crew_sites: list[dict[str, float]], head_bearing: float) -> tuple[dict[str, float] | None, list[tuple[float, dict[str, float]]]]:
        """Where the ambulances could wait: the middle of the crews and, behind them (away from the fire's heading), each distance in ``STANDBY_BACK_M`` whose spot the
        fire never reaches during the run, nearest first. The rules take the first; a commander may weigh them (``advisor.py``)."""
        if not crew_sites:
            return None, []
        middle = {"lat": sum(p["lat"] for p in crew_sites) / len(crew_sites), "lon": sum(p["lon"] for p in crew_sites) / len(crew_sites)}
        back = (head_bearing + 180.0) % 360.0
        options = [(d, {"lat": lat, "lon": lon}) for d in STANDBY_BACK_M for lat, lon in [destination(middle["lat"], middle["lon"], back, d)] if self._safe_all_run({"lat": lat, "lon": lon})]
        return middle, options

    def medical_standby(self, crew_sites: list[dict[str, float]], head_bearing: float, decided_at: float, choice: dict[str, Any] | None = None) -> SupportPlan:
        """Two ambulances behind the crews, at the nearest safe distance; ``choice`` (``{"backM", "ambulances"}``, one of the offered options) is a commander's pick instead."""
        out = SupportPlan(ambulances_left=list(self.ambulances))
        if not crew_sites or not self.ambulances:
            return out
        middle, options = self.standby_options(crew_sites, head_bearing)
        assert middle is not None
        picked = next((spot for d, spot in options if choice and abs(d - float(choice["backM"])) < 1.0), None)
        spot = picked if picked is not None else (options[0][1] if options else None)
        if spot is None:
            out.issues.append("INEM: no spot behind the crews the fire never reaches; no medical standby")
            return out
        wanted = int(choice["ambulances"]) if choice and picked is not None else STANDBY_AMBULANCES
        ranked = sorted(self.ambulances, key=lambda v: self._distance_from_station(v, spot))
        resources: list[dict[str, Any]] = []
        for vehicle in ranked:
            if len(resources) >= wanted:
                break
            travel = self.route(vehicle, spot)
            if travel is not None and not travel.reachable:
                continue
            resource: dict[str, Any] = {"resourceType": "vehicle", "resourceId": vehicle["id"], "personnel": int(vehicle.get("crewCapacity") or 2), "responsibility": "medical"}
            if travel is not None and travel.eta_minutes is not None:
                resource["etaMinutes"] = round(travel.eta_minutes, 1)
                if travel.from_station:
                    resource["fromStationId"] = travel.from_station
            resources.append(resource)
        if not resources:
            out.issues.append("INEM: no ambulance reaches the standby spot")
            return out
        used = {r["resourceId"] for r in resources}
        out.ambulances_left = [v for v in self.ambulances if v["id"] not in used]
        hospitals = sorted((f for f in self.facilities if f.get("kind") == "hospital" and f.get("position")), key=lambda f: distance_m(middle["lat"], middle["lon"], f["position"]["lat"], f["position"]["lon"]))
        action: dict[str, Any] = {
            "id": "inem-standby",
            "type": "medical_standby",
            "title": f"INEM de prevenção atrás das equipas ({len(resources)} ambulâncias)",
            "organizationId": self.medical_org,
            "priority": "high",
            "rationale": f"Ambulâncias a {distance_m(middle['lat'], middle['lon'], spot['lat'], spot['lon']):.0f} m atrás das equipas, num ponto que o fogo previsto nunca atinge: socorro em minutos se algo correr mal. "
                         "O plano não prevê baixas, por isso os hospitais só ficam de pré-aviso.",
            "positions": [{"label": "Prevenção INEM", "position": spot}],
            "casualtyCollectionPoint": spot,
            "hospitalIds": [str(h["id"]) for h in hospitals[:HOSPITALS_ON_ALERT]],
            "hospitalAlert": "prepare",
            "resources": resources,
            "expectedDurationMinutes": max(30, int(self.run_minutes - decided_at)),
        }
        out.actions.append(action)
        return out

    def _distance_from_station(self, vehicle: dict[str, Any], point: dict[str, float]) -> float:
        base = self.station_position(vehicle.get("stationId")) if vehicle.get("stationId") else None
        return distance_m(base["lat"], base["lon"], point["lat"], point["lon"]) if base else float("inf")

    # -- Proteção Civil -----------------------------------------------------------------
    def command_post(self, anchor: dict[str, float]) -> dict[str, Any] | None:
        stations = sorted(
            (f for f in self.facilities if f.get("kind") == "fire_station" and f.get("position") and self._safe_all_run(f["position"])
             and distance_m(anchor["lat"], anchor["lon"], f["position"]["lat"], f["position"]["lon"]) >= COMMAND_POST_MIN_M),
            key=lambda f: distance_m(anchor["lat"], anchor["lon"], f["position"]["lat"], f["position"]["lon"]),
        )
        if not stations:
            return None
        station = stations[0]
        return {
            "id": "pc-command-post",
            "type": "establish_command_post",
            "title": f"Posto de comando em {station.get('name') or 'quartel'}",
            "organizationId": self.civil_org,
            "priority": "high",
            "rationale": f"O quartel mais perto do fogo ({distance_m(anchor['lat'], anchor['lon'], station['position']['lat'], station['position']['lon']) / 1000:.1f} km) que o fogo previsto não atinge: "
                         "comando, comunicações e ponto de encontro das organizações.",
            "location": {"label": station.get("name") or "Posto de comando", "position": station["position"], "facilityId": str(station["id"])},
            "commandOrganizationId": self.civil_org,
        }

    def shelter_options(self, place: dict[str, float], ready_by: float) -> list[tuple[dict[str, Any], float, float | None]]:
        """The shelters (school, town hall...) a population can go to from ``place``: not next door, and not reached by the fire until long after ``ready_by``.

        ``(facility, metres away, minute the fire reaches it or None)``, in the rules' order: real shelters before schools and town halls, then nearest first.
        """
        candidates = []
        for facility in self.facilities:
            position = facility.get("position")
            if facility.get("kind") not in SHELTER_KINDS or not position:
                continue
            away = distance_m(place["lat"], place["lon"], position["lat"], position["lon"])
            reached = self.clock.reached(float(position["lat"]), float(position["lon"])) if self.clock else None
            if away < MIN_SHELTER_DISTANCE_M or (reached is not None and reached < ready_by + SHELTER_SAFE_AFTER_MIN):
                continue
            candidates.append((0 if facility.get("kind") == "shelter" else 1, away, facility, reached))
        candidates.sort(key=lambda c: (c[0], c[1]))
        return [(facility, away, reached) for _rank, away, facility, reached in candidates]

    def shelter_for(self, place: dict[str, float], ready_by: float, prefer: str | None = None) -> dict[str, Any] | None:
        """The nearest shelter (school, town hall...) that is not next door and that the fire does not reach until long after ``ready_by``; ``prefer`` (a facility id
        among the options) is a commander's pick instead."""
        options = self.shelter_options(place, ready_by)
        if prefer is not None:
            chosen = next((f for f, _a, _r in options if str(f["id"]) == prefer), None)
            if chosen is not None:
                return chosen
        return options[0][0] if options else None

    def evacuation_choices(self, plan: dict[str, Any], people: dict[str, tuple[int, bool, str]]) -> list[dict[str, Any]]:
        """Per evacuation of ``plan``, the place's facts and the shelters it can go to (for a commander to choose among): what ``enrich_evacuations`` will use."""
        out: list[dict[str, Any]] = []
        for action in plan["actions"]:
            if action.get("type") != "evacuation":
                continue
            place = _centre(action.get("area"))
            if place is None:
                continue
            ids = [str(i) for i in action.get("placeIds") or []]
            count, vulnerable, _kind = next((people[i] for i in ids if i in people), (0, False, ""))
            ready_by = float((action.get("completeBy") or {}).get("offsetMinutes") or 60)
            options = self.shelter_options(place, ready_by)
            if len(options) < 2:
                continue  # nothing to choose between
            out.append({
                "placeId": ids[0] if ids else str(action.get("id")), "placeIds": ids, "name": action.get("title"), "people": int(count), "vulnerable": bool(vulnerable),
                "options": [{"id": str(f["id"]), "name": str(f.get("name") or "Abrigo"), "kind": f.get("kind"), "distanceKm": round(away / 1000, 1),
                             "fireReachesMin": None if reached is None else round(reached)} for f, away, reached in options[:6]],
            })
        return out

    def enrich_evacuations(self, plan: dict[str, Any], people: dict[str, tuple[int, bool, str]], ambulances: list[dict[str, Any]], shelters: dict[str, str] | None = None) -> list[str]:
        """Shelter, route, people and transport for every evacuation of ``plan`` (in place). ``people`` maps a place id to (people, vulnerable, kind); ``shelters`` is
        a commander's choice of shelter per place id (a facility id among the options), used when it is one of them."""
        issues: list[str] = []
        free = list(ambulances)
        for action in plan["actions"]:
            if action.get("type") != "evacuation":
                continue
            place = _centre(action.get("area"))
            if place is None:
                continue
            ids = [str(i) for i in action.get("placeIds") or []]
            count, vulnerable, kind = next((people[i] for i in ids if i in people), (0, False, ""))
            ready_by = float((action.get("completeBy") or {}).get("offsetMinutes") or 60)
            shelter = self.shelter_for(place, ready_by, next((shelters[i] for i in ids if shelters and i in shelters), None))
            action.setdefault("supportingOrganizationIds", [])
            if self.civil_org not in action["supportingOrganizationIds"]:
                action["supportingOrganizationIds"].append(self.civil_org)
            if count:
                action["estimatedPeople"] = int(count)
            groups = sorted({VULNERABLE_KINDS[kind]} if kind in VULNERABLE_KINDS else ({"reduced_mobility"} if vulnerable else set()))
            if groups:
                action["priorityGroups"] = groups
            if shelter is None:
                issues.append(f"{action.get('title')}: no shelter the fire does not reach; people are taken out of the fire's way without a set destination")
                continue
            action["shelters"] = [{"name": str(shelter.get("name") or "Abrigo"), "facilityId": str(shelter["id"]), "position": shelter["position"]}]
            try:
                route = self.client.route({"locationId": self.location_id, "from": place, "to": shelter["position"], "simulationId": self.simulation_id, **({"at": self.at} if self.at else {})})
            except ApiProblem:
                route = {}
            if route.get("found") and route.get("geometry"):
                action["routes"] = [{"geometry": route["geometry"]}]
            else:
                issues.append(f"{action.get('title')}: no road to {shelter.get('name')} that avoids the predicted fire; the route is left to the units on the ground")
            if groups and free:  # people who need help to move go by vehicle
                vehicle = min(free, key=lambda v: self._distance_from_station(v, place))
                travel = self.route(vehicle, place)
                if travel is None or travel.reachable:
                    free.remove(vehicle)
                    resource: dict[str, Any] = {"resourceType": "vehicle", "resourceId": vehicle["id"], "personnel": int(vehicle.get("crewCapacity") or 2), "responsibility": "evacuation"}
                    if travel is not None and travel.eta_minutes is not None:
                        resource["etaMinutes"] = round(travel.eta_minutes, 1)
                        if travel.from_station:
                            resource["fromStationId"] = travel.from_station
                    action.setdefault("resources", []).append(resource)
            action["rationale"] = (action.get("rationale") or "") + f" Destino: {shelter.get('name')} ({distance_m(place['lat'], place['lon'], shelter['position']['lat'], shelter['position']['lon']) / 1000:.1f} km), que o fogo previsto não atinge."
        return issues

    def public_alerts(self, decisions: list[Any], decided_at: float) -> list[dict[str, Any]]:
        """An alert for every place evacuated or sheltered, and for those that shelter a second one when the fire is about to arrive (``on_fire_arrival``)."""
        actions: list[dict[str, Any]] = []
        for decision in decisions:
            item = decision.item
            if not item.position:
                continue
            area = zone_around(float(item.position["lat"]), float(item.position["lon"]), 0.0, 400.0, 0, 16)
            evacuate = decision.action == "evacuate"
            text = (f"Incêndio a aproximar-se de {item.name}. Evacuação obrigatória: siga as indicações dos bombeiros e da GNR; leve documentos e medicação."
                    if evacuate else
                    f"Incêndio a aproximar-se de {item.name}. Fique em casa: feche portas e janelas, afaste-se das fachadas viradas ao fogo e aguarde indicações.")
            actions.append({
                "id": f"pc-alert-{item.id}", "type": "public_alert", "title": f"Aviso à população: {item.name}", "organizationId": self.civil_org,
                "priority": "critical", "rationale": decision.reason, "channels": ["cell_broadcast", "sms", "door_to_door"], "area": area,
                "messages": [{"language": "pt-PT", "text": text}], "severity": "red" if item.vulnerable else "orange",
            })
            if not evacuate:
                actions.append({
                    "id": f"pc-alert-{item.id}-arrival", "type": "public_alert", "title": f"Segundo aviso: fogo a chegar a {item.name}", "organizationId": self.civil_org,
                    "priority": "critical", "rationale": f"Lembrar quem está abrigado em {item.name} de se manter dentro quando o fogo passar.",
                    "channels": ["cell_broadcast", "sms"], "area": area, "severity": "red",
                    "messages": [{"language": "pt-PT", "text": f"O fogo está a chegar a {item.name}. Mantenha-se dentro de casa até indicação em contrário."}],
                    "trigger": {"kind": "on_fire_arrival", "target": {"label": item.name, "position": item.position}, "leadTimeMinutes": 15},
                })
        return actions
