"""The commander: environment brief + retrieved tactics → an LLM chooses the strategy of plans A and B (or the rules do, when it cannot).

One LLM call per decision, answered as JSON against ``schema.DECISION_SCHEMA``; a bad answer gets one retry with the validation error, then
the rule-based strategy is used and the decision says so. The safety of the result does not depend on the LLM: the plans it leads to are
judged by the engine like any other (``judge.py``), and a crew the fire would reach is cut or not sent by code.
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any

from .cards import Card
from .llm import LlmClient, LlmError
from .retrieval import as_prompt, load_cards, retrieve
from .schema import AIRCRAFT, MODES, PlanStrategy, parse_decision, rules_strategy

log = logging.getLogger("firetrace.commander")

SYSTEM_PROMPT = f"""You are the incident commander of a wildfire response in Guimarães, Portugal, inside a simulation.
Priorities, in order: 1) lives (crews and evacuated people); 2) houses; 3) burned area.

You choose the STRATEGY of two plans. Software carries it out (unit positions, routes, timing, water, fatigue) and a fire engine simulates it.
Crews the fire would reach are withdrawn by code, so a strategy that sends crews ahead of a crown run only wastes them.
- Plan A: save area. Put the fire out if it can be put out, otherwise slow it the most.
- Plan B: save houses and people. Defend what is in the fire's path first.
The two plans must differ where the situation allows.

Decide from the ENVIRONMENT (fire, fleet, rules, weather) and the TACTICS given. The "engine" tactics describe how this engine actually behaves: trust them over
general knowledge. Cite the ids of the tactics you used.

Strategy menu, per plan:
- mode: {" | ".join(MODES)}. "auto" lets the engine decide between attacking the edge and containing. "contain" forces containment and gives up the initial attack
  (measured: much worse when attack.initial_attack is true).
- house_zones (0-16): patches of houses defended by engines. defend_whole_run (bool): defend every patch the fire reaches, not only the first.
- engines_per_zone (2-6): engines per patch.
- fuel_breaks (bool): crews open fuel strips ahead of the fire where they can finish before it arrives.
- aircraft: {" | ".join(AIRCRAFT)}. "head_corridor": aircraft drop on the head's path when it will crown before the crews arrive.
  "timed_with_crews": each aircraft prepares the stretch where crews go in.
- reserve_share (0-0.4): share of units held in reserve; used only when containing.
- concentration (0-8): how many of the most dangerous stretches the line metres go to (0 = spread over the whole front).

Answer ONLY a JSON object: {{"assessment": "<one or two sentences on the situation>", "plans": [<plan A>, <plan B>]}}, each plan
{{"variant": "A"|"B", "intent": "...", "mode": ..., "house_zones": ..., "defend_whole_run": ..., "engines_per_zone": ..., "fuel_breaks": ...,
"aircraft": ..., "reserve_share": ..., "concentration": ..., "cards": ["<tactic id>", ...], "rationale": "<2-4 sentences>"}}.
Write "assessment" and "rationale" in European Portuguese (pt-PT, current spelling) for the operator. Use the fire-service terms:
engines = "autotanques" or "viaturas", crews = "equipas", aircraft = "meios aéreos", fuel strips = "faixas de gestão de combustível".
"""


@dataclass
class CommanderDecision:
    """What the commander chose, with what it was given; ``source`` is ``llm`` or ``rules`` (with ``error`` saying why the rules were used)."""

    plans: dict[str, PlanStrategy]
    assessment: str = ""
    cards: list[str] = field(default_factory=list)
    source: str = "rules"
    error: str | None = None
    model: str | None = None
    seconds: float = 0.0
    brief: dict[str, Any] = field(default_factory=dict)

    def metadata(self, variant: str) -> dict[str, Any]:
        """For ``plan.metadata["agents.commander"]``: the choice, its reason and what it rested on (an audit trail, readable in the frontend)."""
        plan = self.plans[variant]
        return {"source": self.source, "model": self.model, "assessment": self.assessment, "strategy": plan.as_dict(), "retrieved": self.cards,
                "error": self.error, "seconds": round(self.seconds, 1)}

    def summary(self, variant: str) -> str:
        """A short markdown block for the plan's summary (Portuguese, like the rest of it)."""
        plan = self.plans[variant]
        who = f"comandante LLM ({self.model})" if self.source == "llm" else "regras (sem LLM" + (f": {self.error}" if self.error else "") + ")"
        lines = [f"### Decisão do comando — {who}"]
        if self.assessment:
            lines.append(f"- Avaliação: {self.assessment}")
        lines.append(f"- Estratégia: {plan.intent}")
        if plan.rationale:
            lines.append(f"- Porquê: {plan.rationale}")
        if plan.cards:
            lines.append(f"- Táticas usadas: {', '.join(plan.cards)}")
        return "\n".join(lines) + "\n\n"


class Commander:
    def __init__(self, llm: LlmClient | None, *, k: int = 8, cards: list[Card] | None = None) -> None:
        self.llm, self.k = llm, k
        self.cards = cards if cards is not None else load_cards()

    def decide(self, brief: dict[str, Any], *, house_zones_b: int = 10, concentration: int | None = 6) -> CommanderDecision:
        """Plans A and B for this environment: the LLM's choice when it gives a valid one, else the rules'."""
        retrieved = retrieve(brief, k=self.k, cards=self.cards)
        fallback = {v: rules_strategy(v, house_zones_b=house_zones_b, concentration=concentration) for v in ("A", "B")}
        ids = [c.id for c in retrieved]
        if self.llm is None:
            return CommanderDecision(fallback, cards=ids, error="no LLM configured", brief=brief)
        user = (f"ENVIRONMENT (minutes from the decision):\n{json.dumps(brief, ensure_ascii=False, default=str)}\n\n"
                f"TACTICS:\n{as_prompt(retrieved)}\n\nChoose plans A and B.")
        started, error = time.monotonic(), None
        for attempt in range(2):
            try:
                raw = self.llm.complete_json(SYSTEM_PROMPT, user if attempt == 0 else f"{user}\n\nYour previous answer was rejected: {error}. Answer again, valid JSON only.")
                assessment, plans = parse_decision(raw, {c.id for c in self.cards})
                log.info("commander: %s chose A=%s · B=%s in %.1f s", self.llm.model, plans["A"].intent, plans["B"].intent, time.monotonic() - started)
                log.info("commander: decision %s", json.dumps(raw, ensure_ascii=False))  # the whole answer, for the audit trail (no secrets in it)
                return CommanderDecision(plans, assessment, ids, "llm", None, self.llm.model, time.monotonic() - started, brief)
            except (LlmError, ValueError) as caught:
                error = str(caught)
                log.warning("commander: attempt %d failed: %s", attempt + 1, error)
                if isinstance(caught, LlmError) and not caught.retryable:
                    break  # unreachable provider, no credits, a bad key: asking again changes nothing
        return CommanderDecision(fallback, cards=ids, error=error, model=self.llm.model, seconds=time.monotonic() - started, brief=brief)


def commander_from_env(env: dict[str, str] | None = None) -> Commander | None:
    """A commander when ``AGENTS_COMMANDER=llm`` (with or without a working LLM: it falls back to the rules); ``None`` keeps today's behaviour."""
    e = os.environ if env is None else env
    if e.get("AGENTS_COMMANDER", "rules").strip().lower() != "llm":
        return None
    llm = LlmClient.from_env(e)
    if llm is None:
        log.warning("AGENTS_COMMANDER=llm but AGENTS_LLM_MODEL / the API key are not set: the rules decide")
    return Commander(llm, k=int(e.get("AGENTS_TACTICS_K", "8")))
