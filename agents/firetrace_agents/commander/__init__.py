"""The LLM commander: it reads the environment, retrieves the tactics that fit it and chooses the strategy of plans A and B.

The existing orchestrator still executes the strategy (geometry, routes, timing, water, fatigue) and the judge still keeps every plan at zero
predicted crew casualties; the commander only chooses among parameters the executor understands (see ``schema.py``). Without an LLM (no key,
an error, a bad answer) the rule-based strategy is used, so the service never depends on it. See ``agents/LLM_COMMANDER_PLAN.md``.
"""
from .commander import Commander, CommanderDecision, commander_from_env
from .environment import build_brief
from .retrieval import retrieve
from .schema import PlanStrategy, rules_strategy

__all__ = ["Commander", "CommanderDecision", "PlanStrategy", "build_brief", "commander_from_env", "retrieve", "rules_strategy"]
