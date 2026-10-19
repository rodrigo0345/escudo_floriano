"""Firetrace planning agents (see ``AGENTS.md``: contract-first at All times)."""
from .contracts import INTERVENTION_TYPES, ACTION_TYPES, OBJECTIVES, ContractViolation, validate_against_spec
from .client import FiretraceClient, ApiProblem
from .firefighter import ActionProposal, DecisionMessage, FirefighterAgent, Observation, Situation, situation_from_simulation
from .orchestrator import AgentIssue, AgentRegistry, CycleResult, OrchestratorAgent
from .tiers import FirefighterTier, ORCHESTRATOR_ONLY, allowed_interventions, can_execute, explain_denial

__version__ = "0.1.0"

__all__ = [
    "INTERVENTION_TYPES",
    "ACTION_TYPES",
    "OBJECTIVES",
    "ContractViolation",
    "validate_against_spec",
    "FiretraceClient",
    "ApiProblem",
    "ActionProposal",
    "DecisionMessage",
    "FirefighterAgent",
    "Observation",
    "Situation",
    "situation_from_simulation",
    "AgentIssue",
    "AgentRegistry",
    "CycleResult",
    "OrchestratorAgent",
    "FirefighterTier",
    "ORCHESTRATOR_ONLY",
    "allowed_interventions",
    "can_execute",
    "explain_denial",
]
