"""Shared fixtures: the contract, and situation fixtures built from its shapes."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENTS_PKG = REPO_ROOT / "agents"
SPEC_PATH = REPO_ROOT / "api-spec" / "openapi.json"

# The tests double as the runtime contract checker: if the spec moves, every test
# payload below is validated against the NEW spec, and drift fails loudly (AGENTS.md).
sys.path.insert(0, str(AGENTS_PKG))

import httpx  # noqa: E402

from firetrace_agents.client import FiretraceClient  # noqa: E402


@pytest.fixture(scope="session")
def spec() -> dict:
    import json

    with SPEC_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


@pytest.fixture
def fleet_page() -> dict:
    """GET /vehicles → VehiclePage (Realistic fleet of Bombeiros Voluntários)."""
    return {
        "items": [
            {
                "id": "veh-vt-01",
                "callsign": "BV-VT-01",
                "type": "tanker_forest",
                "organizationId": "org-bv-penha",
                "crewCapacity": 6,
                "minimumCrew": 3,
                "waterCapacityL": 2500,
                "passengerCapacity": 8,
                "capabilities": ["wildfire_attack", "structure_protection", "evacuation_transport", "water_supply"],
                "state": {"status": "available", "position": {"lat": 41.4302, "lon": -8.267}},
            },
            {
                "id": "veh-heli-01",
                "callsign": "PT-HELI-05",
                "type": "helicopter",
                "organizationId": "org-bv-penha",
                "crewCapacity": 4,
                "waterCapacityL": 3000,
                "capabilities": ["aerial_water_drop", "aerial_recon"],
                "state": {"status": "available", "position": {"lat": 41.4312, "lon": -8.271}},
            },
            {
                "id": "veh-amb-01",
                "callsign": "BV-ABSC-01",
                "type": "ambulance",
                "organizationId": "org-inem-penha",
                "crewCapacity": 3,
                "capabilities": ["medical_transport"],
                "state": {"status": "available", "position": {"lat": 41.432, "lon": -8.263}},
            },
        ],
        "nextCursor": None,
    }


@pytest.fixture
def pools_page() -> dict:
    return {
        "items": [
            {
                "id": "pp-forest-penha",
                "role": "forest_firefighter",
                "organizationId": "org-bv-penha",
                "total": 10,
                "available": 8,
                "certifications": ["forest_firefighting"],
                "stationId": "st-bv-penha",
            }
        ],
        "nextCursor": None,
    }


THREATENED_TOWN: dict = {
    "simulationId": "sim-penanet",
    "tMin": 30,
    "horizonMinutes": 60,
    "minProbability": 0.2,
    "assets": [
        {
            "assetType": "place",
            "id": "pl-penha",
            "name": "Penha",
            "position": {"lat": 41.4302, "lon": -8.2678},
            "probability": 0.85,
            "arrivalMinute": {"p10": 35, "p50": 47, "p90": 58},
            "population": 320,
        },
        {
            "assetType": "facility",
            "id": "fac-lar-santo-antonio",
            "name": "Lar S. António (vulnerável)",
            "position": {"lat": 41.4312, "lon": -8.2695},
            "probability": 0.9,
            "arrivalMinute": {"p10": 38, "p50": 52, "p90": 61},
            "vulnerable": True,
            "population": 58,
        },
        {
            "assetType": "road",
            "id": "rd-en101-0412",
            "name": "EN101 (km 41,2)",
            "probability": 0.7,
            "arrivalMinute": {"p50": 35},
        },
    ],
    "buildings": {"count": 120, "estimatedPeople": 380},
    "unitsAtRisk": [],
}

THREATENED_ISOLATED: dict = {
    "simulationId": "sim-penanet",
    "tMin": 30,
    "horizonMinutes": 60,
    "minProbability": 0.2,
    "assets": [
        {
            "assetType": "place",
            "id": "pl-valinhos",
            "name": "Valinhos (isolada)",
            "position": {"lat": 41.4712, "lon": -8.2921},
            "probability": 0.6,
            "arrivalMinute": {"p10": 85, "p50": 95, "p90": 120},
            "population": 12,
        }
    ],
    "buildings": {"count": 2, "estimatedPeople": 12},
    "unitsAtRisk": [],
}


def _milestones(time: str, area_ha: float, head_speed: float, intensity: float) -> dict:
    return {
        "simulationId": "sim-penanet",
        "milestones": [
            {
                "tMin": 30,
                "time": time,
                "areaHa": area_ha,
                "areaGrowthHaPerHour": 90.0,
                "headSpeedMmin": head_speed,
                "headBearingDeg": 135.0,
                "maxIntensityKwm": intensity,
                "crownHa": area_ha * 0.2 if intensity > 2500 else 0.0,
                "buildingsAffected": 4,
                "roadsCut": 2,
                "placesThreatened": 1,
                "headPosition": {"lat": 41.4351, "lon": -8.2712},
                "wind": {
                    "windSpeedKmh": 35,
                    "windFromDeg": 315,
                    "temperatureC": 36,
                    "relativeHumidityPct": 22,
                },
            }
        ],
        "final": {
            "tMin": 240,
            "time": "2026-08-17T18:30:00Z",
            "areaHa": area_ha * 8,
            "areaGrowthHaPerHour": 60.0,
            "headSpeedMmin": head_speed,
            "headBearingDeg": 135.0,
            "maxIntensityKwm": intensity,
            "buildingsAffected": 40,
            "roadsCut": 3,
            "placesThreatened": 2,
            "headPosition": {"lat": 41.4402, "lon": -8.2602},
        },
    }


# Hot summer afternoon, nortada: the fire runs at ~11 m/min with 2800 kW/m.
SUMMARY_RAGING = _milestones("2026-08-17T15:30:00Z", 210.0, 11.0, 2800.0)
# Milder, slower fire in a forested valley: 5 m/min, 1200 kW/m.
SUMMARY_MEDIUM = _milestones("2026-08-17T15:30:00Z", 80.0, 5.0, 1200.0)


CAPABILITIES: dict = {
    "apiVersion": "1.0.0",
    "engine": {"name": "ELMFIRE", "version": "3.0"},
    "limits": {"maxActionsPerPlan": 500, "maxEnsembleMembers": 8},
    "interventions": [
        {"name": name, "supported": True}
        for name in (
            "road_closure",
            "fire_line",
            "aerial_drop",
            "backfire",
            "fuel_removal",
            "crew_deployment",
            "structure_protection",
            "evacuation",
        )
    ],
    "actionTypes": [{"name": name, "supported": True} for name in ("fire_attack", "evacuation", "request_reinforcements")],
    "locations": ["guimaraes-concelho"],
}


class _Store:
    """Simple per-test in-memory backend stand-in (never leaves the tests folder)."""

    def __init__(self, *, vehicles=None, pools=None, threatened, summary, capabilities=None):
        self.vehicles = vehicles
        self.pools = pools
        self.threatened = threatened
        self.summary = summary
        self.capabilities = capabilities if capabilities is not None else CAPABILITIES
        self.posted_plans: list[dict] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        method = request.method
        json_ok = lambda payload: httpx.Response(200, json=payload)  # noqa: E731

        if path == "/capabilities":
            return json_ok(self.capabilities)
        if path == "/vehicles":
            return json_ok(self.vehicles or {"items": [], "nextCursor": None})
        if path == "/personnel-pools":
            return json_ok(self.pools or {"items": [], "nextCursor": None})
        if path.startswith("/simulations/") and path.endswith("/threatened"):
            return json_ok(dict(self.threatened, simulationId=path.split("/")[2]))
        if path.startswith("/simulations/") and path.endswith("/summary"):
            return json_ok(dict(self.summary, simulationId=path.split("/")[2]))
        if path == "/rules":
            return json_ok({"version": "test", "safety": {"minSafeDistanceM": 100}, "suppression": {"baseEffectiveness": 0.15}})
        if method == "POST" and path == "/plans/validate":
            return json_ok({"valid": True, "issues": []})
        if method == "POST" and path == "/plans":
            body = json.loads(request.content.decode("utf-8"))
            self.posted_plans.append(body)
            return httpx.Response(
                201,
                json={
                    **body,
                    "id": f"plan-test-{body.get('variant', 'A').lower()}",
                    "status": "proposed",
                    "createdAt": "2026-08-17T15:31:00Z",
                    "updatedAt": "2026-08-17T15:31:00Z",
                    "validation": {"valid": True, "issues": []},
                },
            )
        return httpx.Response(
            404,
            json={"code": "not_found", "title": f"no stand-in for {method} {path}"},
        )


def mock_client(**store_kwargs) -> tuple[FiretraceClient, _Store]:
    store = _Store(**store_kwargs)
    client = FiretraceClient(base_url="mock://firetrace", transport=httpx.MockTransport(store.handle))
    return client, store
