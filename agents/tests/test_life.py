"""The life planner: who is evacuated in time, who shelters, and in what order."""
from __future__ import annotations

import pytest

from firetrace_agents.life import AtRisk, Evacuator, LifeDecision, plan_life


def risk(name, people, p10, *, vulnerable=False):
    return AtRisk(id=name, name=name, kind="place", position={"lat": 41.4, "lon": -8.3}, people=people, vulnerable=vulnerable, arrival_p10=p10, arrival_p50=p10 + 10, people_source="forecast")


def squad(agent_id, responders):
    return Evacuator.on_foot(agent_id, responders)  # 30 people/h per responder


def test_enough_responders_evacuate_in_time_and_say_when_they_finish():
    plan = plan_life([risk("A", 100, 90)], [squad("s1", 10)])  # 10 responders: 5 people/min
    decision = plan.decisions[0]
    assert decision.action == "evacuate" and decision.in_time
    assert decision.completion_min == pytest.approx(10 + 100 / 5)  # mobilisation + people / rate
    assert decision.completion_min <= decision.deadline_min == 80


def test_too_many_people_for_too_few_responders_means_shelter_in_place():
    plan = plan_life([risk("A", 2000, 60)], [squad("s1", 8)])
    assert plan.decisions[0].action == "shelter" and not plan.decisions[0].in_time
    assert plan.decisions[0].responders == ()


def test_a_fire_too_close_to_even_start_an_evacuation_means_shelter():
    assert plan_life([risk("A", 10, 15)], [squad("s1", 50)]).decisions[0].action == "shelter"  # 15 - 10 margin - 10 mobilisation < 0


def test_the_vulnerable_come_first_and_leave_slower():
    items = [risk("village", 50, 50), risk("care home", 50, 80, vulnerable=True)]
    plan = plan_life(items, [squad("s1", 10)])
    assert [d.item.name for d in plan.decisions] == ["care home", "village"]  # vulnerable first even though it burns later
    home = plan.decisions[0]
    assert home.completion_min == pytest.approx(10 + 50 / (5 * 0.33))  # a third of the rate


def test_evacuators_used_in_one_place_are_not_reused_in_the_next():
    plan = plan_life([risk("A", 100, 90), risk("B", 100, 91)], [squad("s1", 10)])
    assert [d.action for d in plan.decisions] == ["evacuate", "shelter"]
    assert plan.responders_for("A") == ("s1",) and plan.responders_for("B") == ()


def test_a_place_that_cannot_be_saved_does_not_hold_back_the_evacuators():
    plan = plan_life([risk("hopeless", 5000, 40), risk("saveable", 60, 120)], [squad("s1", 10)])
    by = {d.item.name: d for d in plan.decisions}
    assert by["hopeless"].action == "shelter" and by["saveable"].action == "evacuate" and by["saveable"].responders == ("s1",)


def test_the_report_adds_up():
    plan = plan_life([risk("A", 100, 90), risk("B", 300, 60, vulnerable=True)], [squad("s1", 10)])
    report = plan.report
    assert report.people_at_risk == 400
    assert report.evacuated_in_time + report.sheltered + report.exposed == 400
    assert report.vulnerable_at_risk == 300


def test_nobody_to_evacuate_with_means_everybody_shelters():
    report = plan_life([risk("A", 100, 90)], []).report
    assert (report.evacuated_in_time, report.sheltered, report.exposed) == (0, 100, 0)


def test_a_decision_explains_itself_in_numbers():
    decision = plan_life([risk("Sendim", 1627, 197)], [squad("s1", 40)]).decisions[0]
    assert isinstance(decision, LifeDecision)
    assert "Sendim" in decision.reason and "1627" in decision.reason and "197" in decision.reason
