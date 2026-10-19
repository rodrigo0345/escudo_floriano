"""Contract conformance: every payload our runtime can emit validates against the spec.

This is the repo's own hard rule (AGENTS.md): the agents are *clients* of
``api-spec/openapi.json``. When the contract changes (or when a schema is added, like
``InterventionFuelRemoval``), these tests fail loudly instead of the server.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

if __package__ in (None, "") and not os.environ.get("FIRETRACE_TESTS_DIRECT"):
    # Direct execution (e.g. the VS Code "Run Python File" button): tests depend
    # on pytest fixtures, parametrization and the sibling conftest context, so
    # simply delegate this file to pytest — identical to `pytest <this path>`.
    os.environ["FIRETRACE_TESTS_DIRECT"] = "1"
    import pytest

    raise SystemExit(pytest.main([str(Path(__file__).resolve())]))

from firetrace_agents.contracts import INTERVENTION_TYPES, validate_against_spec

from .conftest import CAPABILITIES


def _one_intervention_each() -> dict[str, dict]:
    return {
        "fire_line": {
            "type": "fire_line",
            "label": "linha",
            "start": {"offsetMinutes": 0},
            "geometry": {"type": "LineString", "coordinates": [[-8.27, 41.42], [-8.265, 41.425]]},
            "constructionMinutes": 40,
            "effectiveness": 0.8,
            "method": "handline",
        },
        "aerial_drop": {
            "type": "aerial_drop",
            "start": {"offsetMinutes": 0},
            "geometry": {"type": "LineString", "coordinates": [[-8.27, 41.42], [-8.26, 41.42]]},
            "agent": "retardant",
            "effectiveness": 0.45,
            "effectDurationMinutes": 45,
        },
        "backfire": {
            "type": "backfire",
            "start": {"offsetMinutes": 30},
            "geometry": {"type": "LineString", "coordinates": [[-8.27, 41.42], [-8.265, 41.425]]},
            "durationMinutes": 20,
        },
        "fuel_removal": {
            "type": "fuel_removal",
            "start": {"offsetMinutes": 0},
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[-8.275, 41.42], [-8.265, 41.42], [-8.265, 41.426], [-8.275, 41.426], [-8.275, 41.42]]],
            },
            "method": "hand_tool",
            "constructionMinutes": 45,
            "effectiveness": 0.6,
        },
        "crew_deployment": {
            "type": "crew_deployment",
            "start": {"offsetMinutes": 0},
            "responsibility": "firefighting",
            "personnel": 6,
            "vehicles": 1,
            "waterL": 2500,
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[-8.275, 41.42], [-8.265, 41.42], [-8.265, 41.426], [-8.275, 41.42]]],
            },
            "durationMinutes": 60,
        },
        "structure_protection": {
            "type": "structure_protection",
            "start": {"offsetMinutes": 10},
            "placeId": "pl-penha",
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[-8.275, 41.42], [-8.265, 41.42], [-8.265, 41.426], [-8.275, 41.426], [-8.275, 41.42]]],
            },
            "effectiveness": 0.7,
        },
        "evacuation": {
            "type": "evacuation",
            "start": {"offsetMinutes": 0},
            "completeBy": {"offsetMinutes": 30},
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[-8.275, 41.42], [-8.265, 41.42], [-8.265, 41.426], [-8.275, 41.426], [-8.275, 41.42]]],
            },
            "placeIds": ["pl-penha"],
            "population": 320,
        },
        "road_closure": {"type": "road_closure", "start": {"offsetMinutes": 5}, "roadIds": ["rd-en101-0412"]},
    }


def test_every_contract_intervention_is_reachable_and_named_like_the_spec(spec):
    contract_types = set(
        ref.split("/")[-1].removeprefix("Intervention") for ref in [
            entry["$ref"] for entry in spec["components"]["schemas"]["Intervention"]["oneOf"]
        ]
    )
    assert contract_types == {t.replace("_", " ").title().replace(" ", "") for t in INTERVENTION_TYPES}
    mapping = spec["components"]["schemas"]["Intervention"]["discriminator"]["mapping"]
    assert set(mapping) == set(INTERVENTION_TYPES)


def test_every_intervention_variant_validates_against_the_spec():
    for kind, payload in _one_intervention_each().items():
        validate_against_spec("Intervention", payload)


def test_fuel_removal_schema_exists_and_one_of_lists_it(spec):
    """The new intervention: schema present, wired in the oneOf + mapping."""
    schema = spec["components"]["schemas"]["InterventionFuelRemoval"]
    inner = schema["allOf"][1]
    assert inner["properties"]["type"]["const"] == "fuel_removal"
    assert inner["required"] == ["type", "geometry", "effectiveness"]
    assert {"hand_tool", "machine", "grazing"} <= set(inner["properties"]["method"]["enum"])


def test_capabilities_fixture_lists_all_eight_interventions():
    supported = {item["name"] for item in CAPABILITIES["interventions"] if item["supported"]}
    assert supported == set(INTERVENTION_TYPES)


def test_firefighter_decision_payloads_conform_multiple_times():
    """Sanity of constants against the contract pools (units in field names etc.)."""
    validate_against_spec("Objective", {"objective": "protect_life", "weight": 1.0})
    validate_against_spec("Objective", {"objective": "minimize_burned_area", "weight": 0.9})
    validate_against_spec("ActionPriority", "critical")
    validate_against_spec("ActionPriority", "high")
    validate_against_spec("Responsibility", "firefighting")
    validate_against_spec("Responsibility", "evacuation")
    validate_against_spec("ResourceType", "vehicle")
    validate_against_spec("ResourceType", "personnel_pool")
