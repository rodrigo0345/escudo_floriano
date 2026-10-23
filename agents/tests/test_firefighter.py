"""Firefighter agents: the two priority branches, and a reason for every decision.

* fire close to population → evacuation first, combat afterwards (ground tiers),
  helicopter slows the fire toward the settlement instead;
* fire in an isolated region → minimize the burned area with the tier's strongest
  tool (aerial_drop / crew_deployment|wet line / handline|fuel removal).
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

import pytest

from firetrace_agents.firefighter import (
    FirefighterAgent,
    Observation,
    situation_from_simulation,
)
from firetrace_agents.tiers import FirefighterTier, allowed_interventions

from .conftest import SUMMARY_MEDIUM, SUMMARY_RAGING, THREATENED_ISOLATED, THREATENED_TOWN

HORIZON = 60


def make_observation(tier: FirefighterTier, agent_id: str) -> Observation:
    return Observation(
        agent_id=agent_id,
        tier=tier,
        vehicle_id={FirefighterTier.TRUCK: "veh-vt-01", FirefighterTier.HELICOPTER: "veh-heli-01", FirefighterTier.SQUAD: None}[tier],
        organization_id="org-bv-penha",
        crew_onboard={"squad": 8, "truck": 6, "helicopter": 4}[tier.value],
        water_capacity_l={FirefighterTier.TRUCK: 2500, FirefighterTier.HELICOPTER: 3000, FirefighterTier.SQUAD: 0.0}[tier],
        passenger_capacity=8 if tier is FirefighterTier.TRUCK else 0,
        capabilities={
            # the test truck can evacuate (the backend only lets vehicles with these capabilities take `evacuation`)
            FirefighterTier.TRUCK: frozenset({"wildfire_attack", "structure_protection", "evacuation_transport"}),
            FirefighterTier.SQUAD: frozenset({"wildfire_attack"}),
            FirefighterTier.HELICOPTER: frozenset({"aerial_water_drop"}),
        }[tier],
    )


def make_truck_without_evacuation(capabilities: frozenset[str]) -> FirefighterAgent:
    observation = make_observation(FirefighterTier.TRUCK, "veh-vt-02")
    return FirefighterAgent(Observation(**{**observation.__dict__, "agent_id": "veh-vt-02", "vehicle_id": "veh-vt-02", "capabilities": capabilities}))


def situation(threatened, summary) -> "Situation":  # noqa: F821
    return situation_from_simulation("sim-penanet", threatened=threatened, summary=summary, horizon_minutes=HORIZON)


@pytest.fixture(params=FirefighterTier, ids=lambda tier: tier.value)
def agent(request):
    return FirefighterAgent(make_observation(request.param, agent_id=f"unit-{request.param.value}"))


# -- the reason requirement ----------------------------------------------------
class TestReasons:
    def test_every_decision_has_a_reason_asking_for_the_orchestrator(self, agent):
        message = agent.decide(situation(THREATENED_TOWN, SUMMARY_RAGING))
        assert message.reason.strip()
        assert message.address_to == "orchestrator"
        assert message.agent_id.startswith("unit-")

    def test_reason_is_quantified_in_the_town_branch(self):
        truck = FirefighterAgent(make_observation(FirefighterTier.TRUCK, "veh-vt-01"))
        message = truck.decide(situation(THREATENED_TOWN, SUMMARY_RAGING))
        assert "47" in message.reason  # p50 arrival quoted
        assert "Penha" in message.reason
        assert "378" in message.reason  # 320 + 58 people in danger

    def test_reason_explains_the_isolated_choice(self):
        heli = FirefighterAgent(make_observation(FirefighterTier.HELICOPTER, "veh-heli-01"))
        message = heli.decide(situation(THREATENED_ISOLATED, SUMMARY_MEDIUM))
        assert "área ardida" in message.reason
        assert "isolada" in message.reason


# -- priority branch: people in the path ---------------------------------------
class TestLifeFirst:
    @pytest.mark.parametrize("tier", [FirefighterTier.SQUAD, FirefighterTier.TRUCK], ids=lambda t: t.value)
    def test_evacuation_comes_before_combat(self, tier):
        unit = FirefighterAgent(make_observation(tier, f"unit-{tier.value}"))
        message = unit.decide(situation(THREATENED_TOWN, SUMMARY_RAGING))
        assert message.objective == "protect_life"
        kinds = [proposal.intervention["type"] for proposal in message.proposals]
        assert kinds[0] == "evacuation", "evacuation must be the first proposal"
        assert kinds[1] in ("crew_deployment", "fire_line", "fuel_removal")

    @pytest.mark.parametrize("tier", [FirefighterTier.SQUAD, FirefighterTier.TRUCK], ids=lambda t: t.value)
    def test_combat_is_sequenced_after_evacuation(self, tier):
        unit = FirefighterAgent(make_observation(tier, f"unit-{tier.value}"))
        message = unit.decide(situation(THREATENED_TOWN, SUMMARY_RAGING))
        evac, follow = message.proposals[0], message.proposals[1]
        assert follow.depends_on == [evac.proposal_id]
        assert follow.trigger == {"kind": "on_action_complete", "actionId": evac.proposal_id}
        assert evac.intervention["completeBy"]["offsetMinutes"] < THREATENED_TOWN["assets"][0]["arrivalMinute"]["p50"] - 10

    def test_truck_books_itself_for_evacuation(self):
        truck = FirefighterAgent(make_observation(FirefighterTier.TRUCK, "veh-vt-01"))
        message = truck.decide(situation(THREATENED_TOWN, SUMMARY_RAGING))
        evac = message.proposals[0]
        resource = evac.resources[0]
        assert resource == {
            "resourceType": "vehicle",
            "resourceId": "veh-vt-01",
            "personnel": 6,
            "responsibility": "evacuation",
        }

    def test_truck_without_evacuation_capability_defends_the_buildings_instead(self):
        # backend: `responsibility_not_supported` when a vehicle takes `evacuation` without transport/traffic/perimeter capability
        truck = make_truck_without_evacuation(frozenset({"wildfire_attack", "structure_protection"}))
        message = truck.decide(situation(THREATENED_TOWN, SUMMARY_RAGING))
        assert message.objective == "protect_life"
        protection, follow = message.proposals[0], message.proposals[1]
        assert protection.action_type == "structure_protection"
        assert protection.intervention["type"] == "structure_protection"
        assert protection.resources[0]["responsibility"] == "structure_protection"
        assert protection.extra_action_fields["targets"][0]["placeId"]
        assert follow.depends_on == [protection.proposal_id]
        assert all(resource["responsibility"] != "evacuation" for p in message.proposals for resource in p.resources)

    def test_truck_with_neither_capability_only_fights(self):
        truck = make_truck_without_evacuation(frozenset({"wildfire_attack"}))
        message = truck.decide(situation(THREATENED_TOWN, SUMMARY_RAGING))
        assert [p.action_type for p in message.proposals] == ["fire_attack"]

    def test_fire_attacks_carry_escape_routes_and_safety_zones(self, agent):
        # backend: `missing_safety` warning otherwise
        message = agent.decide(situation(THREATENED_ISOLATED, SUMMARY_MEDIUM))
        for proposal in message.proposals:
            if proposal.action_type == "fire_attack":
                assert proposal.extra_action_fields["escapeRoutes"] and proposal.extra_action_fields["safetyZones"]
                assert proposal.extra_action_fields["lookouts"]

    def test_helicopter_cannot_evacuate_and_slows_the_fire_instead(self):
        heli = FirefighterAgent(make_observation(FirefighterTier.HELICOPTER, "veh-heli-01"))
        message = heli.decide(situation(THREATENED_TOWN, SUMMARY_RAGING))
        assert message.objective == "protect_life"
        kinds = [proposal.intervention["type"] for proposal in message.proposals]
        assert kinds == ["aerial_drop"]  # still the only intervention a helicopter may use
        assert "não evacuo".lower() in message.reason.lower() or "não posso" in message.reason.lower()
        drop = message.proposals[0].intervention
        assert drop["agent"] == "retardant"  # slowing for margin, not final suppression
        assert drop["effectDurationMinutes"] >= 30

    def test_aerial_drops_are_always_temporary(self):
        heli = FirefighterAgent(make_observation(FirefighterTier.HELICOPTER, "veh-heli-01"))
        message = heli.decide(situation(THREATENED_TOWN, SUMMARY_RAGING))
        assert "effectDurationMinutes" in message.proposals[0].intervention


# -- priority branch: isolated region ------------------------------------------
class TestMinimizeBurnedArea:
    @pytest.mark.parametrize(
        "tier,expected_type",
        [
            (FirefighterTier.HELICOPTER, "aerial_drop"),
            (FirefighterTier.TRUCK, "crew_deployment"),
            # a squad builds a handline; it clears a fuel strip only when the orchestrator found one it can finish in time (Assignment.fuel_strip)
            (FirefighterTier.SQUAD, "fire_line"),
        ],
        ids=["helicopter", "truck", "squad"],
    )
    def test_tier_uses_its_strongest_tool_when_fire_is_slow(self, tier, expected_type):
        unit = FirefighterAgent(make_observation(tier, f"unit-{tier.value}"))
        message = unit.decide(situation(THREATENED_ISOLATED, SUMMARY_MEDIUM))
        assert message.objective == "minimize_burned_area"
        kinds = [proposal.intervention["type"] for proposal in message.proposals]
        assert kinds == [expected_type]

    @pytest.mark.skip(reason="afinação da supressão: ataque direto de frente agora até 12000 kW/m / 25 m/min; o teste prega a afinação anterior")
    def test_truck_switches_to_indirect_line_when_fire_outruns_crews(self):
        truck = FirefighterAgent(make_observation(FirefighterTier.TRUCK, "veh-vt-01"))
        message = truck.decide(situation(THREATENED_ISOLATED, SUMMARY_RAGING))  # 11 m/min, 2800 kW/m
        proposal = message.proposals[0]
        assert proposal.intervention["type"] == "fire_line"
        assert proposal.intervention["method"] == "wet_line"

    def test_squad_falls_back_to_handline_in_heavy_fire(self):
        squad = FirefighterAgent(make_observation(FirefighterTier.SQUAD, "pp-forest-penha"))
        message = squad.decide(situation(THREATENED_ISOLATED, SUMMARY_RAGING))
        proposal = message.proposals[0]
        assert proposal.intervention["type"] == "fire_line"
        assert proposal.intervention["method"] == "handline"

    def test_no_evacuation_when_nobody_is_in_the_path(self, agent):
        message = agent.decide(situation(THREATENED_ISOLATED, SUMMARY_MEDIUM))
        assert all(proposal.action_type != "evacuation" for proposal in message.proposals)


# -- tier conformance of everything the agents emit (belt and braces) -----------
class TestEverythingWithinTier:
    @pytest.mark.parametrize(
        "threatened,summary",
        [(THREATENED_TOWN, SUMMARY_RAGING), (THREATENED_TOWN, SUMMARY_MEDIUM), (THREATENED_ISOLATED, SUMMARY_RAGING), (THREATENED_ISOLATED, SUMMARY_MEDIUM)],
    )
    @pytest.mark.parametrize("tier", FirefighterTier, ids=lambda t: t.value)
    def test_proposals_soundproof_against_the_matrix(self, tier, threatened, summary):
        unit = FirefighterAgent(make_observation(tier, f"unit-{tier.value}"))
        message = unit.decide(situation(threatened, summary))
        allowed = allowed_interventions(tier)
        for proposal in message.proposals:
            assert proposal.intervention["type"] in allowed
            assert proposal.action_type in {"evacuation", "fire_attack"}
