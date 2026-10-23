"""Registers, through the API, what a day of maximum alert really has on top of the local brigades: more aircraft, and crews waiting out in the forest.

* **Aircraft** (``civil_protection``, tag ``aerial-reinforcement``): on a summer day there are always aircraft working the fires. Each one waits at a ``helipad``
  station on the edge of the map, on the side its base is, with ``metadata["agents.mobilizationMinutes"]``: how long after the call it is overhead there
  (take-off plus the flight from its base). The agents add the rest of the flight, then make it drop, refill and come back (its rotation) and stop at sunset.
  Amphibious airtankers scoop from a large water body (``agents.scoopDistanceKm``); helicopters dip into the nearest water point they can use.
* **Pre-positioned crews** (``fire_brigade``, tag ``prepositioned``): on a maximum-alert day the district puts first-attack crews at strategic points in the forest
  instead of the stations, so a new fire is hit in minutes. The points are chosen here, from the map alone: road points with the most forest around them,
  at least ``LEE_SPACING_M`` apart (nothing about where any scenario starts its fire).

The numbers are **examples to be checked** with the district command (CDOS) and this year's national plan (DECIR); everything is tagged ``demo-seed``.

    python agents/scripts/seed_air_and_prepositioning.py              # backend on http://localhost:8080/api/v1
    python agents/scripts/seed_air_and_prepositioning.py --dry-run    # validate and print, send nothing
    python agents/scripts/seed_air_and_prepositioning.py --remove     # delete what this script created (by its tags)

Idempotent: anything already there (same name / callsign) is skipped.
"""
from __future__ import annotations

import argparse
import math
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from seed_reinforcements import Api, _distance_m  # noqa: E402

LOCATION = "guimaraes-concelho"
AIR_TAGS = ["demo-seed", "aerial-reinforcement"]
LEE_TAGS = ["demo-seed", "prepositioned"]
NOTE = "meio de exemplo de um dia de alerta máximo (números a confirmar com o CDOS / DECIR)"
EDGE_M = 300.0  # how far inside the map an aircraft's helipad is
FOREST = {4, 5, 8, 9, 10}  # vegetation classes: mato, floresta mista, eucalipto, pinheiro, folhosas
LEE_COUNT = 10
LEE_SPACING_M = 3000.0
LEE_RADIUS_M = 1500.0  # the forest share is measured within this distance of the point

AERIAL = {"maxWindKmh": 55, "minVisibilityM": 3000, "dayOnly": True}
LIGHT_HELI = {"type": "helicopter", "typeCode": "HEBL", "crewCapacity": 2, "minimumCrew": 1, "waterCapacityL": 1000, "cruiseSpeedKmh": 200, "capabilities": ["aerial_water_drop"],
              "aerial": {**AERIAL, "bucketCapacityL": 1000, "loadMinutes": 1, "dropMinutes": 1, "cruiseSpeedKmh": 200}}
HEAVY_HELI = {"type": "helicopter", "typeCode": "HEBP", "crewCapacity": 3, "minimumCrew": 2, "waterCapacityL": 4500, "cruiseSpeedKmh": 230, "capabilities": ["aerial_water_drop"],
              "aerial": {**AERIAL, "bucketCapacityL": 4500, "loadMinutes": 2, "dropMinutes": 1, "cruiseSpeedKmh": 230}}
MEDIUM_HELI = {"type": "helicopter", "typeCode": "HEBM", "crewCapacity": 3, "minimumCrew": 2, "waterCapacityL": 1500, "cruiseSpeedKmh": 220, "capabilities": ["aerial_water_drop"],
               "aerial": {**AERIAL, "bucketCapacityL": 1500, "loadMinutes": 1, "dropMinutes": 1, "cruiseSpeedKmh": 220}}
MEDIUM_AMPHIBIOUS = {"type": "airtanker", "typeCode": "AVBM", "crewCapacity": 1, "minimumCrew": 1, "waterCapacityL": 3000, "cruiseSpeedKmh": 300, "capabilities": ["aerial_water_drop"],
                     "aerial": {**AERIAL, "bucketCapacityL": 3000, "loadMinutes": 1, "dropMinutes": 1, "cruiseSpeedKmh": 300}}
HEAVY_AMPHIBIOUS = {"type": "airtanker", "typeCode": "AVBP", "crewCapacity": 2, "minimumCrew": 2, "waterCapacityL": 6000, "cruiseSpeedKmh": 330, "capabilities": ["aerial_water_drop"],
                    "aerial": {**AERIAL, "bucketCapacityL": 6000, "loadMinutes": 1, "dropMinutes": 1, "cruiseSpeedKmh": 330}}
COORDINATION_HELI = {"type": "helicopter", "typeCode": "HECO", "crewCapacity": 3, "minimumCrew": 2, "waterCapacityL": 0, "cruiseSpeedKmh": 220, "capabilities": ["aerial_recon"],
                     "aerial": {**AERIAL, "bucketCapacityL": 0, "loadMinutes": 0, "dropMinutes": 0, "cruiseSpeedKmh": 220}}
SCOOP_KM = 25  # the nearest water body an amphibious airtanker can scoop from (a large reservoir up the valley)

# where the aircraft come from (the side of the map their base is), minutes until they are overhead on that edge, the aircraft
AIR_GROUPS: list[dict[str, Any]] = [
    # demo boost: a reinforced air component (20 aircraft instead of 9) so the plans have a strong air attack to work with
    {"name": "Helicópteros ligeiros de ataque inicial (centro de meios aéreos a nascente)", "short": "HEBL nascente", "prefix": "HEBL", "side": 80, "mobilization": 8, "aircraft": [LIGHT_HELI] * 4},
    {"name": "Helicópteros médios (centro de meios aéreos a poente)", "short": "HEBM poente", "prefix": "HEBM", "side": 290, "mobilization": 15, "aircraft": [MEDIUM_HELI] * 3},
    {"name": "Helicópteros pesados (base regional a sul)", "short": "HEBP sul", "prefix": "HEBP", "side": 180, "mobilization": 30, "aircraft": [HEAVY_HELI] * 4},
    {"name": "Aviões anfíbios médios (base regional a sul)", "short": "Anfíbios médios", "prefix": "AVBM", "side": 200, "mobilization": 25, "aircraft": [MEDIUM_AMPHIBIOUS] * 4},
    {"name": "Aviões anfíbios pesados (dispositivo nacional)", "short": "Anfíbios pesados", "prefix": "AVBP", "side": 190, "mobilization": 55, "aircraft": [HEAVY_AMPHIBIOUS] * 4},
    {"name": "Helicóptero de coordenação aérea (dispositivo nacional)", "short": "HECO coordenação", "prefix": "HECO", "side": 210, "mobilization": 20, "aircraft": [COORDINATION_HELI]},
]

ECIN = {"type": "forest_firefighting_vehicle", "typeCode": "VFCI", "crewCapacity": 5, "minimumCrew": 3, "waterCapacityL": 3000, "pumpFlowLpm": 1000,
        "offRoad": True, "maxSlopePercent": 35, "cruiseSpeedKmh": 60, "capabilities": ["wildfire_attack", "structure_protection"]}
LEE_ORG = {"name": "Equipas de Combate a Incêndios pré-posicionadas (alerta máximo)", "short": "ECIN pré-posicionadas"}


def edge_point(bounds: dict[str, float], side_deg: float) -> dict[str, float]:
    """The point on the map's edge in that direction from the centre, ``EDGE_M`` inside."""
    lat0, lon0 = (bounds["south"] + bounds["north"]) / 2, (bounds["west"] + bounds["east"]) / 2
    m_lat, m_lon = EDGE_M / 111_000.0, EDGE_M / (111_000.0 * math.cos(math.radians(lat0)))
    dx, dy = math.sin(math.radians(side_deg)), math.cos(math.radians(side_deg))
    half_w, half_h = (bounds["east"] - bounds["west"]) / 2 - m_lon, (bounds["north"] - bounds["south"]) / 2 - m_lat
    scale = min(half_w / abs(dx) if abs(dx) > 1e-9 else math.inf, half_h / abs(dy) if abs(dy) > 1e-9 else math.inf)
    return {"lat": lat0 + dy * scale, "lon": lon0 + dx * scale}


def forest_points(roads: list[dict[str, Any]], grid: bytes, width: int, height: int, bounds: dict[str, float], cell_m: float) -> list[dict[str, float]]:
    """``LEE_COUNT`` road points with the most forest within ``LEE_RADIUS_M``, at least ``LEE_SPACING_M`` apart (a summed-area table makes each share O(1))."""
    sat = [[0] * (width + 1) for _ in range(height + 1)]
    for r in range(height):
        row = 0
        for c in range(width):
            row += 1 if grid[r * width + c] in FOREST else 0
            sat[r + 1][c + 1] = sat[r][c + 1] + row
    k = max(1, int(LEE_RADIUS_M / cell_m))

    def share(lat: float, lon: float) -> float:
        c = int((lon - bounds["west"]) / (bounds["east"] - bounds["west"]) * width)
        r = int((bounds["north"] - lat) / (bounds["north"] - bounds["south"]) * height)
        r0, r1, c0, c1 = max(0, r - k), min(height, r + k + 1), max(0, c - k), min(width, c + k + 1)
        if r0 >= r1 or c0 >= c1:
            return 0.0
        return (sat[r1][c1] - sat[r0][c1] - sat[r1][c0] + sat[r0][c0]) / ((r1 - r0) * (c1 - c0))

    # a point is scored over its whole radius: one on the map's edge would be scored on a clipped window, so candidates stay a radius inside
    lat0 = (bounds["south"] + bounds["north"]) / 2
    in_lat, in_lon = LEE_RADIUS_M / 111_000.0, LEE_RADIUS_M / (111_000.0 * math.cos(math.radians(lat0)))
    inner = {"west": bounds["west"] + in_lon, "east": bounds["east"] - in_lon, "south": bounds["south"] + in_lat, "north": bounds["north"] - in_lat}
    candidates: list[tuple[float, dict[str, float]]] = []
    for feature in roads:
        if (feature.get("properties") or {}).get("class") in {"motorway", "motorway_link", "trunk", "trunk_link", "path", "footway", "track"}:
            continue  # the crew waits on an ordinary road it can leave quickly in any direction
        coordinates = (feature.get("geometry") or {}).get("coordinates") or []
        for lon, lat in coordinates[:: max(1, len(coordinates) // 3)]:
            if inner["west"] < lon < inner["east"] and inner["south"] < lat < inner["north"]:
                candidates.append((share(lat, lon), {"lat": lat, "lon": lon}))
    candidates.sort(key=lambda pair: pair[0], reverse=True)
    chosen: list[dict[str, float]] = []
    for _share, point in candidates:
        if all(_distance_m(point["lat"], point["lon"], p["lat"], p["lon"]) >= LEE_SPACING_M for p in chosen):
            chosen.append(point)
        if len(chosen) >= LEE_COUNT:
            break
    return chosen


def remove(api: Api) -> None:
    for path in ("/vehicles", "/stations", "/organizations"):
        for item in api.all(path):
            if {"aerial-reinforcement", "prepositioned"} & set(item.get("tags") or []):
                if api.dry_run:
                    print(f"  [dry-run] would delete {path}/{item['id']}")
                    continue
                response = api.http.delete(f"{path}/{item['id']}")
                print(f"  delete {path}/{item['id']}: HTTP {response.status_code}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=os.environ.get("FIRETRACE_BASE_URL", "http://localhost:8080/api/v1"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--remove", action="store_true", help="delete every vehicle, station and organization tagged 'aerial-reinforcement' or 'prepositioned'")
    args = parser.parse_args(argv)
    api = Api(args.base_url, args.dry_run)
    if args.remove:
        remove(api)
        return 0

    bounds = api.http.get(f"/locations/{LOCATION}").json()["bounds"]
    orgs = {o["name"]: o for o in api.all("/organizations")}
    stations = {s["name"]: s for s in api.all("/stations")}
    callsigns = {v["callsign"] for v in api.all("/vehicles")}

    for group in AIR_GROUPS:
        print(f"{group['short']} (sobre o concelho em ~{group['mobilization']} min):")
        metadata = {"note": NOTE, "agents.mobilizationMinutes": group["mobilization"]}
        org = orgs.get(group["name"]) or api.create("/organizations", "OrganizationInput", {
            "name": group["name"], "shortName": group["short"], "type": "civil_protection", "active": True, "tags": AIR_TAGS, "metadata": metadata,
            "jurisdiction": {"level": "national", "name": "meios aéreos de combate", "locationIds": [LOCATION]},
        }, f"organization {group['short']}")
        station_name = f"Meios aéreos — {group['short']}"
        station = stations.get(station_name)
        if station is None:
            point = edge_point(bounds, group["side"])
            station = api.create("/stations", "StationInput", {
                "organizationId": org["id"], "name": station_name, "kind": "helipad", "locationId": LOCATION, "position": point,
                "vehicleBays": len(group["aircraft"]), "status": "operational", "tags": AIR_TAGS, "metadata": metadata,
            }, f"station {station_name} at {point['lat']:.5f}, {point['lon']:.5f}")
        for index, spec in enumerate(group["aircraft"], start=1):
            callsign = f"{group['prefix']}-{index:02d}"
            if callsign in callsigns:
                continue
            vehicle_metadata = {**metadata, **({"agents.scoopDistanceKm": SCOOP_KM} if spec["type"] == "airtanker" else {})}
            api.create("/vehicles", "VehicleInput", {
                **spec, "organizationId": org["id"], "callsign": callsign, "stationId": station["id"], "inService": True, "tags": AIR_TAGS, "metadata": vehicle_metadata,
            }, f"aircraft {callsign}")

    print(f"{LEE_ORG['short']}:")
    org = orgs.get(LEE_ORG["name"]) or api.create("/organizations", "OrganizationInput", {
        "name": LEE_ORG["name"], "shortName": LEE_ORG["short"], "type": "fire_brigade", "active": True, "tags": LEE_TAGS, "metadata": {"note": NOTE},
        "jurisdiction": {"level": "municipal", "name": "concelho de Guimarães", "locationIds": [LOCATION]},
    }, f"organization {LEE_ORG['short']}")
    existing = [s for s in stations.values() if "prepositioned" in (s.get("tags") or [])]
    if len(existing) < LEE_COUNT:
        response = api.http.get(f"/locations/{LOCATION}/grids/vegetation")
        response.raise_for_status()
        width, height, cell_m = int(response.headers["X-Grid-Width"]), int(response.headers["X-Grid-Height"]), float(response.headers["X-Grid-Cell-M"])
        roads = api.http.get(f"/locations/{LOCATION}/roads", params={"limit": 50000}).json().get("features", [])
        points = forest_points(roads, response.content, width, height, bounds, cell_m)
        for index, point in enumerate(points, start=1):
            name = f"Ponto de pré-posicionamento LEE-{index:02d}"
            if name in stations:
                continue
            station = api.create("/stations", "StationInput", {
                "organizationId": org["id"], "name": name, "kind": "staging_area", "locationId": LOCATION, "position": point,
                "vehicleBays": 1, "status": "operational", "tags": LEE_TAGS, "metadata": {"note": NOTE},
            }, f"station {name} at {point['lat']:.5f}, {point['lon']:.5f}")
            stations[name] = station
    for index, station in enumerate(sorted((s for s in stations.values() if "prepositioned" in (s.get("tags") or []) or s.get("name", "").startswith("Ponto de pré-posicionamento")), key=lambda s: s["name"]), start=1):
        callsign = f"ECIN-LEE-{index:02d}"
        if callsign in callsigns:
            continue
        api.create("/vehicles", "VehicleInput", {
            **ECIN, "organizationId": org["id"], "callsign": callsign, "stationId": station["id"], "inService": True, "tags": LEE_TAGS, "metadata": {"note": NOTE},
        }, f"vehicle {callsign}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
