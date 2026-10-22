"""Registers a realistic, full-scale operational fleet for Guimarães and surrounding region through the API,
so the planning agents have realistic operational capacity across all response institutions:
Bombeiros, GNR, INEM, Proteção Civil (SMPC), and Meios Aéreos (CMA).

Idempotent: anything that already exists (same name / callsign / organization+role) is skipped.
Every payload is validated against the spec's `*Input` schema before it is sent (see AGENTS.md).

    python agents/scripts/seed_fleet.py                  # from the repo root, backend on http://localhost:8080/api/v1
    python agents/scripts/seed_fleet.py --dry-run        # validate and print, send nothing

The fire stations and institutions reflect real facilities in Guimarães and surrounding municipalities;
all entities are tagged `demo-seed`.
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
METADATA = {"seed": True, "note": "dispositivo operacional de Guimarães e concelhos limítrofes"}

# Facility name -> (Organization name, short name)
BRIGADES: dict[str, tuple[str, str]] = {
    "Associação Humanitária dos Bombeiros Voluntários de Guimarães": ("Bombeiros Voluntários de Guimarães", "BV Guimarães"),
    "Bombeiros Voluntários das Taipas": ("Bombeiros Voluntários das Taipas", "BV Taipas"),
    "Bombeiros Voluntários de Fafe": ("Bombeiros Voluntários de Fafe", "BV Fafe"),
    "Bombeiros Voluntários de Vizela": ("Bombeiros Voluntários de Vizela", "BV Vizela"),
}

CALLSIGN_PREFIX = {"BV Guimarães": "BVG", "BV Taipas": "BVT", "BV Fafe": "BVF", "BV Vizela": "BVV"}

# Fallback positions in case facility ingestion has not run yet
DEFAULT_COORDS: dict[str, dict[str, float]] = {
    "Associação Humanitária dos Bombeiros Voluntários de Guimarães": {"lat": 41.4406, "lon": -8.2917},
    "Bombeiros Voluntários das Taipas": {"lat": 41.4883, "lon": -8.3444},
    "Bombeiros Voluntários de Fafe": {"lat": 41.4518, "lon": -8.1722},
    "Bombeiros Voluntários de Vizela": {"lat": 41.3783, "lon": -8.3075},
    "Destacamento Territorial da GNR de Guimarães": {"lat": 41.4445, "lon": -8.2982},
    "Base INEM Norte - Guimarães": {"lat": 41.4430, "lon": -8.3050},
    "Serviço Municipal de Proteção Civil de Guimarães": {"lat": 41.4415, "lon": -8.2955},
    "Heliporto do Hospital da Senhora da Oliveira": {"lat": 41.4423, "lon": -8.3055},
}

# Fire brigades fleet and personnel pools
FLEET: dict[str, dict[str, Any]] = {
    "BV Guimarães": {
        "vehicles": [
            {"type": "forest_firefighting_vehicle", "typeCode": "VFCI", "suffix": "VFCI-01", "crew": 5, "water": 3500, "capabilities": ["wildfire_attack", "structure_protection"]},
            {"type": "forest_firefighting_vehicle", "typeCode": "VFCI", "suffix": "VFCI-02", "crew": 5, "water": 3500, "capabilities": ["wildfire_attack", "structure_protection"]},
            {"type": "forest_firefighting_vehicle", "typeCode": "VFCI", "suffix": "VFCI-03", "crew": 5, "water": 3500, "capabilities": ["wildfire_attack", "structure_protection"]},
            {"type": "forest_firefighting_vehicle", "typeCode": "VFCI", "suffix": "VFCI-04", "crew": 5, "water": 3500, "capabilities": ["wildfire_attack", "structure_protection"]},
            {"type": "tanker_forest", "typeCode": "VTTF", "suffix": "VTTF-01", "crew": 3, "water": 10000, "capabilities": ["wildfire_attack", "water_supply"]},
            {"type": "tanker_forest", "typeCode": "VTTF", "suffix": "VTTF-02", "crew": 3, "water": 12000, "capabilities": ["wildfire_attack", "water_supply"]},
            {"type": "light_firefighting_vehicle", "typeCode": "VLCI", "suffix": "VLCI-01", "crew": 3, "water": 800, "capabilities": ["wildfire_attack"]},
            {"type": "light_firefighting_vehicle", "typeCode": "VLCI", "suffix": "VLCI-02", "crew": 3, "water": 800, "capabilities": ["wildfire_attack"]},
            {"type": "command_vehicle", "typeCode": "VCOT", "suffix": "VCOT-01", "crew": 3, "water": 0, "capabilities": ["command_and_control", "reconnaissance"]},
            {"type": "ambulance", "typeCode": "ABSC", "suffix": "ABSC-01", "crew": 2, "water": 0, "passengerCapacity": 1, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
            {"type": "ambulance", "typeCode": "ABSC", "suffix": "ABSC-02", "crew": 2, "water": 0, "passengerCapacity": 1, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
        ],
        "pools": [
            ("firefighter", 80, 70),
            ("forest_firefighter", 40, 35),
            ("paramedic", 15, 12),
            ("crew_leader", 12, 10),
        ],
    },
    "BV Taipas": {
        "vehicles": [
            {"type": "forest_firefighting_vehicle", "typeCode": "VFCI", "suffix": "VFCI-01", "crew": 5, "water": 3500, "capabilities": ["wildfire_attack", "structure_protection"]},
            {"type": "forest_firefighting_vehicle", "typeCode": "VFCI", "suffix": "VFCI-02", "crew": 5, "water": 3500, "capabilities": ["wildfire_attack", "structure_protection"]},
            {"type": "forest_firefighting_vehicle", "typeCode": "VFCI", "suffix": "VFCI-03", "crew": 5, "water": 3500, "capabilities": ["wildfire_attack", "structure_protection"]},
            {"type": "tanker_forest", "typeCode": "VTTF", "suffix": "VTTF-01", "crew": 3, "water": 10000, "capabilities": ["wildfire_attack", "water_supply"]},
            {"type": "light_firefighting_vehicle", "typeCode": "VLCI", "suffix": "VLCI-01", "crew": 3, "water": 800, "capabilities": ["wildfire_attack"]},
            {"type": "command_vehicle", "typeCode": "VCOT", "suffix": "VCOT-01", "crew": 3, "water": 0, "capabilities": ["command_and_control"]},
            {"type": "ambulance", "typeCode": "ABSC", "suffix": "ABSC-01", "crew": 2, "water": 0, "passengerCapacity": 1, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
            {"type": "ambulance", "typeCode": "ABSC", "suffix": "ABSC-02", "crew": 2, "water": 0, "passengerCapacity": 1, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
        ],
        "pools": [
            ("firefighter", 50, 45),
            ("forest_firefighter", 25, 22),
            ("paramedic", 10, 8),
            ("crew_leader", 8, 7),
        ],
    },
    "BV Fafe": {
        "vehicles": [
            {"type": "forest_firefighting_vehicle", "typeCode": "VFCI", "suffix": "VFCI-01", "crew": 5, "water": 3500, "capabilities": ["wildfire_attack", "structure_protection"]},
            {"type": "forest_firefighting_vehicle", "typeCode": "VFCI", "suffix": "VFCI-02", "crew": 5, "water": 3500, "capabilities": ["wildfire_attack", "structure_protection"]},
            {"type": "forest_firefighting_vehicle", "typeCode": "VFCI", "suffix": "VFCI-03", "crew": 5, "water": 3500, "capabilities": ["wildfire_attack", "structure_protection"]},
            {"type": "tanker_forest", "typeCode": "VTTF", "suffix": "VTTF-01", "crew": 3, "water": 10000, "capabilities": ["wildfire_attack", "water_supply"]},
            {"type": "light_firefighting_vehicle", "typeCode": "VLCI", "suffix": "VLCI-01", "crew": 3, "water": 800, "capabilities": ["wildfire_attack"]},
            {"type": "command_vehicle", "typeCode": "VCOT", "suffix": "VCOT-01", "crew": 3, "water": 0, "capabilities": ["command_and_control"]},
            {"type": "ambulance", "typeCode": "ABSC", "suffix": "ABSC-01", "crew": 2, "water": 0, "passengerCapacity": 1, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
            {"type": "ambulance", "typeCode": "ABSC", "suffix": "ABSC-02", "crew": 2, "water": 0, "passengerCapacity": 1, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
        ],
        "pools": [
            ("firefighter", 50, 45),
            ("forest_firefighter", 25, 22),
            ("paramedic", 10, 8),
            ("crew_leader", 8, 7),
        ],
    },
    "BV Vizela": {
        "vehicles": [
            {"type": "forest_firefighting_vehicle", "typeCode": "VFCI", "suffix": "VFCI-01", "crew": 5, "water": 3500, "capabilities": ["wildfire_attack", "structure_protection"]},
            {"type": "forest_firefighting_vehicle", "typeCode": "VFCI", "suffix": "VFCI-02", "crew": 5, "water": 3500, "capabilities": ["wildfire_attack", "structure_protection"]},
            {"type": "forest_firefighting_vehicle", "typeCode": "VFCI", "suffix": "VFCI-03", "crew": 5, "water": 3500, "capabilities": ["wildfire_attack", "structure_protection"]},
            {"type": "tanker_forest", "typeCode": "VTTF", "suffix": "VTTF-01", "crew": 3, "water": 10000, "capabilities": ["wildfire_attack", "water_supply"]},
            {"type": "light_firefighting_vehicle", "typeCode": "VLCI", "suffix": "VLCI-01", "crew": 3, "water": 800, "capabilities": ["wildfire_attack"]},
            {"type": "command_vehicle", "typeCode": "VCOT", "suffix": "VCOT-01", "crew": 3, "water": 0, "capabilities": ["command_and_control"]},
            {"type": "ambulance", "typeCode": "ABSC", "suffix": "ABSC-01", "crew": 2, "water": 0, "passengerCapacity": 1, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
            {"type": "ambulance", "typeCode": "ABSC", "suffix": "ABSC-02", "crew": 2, "water": 0, "passengerCapacity": 1, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
        ],
        "pools": [
            ("firefighter", 40, 35),
            ("forest_firefighter", 20, 18),
            ("paramedic", 8, 6),
            ("crew_leader", 6, 5),
        ],
    },
}

# Dedicated non-fire institutions
OTHER_ORGS: list[dict[str, Any]] = [
    {
        "name": "Guarda Nacional Republicana — Destacamento de Guimarães",
        "short": "GNR Guimarães",
        "type": "gnr",
        "prefix": "GNR-GMR",
        "facilityName": "Destacamento Territorial da GNR de Guimarães",
        "station": {"name": "Quartel da GNR de Guimarães", "kind": "gnr_post", "bays": 8, "pos": {"lat": 41.4445, "lon": -8.2982}},
        "vehicles": [
            {"type": "all_terrain_patrol", "typeCode": "UEPS", "suffix": "UEPS-01", "crew": 5, "water": 500, "capabilities": ["wildfire_attack", "structure_protection", "perimeter_security"]},
            {"type": "all_terrain_patrol", "typeCode": "UEPS", "suffix": "UEPS-02", "crew": 5, "water": 500, "capabilities": ["wildfire_attack", "structure_protection", "perimeter_security"]},
            {"type": "all_terrain_patrol", "typeCode": "UEPS", "suffix": "UEPS-03", "crew": 5, "water": 500, "capabilities": ["wildfire_attack", "structure_protection", "perimeter_security"]},
            {"type": "traffic_unit", "typeCode": "BT", "suffix": "BT-01", "crew": 2, "water": 0, "offRoad": False, "capabilities": ["traffic_control", "perimeter_security"]},
            {"type": "traffic_unit", "typeCode": "BT", "suffix": "BT-02", "crew": 2, "water": 0, "offRoad": False, "capabilities": ["traffic_control", "perimeter_security"]},
            {"type": "traffic_unit", "typeCode": "BT", "suffix": "BT-03", "crew": 2, "water": 0, "offRoad": False, "capabilities": ["traffic_control", "perimeter_security"]},
            {"type": "all_terrain_patrol", "typeCode": "VRR", "suffix": "VRR-01", "crew": 2, "water": 0, "capabilities": ["reconnaissance", "perimeter_security"]},
        ],
        "pools": [
            ("gnr_soldier", 60, 55, ["perimeter_security", "traffic_control"]),
            ("rescue_specialist", 35, 30, ["forest_firefighting"]),
        ],
    },
    {
        "name": "INEM — Delegação Regional Norte (Guimarães)",
        "short": "INEM Guimarães",
        "type": "inem",
        "prefix": "INEM",
        "facilityName": "Base INEM Norte - Guimarães",
        "station": {"name": "Base INEM Guimarães", "kind": "inem_base", "bays": 12, "pos": {"lat": 41.4430, "lon": -8.3050}},
        "vehicles": [
            {"type": "ambulance", "typeCode": "ABSC", "suffix": "ABSC-01", "crew": 2, "water": 0, "passengerCapacity": 1, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
            {"type": "ambulance", "typeCode": "ABSC", "suffix": "ABSC-02", "crew": 2, "water": 0, "passengerCapacity": 1, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
            {"type": "ambulance", "typeCode": "ABSC", "suffix": "ABSC-03", "crew": 2, "water": 0, "passengerCapacity": 1, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
            {"type": "ambulance", "typeCode": "ABSC", "suffix": "ABSC-04", "crew": 2, "water": 0, "passengerCapacity": 1, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
            {"type": "ambulance", "typeCode": "ABSC", "suffix": "ABSC-05", "crew": 2, "water": 0, "passengerCapacity": 1, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
            {"type": "ambulance", "typeCode": "ABSC", "suffix": "ABSC-06", "crew": 2, "water": 0, "passengerCapacity": 1, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
            {"type": "advanced_medical_vehicle", "typeCode": "VMER", "suffix": "VMER-01", "crew": 2, "water": 0, "offRoad": False, "capabilities": ["advanced_life_support"]},
            {"type": "immediate_life_support_vehicle", "typeCode": "SIV", "suffix": "SIV-01", "crew": 2, "water": 0, "offRoad": False, "capabilities": ["medical_transport", "advanced_life_support"]},
            {"type": "command_vehicle", "typeCode": "PMA", "suffix": "PMA-01", "crew": 6, "water": 0, "offRoad": False, "capabilities": ["command_and_control", "medical_transport"]},
            {"type": "operations_vehicle", "typeCode": "UMIPE", "suffix": "UMIPE-01", "crew": 3, "water": 0, "offRoad": False, "capabilities": ["evacuation_transport"]},
        ],
        "pools": [
            ("emergency_physician", 15, 12, ["advanced_life_support"]),
            ("nurse", 25, 20, ["advanced_life_support"]),
            ("paramedic", 50, 45, ["first_aid"]),
        ],
    },
    {
        "name": "Serviço Municipal de Proteção Civil de Guimarães",
        "short": "SMPC Guimarães",
        "type": "civil_protection",
        "prefix": "PC-GMR",
        "facilityName": "Serviço Municipal de Proteção Civil de Guimarães",
        "station": {"name": "Centro de Coordenação Operacional Municipal (CCOM)", "kind": "civil_protection_hq", "bays": 16, "pos": {"lat": 41.4415, "lon": -8.2955}},
        "vehicles": [
            {"type": "command_vehicle", "typeCode": "PCO", "suffix": "PCO-01", "crew": 6, "water": 0, "capabilities": ["command_and_control", "communications"]},
            {"type": "command_vehicle", "typeCode": "VCOT", "suffix": "VCOT-01", "crew": 3, "water": 0, "capabilities": ["command_and_control"]},
            {"type": "command_vehicle", "typeCode": "VCOT", "suffix": "VCOT-02", "crew": 3, "water": 0, "capabilities": ["command_and_control"]},
            {"type": "personnel_transport", "typeCode": "VTTP", "suffix": "VTTP-01", "crew": 9, "water": 0, "passengerCapacity": 9, "capabilities": ["evacuation_transport"]},
            {"type": "personnel_transport", "typeCode": "VTTP", "suffix": "VTTP-02", "crew": 9, "water": 0, "passengerCapacity": 9, "capabilities": ["evacuation_transport"]},
            {"type": "personnel_transport", "typeCode": "VTTP", "suffix": "VTTP-03", "crew": 9, "water": 0, "passengerCapacity": 9, "capabilities": ["evacuation_transport"]},
            {"type": "personnel_transport", "typeCode": "VTTP", "suffix": "VTTP-04", "crew": 9, "water": 0, "passengerCapacity": 9, "capabilities": ["evacuation_transport"]},
            {"type": "bus", "typeCode": "BUS", "suffix": "BUS-01", "crew": 2, "water": 0, "passengerCapacity": 55, "offRoad": False, "capabilities": ["evacuation_transport"]},
            {"type": "bus", "typeCode": "BUS", "suffix": "BUS-02", "crew": 2, "water": 0, "passengerCapacity": 55, "offRoad": False, "capabilities": ["evacuation_transport"]},
            {"type": "bus", "typeCode": "BUS", "suffix": "BUS-03", "crew": 2, "water": 0, "passengerCapacity": 55, "offRoad": False, "capabilities": ["evacuation_transport"]},
            {"type": "ambulance", "typeCode": "ABEV", "suffix": "ABEV-01", "crew": 3, "water": 0, "passengerCapacity": 4, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
            {"type": "ambulance", "typeCode": "ABEV", "suffix": "ABEV-02", "crew": 3, "water": 0, "passengerCapacity": 4, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
            {"type": "ambulance", "typeCode": "ABEV", "suffix": "ABEV-03", "crew": 3, "water": 0, "passengerCapacity": 4, "offRoad": False, "capabilities": ["evacuation_transport", "medical_transport"]},
            {"type": "drone", "typeCode": "DRONE", "suffix": "DRONE-01", "crew": 2, "water": 0, "capabilities": ["aerial_recon", "reconnaissance"]},
            {"type": "drone", "typeCode": "DRONE", "suffix": "DRONE-02", "crew": 2, "water": 0, "capabilities": ["aerial_recon", "reconnaissance"]},
            {"type": "forest_firefighting_vehicle", "typeCode": "VFCI-SF", "suffix": "VFCI-SF-01", "crew": 5, "water": 3000, "capabilities": ["wildfire_attack", "structure_protection"]},
            {"type": "forest_firefighting_vehicle", "typeCode": "VFCI-SF", "suffix": "VFCI-SF-02", "crew": 5, "water": 3000, "capabilities": ["wildfire_attack", "structure_protection"]},
            {"type": "bulldozer", "typeCode": "MR-PC", "suffix": "MR-PC-01", "crew": 1, "water": 0, "capabilities": ["firebreak_construction", "heavy_earthmoving"]},
            {"type": "tanker_large", "typeCode": "VTTG", "suffix": "VTTG-01", "crew": 2, "water": 15000, "offRoad": False, "capabilities": ["water_supply"]},
            {"type": "operations_vehicle", "typeCode": "VMAT", "suffix": "VMAT-01", "crew": 2, "water": 0, "capabilities": ["logistics"]},
            {"type": "operations_vehicle", "typeCode": "VMAT", "suffix": "VMAT-02", "crew": 2, "water": 0, "capabilities": ["logistics"]},
        ],
        "pools": [
            ("civil_protection_technician", 50, 45, ["logistics", "evacuation"]),
            ("forest_firefighter", 70, 65, ["forest_firefighting"]),
            ("volunteer", 300, 275, ["first_aid", "evacuation"]),
            ("drone_pilot", 8, 6, ["drone_a1"]),
        ],
    },
]

AIR_ORG = ("Meios Aéreos de Combate", "Meios Aéreos")
HELIPAD = ("Heliporto do Hospital da Senhora da Oliveira", {"lat": 41.4423, "lon": -8.3055})
AERIAL_FLEET = [
    ("HEBL-01", "helicopter", "HEBL", 1000, 200, ["aerial_water_drop"], {"bucketCapacityL": 1000, "loadMinutes": 1, "dropMinutes": 1, "cruiseSpeedKmh": 200, "maxWindKmh": 50, "minVisibilityM": 2000, "dayOnly": True}),
    ("HEBL-02", "helicopter", "HEBL", 1000, 200, ["aerial_water_drop"], {"bucketCapacityL": 1000, "loadMinutes": 1, "dropMinutes": 1, "cruiseSpeedKmh": 200, "maxWindKmh": 50, "minVisibilityM": 2000, "dayOnly": True}),
    ("HEBP-01", "helicopter", "HEBP", 4500, 230, ["aerial_water_drop"], {"bucketCapacityL": 4500, "loadMinutes": 2, "dropMinutes": 1, "cruiseSpeedKmh": 230, "maxWindKmh": 55, "minVisibilityM": 2500, "dayOnly": True}),
    ("HEBP-02", "helicopter", "HEBP", 4500, 230, ["aerial_water_drop"], {"bucketCapacityL": 4500, "loadMinutes": 2, "dropMinutes": 1, "cruiseSpeedKmh": 230, "maxWindKmh": 55, "minVisibilityM": 2500, "dayOnly": True}),
    ("HECO-01", "helicopter", "HECO", 0, 220, ["aerial_recon"], {"cruiseSpeedKmh": 220, "maxWindKmh": 60, "minVisibilityM": 1500, "dayOnly": False}),
]


class Api:
    def __init__(self, base_url: str, dry_run: bool) -> None:
        self.http = httpx.Client(base_url=base_url, timeout=30.0)
        self.dry_run = dry_run
        self.dry_ids = 0

    def all(self, path: str, **params: Any) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        params = {"limit": 200, **params}
        try:
            while True:
                response = self.http.get(path, params=params)
                if response.status_code >= 400:
                    return []
                page = response.json()
                items.extend(page.get("items", []))
                if not page.get("nextCursor"):
                    return items
                params["cursor"] = page["nextCursor"]
        except Exception:
            return []

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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=os.environ.get("FIRETRACE_BASE_URL", "http://localhost:8080/api/v1"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    api = Api(args.base_url, args.dry_run)

    facilities = {f["name"]: f for f in api.all(f"/locations/{LOCATION}/facilities")}
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

    def ensure_vehicle(org_id: str, station_id: str, prefix: str, spec: dict[str, Any] | tuple) -> None:
        if isinstance(spec, tuple):
            vtype, code, suffix, crew, water, caps = spec
            extra: dict[str, Any] = {}
        else:
            vtype = spec["type"]
            code = spec["typeCode"]
            suffix = spec["suffix"]
            crew = spec["crew"]
            water = spec.get("water", 0)
            caps = spec["capabilities"]
            extra = {k: v for k, v in spec.items() if k not in ("type", "typeCode", "suffix", "crew", "water", "capabilities")}

        callsign = f"{prefix}-{suffix}"
        if callsign in callsigns:
            return
        payload = {
            "organizationId": org_id,
            "callsign": callsign,
            "type": vtype,
            "typeCode": code,
            "stationId": station_id,
            "crewCapacity": crew,
            "minimumCrew": min(extra.get("minimumCrew", 2), crew),
            "waterCapacityL": water,
            "pumpFlowLpm": 1000 if water > 0 else 0,
            "passengerCapacity": extra.get("passengerCapacity", 0),
            "offRoad": extra.get("offRoad", True),
            "maxSlopePercent": extra.get("maxSlopePercent", 35),
            "cruiseSpeedKmh": extra.get("cruiseSpeedKmh", 60),
            "capabilities": caps,
            "inService": True,
            "tags": TAGS,
            "metadata": METADATA,
        }
        api.create("/vehicles", "VehicleInput", payload, f"vehicle {callsign}")
        callsigns.add(callsign)

    def ensure_pool(org_id: str, station_id: str, role: str, total: int, available: int, certs: list[str] | None = None, label: str = "") -> None:
        if (org_id, role) in pools:
            return
        api.create(
            "/personnel-pools",
            "PersonnelPoolInput",
            {
                "organizationId": org_id, "role": role, "stationId": station_id, "total": total, "available": available,
                "fatiguePct": 0, "certifications": certs or ["forest_firefighting"], "tags": TAGS, "metadata": METADATA,
            },
            f"pool {label or role}",
        )
        pools.add((org_id, role))

    print(f"Seeding full regional response fleet for {LOCATION} via {args.base_url}")

    # 1. Fire Brigades
    for facility_name, (org_name, short) in BRIGADES.items():
        facility = facilities.get(facility_name)
        pos = facility["position"] if facility else DEFAULT_COORDS.get(facility_name, {"lat": 41.4406, "lon": -8.2917})
        org_id = ensure_org(org_name, short, "fire_brigade")
        station_id = ensure_station(org_id, f"Quartel dos {short}", "fire_station", pos, 10, facility.get("id") if facility else None)
        for spec in FLEET[short]["vehicles"]:
            ensure_vehicle(org_id, station_id, CALLSIGN_PREFIX[short], spec)
        for pool_data in FLEET[short]["pools"]:
            role, total, available = pool_data[:3]
            certs = pool_data[3] if len(pool_data) > 3 else ["forest_firefighting"]
            ensure_pool(org_id, station_id, role, total, available, certs, f"{short}/{role}")

    # 2. Other institutions: GNR, INEM, SMPC
    for org_spec in OTHER_ORGS:
        facility = facilities.get(org_spec["facilityName"])
        pos = facility["position"] if facility else org_spec["station"]["pos"]
        org_id = ensure_org(org_spec["name"], org_spec["short"], org_spec["type"])
        station_id = ensure_station(org_id, org_spec["station"]["name"], org_spec["station"]["kind"], pos, org_spec["station"]["bays"], facility.get("id") if facility else None)
        for spec in org_spec["vehicles"]:
            ensure_vehicle(org_id, station_id, org_spec["prefix"], spec)
        for pool_data in org_spec["pools"]:
            role, total, available = pool_data[:3]
            certs = pool_data[3] if len(pool_data) > 3 else []
            ensure_pool(org_id, station_id, role, total, available, certs, f"{org_spec['short']}/{role}")

    # 3. Air Force (CMA Fleet)
    air_org = ensure_org(AIR_ORG[0], AIR_ORG[1], "air_force")
    helipad = ensure_station(air_org, HELIPAD[0], "helipad", HELIPAD[1], 6)
    for callsign, vtype, code, water, speed, caps, aerial in AERIAL_FLEET:
        if callsign in callsigns:
            continue
        api.create(
            "/vehicles",
            "VehicleInput",
            {
                "organizationId": air_org, "callsign": callsign, "type": vtype, "typeCode": code, "stationId": helipad,
                "crewCapacity": 3, "minimumCrew": 2, "waterCapacityL": water, "passengerCapacity": 0,
                "cruiseSpeedKmh": speed, "capabilities": caps, "inService": True,
                "aerial": aerial,
                "tags": TAGS, "metadata": METADATA,
            },
            f"aircraft {callsign}",
        )
        callsigns.add(callsign)

    print("done" + (" (dry run, nothing sent)" if args.dry_run else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
