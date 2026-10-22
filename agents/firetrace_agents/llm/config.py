"""Settings of the LLM commander, read from the environment, and the one place that decides whether an advisor exists at all.

``AGENTS_COMMANDER``       ``rules`` (default) or ``llm``
``OPENAI_API_KEY``         the key (never logged, never in ``repr``)
``AGENTS_LLM_MODEL``       the model to ask (an account may be allowed only some models: a refused one is detected at start and the rules take over)
``AGENTS_LLM_TIMEOUT``     seconds one call may take (default 60)
``AGENTS_LLM_RETRIES``     how many times an answer that breaks a rule is sent back to the model with what was wrong (default 2)
``AGENTS_LLM_TEMPERATURE`` only if set: some models accept only their default, so nothing is sent unless asked for
``AGENTS_LLM_LOG_DIR``     if set, every call (brief, answer, tokens, seconds) is appended there as JSON lines, for audit
"""
from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass, field

from ..advisor import Advisor, NullAdvisor

log = logging.getLogger("firetrace.llm")


@dataclass(frozen=True)
class LlmSettings:
    commander: str = "rules"
    model: str = ""
    api_key: str = field(default="", repr=False)
    timeout_seconds: float = 60.0
    retries: int = 2
    temperature: float | None = None
    log_dir: str | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "LlmSettings":
        env = os.environ if env is None else env
        temperature = env.get("AGENTS_LLM_TEMPERATURE", "").strip()
        return cls(
            commander=env.get("AGENTS_COMMANDER", "rules").strip().lower() or "rules",
            model=env.get("AGENTS_LLM_MODEL", "").strip(),
            api_key=env.get("OPENAI_API_KEY", "").strip(),
            timeout_seconds=float(env.get("AGENTS_LLM_TIMEOUT", "60") or 60),
            retries=int(env.get("AGENTS_LLM_RETRIES", "2") or 2),
            temperature=float(temperature) if temperature else None,
            log_dir=env.get("AGENTS_LLM_LOG_DIR", "").strip() or None,
        )

    @property
    def wanted(self) -> bool:
        """The operator asked for the LLM commander."""
        return self.commander == "llm"

    def problem(self) -> str | None:
        """Why the LLM commander cannot run, if it was asked for; ``None`` when it can (or was not asked for)."""
        if not self.wanted:
            return None
        if not self.api_key:
            return "OPENAI_API_KEY is not set"
        if not self.model:
            return "AGENTS_LLM_MODEL is not set"
        return None


def build_advisor(settings: LlmSettings | None = None, *, check: bool = True) -> Advisor:
    """The advisor to plug into the orchestrator: the LLM commander if it was asked for and is usable, else ``NullAdvisor`` (the rules decide everything).

    With ``check`` (the default) a tiny call proves the model answers before any plan depends on it; a failed check, a missing dependency or a missing key leaves the
    rules in charge and says why in the log, so the service always starts.
    """
    settings = settings or LlmSettings.from_env()
    if not settings.wanted:
        return NullAdvisor()
    if (problem := settings.problem()) is not None:
        log.warning("AGENTS_COMMANDER=llm but %s: the rules decide", problem)
        return NullAdvisor()
    try:
        from .advisor import LlmAdvisor  # noqa: PLC0415 — needs the optional dependencies
    except ImportError as error:
        log.warning("AGENTS_COMMANDER=llm but the LLM extra is not installed (%s): the rules decide. Install it with `pip install .[llm]`.", error)
        return NullAdvisor()
    advisor = LlmAdvisor(settings)
    if check:
        failure = advisor.ping()
        if failure is not None:
            log.warning("AGENTS_COMMANDER=llm but model '%s' does not answer (%s): the rules decide", settings.model, failure)
            return NullAdvisor()
    log.info("LLM commander on: model '%s'", settings.model)
    return advisor
