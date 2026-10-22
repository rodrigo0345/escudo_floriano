"""The LangGraph of the LLM commander.

    START ──route by task──▶ bombeiros | protecao_civil_ordem | protecao_civil_abrigos | gnr | inem | comandante
                                              │ (each agent: its own instructions and answer schema)
                                              ▼
                                           validate ──▶ END                      (the answer is usable, or the model/the retries gave out)
                                              │
                                              └──▶ the same agent again, with what was wrong   (an id it was not given, a doctrine rule broken)

Each call of the graph is one decision of one organization's agent (the orchestrator asks at the point in the cycle where that decision is needed, with the options the
rules code has worked out); the loop gives the agent a few chances to fix an answer that breaks a rule, instead of throwing a good decision away for one wrong id.
A model error ends the call without an answer: the rules decide that point.
"""
from __future__ import annotations

import json
import time
from typing import Any, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph

from .checks import CHECKS
from .prompts import PROMPTS
from .schemas import BombeirosDecision, ClosureDecision, EvacuationOrder, ReviewNote, ShelterChoice, StandbyDecision

SCHEMAS: dict[str, type] = {
    "bombeiros": BombeirosDecision,
    "protecao_civil_ordem": EvacuationOrder,
    "protecao_civil_abrigos": ShelterChoice,
    "gnr": ClosureDecision,
    "inem": StandbyDecision,
    "comandante": ReviewNote,
}
TASKS = tuple(SCHEMAS)


class AgentState(TypedDict, total=False):
    task: str
    brief: dict[str, Any]
    attempt: int  # how many times the agent has answered
    decision: Any  # the last answer (a pydantic model) or None
    problems: list[str]  # what was wrong with it, for the next attempt
    error: str | None  # the model failed (timeout, refusal...): no answer
    tokens: dict[str, int]
    seconds: float


def _usage(raw: Any) -> dict[str, int]:
    meta = getattr(raw, "usage_metadata", None) or {}
    return {"input": int(meta.get("input_tokens") or 0), "output": int(meta.get("output_tokens") or 0)}


def make_agent_node(task: str, llm: Any):
    """The node of one organization's agent: its instructions, the briefing, and (on a retry) what was wrong with its last answer."""
    schema = SCHEMAS[task]

    def node(state: AgentState) -> AgentState:
        brief = state["brief"]
        text = "Briefing (JSON):\n" + json.dumps(brief, ensure_ascii=False, separators=(",", ":"))
        if state.get("problems"):
            text += "\n\nA tua resposta anterior tinha problemas. Corrige-os e responde de novo:\n" + "\n".join(f"- {p}" for p in state["problems"])
        started = time.monotonic()
        try:
            out = llm.with_structured_output(schema, include_raw=True).invoke([SystemMessage(content=PROMPTS[task]), HumanMessage(content=text)])
        except Exception as error:  # noqa: BLE001 — any model failure (timeout, refusal, network) ends the call; the rules decide
            return {"decision": None, "error": f"{type(error).__name__}: {str(error)[:200]}", "attempt": state.get("attempt", 0) + 1, "seconds": state.get("seconds", 0.0) + time.monotonic() - started}
        tokens = state.get("tokens") or {"input": 0, "output": 0}
        used = _usage(out.get("raw"))
        merged = {"input": tokens["input"] + used["input"], "output": tokens["output"] + used["output"]}
        parsed = out.get("parsed")
        problems = [] if parsed is not None else [f"a resposta não respeita o formato: {str(out.get('parsing_error'))[:200]}"]
        return {"decision": parsed, "problems": problems, "error": None, "attempt": state.get("attempt", 0) + 1, "tokens": merged, "seconds": state.get("seconds", 0.0) + time.monotonic() - started}

    return node


def build_graph(llm: Any, *, retries: int = 2) -> Any:
    """Compile the graph for ``llm`` (anything with ``with_structured_output``: a ``ChatOpenAI``, or a stand-in in tests)."""

    def validate(state: AgentState) -> AgentState:
        if state.get("error") or state.get("decision") is None and not state.get("problems"):
            return {}
        problems = list(state.get("problems") or [])
        if state.get("decision") is not None:
            problems += CHECKS[state["task"]](state["decision"], state["brief"])
        return {"problems": problems}

    def after_validate(state: AgentState) -> str:
        if state.get("error"):
            return END
        if state.get("problems") and state.get("attempt", 0) <= retries:
            return state["task"]  # try again, with what was wrong
        return END

    graph = StateGraph(AgentState)
    for task in TASKS:
        graph.add_node(task, make_agent_node(task, llm))
        graph.add_edge(task, "validate")
    graph.add_node("validate", validate)
    graph.add_conditional_edges(START, lambda state: state["task"], {task: task for task in TASKS})
    graph.add_conditional_edges("validate", after_validate, {**{task: task for task in TASKS}, END: END})
    return graph.compile()
