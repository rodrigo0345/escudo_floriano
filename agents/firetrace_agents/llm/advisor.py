"""The LLM commander as an ``Advisor``: one LangGraph call per decision, with a memory, an audit log and the reasons it gives kept for the plan.

It answers only when it has something usable: a model error, an answer that still breaks a rule after its retries, or a decision the orchestrator cannot map to its
options all end as ``None`` ("no opinion"), and the rules decide that point. Every call is cached by what was asked (plans A and B over the same fire ask the same
questions), and, if ``AGENTS_LLM_LOG_DIR`` is set, appended to a JSON-lines file with the briefing, the answer, the tokens and the seconds, so every decision can be audited.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from datetime import UTC, datetime
from typing import Any

from .checks import drop_bad_sector_items
from .config import LlmSettings
from .graph import build_graph
from .prompts import AGENT_LABEL

log = logging.getLogger("firetrace.llm")


class LlmAdvisor:
    name = "llm"

    def __init__(self, settings: LlmSettings, *, llm: Any | None = None) -> None:
        self.settings = settings
        self._llm = llm if llm is not None else self._chat(settings)
        self._graph = build_graph(self._llm, retries=settings.retries)
        self._cache: dict[str, Any] = {}
        self._notes: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self.calls = 0  # calls that went to the model
        self.cache_hits = 0
        self.failures = 0
        self.tokens = {"input": 0, "output": 0}
        self.seconds = 0.0

    @staticmethod
    def _chat(settings: LlmSettings) -> Any:
        from langchain_openai import ChatOpenAI  # noqa: PLC0415 — optional dependency

        kwargs: dict[str, Any] = {"model": settings.model, "api_key": settings.api_key, "timeout": settings.timeout_seconds, "max_retries": 1}
        if settings.temperature is not None:
            kwargs["temperature"] = settings.temperature
        return ChatOpenAI(**kwargs)

    # -- health ------------------------------------------------------------------
    def ping(self) -> str | None:
        """A tiny call to prove the model answers: ``None`` if it does, else why not (a model the account cannot use, a bad key, no network)."""
        try:
            self._llm.invoke("Responde apenas: ok")
            return None
        except Exception as error:  # noqa: BLE001
            return f"{type(error).__name__}: {str(error)[:160]}"

    # -- one decision --------------------------------------------------------------
    def _ask(self, task: str, brief: dict[str, Any]) -> Any | None:
        key = hashlib.sha256((task + json.dumps(brief, sort_keys=True, ensure_ascii=False, default=str)).encode()).hexdigest()
        with self._lock:
            if key in self._cache:
                self.cache_hits += 1
                decision = self._cache[key]
                self._notes.append(self._note(task, decision))
                return decision
        started = time.monotonic()
        state = self._graph.invoke({"task": task, "brief": brief, "attempt": 0, "problems": []})
        seconds = time.monotonic() - started
        decision = state.get("decision")
        problems = list(state.get("problems") or [])
        with self._lock:
            self.calls += 1
            self.seconds += seconds
            for k in ("input", "output"):
                self.tokens[k] += int((state.get("tokens") or {}).get(k, 0))
            if state.get("error") or decision is None:
                self.failures += 1
        self._log(task, brief, state, seconds)
        if state.get("error"):
            log.warning("llm %s: no answer (%s); the rules decide", task, state["error"])
            return None
        if decision is None:
            return None
        if task == "bombeiros":  # what still breaks a rule after the retries is dropped, item by item; the good choices stay
            decision, dropped = drop_bad_sector_items(decision, brief)
            if dropped:
                log.info("llm bombeiros: dropped %d assignment(s) that break a rule: %s", len(dropped), "; ".join(dropped)[:300])
        elif problems:
            log.info("llm %s: answer still breaks a rule after %s attempt(s): %s; the rules decide", task, state.get("attempt"), "; ".join(problems)[:300])
            return None
        with self._lock:
            self._cache[key] = decision
            self._notes.append(self._note(task, decision))
        return decision

    @staticmethod
    def _note(task: str, decision: Any) -> dict[str, Any]:
        text = getattr(decision, "reasoning", None) or getattr(decision, "note", "") or ""
        extras = [f"{a.unit_id} → {a.sector_id}: {a.reason}" for a in getattr(decision, "assignments", [])] + [f"{p.place_id} → {p.shelter_id}: {p.reason}" for p in getattr(decision, "picks", [])]
        return {"agent": AGENT_LABEL.get(task, task), "text": " ".join([text.strip(), *(f"[{e}]" for e in extras)]).strip()}

    def _log(self, task: str, brief: dict[str, Any], state: dict[str, Any], seconds: float) -> None:
        if not self.settings.log_dir:
            return
        try:
            os.makedirs(self.settings.log_dir, exist_ok=True)
            decision = state.get("decision")
            entry = {
                "time": datetime.now(UTC).isoformat(), "task": task, "model": self.settings.model, "seconds": round(seconds, 2), "attempts": state.get("attempt"),
                "tokens": state.get("tokens"), "error": state.get("error"), "problems": state.get("problems"), "brief": brief,
                "decision": decision.model_dump() if decision is not None else None,
            }
            with open(os.path.join(self.settings.log_dir, f"llm-{datetime.now(UTC):%Y-%m-%d}.jsonl"), "a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
        except OSError as error:
            log.warning("llm log not written: %s", error)

    # -- the Advisor contract -----------------------------------------------------
    def assign_sectors(self, brief: dict[str, Any]) -> dict[str, str] | None:
        decision = self._ask("bombeiros", brief)
        return None if decision is None else {a.unit_id: a.sector_id for a in decision.assignments}

    def order_evacuations(self, brief: dict[str, Any]) -> list[str] | None:
        decision = self._ask("protecao_civil_ordem", brief)
        return None if decision is None else list(decision.order)

    def choose_shelters(self, brief: dict[str, Any]) -> dict[str, str] | None:
        decision = self._ask("protecao_civil_abrigos", brief)
        return None if decision is None else {p.place_id: p.shelter_id for p in decision.picks}

    def order_closures(self, brief: dict[str, Any]) -> list[str] | None:
        decision = self._ask("gnr", brief)
        return None if decision is None else list(decision.enforce)

    def choose_standby(self, brief: dict[str, Any]) -> dict[str, Any] | None:
        decision = self._ask("inem", brief)
        return None if decision is None else {"backM": decision.back_m, "ambulances": decision.ambulances}

    def review(self, brief: dict[str, Any]) -> str | None:
        decision = self._ask("comandante", brief)
        if decision is None:
            return None
        return decision.note.strip() + ("" if not decision.concerns else "\n" + "\n".join(f"- A confirmar: {c}" for c in decision.concerns))

    def drain_notes(self) -> list[dict[str, Any]]:
        with self._lock:
            notes, self._notes = self._notes, []
        return notes

    def stats(self) -> dict[str, Any]:
        """What the commander cost so far: calls, cache hits, failures, tokens and seconds (``metadata["agents.llm"]``)."""
        return {"model": self.settings.model, "calls": self.calls, "cacheHits": self.cache_hits, "failures": self.failures, "tokens": dict(self.tokens), "seconds": round(self.seconds, 1)}
