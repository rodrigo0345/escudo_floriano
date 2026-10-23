"""Realism rules: a finished crew holds instead of going home, a drive never crosses burning ground, the corporations are linked."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from firetrace_agents.holding import backend_end, hold_idle_units
from firetrace_agents.joint import link_organizations
from firetrace_agents.placement import FireClock, route_in_fire

GRID = {"width": 10, "height": 10, "lonWest": 0.0, "latNorth": 1.0, "dLon": 0.001, "dLat": 0.001}


def clock(reach: dict[tuple[int, int], int]) -> FireClock:
    """A 10 x 10 grid; ``reach[(row, col)]`` is the minute the fire gets to that cell (the rest never burn)."""
    ignition = [-1] * 100
    for (row, col), minute in reach.items():
        ignition[row * 10 + col] = minute
    return FireClock(GRID, ignition)


def agent(unit: str) -> Any:
    return SimpleNamespace(observation=SimpleNamespace(vehicle_id=unit, crew_onboard=4, station_id="st-1", organization_id="org-b", callsign=unit.upper()), agent_id=unit)


def attack(action_id: str, unit: str, at: float, stay: int, where: tuple[float, float] = (0.5, 0.5)) -> dict[str, Any]:
    lon, lat = where
    return {
        "id": action_id, "type": "fire_attack", "organizationId": "org-b", "title": "Ataque",
        "trigger": {"kind": "at_time", "at": {"offsetMinutes": at}}, "expectedDurationMinutes": stay,
        "anchorPoint": {"lat": lat, "lon": lon}, "resources": [{"resourceType": "vehicle", "resourceId": unit, "etaMinutes": 10}],
    }


def test_the_backend_sends_a_unit_home_after_its_stay_and_holding_prevents_that() -> None:
    plan = {"actions": [attack("a1", "u1", at=0, stay=60, where=(0.0005, 0.9995))]}
    assert backend_end(plan["actions"][0], "u1") == 70  # leaves at 0, drives 10, stays 60
    held = hold_idle_units(plan, clock({}), 720, {"u1": agent("u1")})
    hold = next(a for a in plan["actions"] if a["id"] == "hold-u1")
    assert held == 1 and hold["type"] == "stage_resources" and hold["trigger"]["at"]["offsetMinutes"] == 70
    assert hold["expectedDurationMinutes"] == 650 and hold["resources"][0]["responsibility"] == "standby"  # to the end of the run, not 30 minutes


def test_a_crew_whose_spot_the_fire_reaches_waits_on_the_road_it_came_by() -> None:
    action = attack("a1", "u1", at=0, stay=60, where=(0.0005, 0.9995))
    action["resources"][0]["route"] = {"type": "LineString", "coordinates": [[0.0095, 0.9005], [0.0005, 0.9995]]}  # station -> job
    fire = clock({(0, 0): 300})  # the job's own cell burns at T+300
    plan = {"actions": [action]}
    assert hold_idle_units(plan, fire, 720, {"u1": agent("u1")}) == 1
    spot = next(a for a in plan["actions"] if a["id"] == "hold-u1")["stagingArea"]["position"]
    assert spot != {"lat": 0.9995, "lon": 0.0005}  # not where the fire comes


def test_a_holding_spot_must_be_clear_of_every_fire_the_plan_was_judged_on() -> None:
    from firetrace_agents.holding import HoldingClock

    action = attack("a1", "u1", at=0, stay=60, where=(0.0005, 0.9995))
    action["resources"][0]["route"] = {"type": "LineString", "coordinates": [[0.0095, 0.9005], [0.0005, 0.9995]]}  # station -> job
    forecast, wrong_wind = clock({}), clock({(1, 1): 400})  # only the wrong-wind fire comes, to the cell beside the job
    plan = {"actions": [action]}
    assert hold_idle_units(plan, HoldingClock([forecast, wrong_wind]), 720, {"u1": agent("u1")}) == 1
    spot = next(a for a in plan["actions"] if a["id"] == "hold-u1")["stagingArea"]["position"]
    assert spot != {"lat": 0.9995, "lon": 0.0005}  # the forecast alone would have kept it there


def test_without_fire_data_nobody_holds() -> None:
    plan = {"actions": [attack("a1", "u1", at=0, stay=60)]}
    why: dict[str, int] = {}
    assert hold_idle_units(plan, None, 720, {"u1": agent("u1")}, why) == 0 and why == {"no fire data": 1}
    assert [a["id"] for a in plan["actions"]] == ["a1"]  # it goes home, as the backend sends it


def test_stage_resources_are_held_to_the_end_of_the_run_not_the_backends_30_minutes() -> None:
    plan = {"actions": [{"id": "reserve-0", "type": "stage_resources", "resources": [{"resourceId": "u9", "etaMinutes": 15}], "trigger": {"kind": "at_time", "at": {"offsetMinutes": 5}}}]}
    hold_idle_units(plan, None, 720, {})
    assert plan["actions"][0]["expectedDurationMinutes"] == 700 and plan["actions"][0]["holdUntil"] == {"offsetMinutes": 720}


def test_a_reserve_is_held_until_a_later_order_draws_on_it_not_to_the_end_of_the_run() -> None:
    reserve = {"id": "reserve-0", "type": "stage_resources", "resources": [{"resourceId": "u9", "etaMinutes": 15}], "trigger": {"kind": "at_time", "at": {"offsetMinutes": 5}}}
    wave = {"id": "w120", "type": "fire_attack", "resources": [{"resourceId": "u9"}], "trigger": {"kind": "at_time", "at": {"offsetMinutes": 120}}}
    plan = {"actions": [reserve, wave]}
    hold_idle_units(plan, None, 720, {})
    assert reserve["expectedDurationMinutes"] == 100 and reserve["holdUntil"] == {"offsetMinutes": 120}  # arrives at 20, re-tasked at 120


def test_a_route_through_cells_that_burn_when_the_unit_passes_is_refused_but_not_the_last_stretch() -> None:
    route = {"type": "LineString", "coordinates": [[0.0005, 0.9995], [0.0095, 0.9995]]}  # along row 0, west to east (~1 km)
    burning_midway = clock({(0, 4): 20, (0, 5): 20})
    assert route_in_fire(burning_midway, route, depart=15, drive_minutes=10) is not None  # it passes cells 4-5 at ~T+20: burning
    assert route_in_fire(burning_midway, route, depart=60, drive_minutes=10) is None  # long after: burned out
    assert route_in_fire(burning_midway, route, depart=0, drive_minutes=10) is None  # long before: not reached yet
    at_the_end = clock({(0, 9): 18})
    assert route_in_fire(at_the_end, route, depart=15, drive_minutes=10) is None  # the fire is where the crew is going: the last 300 m are the job


def test_the_corporations_that_work_side_by_side_are_linked() -> None:
    actions = [
        {**attack("fire", "u1", 0, 60), "organizationId": "org-b"},
        {"id": "post", "type": "traffic_control_point", "organizationId": "org-g", "position": {"lat": 0.5004, "lon": 0.5004}, "title": "Controlo"},
        {"id": "evac", "type": "evacuation", "organizationId": "org-b", "title": "Evacuar", "area": {"type": "Polygon", "coordinates": [[[0.5, 0.5], [0.501, 0.5], [0.501, 0.501], [0.5, 0.5]]]}},
        {"id": "amb", "type": "medical_standby", "organizationId": "org-i", "positions": [{"position": {"lat": 0.5002, "lon": 0.5002}}], "title": "INEM"},
    ]
    made = link_organizations(actions, gnr_org="org-g", civil_org="org-p", medical_org="org-i")
    by = {a["id"]: a for a in actions}
    assert made >= 3
    assert "org-g" in by["fire"]["supportingOrganizationIds"] and "org-b" in by["post"]["supportingOrganizationIds"]  # Bombeiros + GNR, both ways
    assert "org-g" in by["evac"]["supportingOrganizationIds"]  # GNR + Proteção Civil: the way out
    assert "org-b" in by["amb"]["supportingOrganizationIds"]  # INEM + Bombeiros
    assert "Operação conjunta [J" in by["fire"]["description"] and "operação conjunta" in by["fire"]["rationale"].lower()


def test_a_holding_action_the_backend_says_cannot_be_reached_is_dropped_but_never_another_action() -> None:
    from firetrace_agents.holding import drop_unreachable_holds

    plan = {"actions": [{"id": "a1"}, {"id": "hold-u1"}, {"id": "hold-u2"}]}
    validation = {"valid": False, "issues": [
        {"severity": "error", "code": "target_unreachable", "pointer": "/actions/1/resources/0/resourceId"},
        {"severity": "error", "code": "other", "pointer": "/actions/0/title"},  # an error in a real action stays
    ]}
    assert drop_unreachable_holds(plan, validation) == 1
    assert [a["id"] for a in plan["actions"]] == ["a1", "hold-u2"]
