"""Registers a small demo fleet for Guimarães through the API, so the agents have something to command.

Idempotent: anything that already exists (same name / callsign / organization+role) is skipped.
Every payload is validated against the spec's `*Input` schema before it is sent (see AGENTS.md).

    python agents/scripts/seed_fleet.py                  # from the repo root, backend on http://localhost:8080/api/v1
    python agents/scripts/seed_fleet.py --dry-run        # validate and print, send nothing

The fire stations are the real ones the backend loaded (`GET /locations/{id}/facilities?kind=fire_station`);
the vehicles and crews are invented demo data, tagged `demo-seed`.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from firetrace_agents.contracts import validate_against_spec  # noqa: E402

LOCATION = "guimaraes-concelho"
TAGS = ["demo-seed"]
METADATA = {"seed": True, "note": "dados de exemplo para os agentes; frota inventada"}

# real facility name (as the backend loaded it) -> (organization name, short name)
BRIGADES: dict[str, tuple[str, str]] = {
    "Associação Humanitária dos Bombeiros Voluntários de Guimarães": ("Bombeiros Voluntários de Guimarães", "BV Guimarães"),
    "Bombeiros Voluntários das Taipas": ("Bombeiros Voluntários das Taipas", "BV Taipas"),
    "Bombeiros Voluntários de Fafe": ("Bombeiros Voluntários de Fafe", "BV Fafe"),
    "Bombeiros Voluntários de Vizela": ("Bombeiros Voluntários de Vizela", "BV Vizela"),
}

CALLSIGN_PREFIX = {"BV Guimarães": "BVG", "BV Taipas": "BVT", "BV Fafe": "BVF", "BV Vizela": "BVV"}  # like the spec's `BVG-VFCI-01`

# brigade short name -> vehicles (type, typeCode, callsign suffix, crew capacity, water L, capabilities) and pools
FLEET: dict[str, dict[str, Any]] = {
    "BV Guimarães": {
        "vehicles": [
            ("forest_firefighting_vehicle", "VFCI", "VFCI-01", 5, 3000, ["wildfire_attack", "structure_protection"]),
            ("forest_firefighting_vehicle", "VFCI", "VFCI-02", 5, 3000, ["wildfire_attack", "structure_protection"]),
            ("tanker_forest", "VTTF", "VTTF-01", 3, 8000, ["wildfire_attack", "water_supply"]),
        ],
        "pools": [("firefighter", 20, 16), ("forest_firefighter", 10, 8)],
    },
    "BV Taipas": {
        "vehicles": [("forest_firefighting_vehicle", "VFCI", "VFCI-01", 5, 3000, ["wildfire_attack", "structure_protection"])],
        "pools": [("firefighter", 12, 8)],
    },
    "BV Fafe": {
        "vehicles": [
            ("forest_firefighting_vehicle", "VFCI", "VFCI-01", 5, 3000, ["wildfire_attack", "structure_protection"]),
            ("light_firefighting_vehicle", "VLCI", "VLCI-01", 3, 800, ["wildfire_attack"]),
        ],
        "pools": [("firefighter", 12, 8)],
    },
    "BV Vizela": {
        "vehicles": [("forest_firefighting_vehicle", "VFCI", "VFCI-01", 5, 3000, ["wildfire_attack", "structure_protection"])],
        "pools": [("firefighter", 10, 8)],
    },
}

AIR_ORG = ("Meios Aéreos de Combate (demo)", "Meios Aéreos")
HELIPAD = ("Heliporto do Hospital da Senhora da Oliveira", {"lat": 41.4423259, "lon": -8.3055401})
HELICOPTERS = ["HELI-01", "HELI-02"]


class Api:
    def __init__(self, base_url: str, dry_run: bool) -> None:
        self.http = httpx.Client(base_url=base_url, timeout=30.0)
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
            return {"id": f"dry-{self.dry_ids}"}  # a valid spec `Id`: later payloads that reference it still validate
        response = self.http.post(path, json=payload)
        if response.status_code >= 400:
            raise SystemExit(f"POST {path} for {label} failed: HTTP {response.status_code} {response.text[:400]}")
        created = response.json()
        print(f"  created {label}  -> {created.get('id')}")
        return created


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=os.environ.get("FIRETRACE_BASE_URL", "http://localhost:8080/api/v1"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    api = Api(args.base_url, args.dry_run)

    facilities = {f["name"]: f for f in api.all(f"/locations/{LOCATION}/facilities", kind="fire_station")}
    missing = [name for name in BRIGADES if name not in facilities]
    if missing:
        raise SystemExit(f"fire stations not loaded by the backend (ingest 'places' first): {missing}")

    orgs = {o["name"]: o for o in api.all("/organizations")}
    stations = {s["name"]: s for s in api.all("/stations")}
    callsigns = {v["callsign"] for v in api.all("/vehicles")}
    pools = {(p["organizationId"], p["role"]) for p in api.all("/personnel-pools")}
    jurisdiction = {"level": "municipal", "name": "Guimarães", "locationIds": [LOCATION]}

    def ensure_org(name: str, short: str, kind: str) -> str:
        if name in orgs:
            return orgs[name]["id"]
        created = api.create(
            "/organizations",
            "OrganizationInput",
            {"name": name, "shortName": short, "type": kind, "jurisdiction": jurisdiction, "active": True, "tags": TAGS, "metadata": METADATA},
            f"organization {short}",
        )
        orgs[name] = created
        return created["id"]

    def ensure_station(org_id: str, name: str, kind: str, position: dict[str, float], bays: int, facility_id: str | None = None) -> str:
        if name in stations:
            return stations[name]["id"]
        payload: dict[str, Any] = {
            "organizationId": org_id, "name": name, "kind": kind, "locationId": LOCATION, "position": position,
            "vehicleBays": bays, "status": "operational", "tags": TAGS, "metadata": METADATA,
        }
        if facility_id:
            payload["facilityId"] = facility_id
        created = api.create("/stations", "StationInput", payload, f"station {name}")
        stations[name] = created
        return created["id"]

    def ensure_vehicle(org_id: str, station_id: str, prefix: str, spec: tuple) -> None:
        vtype, code, suffix, crew, water, caps = spec
        callsign = f"{prefix}-{suffix}"
        if callsign in callsigns:
            return
        api.create(
            "/vehicles",
            "VehicleInput",
            {
                "organizationId": org_id, "callsign": callsign, "type": vtype, "typeCode": code, "stationId": station_id,
                "crewCapacity": crew, "minimumCrew": min(3, crew), "waterCapacityL": water, "pumpFlowLpm": 1000,
                "passengerCapacity": 0, "offRoad": True, "maxSlopePercent": 35, "cruiseSpeedKmh": 60,
                "capabilities": caps, "inService": True, "tags": TAGS, "metadata": METADATA,
            },
            f"vehicle {callsign}",
        )
        callsigns.add(callsign)

    print(f"Seeding {LOCATION} via {args.base_url}")
    for facility_name, (org_name, short) in BRIGADES.items():
        facility = facilities[facility_name]
        org_id = ensure_org(org_name, short, "fire_brigade")
        station_id = ensure_station(org_id, f"Quartel dos {short}", "fire_station", facility["position"], 4, facility.get("id"))
        for spec in FLEET[short]["vehicles"]:
            ensure_vehicle(org_id, station_id, CALLSIGN_PREFIX[short], spec)
        for role, total, available in FLEET[short]["pools"]:
            if (org_id, role) in pools:
                continue
            api.create(
                "/personnel-pools",
                "PersonnelPoolInput",
                {
                    "organizationId": org_id, "role": role, "stationId": station_id, "total": total, "available": available,
                    "fatiguePct": 0, "certifications": ["forest_firefighting"], "tags": TAGS, "metadata": METADATA,
                },
                f"pool {short}/{role}",
            )
            pools.add((org_id, role))

    air_org = ensure_org(AIR_ORG[0], AIR_ORG[1], "air_force")
    helipad = ensure_station(air_org, HELIPAD[0], "helipad", HELIPAD[1], 2)
    for callsign in HELICOPTERS:
        if callsign in callsigns:
            continue
        api.create(
            "/vehicles",
            "VehicleInput",
            {
                "organizationId": air_org, "callsign": callsign, "type": "helicopter", "stationId": helipad,
                "crewCapacity": 3, "minimumCrew": 2, "waterCapacityL": 1000, "passengerCapacity": 0,
                "cruiseSpeedKmh": 180, "capabilities": ["aerial_water_drop", "aerial_recon"], "inService": True,
                "aerial": {"bucketCapacityL": 1000, "loadMinutes": 3, "dropMinutes": 1, "cruiseSpeedKmh": 180,
                           "maxWindKmh": 50, "minVisibilityM": 1500, "dayOnly": True},
                "tags": TAGS, "metadata": METADATA,
            },
            f"vehicle {callsign}",
        )
        callsigns.add(callsign)
    print("done" + (" (dry run, nothing sent)" if args.dry_run else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
