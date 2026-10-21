"""Orchestrator: collects, validates, resolves conflicts, publishes plans A and B.

The plan payloads the orchestrator posts are validated in-test against the real
``api-spec/openapi.json`` (``PlanInput`` — the whole discriminated ``Action`` and
``Intervention`` trees), so the published shape is contract-conformant.
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

import firetrace_agents.contracts as contracts
from firetrace_agents.contracts import validate_against_spec
from firetrace_agents.firefighter import ActionProposal, DecisionMessage, FirefighterAgent, situation_from_simulation
from firetrace_agents.orchestrator import CycleResult, OrchestratorAgent
from firetrace_agents.tiers import FirefighterTier

from .conftest import SUMMARY_MEDIUM, SUMMARY_RAGING, THREATENED_ISOLATED, THREATENED_TOWN, mock_client
from .test_firefighter import make_observation

VEHICLES = {
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

POOLS = {
    "items": [
        {
            "id": "pp-forest-penha",
            "role": "forest_firefighter",
            "organizationId": "org-bv-penha",
            "total": 10,
            "available": 8,
            "certifications": ["forest_firefighting"],
        }
    ],
    "nextCursor": None,
}


def _orchestrator(threatened, summary, capabilities=None) -> OrchestratorAgent:
    client, _store = mock_client(
        vehicles=VEHICLES,
        pools=POOLS,
        threatened=threatened,
        summary=summary,
        capabilities=capabilities,
    )
    orchestrator = OrchestratorAgent(client)
    orchestrator.pull_fleet()
    return orchestrator


def _situation(threatened, summary):
    return situation_from_simulation("sim-penanet", threatened=threatened, summary=summary, horizon_minutes=60)


class TestPullFleet:
    def test_builds_truck_helicopter_and_squad_skipping_the_ambulance(self):
        orchestrator = _orchestrator(THREATENED_TOWN, SUMMARY_RAGING)
        tiers = sorted(agent.tier.value for agent in orchestrator.agents)
        assert tiers == ["helicopter", "squad", "truck"]
        ids = {agent.agent_id for agent in orchestrator.agents}
        assert ids == {"veh-vt-01", "veh-heli-01", "pp-forest-penha"}


class TestPlanCycle:
    def test_town_cycle_publishes_a_and_b_contract_conformant(self):
        orchestrator, store = _with_store(THREATENED_TOWN, SUMMARY_RAGING)
        result = orchestrator.run_cycle("sim-penanet", location_id="guimaraes-concelho")
        assert set(result.published) == {"A", "B"}
        assert len(store.posted_plans) == 2

        for plan in store.posted_plans:
            validate_against_spec("PlanInput", plan)  # <<< the payload against the real spec

        plan_a, plan_b = result.plan_a, result.plan_b
        assert plan_a["variant"] == "A" and plan_b["variant"] == "B"
        assert plan_a["basis"]["simulationId"] == "sim-penanet"

        # A: life first — the evacuation action opens the plan.
        first_a = plan_a["actions"][0]
        assert first_a["type"] == "evacuation"
        assert first_a["priority"] == "critical"

        # B: suppression first — no evacuation opens the plan.
        assert plan_b["actions"][0]["type"] != "evacuation"
        weights = {objective["objective"]: objective["weight"] for objective in plan_b["objectives"]}
        assert weights["minimize_burned_area"] == 0.9

    def test_actions_keep_the_firefighters_reason_and_effects(self):
        orchestrator, store = _with_store(THREATENED_TOWN, SUMMARY_RAGING)
        result = orchestrator.run_cycle("sim-penanet")
        reasons = result.reasons_log()
        assert reasons and all(reason.strip() for reason in reasons)
        plan_a = store.posted_plans[0]
        # actions the agents proposed carry their own reason verbatim; the command-level shelter advisories carry the life planner's
        rationales = {action["rationale"] for action in plan_a["actions"] if action["type"] != "shelter_in_place"}
        assert rationales <= set(reasons), "each agent action carries the agent's reason, verbatim"
        assert all(action["rationale"].strip() for action in plan_a["actions"])
        for action in plan_a["actions"]:
            if action["type"] == "shelter_in_place":
                continue  # a public advisory: it has no physical effect on the fire
            assert len(action["simulationEffects"]) == 1
            assert action["simulationEffects"][0]["type"] in contracts.INTERVENTION_TYPES

    def test_dependency_integrity_inside_the_plan(self):
        """The follow-up attack depends on an evacuation id that exists in the plan."""
        orchestrator, _store = _with_store(THREATENED_TOWN, SUMMARY_RAGING)
        result = orchestrator.run_cycle("sim-penanet")
        plan_a = result.plan_a
        ids = {action["id"] for action in plan_a["actions"]}
        assert ids
        for action in plan_a["actions"]:
            for dependency in action.get("dependsOn", []) or []:
                assert dependency in ids
            trigger = action.get("trigger") or {}
            if trigger.get("kind") == "on_action_complete":
                assert trigger["actionId"] in ids

    def test_no_plan_carries_a_forbidden_tier_intervention(self):
        orchestrator, store = _with_store(THREATENED_TOWN, SUMMARY_RAGING)
        orchestrator.run_cycle("sim-penanet")
        for plan in store.posted_plans:
            for action in plan["actions"]:
                if action["type"] == "shelter_in_place":
                    continue  # command-level advisory, no firefighter intervention
                kind = action["simulationEffects"][0]["type"]
                if kind == "aerial_drop":
                    vehicle_ids = [
                        resource["resourceId"]
                        for resource in action.get("resources", [])
                        if resource["resourceType"] == "vehicle"
                    ]
                    assert vehicle_ids and all(vehicle_id == "veh-heli-01" for vehicle_id in vehicle_ids)

    def test_isolated_cycle_publishes_two_plans(self):
        orchestrator, store = _with_store(THREATENED_ISOLATED, SUMMARY_MEDIUM)
        result = orchestrator.run_cycle("sim-penanet")
        assert len(store.posted_plans) == 2
        assert result.published["A"] and result.published["B"]
        for plan in store.posted_plans:
            validate_against_spec("PlanInput", plan)


def _with_store(threatened, summary, capabilities=None):
    client, store = mock_client(
        vehicles=VEHICLES,
        pools=POOLS,
        threatened=threatened,
        summary=summary,
        capabilities=capabilities,
    )
    orchestrator = OrchestratorAgent(client)
    orchestrator.pull_fleet()
    return orchestrator, store


class TestOrchestratorGuards:
    def test_truck_proposing_aerial_drop_is_rejected(self):
        """The case the user called out: a fire truck must never perform an aerial drop."""
        orchestrator = _orchestrator(THREATENED_TOWN, SUMMARY_RAGING)
        message = DecisionMessage(
            agent_id="veh-vt-01",
            tier=FirefighterTier.TRUCK,
            organization_id="org-bv-penha",
            objective="minimize_burned_area",
            reason="deliberately misplanned proposal",
            proposals=[
                ActionProposal(
                    action_type="fire_attack",
                    title="squirt from the ground like a helicopter",
                    intervention={
                        "type": "aerial_drop",
                        "start": {"offsetMinutes": 0},
                        "geometry": {"type": "LineString", "coordinates": [[-8.27, 41.42], [-8.26, 41.42]]},
                        "agent": "water",
                        "effectiveness": 0.5,
                        "effectDurationMinutes": 20,
                    },
                    priority="high",
                )
            ],
        )
        result = CycleResult(simulation_id="sim-penanet", decisions=[message])
        orchestrator._guard_decisions(result)
        assert any("aerial_drop" in issue.problem for issue in result.issues), "tier guard must catch the drop"

    def test_capability_gate_drops_unsupported_intervention(self):
        orchestrator = _orchestrator(
            THREATENED_ISOLATED, SUMMARY_MEDIUM,
            capabilities={
                "apiVersion": "x",
                "interventions": [{"name": "fire_line", "supported": False}],
            },
        )
        squads = [agent for agent in orchestrator.agents if agent.tier is FirefighterTier.SQUAD]
        assert squads, "the pull_fleet team includes the personnel pool (squad tier)"
        message = squads[0].decide(_situation(THREATENED_ISOLATED, SUMMARY_MEDIUM))
        result = CycleResult(simulation_id="sim-penanet", decisions=[message])
        orchestrator._guard_decisions(result)
        assert any("fire_line" in issue.problem for issue in result.issues)

    def test_fuel_removal_is_kept_now_that_the_backend_takes_it_with_its_removal_field(self):
        orchestrator = _orchestrator(THREATENED_ISOLATED, SUMMARY_MEDIUM)  # /capabilities says it is supported
        message = DecisionMessage(
            agent_id="pp-x",
            tier=FirefighterTier.SQUAD,
            organization_id="org-bv-penha",
            objective="minimize_burned_area",
            reason="clear fuel ahead",
            proposals=[
                ActionProposal(
                    action_type="fire_attack",
                    title="fuel removal",
                    intervention={"type": "fuel_removal", "start": {"offsetMinutes": 0}},
                    priority="high",
                )
            ],
        )
        result = CycleResult(simulation_id="sim-penanet", decisions=[message])
        orchestrator._guard_decisions(result)
        assert not any("fuel_removal" in issue.problem and "backend" in issue.problem for issue in result.issues)

    def test_vehicle_conflict_keeps_the_life_first_action(self):
        orchestrator = _orchestrator(THREATENED_TOWN, SUMMARY_RAGING)
        first_owner = DecisionMessage(
            agent_id="veh-vt-01",
            tier=FirefighterTier.TRUCK,
            organization_id="org-bv-penha",
            objective="protect_life",
            reason="own vehicle, evacuation",
            proposals=[
                ActionProposal(
                    action_type="evacuation",
                    title="evac with own truck",
                    proposal_id="act-veh-vt-01-00",
                    intervention={"type": "evacuation", "start": {"offsetMinutes": 0}},
                    priority="critical",
                    resources=[
                        {"resourceType": "vehicle", "resourceId": "veh-vt-01", "responsibility": "evacuation", "personnel": 6}
                    ],
                )
            ],
        )
        clash = DecisionMessage(
            agent_id="other-agent",
            tier=FirefighterTier.TRUCK,
            organization_id="org-bv-penha",
            objective="minimize_burned_area",
            reason="someone else's truck",
            proposals=[
                ActionProposal(
                    action_type="fire_attack",
                    title="attack with the same truck",
                    proposal_id="act-other-agent-00",
                    intervention={
                        "type": "crew_deployment",
                        "start": {"offsetMinutes": 0},
                        "responsibility": "firefighting",
                        "personnel": 5,
                        "geometry": {"type": "Polygon", "coordinates": [[[0.0, 0.0], [0.1, 0.0], [0.1, 0.1], [0.0, 0.0]]]},
                    },
                    priority="high",
                    resources=[
                        {"resourceType": "vehicle", "resourceId": "veh-vt-01", "responsibility": "firefighting", "personnel": 5}
                    ],
                )
            ],
        )
        result = CycleResult(simulation_id="sim-penanet", decisions=[first_owner, clash])
        orchestrator._guard_decisions(result)
        assert any("resource_conflict" in issue.problem and issue.agent_id == "other-agent" for issue in result.issues)
        assert not any("resource_conflict" in issue.problem and issue.agent_id == "veh-vt-01" for issue in result.issues)
