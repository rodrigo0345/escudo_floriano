"""Registers reinforcement groups from the neighbouring districts through the API: the help a large fire in Guimarães really gets, a while after it is asked for.

In a large incident the district's own brigades are joined by reinforcement groups (GRIF) from the next districts and by the other brigades of the district.
They do not come from a station in the municipality: they drive in on the main roads. Each group gets:

* an organization (``fire_brigade``) named after where it comes from, so it reads on the map and in the plans ("GRIF Porto");
* a ``staging_area`` station at the point where its road enters the municipality (the main road nearest that side, a little inside the map);
* its vehicles, with ``metadata["agents.mobilizationMinutes"]``: how long after the call the group reaches that entry point (assembling the group plus the drive
  from its district). The agents add it to the group's arrival (see ``travel.py``).

The numbers are **examples to be checked** with the district command (CDOS): every entity is tagged ``reinforcement`` and ``demo-seed``.

    python agents/scripts/seed_reinforcements.py              # backend on http://localhost:8080/api/v1
    python agents/scripts/seed_reinforcements.py --dry-run    # validate and print, send nothing
    python agents/scripts/seed_reinforcements.py --remove     # delete what this script created (by its tag)

Idempotent: anything already there (same name / callsign) is skipped.
"""
from __future__ import annotations

import argparse
import math
import os
import sys
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from firetrace_agents.contracts import validate_against_spec  # noqa: E402

LOCATION = "guimaraes-concelho"
TAGS = ["demo-seed", "reinforcement"]
NOTE = "reforço de exemplo (números a confirmar com o CDOS)"
MAIN_ROADS = {"motorway", "trunk", "primary", "motorway_link", "trunk_link", "primary_link"}
INSIDE_M = 400.0  # how far inside the map the entry point is (the routing works on the municipality's own network)

VFCI = {"type": "forest_firefighting_vehicle", "typeCode": "VFCI", "crewCapacity": 5, "minimumCrew": 3, "waterCapacityL": 3000, "pumpFlowLpm": 1000,
        "offRoad": True, "maxSlopePercent": 35, "cruiseSpeedKmh": 60, "capabilities": ["wildfire_attack", "structure_protection"]}
VTTF = {"type": "tanker_forest", "typeCode": "VTTF", "crewCapacity": 3, "minimumCrew": 2, "waterCapacityL": 10000, "pumpFlowLpm": 1000,
        "offRoad": False, "maxSlopePercent": 20, "cruiseSpeedKmh": 55, "capabilities": ["wildfire_attack", "water_supply"]}

# where the group comes from, the side of the municipality its road enters by (a compass bearing from the centre), minutes until it is there, vehicles
GROUPS: list[dict[str, Any]] = [
    {"name": "Grupo de Reforço do Distrito do Porto", "short": "GRIF Porto", "prefix": "GRIF-PRT", "side": 225, "mobilization": 60, "vehicles": [VFCI] * 4 + [VTTF]},
    {"name": "Grupo de Reforço do Distrito de Viana do Castelo", "short": "GRIF Viana", "prefix": "GRIF-VCT", "side": 315, "mobilization": 75, "vehicles": [VFCI] * 4 + [VTTF]},
    {"name": "Grupo de Reforço do Distrito de Vila Real", "short": "GRIF Vila Real", "prefix": "GRIF-VRL", "side": 90, "mobilization": 90, "vehicles": [VFCI] * 4 + [VTTF]},
    {"name": "Bombeiros do Distrito de Braga (reforço)", "short": "Reforço Braga", "prefix": "RF-BRG", "side": 330, "mobilization": 30, "vehicles": [VFCI] * 3},
]


class Api:
    def __init__(self, base_url: str, dry_run: bool) -> None:
        self.http = httpx.Client(base_url=base_url, timeout=60.0)
        self.dry_run = dry_run
        self.dry_ids = 0

    def all(self, path: str, **params: Any) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        params = {"limit": 200, **params}
        while True:
            response = self.http.get(path, params=params)
            response.raise_for_status()
            page = response.json()
            items.extend(page.get("items", []))
            if not page.get("nextCursor"):
                return items
            params["cursor"] = page["nextCursor"]

    def create(self, path: str, schema: str, payload: dict[str, Any], label: str) -> dict[str, Any]:
        validate_against_spec(schema, payload)
        if self.dry_run:
            print(f"  [dry-run] would create {label}")
            self.dry_ids += 1
            return {"id": f"dry-{self.dry_ids}"}
        response = self.http.post(path, json=payload)
        if response.status_code >= 400:
            raise SystemExit(f"POST {path} for {label} failed: HTTP {response.status_code} {response.text[:400]}")
        created = response.json()
        print(f"  created {label}  -> {created.get('id')}")
        return created


def _distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6_371_008.8 * math.asin(math.sqrt(h))


def entry_point(roads: list[dict[str, Any]], bounds: dict[str, float], side_deg: float) -> dict[str, float]:
    """The main-road point nearest the municipality's edge on that side (a little inside the map)."""
    centre_lat, centre_lon = (bounds["south"] + bounds["north"]) / 2, (bounds["west"] + bounds["east"]) / 2
    margin_lat, margin_lon = INSIDE_M / 111_000.0, INSIDE_M / (111_000.0 * math.cos(math.radians(centre_lat)))
    dx, dy = math.sin(math.radians(side_deg)), math.cos(math.radians(side_deg))
    best: tuple[float, dict[str, float]] | None = None
    for feature in roads:
        if (feature.get("properties") or {}).get("class") not in MAIN_ROADS:
            continue
        for lon, lat in (feature.get("geometry") or {}).get("coordinates") or []:
            if not (bounds["south"] + margin_lat <= lat <= bounds["north"] - margin_lat and bounds["west"] + margin_lon <= lon <= bounds["east"] - margin_lon):
                continue
            # how far towards that side (projection on the bearing), in metres
            reach = (lon - centre_lon) * 111_000.0 * math.cos(math.radians(centre_lat)) * dx + (lat - centre_lat) * 111_000.0 * dy
            if best is None or reach > best[0]:
                best = (reach, {"lat": lat, "lon": lon})
    if best is None:
        raise SystemExit("no main road found in the municipality's map")
    return best[1]


def remove(api: Api) -> None:
    for path in ("/vehicles", "/stations", "/organizations"):
        for item in api.all(path):
            if "reinforcement" in (item.get("tags") or []):
                if api.dry_run:
                    print(f"  [dry-run] would delete {path}/{item['id']}")
                    continue
                response = api.http.delete(f"{path}/{item['id']}")
                print(f"  delete {path}/{item['id']}: HTTP {response.status_code}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=os.environ.get("FIRETRACE_BASE_URL", "http://localhost:8080/api/v1"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--remove", action="store_true", help="delete every vehicle, station and organization tagged 'reinforcement'")
    args = parser.parse_args(argv)
    api = Api(args.base_url, args.dry_run)
    if args.remove:
        remove(api)
        return 0

    location = api.http.get(f"/locations/{LOCATION}").json()
    bounds = location["bounds"]
    roads = api.http.get(f"/locations/{LOCATION}/roads", params={"limit": 50000}).json().get("features", [])
    orgs = {o["name"]: o for o in api.all("/organizations")}
    stations = {s["name"]: s for s in api.all("/stations")}
    callsigns = {v["callsign"] for v in api.all("/vehicles")}
    jurisdiction = {"level": "district", "name": "reforço ao concelho de Guimarães", "locationIds": [LOCATION]}

    for group in GROUPS:
        print(f"{group['short']} (chega em ~{group['mobilization']} min):")
        metadata = {"note": NOTE, "agents.mobilizationMinutes": group["mobilization"]}
        org = orgs.get(group["name"]) or api.create("/organizations", "OrganizationInput", {
            "name": group["name"], "shortName": group["short"], "type": "fire_brigade", "jurisdiction": jurisdiction, "active": True, "tags": TAGS, "metadata": metadata,
        }, f"organization {group['short']}")
        station_name = f"Entrada de reforços — {group['short']}"
        station = stations.get(station_name)
        if station is None:
            point = entry_point(roads, bounds, group["side"])
            station = api.create("/stations", "StationInput", {
                "organizationId": org["id"], "name": station_name, "kind": "staging_area", "locationId": LOCATION, "position": point,
                "vehicleBays": len(group["vehicles"]), "status": "operational", "tags": TAGS, "metadata": metadata,
            }, f"station {station_name} at {point['lat']:.5f}, {point['lon']:.5f}")
        for index, spec in enumerate(group["vehicles"], start=1):
            callsign = f"{group['prefix']}-{spec['typeCode']}-{index:02d}"
            if callsign in callsigns:
                continue
            api.create("/vehicles", "VehicleInput", {
                **spec, "organizationId": org["id"], "callsign": callsign, "stationId": station["id"], "inService": True, "tags": TAGS, "metadata": metadata,
            }, f"vehicle {callsign}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
