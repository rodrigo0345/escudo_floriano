"""Tier rules: who may execute which intervention (the "common sense" matrix in code)."""
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

import pytest

from firetrace_agents.tiers import (
    AERIAL_FIRE_TYPES,
    GROUND_FIRE_TYPES,
    ORCHESTRATOR_ONLY,
    FirefighterTier,
    allowed_interventions,
    can_execute,
    explain_denial,
    tier_for_vehicle,
)


class TestMatrix:
    def test_ground_tiers_never_drop_from_the_air(self):
        for tier in (FirefighterTier.SQUAD, FirefighterTier.TRUCK):
            assert not can_execute(tier, "aerial_drop"), f"{tier} must not perform aerial drops"
            assert "aerial_drop" not in allowed_interventions(tier)

    def test_helicopter_only_drops_from_the_air(self):
        allowed = allowed_interventions(FirefighterTier.HELICOPTER)
        assert allowed == {"aerial_drop"}
        for forbidden in ("crew_deployment", "fire_line", "fuel_removal", "evacuation", "backfire", "structure_protection", "road_closure"):
            assert not can_execute(FirefighterTier.HELICOPTER, forbidden)

    def test_backfire_and_road_closure_are_command_level(self):
        assert ORCHESTRATOR_ONLY == {"road_closure", "backfire"}
        for tier in FirefighterTier:
            if tier is not FirefighterTier.TRUCK:
                assert not can_execute(tier, "backfire")
            assert not can_execute(tier, "road_closure"), "closing roads is the incident commander's order"

    def test_squad_theory(self):
        allowed = allowed_interventions(FirefighterTier.SQUAD)
        assert {"crew_deployment", "fire_line", "fuel_removal", "evacuation"} <= allowed
        assert allowed_interventions(FirefighterTier.SQUAD).isdisjoint({"aerial_drop", "backfire", "road_closure"})

    def test_truck_theory(self):
        allowed = allowed_interventions(FirefighterTier.TRUCK)
        assert {"crew_deployment", "fire_line", "fuel_removal", "structure_protection", "evacuation", "backfire"} <= allowed
        assert "aerial_drop" not in allowed

    def test_method_constraints(self):
        from firetrace_agents.tiers import TIER_PERMISSIONS

        squads = TIER_PERMISSIONS[FirefighterTier.SQUAD]
        assert squads.fire_line_methods == {"handline"}
        assert squads.fuel_removal_methods == {"hand_tool"}
        trucks = TIER_PERMISSIONS[FirefighterTier.TRUCK]
        assert "wet_line" in trucks.fire_line_methods and "machine" in trucks.fire_line_methods
        helis = TIER_PERMISSIONS[FirefighterTier.HELICOPTER]
        assert {"water", "retardant", "foam"} == set(helis.aerial_drop_agents)

    def test_unknown_intervention_rejected(self):
        assert not can_execute(FirefighterTier.TRUCK, "fuel_removal_intervention")
        assert "does not exist in the openapi contract" in explain_denial(FirefighterTier.TRUCK, "fuel_removal_intervention")

    def test_denied_pairs_get_a_literate_reason(self):
        assert "cannot execute 'aerial_drop'" in explain_denial(FirefighterTier.TRUCK, "aerial_drop")
        assert "orchestrator only" in explain_denial(FirefighterTier.SQUAD, "road_closure").lower()


class TestVehicleTyping:
    @pytest.mark.parametrize(
        "vehicle_type,expected",
        [
            ("tanker_forest", FirefighterTier.TRUCK),
            ("forest_firefighting_vehicle", FirefighterTier.TRUCK),
            ("tanker_urban", FirefighterTier.TRUCK),
            ("helicopter", FirefighterTier.HELICOPTER),
            ("airtanker", FirefighterTier.HELICOPTER),
            ("ambulance", None),
            ("command_vehicle", None),
            ("drone", None),
        ],
    )
    def test_type_to_tier(self, vehicle_type, expected):
        assert tier_for_vehicle(vehicle_type) == expected

    def test_typing_tables_are_disjoint(self):
        assert GROUND_FIRE_TYPES.isdisjoint(AERIAL_FIRE_TYPES)
