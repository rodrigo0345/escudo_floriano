"""The LLM commander: a LangGraph of one agent per organization (Bombeiros, Proteção Civil, GNR, INEM) and a commander's review, behind ``advisor.Advisor``.

Optional: the rule-based agents need none of this. Install the extra (``pip install .[llm]``) and set ``AGENTS_COMMANDER=llm`` (plus ``OPENAI_API_KEY`` and
``AGENTS_LLM_MODEL``) to turn it on; anything that goes wrong (no key, a model the account cannot use, a timeout, an answer that breaks a rule) falls back to the rules.
"""
from __future__ import annotations

from .config import LlmSettings, build_advisor

__all__ = ["LlmSettings", "build_advisor"]
