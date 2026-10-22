"""The LLM commander's LangGraph, run against a scripted stand-in for the model (no network, no key).

Skipped where the optional dependencies (``pip install .[llm]``) are not installed.
"""
from __future__ import annotations

import json
from typing import Any

import pytest

pytest.importorskip("langgraph")
pytest.importorskip("langchain_core")

from langchain_core.messages import AIMessage  # noqa: E402

from firetrace_agents.llm.advisor import LlmAdvisor  # noqa: E402
from firetrace_agents.llm.config import LlmSettings, build_advisor  # noqa: E402
from firetrace_agents.llm.schemas import (  # noqa: E402
    BombeirosDecision, ClosureDecision, EvacuationOrder, ReviewNote, ShelterChoice, ShelterPick, StandbyDecision, UnitSector,
)


class ScriptedModel:
    """Answers each agent from a script (a list per schema, used in order; the last repeats). An ``Exception`` in the script is raised instead of answered."""

    def __init__(self, script: dict[type, list[Any]]) -> None:
        self.script = script
        self.calls: list[tuple[str, str, str]] = []  # (schema name, system prompt, human message)
        self.pings = 0

    def invoke(self, _prompt: Any) -> Any:
        self.pings += 1
        return AIMessage(content="ok")

    def with_structured_output(self, schema: type, include_raw: bool = True) -> "ScriptedModel._Runner":
        return ScriptedModel._Runner(self, schema)

    class _Runner:
        def __init__(self, model: "ScriptedModel", schema: type) -> None:
            self.model, self.schema = model, schema

        def invoke(self, messages: list[Any]) -> dict[str, Any]:
            self.model.calls.append((self.schema.__name__, messages[0].content, messages[1].content))
            queue = self.model.script[self.schema]
            answer = queue.pop(0) if len(queue) > 1 else queue[0]
            if isinstance(answer, Exception):
                raise answer
            return {"raw": AIMessage(content="", usage_metadata={"input_tokens": 100, "output_tokens": 20, "total_tokens": 120}), "parsed": answer, "parsing_error": None}


SETTINGS = LlmSettings(commander="llm", model="test-model", api_key="k", retries=2)

BRIEF_SECTORS = {
    "decidedAtMin": 0, "initialAttack": True,
    "sectors": [
        {"id": "S1", "danger": 9000, "terrain": {"slopeDeg": 34, "fireRunsUphill": True, "workability": 0.25, "fuel": "eucalipto"}},
        {"id": "S2", "danger": 8000, "terrain": {"slopeDeg": 4, "fireRunsUphill": False, "workability": 0.95, "fuel": "pasto"}},
    ],
    "units": [{"id": "sq1", "kind": "squad", "crew": 5}, {"id": "tr1", "kind": "truck", "crew": 4}, {"id": "he1", "kind": "helicopter", "crew": 3}],
    "rulesAssignment": {"sq1": "S1", "tr1": "S2", "he1": "S2"},
}


def advisor(script: dict[type, list[Any]], **settings: Any) -> tuple[LlmAdvisor, ScriptedModel]:
    model = ScriptedModel(script)
    return LlmAdvisor(LlmSettings(**{**SETTINGS.__dict__, **settings}), llm=model), model


def test_a_valid_answer_is_used_and_its_reason_kept() -> None:
    llm, model = advisor({BombeirosDecision: [BombeirosDecision(reasoning="A encosta de S1 é íngreme e o fogo sobe-a.", assignments=[UnitSector(unit_id="sq1", sector_id="S2", reason="trabalhável")])]})
    assert llm.assign_sectors(BRIEF_SECTORS) == {"sq1": "S2"}
    notes = llm.drain_notes()
    assert notes[0]["agent"] == "Bombeiros" and "encosta" in notes[0]["text"] and "sq1 → S2" in notes[0]["text"]
    assert llm.drain_notes() == []  # drained
    assert llm.calls == 1 and llm.tokens == {"input": 100, "output": 20}
    system, human = model.calls[0][1], model.calls[0][2]
    assert "LACES" in system and "encosta" in system and "Usa APENAS os ids" in system  # the doctrine and the answer rules are in the instructions
    assert json.loads(human.split("\n", 1)[1])["sectors"][0]["id"] == "S1"  # and the briefing is the JSON it was given


def test_each_organization_has_its_own_agent_with_its_own_instructions() -> None:
    llm, model = advisor({
        EvacuationOrder: [EvacuationOrder(reasoning="vulneráveis primeiro", order=["b", "a"])],
        ShelterChoice: [ShelterChoice(reasoning="o pavilhão é seguro", picks=[ShelterPick(place_id="p1", shelter_id="s2", reason="longe do fogo")])],
        ClosureDecision: [ClosureDecision(reasoning="proteger a rota", enforce=["C2", "C1"])],
        StandbyDecision: [StandbyDecision(reasoning="longe", back_m=1000.0, ambulances=2)],
        ReviewNote: [ReviewNote(note="Plano ofensivo.", concerns=["terreno a norte"])],
    })
    places = [{"id": "a", "name": "A", "people": 10, "vulnerable": False, "fireArrivalMin": {"pessimistic": 40, "likely": 50}}, {"id": "b", "name": "B", "people": 10, "vulnerable": True, "fireArrivalMin": {"pessimistic": 41, "likely": 52}}]
    assert llm.order_evacuations({"places": places}) == ["b", "a"]
    assert llm.choose_shelters({"evacuations": [{"placeId": "p1", "options": [{"id": "s1"}, {"id": "s2"}]}]}) == {"p1": "s2"}
    assert llm.order_closures({"closures": [{"id": "C1"}, {"id": "C2"}]}) == ["C2", "C1"]
    assert llm.choose_standby({"safeDistancesBehindCrewsM": [600.0, 1000.0], "ambulancesAvailable": 3}) == {"backM": 1000.0, "ambulances": 2}
    assert llm.review({}) == "Plano ofensivo.\n- A confirmar: terreno a norte"
    prompts = {name: system for name, system, _human in model.calls}
    assert len(set(prompts.values())) == 5  # five different agents
    assert "Proteção Civil" in prompts["EvacuationOrder"] and "GNR" in prompts["ClosureDecision"] and "INEM" in prompts["StandbyDecision"]
    assert {n["agent"] for n in llm.drain_notes()} == {"Proteção Civil", "GNR", "INEM", "Comando"}


def test_an_answer_that_breaks_a_rule_is_sent_back_with_what_was_wrong_and_the_second_try_is_used() -> None:
    bad = BombeirosDecision(reasoning="x", assignments=[UnitSector(unit_id="sq1", sector_id="S9", reason="?")])  # a sector that does not exist
    good = BombeirosDecision(reasoning="y", assignments=[UnitSector(unit_id="sq1", sector_id="S2", reason="ok")])
    llm, model = advisor({BombeirosDecision: [bad, good]})
    assert llm.assign_sectors(BRIEF_SECTORS) == {"sq1": "S2"}
    assert len(model.calls) == 2 and llm.calls == 1
    assert "problemas" in model.calls[1][2] and "S9" in model.calls[1][2]  # the second call carries the feedback


def test_a_crew_on_foot_is_never_sent_up_a_steep_slope_the_fire_is_running_up() -> None:
    uphill = BombeirosDecision(reasoning="x", assignments=[UnitSector(unit_id="sq1", sector_id="S1", reason="é o mais perigoso")])
    llm, model = advisor({BombeirosDecision: [uphill]})  # it insists, every time
    assert llm.assign_sectors(BRIEF_SECTORS) == {}  # the doctrine breach is dropped; nothing else is lost
    assert len(model.calls) == 3  # first answer plus the two retries
    assert "encosta" in model.calls[1][2] and "34" in model.calls[1][2]


def test_one_bad_item_does_not_cost_the_good_ones() -> None:
    mixed = BombeirosDecision(reasoning="x", assignments=[UnitSector(unit_id="sq1", sector_id="S1", reason="mau"), UnitSector(unit_id="tr1", sector_id="S1", reason="bom")])
    llm, _model = advisor({BombeirosDecision: [mixed]})
    # an engine may work S1 (workability 0.25 is above the engine floor); the squad may not
    assert llm.assign_sectors(BRIEF_SECTORS) == {"tr1": "S1"}


def test_an_evacuation_order_that_breaks_the_rules_is_refused_after_the_retries() -> None:
    places = [{"id": "a", "name": "A", "people": 10, "vulnerable": False, "fireArrivalMin": {"pessimistic": 30, "likely": 40}}, {"id": "c", "name": "C", "people": 10, "vulnerable": False, "fireArrivalMin": {"pessimistic": 90, "likely": 99}}]
    llm, model = advisor({EvacuationOrder: [EvacuationOrder(reasoning="x", order=["c", "a"])]})  # the later place first
    assert llm.order_evacuations({"places": places}) is None  # the rules' order stands
    assert len(model.calls) == 3


def test_a_model_failure_ends_the_call_without_an_answer_and_is_counted() -> None:
    llm, model = advisor({BombeirosDecision: [TimeoutError("timed out")]})
    assert llm.assign_sectors(BRIEF_SECTORS) is None
    assert len(model.calls) == 1 and llm.failures == 1 and llm.drain_notes() == []  # no retry on a model error: the rules decide


def test_the_same_question_is_asked_once() -> None:
    llm, model = advisor({ReviewNote: [ReviewNote(note="uma nota", concerns=[])]})
    assert llm.review({"x": 1}) == llm.review({"x": 1})
    assert len(model.calls) == 1 and llm.cache_hits == 1
    assert len(llm.drain_notes()) == 2  # the reason is given again for the second plan that asks
    llm.review({"x": 2})
    assert len(model.calls) == 2


def test_every_call_can_be_audited(tmp_path: Any) -> None:
    llm, _ = advisor({ReviewNote: [ReviewNote(note="nota", concerns=["c"])]}, log_dir=str(tmp_path))
    llm.review({"unidades": 3})
    (file,) = list(tmp_path.glob("llm-*.jsonl"))
    entry = json.loads(file.read_text(encoding="utf-8").splitlines()[0])
    assert entry["task"] == "comandante" and entry["brief"] == {"unidades": 3} and entry["decision"]["note"] == "nota" and entry["tokens"] == {"input": 100, "output": 20} and entry["model"] == "test-model"


def test_the_key_is_never_in_the_settings_repr() -> None:
    assert "secret-key" not in repr(LlmSettings(commander="llm", model="m", api_key="secret-key"))


def test_stats_say_what_it_cost() -> None:
    llm, _ = advisor({ReviewNote: [ReviewNote(note="n", concerns=[])]})
    llm.review({"a": 1})
    llm.review({"a": 1})
    assert llm.stats() == {"model": "test-model", "calls": 1, "cacheHits": 1, "failures": 0, "tokens": {"input": 100, "output": 20}, "seconds": llm.stats()["seconds"]}


# ------------------------------------------------------------------------------------------------------------------ configuration
def test_settings_come_from_the_environment() -> None:
    s = LlmSettings.from_env({"AGENTS_COMMANDER": "LLM", "AGENTS_LLM_MODEL": "gpt-x", "OPENAI_API_KEY": "k", "AGENTS_LLM_TIMEOUT": "15", "AGENTS_LLM_RETRIES": "1", "AGENTS_LLM_TEMPERATURE": "0.2"})
    assert (s.wanted, s.model, s.timeout_seconds, s.retries, s.temperature, s.problem()) == (True, "gpt-x", 15.0, 1, 0.2, None)
    default = LlmSettings.from_env({})
    assert not default.wanted and default.temperature is None and default.retries == 2 and default.problem() is None  # not asked for: nothing to complain about


def test_the_rules_decide_when_the_llm_is_not_asked_for_or_cannot_run() -> None:
    assert build_advisor(LlmSettings.from_env({})).name == "rules"
    assert build_advisor(LlmSettings.from_env({"AGENTS_COMMANDER": "llm", "AGENTS_LLM_MODEL": "m"})).name == "rules"  # no key
    assert build_advisor(LlmSettings.from_env({"AGENTS_COMMANDER": "llm", "OPENAI_API_KEY": "k"})).name == "rules"  # no model
    assert LlmSettings.from_env({"AGENTS_COMMANDER": "llm", "AGENTS_LLM_MODEL": "m"}).problem() == "OPENAI_API_KEY is not set"


def test_a_model_the_account_cannot_use_leaves_the_rules_in_charge(monkeypatch: pytest.MonkeyPatch) -> None:
    class Refusing(ScriptedModel):
        def invoke(self, _prompt: Any) -> Any:
            raise PermissionError("model_not_found")

    monkeypatch.setattr(LlmAdvisor, "_chat", staticmethod(lambda settings: Refusing({})))
    assert build_advisor(SETTINGS).name == "rules"
    assert build_advisor(SETTINGS, check=False).name == "llm"  # the check is what catches it
    monkeypatch.setattr(LlmAdvisor, "_chat", staticmethod(lambda settings: ScriptedModel({})))
    assert build_advisor(SETTINGS).name == "llm"


def test_a_crew_on_foot_is_never_sent_into_fire_too_intense_for_hand_tools() -> None:
    brief = {**BRIEF_SECTORS, "sectors": [{**BRIEF_SECTORS["sectors"][0]}, {**BRIEF_SECTORS["sectors"][1], "intensityKwM": 2400}]}
    hot = BombeirosDecision(reasoning="x", assignments=[UnitSector(unit_id="sq1", sector_id="S2", reason="mais perigoso"), UnitSector(unit_id="tr1", sector_id="S2", reason="autotanque aguenta")])
    llm, model = advisor({BombeirosDecision: [hot]})
    assert llm.assign_sectors(brief) == {"tr1": "S2"}  # the engine may go (Haul chart), the squad may not
    assert "1700" in model.calls[1][2]


def test_each_agent_gets_only_its_own_doctrine() -> None:
    from firetrace_agents.llm.prompts import PROMPTS
    assert "kW/m" in PROMPTS["bombeiros"] and "Ancorar" in PROMPTS["bombeiros"]
    assert "Ancorar" not in PROMPTS["gnr"] and "Ancorar" not in PROMPTS["inem"]  # no fire tactics in the other agents' prompts
    assert all("Usa APENAS os ids" in p for p in PROMPTS.values())
    assert max(len(p) for p in PROMPTS.values()) < 3200  # short prompts: tokens are paid on every call


def test_a_note_with_letters_of_another_alphabet_is_sent_back() -> None:
    garbled = ReviewNote(note="Confirme que os autotანკues têm água.", concerns=[])
    clean = ReviewNote(note="Confirme que os autotanques têm água a 2 km.", concerns=["S1: 26099 kW/m"])
    llm, model = advisor({ReviewNote: [garbled, clean]})
    assert llm.review({}) == "Confirme que os autotanques têm água a 2 km.\n- A confirmar: S1: 26099 kW/m"
    assert "alfabeto" in model.calls[1][2]
