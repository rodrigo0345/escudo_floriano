"""Campaign helpers: the scenario of a stage, the plan's effects, and what stays on the ground between stages."""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from firetrace_agents.campaign import carry_over, plan_effects, scenario_at
from firetrace_agents.contracts import validate_against_spec

SNAPSHOT = {
    "name": "Fogo",
    "locationId": "guimaraes-concelho",
    "start": "2026-08-17T15:00:00+01:00",
    "durationMinutes": 240,
    "ignitions": [{"position": {"lat": 41.4, "lon": -8.3}}],
    "weather": {"base": "provider"},
    "id": "sc-x",  # a server-side field the inline scenario must not carry
    "createdAt": "2026-10-19T20:35:17+00:00",
}
PERIMETER = {"type": "MultiPolygon", "coordinates": [[[[-8.3, 41.4], [-8.29, 41.4], [-8.29, 41.41], [-8.3, 41.4]]]]}
LINE = {"type": "fire_line", "start": {"offsetMinutes": 0}, "geometry": {"type": "LineString", "coordinates": [[-8.3, 41.4], [-8.2, 41.4]]}, "effectiveness": 0.7}
DROP = {"type": "aerial_drop", "start": {"offsetMinutes": 0}, "geometry": LINE["geometry"], "effectiveness": 0.5, "agent": "water"}


def test_a_stage_scenario_starts_later_from_the_outline_and_drops_server_fields():
    scenario = scenario_at(SNAPSHOT, 90, 30, perimeter=PERIMETER, interventions=[LINE], name="[lab] fase")
    assert datetime.fromisoformat(scenario["start"]) == datetime.fromisoformat(SNAPSHOT["start"]) + timedelta(minutes=90)
    assert scenario["durationMinutes"] == 30
    assert scenario["initialFire"]["perimeter"] == PERIMETER and scenario["initialFire"]["asOf"] == scenario["start"]
    assert scenario["interventions"] == [LINE]
    assert "id" not in scenario and "createdAt" not in scenario


def test_at_the_ignition_there_is_no_initial_fire():
    assert "initialFire" not in scenario_at(SNAPSHOT, 0, 30, perimeter=None, interventions=[], name="x")


def test_the_forecast_can_be_given_a_wrong_wind_without_touching_the_snapshot():
    scenario = scenario_at(SNAPSHOT, 0, 30, perimeter=None, interventions=[], name="x", wind_shift_deg=30)
    assert scenario["weather"]["events"] == [{"type": "wind_shift", "start": {"offsetMinutes": 0}, "deltaDeg": 30}]
    assert "events" not in SNAPSHOT["weather"]


def test_scenarios_validate_against_the_spec():
    validate_against_spec("ScenarioInput", scenario_at(SNAPSHOT, 90, 30, perimeter=PERIMETER, interventions=[LINE, DROP], name="x", wind_shift_deg=-30))


def test_plan_effects_are_the_simulation_effects_of_every_action():
    plan = {"actions": [{"id": "a", "simulationEffects": [LINE, DROP]}, {"id": "b"}, {"id": "c", "simulationEffects": [LINE]}]}
    assert plan_effects(plan) == [LINE, DROP, LINE]


def test_only_built_lines_stay_on_the_ground_and_never_twice():
    kept = carry_over([], [LINE, DROP])
    assert kept == [LINE]  # a drop wears off, a line holds
    assert carry_over(kept, [LINE, DROP]) == [LINE]  # the same line proposed again is not stacked
    other = {**LINE, "effectiveness": 0.8}
    assert carry_over(kept, [other]) == [LINE, other]


def test_the_policy_is_checked():
    from firetrace_agents.campaign import Campaign

    with pytest.raises(ValueError):
        Campaign(None, None, {"id": "s", "scenarioSnapshot": SNAPSHOT}, policy="C")  # type: ignore[arg-type]
