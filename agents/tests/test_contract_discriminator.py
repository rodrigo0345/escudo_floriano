"""The payload check follows the contract's ``discriminator`` (one schema per ``type``) instead of trying every ``oneOf`` branch: same verdicts, a fraction of the time.

Plain JSON Schema applies all 15 action schemas to every action (and 8 intervention schemas to each of its effects): seconds per publish for a plan of a few dozen
actions. The server picks the schema by ``type``, so the check does too; these tests hold the two to the same verdict on valid, invalid and unknown payloads.
"""
from __future__ import annotations

import copy
import time
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from firetrace_agents import contracts
from firetrace_agents.contracts import ContractViolation, validate_against_spec

from .test_contracts import _one_intervention_each

CREW = _one_intervention_each()["crew_deployment"]


def action(kind: str = "fire_attack", **extra: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"id": "act-1", "type": kind, "title": "Ataque", "organizationId": "org-1", "priority": "high", "simulationEffects": [copy.deepcopy(CREW)]}
    if kind == "fire_attack":
        base.update(tactic="direct", anchorPoint={"lat": 41.42, "lon": -8.27})
    return {**base, **extra}


def plan_with(*actions: dict[str, Any]) -> dict[str, Any]:
    return {"locationId": "guimaraes", "title": "Plano", "actions": list(actions)}


def plain(schema_name: str, payload: Any) -> bool:
    """The verdict of ordinary JSON Schema (every ``oneOf`` branch tried)."""
    schema = contracts.get_schema(schema_name)
    doc = contracts.load_registry()
    return Draft202012Validator(schema, resolver=contracts.RefResolver(base_uri="", referrer=doc)).is_valid(payload)


def follows_discriminator(schema_name: str, payload: Any) -> bool:
    try:
        validate_against_spec(schema_name, payload)
        return True
    except ContractViolation:
        return False


def cases() -> list[tuple[str, dict[str, Any]]]:
    bad_effect = action()
    del bad_effect["simulationEffects"][0]["responsibility"]  # crew_deployment without its required field
    unknown_effect = action()
    unknown_effect["simulationEffects"][0]["type"] = "teleport"
    no_type = action()
    del no_type["type"]
    return [
        ("valid fire attack", plan_with(action())),
        ("valid with several kinds of effect", plan_with(action(simulationEffects=list(_one_intervention_each().values())))),
        ("an effect missing a required field", plan_with(bad_effect)),
        ("an unknown effect type", plan_with(unknown_effect)),
        ("an unknown action type", plan_with(action("teleport"))),
        ("an action with no type", plan_with(no_type)),
        ("a fire attack with a wrong tactic", plan_with(action(tactic="sideways"))),
        ("a fire attack without its anchor", plan_with({k: v for k, v in action().items() if k != "anchorPoint"})),
        ("a plan with no title", {"locationId": "guimaraes", "actions": [action()]}),
        ("a plan with too many actions", plan_with(*[action(id=f"a{i}") for i in range(501)])),
        ("an action that is not an object", plan_with("nope")),  # type: ignore[arg-type]
    ]


@pytest.mark.parametrize(("label", "payload"), cases(), ids=[c[0] for c in cases()])
def test_same_verdict_as_plain_json_schema(label: str, payload: dict[str, Any]) -> None:
    assert follows_discriminator("PlanInput", payload) == plain("PlanInput", payload), label


def test_a_wrong_effect_is_reported_where_it_is() -> None:
    bad = action()
    del bad["simulationEffects"][0]["responsibility"]
    with pytest.raises(ContractViolation) as info:
        validate_against_spec("PlanInput", plan_with(bad))
    assert "actions/0/simulationEffects/0" in str(info.value) and "responsibility" in str(info.value)  # not "not valid under any of the given schemas"


def test_an_unknown_type_is_still_refused() -> None:
    with pytest.raises(ContractViolation):
        validate_against_spec("PlanInput", plan_with(action("teleport")))


def test_a_plan_of_dozens_of_actions_is_checked_quickly() -> None:
    plan = plan_with(*[action(id=f"a{i}") for i in range(60)])
    started = time.monotonic()
    validate_against_spec("PlanInput", plan)
    assert time.monotonic() - started < 3.0  # plain JSON Schema took about 0.25 s per action
