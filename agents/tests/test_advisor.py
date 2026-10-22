"""An advisor (the LLM commander) may only choose among options the rules offer, and whatever it gets wrong costs nothing but its own choice.

No LLM here: a fake advisor says what it likes (valid choices, ids that do not exist, a refusal, an exception) and the tests check what the orchestrator does with it.
"""
from __future__ import annotations

from typing import Any

import httpx
import pytest

from firetrace_agents.advisor import (
    NullAdvisor, evacuation_brief, sector_brief, sector_id, valid_closures, valid_evacuation_order, valid_sector_choice, valid_shelters, valid_standby,
)
from firetrace_agents.client import FiretraceClient
from firetrace_agents.gnr import Closure
from firetrace_agents.life import AtRisk, Evacuator, plan_life
from firetrace_agents.orchestrator import CycleResult, OrchestratorAgent
from firetrace_agents.sectors import Assignment, Sector, assign_units, with_preferences
from firetrace_agents.support import SupportAgents

from .conftest import SUMMARY_RAGING, THREATENED_TOWN, mock_client
from .test_orchestrator import POOLS, VEHICLES


# ------------------------------------------------------------------------------------------------------------------ validators
def test_a_sector_choice_keeps_only_units_and_sectors_that_exist() -> None:
    kept, problems = valid_sector_choice({"u1": "S2", "ghost": "S1", "u2": "S9"}, ["u1", "u2"], ["S1", "S2"])
    assert kept == {"u1": "S2"} and len(problems) == 2
    assert valid_sector_choice(None, ["u1"], ["S1"]) == ({}, [])


PLACES = [
    {"id": "a", "name": "Aldeia", "people": 40, "vulnerable": False, "fireArrivalMin": {"pessimistic": 30, "likely": 40}},
    {"id": "b", "name": "Lar", "people": 20, "vulnerable": True, "fireArrivalMin": {"pessimistic": 55, "likely": 65}},
    {"id": "c", "name": "Quinta", "people": 5, "vulnerable": False, "fireArrivalMin": {"pessimistic": 90, "likely": 100}},
]


def test_an_evacuation_order_must_be_every_place_once() -> None:
    assert valid_evacuation_order(["b", "a", "c"], PLACES)[0] == ["b", "a", "c"]  # a vulnerable place first is allowed
    order, problems = valid_evacuation_order(["a", "b"], PLACES)
    assert order is None and any("faltam" in p for p in problems)
    assert valid_evacuation_order(["a", "b", "b"], PLACES)[0] is None
    assert valid_evacuation_order(["a", "b", "z"], PLACES)[0] is None


def test_a_place_the_fire_reaches_much_sooner_is_not_pushed_behind_a_later_one() -> None:
    order, problems = valid_evacuation_order(["c", "a", "b"], PLACES)  # the quinta (fire at 90) before the aldeia (fire at 30)
    assert order is None and any("Aldeia" in p and "Quinta" in p for p in problems)
    assert valid_evacuation_order(["a", "c", "b"], PLACES)[0] is None  # the lar (fire at 55) behind the quinta (fire at 90), which is not vulnerable: refused
    assert valid_evacuation_order(["a", "b", "c"], PLACES)[0] == ["a", "b", "c"]  # by arrival time: fine
    assert valid_evacuation_order(["b", "a", "c"], PLACES)[0] == ["b", "a", "c"]  # the vulnerable lar first: fine


def test_shelters_closures_and_standby_are_checked_against_the_options() -> None:
    assert valid_shelters({"p1": "s2", "p1x": "s1", "p2": "zzz"}, {"p1": ["s1", "s2"], "p2": ["s3"]})[0] == {"p1": "s2"}
    kept, problems = valid_closures(["C2", "C9", "C2", "C1"], ["C1", "C2", "C3"])
    assert kept == ["C2", "C1"] and len(problems) == 1
    assert valid_standby({"backM": 1000, "ambulances": 2}, [600, 1000, 1500], 3)[0] == {"backM": 1000.0, "ambulances": 2}
    assert valid_standby({"backM": 700, "ambulances": 2}, [600, 1000], 3)[0] is None  # not one of the safe distances
    assert valid_standby({"backM": 600, "ambulances": 4}, [600], 3)[0] is None  # more ambulances than there are
    assert valid_standby(None, [600], 3)[0] is None


# ------------------------------------------------------------------------------------------------------------------ the rules' hooks
SECTORS = [Sector(41.43, -8.27, 90.0, 10.0, 2000.0), Sector(41.44, -8.27, 90.0, 9.0, 1800.0), Sector(41.45, -8.27, 90.0, 5.0, 900.0)]
UNITS = [("h1", "helicopter"), ("t1", "truck"), ("t2", "truck"), ("s1", "squad"), ("s2", "squad")]


def test_with_preferences_moves_the_named_units_and_lays_each_sector_out_again() -> None:
    base = assign_units(UNITS, SECTORS, [])
    moved = with_preferences(base, UNITS, SECTORS, {"s1": 0, "s2": 0})
    assert moved["s1"].sector is SECTORS[0] and moved["s2"].sector is SECTORS[0]
    in_first = sorted((a.slot for u, a in moved.items() if a.sector is SECTORS[0]))
    assert in_first == list(range(len(in_first)))  # slots are consecutive from 0 in every sector
    assert with_preferences(base, UNITS, SECTORS, {}) is base  # nothing to change


def test_with_preferences_keeps_the_barrier_layout_when_there_are_budgets() -> None:
    budgets = {"h1": 80.0, "t1": 200.0, "t2": 200.0, "s1": 60.0, "s2": 60.0}
    base = assign_units(UNITS, SECTORS, [], budgets=budgets, concentration=2)
    moved = with_preferences(base, UNITS, SECTORS, {"t2": 0, "s2": 0}, budgets=budgets, concentration=2)
    group = [a for a in moved.values() if a.sector is SECTORS[0]]
    assert all(a.segment_m for a in group)
    offsets = sorted(a.offset_m for a in group)
    assert offsets == sorted(set(offsets)) and offsets[0] < 0 < offsets[-1] or len(group) == 1  # laid end to end around the sector's centre


def test_an_index_outside_the_sectors_is_ignored() -> None:
    base = assign_units(UNITS, SECTORS, [])
    moved = with_preferences(base, UNITS, SECTORS, {"s1": 99})
    assert moved["s1"].sector is base["s1"].sector


def at_risk(name: str, people: int, vulnerable: bool, p10: float) -> AtRisk:
    return AtRisk(id=name, name=name, kind="place", position={"lat": 41.4, "lon": -8.3}, people=people, vulnerable=vulnerable, arrival_p10=p10, arrival_p50=p10 + 10, people_source="forecast")


def test_the_evacuation_order_can_be_a_commanders_and_defaults_to_vulnerable_first() -> None:
    items = [at_risk("aldeia", 40, False, 60), at_risk("lar", 20, True, 120), at_risk("quinta", 5, False, 90)]
    evacuators = [Evacuator.on_foot("e1", 30), Evacuator.on_foot("e2", 30), Evacuator.on_foot("e3", 30)]
    assert [d.item.id for d in plan_life(items, evacuators).decisions] == ["lar", "aldeia", "quinta"]
    assert [d.item.id for d in plan_life(items, evacuators, order=["aldeia", "quinta", "lar"]).decisions] == ["aldeia", "quinta", "lar"]
    assert [d.item.id for d in plan_life(items, evacuators, order=["quinta"]).decisions] == ["quinta", "lar", "aldeia"]  # what is not named follows, in the usual order


FACILITIES = [
    {"id": "sh-1", "name": "Pavilhão", "kind": "shelter", "position": {"lat": 41.40, "lon": -8.30}},
    {"id": "sc-1", "name": "Escola", "kind": "school", "position": {"lat": 41.41, "lon": -8.31}},
    {"id": "th-1", "name": "Junta", "kind": "town_hall", "position": {"lat": 41.385, "lon": -8.29}},
    {"id": "hos-1", "name": "Hospital", "kind": "hospital", "position": {"lat": 41.39, "lon": -8.28}},
    {"id": "near", "name": "Ao lado", "kind": "school", "position": {"lat": 41.4301, "lon": -8.2701}},  # next door: not a shelter for that place
]


def support(client: FiretraceClient | None = None) -> SupportAgents:
    ambulances = [{"id": f"amb-{i}", "stationId": None, "crewCapacity": 2} for i in range(3)]
    return SupportAgents(client or mock_client(threatened=THREATENED_TOWN, summary=SUMMARY_RAGING)[0], location_id="loc", simulation_id="sim", at=None, clock=None, run_minutes=240,
                         civil_org="org-pc", medical_org="org-inem", facilities=FACILITIES, ambulances=ambulances, station_position=lambda _id: None, route=lambda v, p: None)


def test_shelter_options_exclude_the_one_next_door_and_a_preference_picks_among_them() -> None:
    agents = support()
    place = {"lat": 41.43, "lon": -8.27}
    options = agents.shelter_options(place, 60.0)
    assert [f["id"] for f, _a, _r in options] == ["sh-1", "sc-1", "th-1"]  # real shelter first, then by distance; 'near' is not an option
    assert agents.shelter_for(place, 60.0)["id"] == "sh-1"
    assert agents.shelter_for(place, 60.0, prefer="th-1")["id"] == "th-1"
    assert agents.shelter_for(place, 60.0, prefer="not-an-option")["id"] == "sh-1"  # a preference that is not an option is ignored


def test_standby_options_are_the_safe_distances_behind_the_crews_and_a_choice_picks_one() -> None:
    agents = support()
    sites = [{"lat": 41.43, "lon": -8.27}]
    middle, options = agents.standby_options(sites, head_bearing=90.0)
    assert middle is not None and [d for d, _s in options] == [600.0, 1000.0, 1500.0, 2500.0]  # no clock: the fire reaches none of them
    default = agents.medical_standby(sites, 90.0, 0.0)
    far = agents.medical_standby(sites, 90.0, 0.0, {"backM": 1500, "ambulances": 3})
    assert len(default.actions[0]["resources"]) == 2 and len(far.actions[0]["resources"]) == 3
    assert far.actions[0]["positions"][0]["position"] != default.actions[0]["positions"][0]["position"]  # a farther spot
    assert agents.medical_standby(sites, 90.0, 0.0, {"backM": 123, "ambulances": 1}).actions[0]["positions"] == default.actions[0]["positions"]  # not an option: the rules' spot


# ------------------------------------------------------------------------------------------------------------------ the orchestrator with an advisor
class FakeAdvisor:
    """Says what the test tells it to, and keeps what it was shown."""

    name = "fake"

    def __init__(self, **answers: Any) -> None:
        self.answers = answers
        self.briefs: dict[str, dict[str, Any]] = {}
        self._notes: list[dict[str, Any]] = []

    def _answer(self, key: str, brief: dict[str, Any]) -> Any:
        self.briefs[key] = brief
        answer = self.answers.get(key)
        if isinstance(answer, Exception):
            raise answer
        if callable(answer):
            answer = answer(brief)
        if answer is not None:
            self._notes.append({"agent": key, "text": f"decidi {key}"})
        return answer

    def assign_sectors(self, brief): return self._answer("sectors", brief)  # noqa: E704
    def order_evacuations(self, brief): return self._answer("order", brief)  # noqa: E704
    def choose_shelters(self, brief): return self._answer("shelters", brief)  # noqa: E704
    def order_closures(self, brief): return self._answer("closures", brief)  # noqa: E704
    def choose_standby(self, brief): return self._answer("standby", brief)  # noqa: E704
    def review(self, brief): return self._answer("review", brief)  # noqa: E704

    def drain_notes(self) -> list[dict[str, Any]]:
        notes, self._notes = self._notes, []
        return notes


VECTORS = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-8.268, 41.430]}, "properties": {"bearingDeg": 135, "speedMmin": 11.0, "intensityKwm": 2800}},
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-8.268, 41.438]}, "properties": {"bearingDeg": 135, "speedMmin": 8.0, "intensityKwm": 2000}},
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-8.268, 41.446]}, "properties": {"bearingDeg": 135, "speedMmin": 5.0, "intensityKwm": 1200}},
]}


def cycle(advisor: Any, *, use_advisor: bool = True) -> tuple[CycleResult, OrchestratorAgent]:
    _client, store = mock_client(vehicles=VEHICLES, pools=POOLS, threatened=THREATENED_TOWN, summary=SUMMARY_RAGING)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/vectors"):
            return httpx.Response(200, json=VECTORS)
        return store.handle(request)

    orchestrator = OrchestratorAgent(FiretraceClient(base_url="mock://firetrace", transport=httpx.MockTransport(handler)))
    orchestrator.advisor = advisor
    orchestrator.terrain_enabled = False
    orchestrator.pull_fleet()
    return orchestrator.run_cycle("sim-penanet", location_id="guimaraes-concelho", publish=False, validate=False, traffic=False, use_advisor=use_advisor), orchestrator


def test_a_null_advisor_changes_nothing_and_says_so() -> None:
    plain, _ = cycle(NullAdvisor(), use_advisor=False)
    asked, _ = cycle(NullAdvisor(), use_advisor=True)
    assert asked.advice.advisor == "rules" and not asked.advice.applied and not asked.advice.notes
    assert {u: a.sector for u, a in plain.assignments.items()} == {u: a.sector for u, a in asked.assignments.items()}


def test_an_advisor_that_is_not_asked_is_not_called() -> None:
    advisor = FakeAdvisor(sectors={"veh-vt-01": "S3"}, order=["x"])
    result, _ = cycle(advisor, use_advisor=False)
    assert advisor.briefs == {} and not result.advice.applied


def test_the_sector_brief_has_the_front_the_units_and_the_rules_own_assignment() -> None:
    advisor = FakeAdvisor()
    cycle(advisor)
    brief = advisor.briefs["sectors"]
    assert [s["id"] for s in brief["sectors"]] == ["S1", "S2", "S3"]
    assert {"spreadMPerMin", "intensityKwM", "headingDeg", "danger"} <= set(brief["sectors"][0])
    assert {u["kind"] for u in brief["units"]} == {"helicopter", "squad", "truck"} and all("crew" in u for u in brief["units"])
    assert set(brief["rulesAssignment"]) <= {u["id"] for u in brief["units"]} and set(brief["rulesAssignment"].values()) <= {"S1", "S2", "S3"}


def test_a_valid_sector_choice_moves_the_unit() -> None:
    first, _ = cycle(FakeAdvisor())
    before = first.assignments["veh-vt-01"].sector
    advisor = FakeAdvisor(sectors=lambda brief: {"veh-vt-01": "S3" if brief["rulesAssignment"]["veh-vt-01"] != "S3" else "S1"})
    result, _ = cycle(advisor)
    assert result.assignments["veh-vt-01"].sector != before
    assert any("setores" in a for a in result.advice.applied) and result.advice.notes and result.advice.discarded == []


def test_ids_the_advisor_made_up_are_thrown_away_and_recorded() -> None:
    first, _ = cycle(FakeAdvisor())
    advisor = FakeAdvisor(sectors={"veh-vt-01": "S9", "nobody": "S1"})
    result, _ = cycle(advisor)
    assert result.assignments["veh-vt-01"].sector == first.assignments["veh-vt-01"].sector  # the rules' sector stays
    assert len(result.advice.discarded) == 2 and not result.advice.applied


def test_an_advisor_that_raises_costs_nothing_but_its_own_choice() -> None:
    first, _ = cycle(FakeAdvisor())
    result, _ = cycle(FakeAdvisor(sectors=RuntimeError("boom"), order=TimeoutError("slow"), review=ValueError("x")))
    assert {u: a.sector for u, a in result.assignments.items()} == {u: a.sector for u, a in first.assignments.items()}
    assert result.plan_a is not None and result.plan_b is not None
    assert any("falhou" in d for d in result.advice.discarded)


def test_the_evacuation_order_comes_from_the_advisor_when_it_is_valid() -> None:
    default, _ = cycle(FakeAdvisor())
    names = [d.item.id for d in default.life.decisions]
    assert len(names) == 2
    advisor = FakeAdvisor(order=lambda brief: [p["id"] for p in reversed(brief["places"])])
    # the order is validated: putting the vulnerable home behind a place the fire reaches sooner is refused, and the rules' order stays
    result, _ = cycle(advisor)
    assert [d.item.id for d in result.life.decisions] in (names, names[::-1])
    assert {"id", "name", "people", "vulnerable", "fireArrivalMin", "minutesLeft"} <= set(advisor.briefs["order"]["places"][0])


def test_the_review_is_kept_for_the_plan() -> None:
    advisor = FakeAdvisor(review="Plano ofensivo; confirmar o terreno a norte.")
    result, _ = cycle(advisor)
    assert result.advice.review == "Plano ofensivo; confirmar o terreno a norte."
    brief = advisor.briefs["review"]
    assert {"assessment", "actionsByType", "unitsCommitted", "issues", "advisorDecisions"} <= set(brief)


def closure(name: str, cut_p10: float, *, ends: tuple[tuple[float, float], tuple[float, float]] = ((41.43, -8.27), (41.44, -8.27))) -> Closure:
    return Closure(road_ids=[name], name=name, road_class="primary", cut_p10=cut_p10, cut_p50=cut_p10 + 5, reopen_p50=cut_p10 + 60, reopen_p90=cut_p10 + 90, probability=0.9,
                   ends=[{"lat": e[0], "lon": e[1]} for e in ends], end_roads=[name, name], length_m=800.0, max_intensity_kwm=1500.0)


def test_the_commander_orders_the_accesses_but_never_opens_a_gap_in_the_cordon() -> None:
    closures = [closure("EN101", 30), closure("EM5", 50), closure("N7", 70)]
    advisor = FakeAdvisor(closures=["C3", "C1"])
    orchestrator = OrchestratorAgent(mock_client(threatened=THREATENED_TOWN, summary=SUMMARY_RAGING)[0])
    orchestrator.advisor = advisor
    orchestrator._begin_advice(True)
    result = CycleResult(simulation_id="s")
    kept = orchestrator._advised_closures(closures, 4, result, 0.0)
    assert [c.name for c in kept] == ["N7", "EN101", "EM5"]  # its order first; the one it left out is still closed, last in the queue for a patrol
    assert advisor.briefs["closures"]["patrolsAvailable"] == 4 and [c["id"] for c in advisor.briefs["closures"]["closures"]] == ["C1", "C2", "C3"]


def test_a_closure_choice_that_names_nothing_real_leaves_the_rules_closures() -> None:
    closures = [closure("EN101", 30), closure("EM5", 50)]
    orchestrator = OrchestratorAgent(mock_client(threatened=THREATENED_TOWN, summary=SUMMARY_RAGING)[0])
    orchestrator.advisor = FakeAdvisor(closures=["C7"])
    orchestrator._begin_advice(True)
    assert orchestrator._advised_closures(closures, 4, CycleResult(simulation_id="s"), 0.0) == closures
    assert orchestrator._advice.discarded


def test_brief_builders_are_json_ready() -> None:
    import json

    json.dumps(sector_brief(SECTORS, lambda s: None))
    json.dumps(evacuation_brief([at_risk("aldeia", 40, False, 60)], 0.0, 10.0))
    assert sector_id(0) == "S1" and sector_id(11) == "S12"


# ------------------------------------------------------------------------------------------------------------------ what the plan tells the operator
def candidate(applied: list[str] | None = None, discarded: list[str] | None = None, review: str | None = None) -> CycleResult:
    from firetrace_agents.advisor import AdvisorLog

    result = CycleResult(simulation_id="s")
    result.advice = AdvisorLog(advisor="fake", notes=[{"agent": "Bombeiros", "text": "mudei duas viaturas"}, {"agent": "Comando", "text": "nota repetida"}], applied=applied or [], discarded=discarded or [], review=review)
    return result


def test_the_outcome_says_which_plan_it_is_and_why() -> None:
    from firetrace_agents.alternatives import _llm_outcome

    class Counting(FakeAdvisor):
        def stats(self) -> dict[str, Any]:
            return {"model": "m", "calls": 3}

    rules_result, llm_result = candidate(), candidate(applied=["setores: 2 unidade(s) mudadas de setor"], review="Confirmar o terreno a norte.")
    line = "311.0 ha ardidos · 4 edifícios · 0 baixas de equipas · 20 meios"
    tie = _llm_outcome(Counting(), [(False, (False, 0, 4, 99.0, 311.0), line, rules_result), (True, (False, 0, 4, 99.0, 311.0), line, llm_result)], winner=llm_result)
    assert tie["metadata"]["chosen"] is True and tie["metadata"]["model"] == "m" and tie["metadata"]["applied"] == ["setores: 2 unidade(s) mudadas de setor"]
    assert "o mesmo resultado" in tie["summary"] and "Confirmar o terreno a norte." in tie["summary"] and "mudei duas viaturas" in tie["summary"]
    assert tie["summary"].count("nota repetida") == 0  # the commander's note is printed once, not as a note as well

    better = _llm_outcome(Counting(), [(False, (False, 0, 4, 99.0, 311.0), line, rules_result), (True, (False, 0, 3, 99.0, 250.0), "250.0 ha", llm_result)], winner=llm_result)
    assert "o do comando (melhor)" in better["summary"]

    worse = _llm_outcome(Counting(), [(False, (False, 0, 4, 99.0, 311.0), line, rules_result), (True, (False, 0, 6, 99.0, 400.0), "400.0 ha", llm_result)], winner=rules_result)
    assert worse["metadata"]["chosen"] is False and "Este plano é o das regras" in worse["summary"] and worse["metadata"]["comparison"] == {"llm": "400.0 ha", "rules": line}


def test_a_commander_that_proposed_nothing_is_said_so() -> None:
    from firetrace_agents.alternatives import _llm_outcome

    out = _llm_outcome(FakeAdvisor(), [(False, (False, 0, 4, 99.0, 311.0), "x", candidate())], winner=candidate())
    assert out["metadata"]["evaluated"] is False and "não chegou a propor" in out["summary"]


def test_the_lives_model_breaks_a_tie_against_a_commander_that_shelters_more_people() -> None:
    from firetrace_agents.alternatives import _lives_cost

    assert _lives_cost(CycleResult(simulation_id="s")) == (0, 0)  # nobody at risk
    small, big = at_risk("pequena", 100, False, 100), at_risk("grande", 400, False, 100)
    one_responder = [Evacuator.on_foot("e1", 10)]  # 5 people a minute: enough for either place, not both
    small_first, big_first = CycleResult(simulation_id="s"), CycleResult(simulation_id="s")
    small_first.life = plan_life([small, big], one_responder, now=0.0, order=["pequena", "grande"])
    big_first.life = plan_life([small, big], one_responder, now=0.0, order=["grande", "pequena"])
    assert _lives_cost(small_first) == (0, 400) and _lives_cost(big_first) == (0, 100)  # the order decides who is evacuated and who shelters
    assert _lives_cost(big_first) <= _lives_cost(small_first) and not _lives_cost(small_first) <= _lives_cost(big_first)
