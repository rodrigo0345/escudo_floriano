"""Retrieval of the tactic cards that fit the environment brief.

A card applies when every one of its conditions holds on the brief (``cards.py``): retrieval is keyed on THIS fire, fleet and rules, not on
words. The engine cards are always returned first, filled with the live numbers. The other cards that apply are ranked by how specific
they are (more conditions met first; lessons before doctrine on a tie, since they were measured here) and the top ``k`` are kept. An
embedding ranker can be added on top later, once the base grows past what conditions sort well.
"""
from __future__ import annotations

import json
import logging
import operator
import os
import re
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable

from .cards import CARDS, Card
from .environment import lookup_path

log = logging.getLogger("firetrace.commander")

OPS: dict[str, Callable[[Any, Any], bool]] = {"==": operator.eq, "!=": operator.ne, ">=": operator.ge, "<=": operator.le, ">": operator.gt, "<": operator.lt}
KIND_RANK = {"lesson": 0, "tactic": 1}
PLACEHOLDER = re.compile(r"\{([a-z_]+(?:\.[a-z_0-9]+)+)\}")


def load_cards(extra_dir: str | None = None) -> list[Card]:
    """The built-in cards plus any JSON cards in ``extra_dir`` (``AGENTS_TACTICS_DIR``); a malformed file is skipped with a warning."""
    cards = list(CARDS)
    folder = extra_dir if extra_dir is not None else os.environ.get("AGENTS_TACTICS_DIR")
    if folder and Path(folder).is_dir():
        for path in sorted(Path(folder).glob("*.json")):
            try:
                for raw in json.loads(path.read_text(encoding="utf-8")):
                    cards.append(Card(**{**raw, "when": tuple(tuple(c) for c in raw.get("when", []))}))
            except (ValueError, TypeError) as error:
                log.warning("tactic cards %s skipped: %s", path, error)
    return cards


def holds(condition: tuple[str, str, Any], brief: dict[str, Any]) -> bool:
    field, op, value = condition
    left = lookup_path(brief, field)
    right = lookup_path(brief, value[1:]) if isinstance(value, str) and value.startswith("@") else value
    if left is None or right is None or op not in OPS:
        return False
    try:
        return bool(OPS[op](left, right))
    except TypeError:
        return False


def fill(text: str, brief: dict[str, Any]) -> str:
    """``{fleet.aircraft}`` → its value in the brief (``?`` when the brief does not have it), so a card states the live numbers."""
    def value(match: re.Match[str]) -> str:
        found = lookup_path(brief, match.group(1))
        if found is None:
            return "?"
        return f"{found:.0f}" if isinstance(found, float) else str(found)
    return PLACEHOLDER.sub(value, text)


def retrieve(brief: dict[str, Any], *, k: int = 8, cards: list[Card] | None = None) -> list[Card]:
    """The engine cards (always) and the ``k`` most specific other cards whose conditions all hold, their text filled from the brief."""
    pool = cards if cards is not None else load_cards()
    pinned = [c for c in pool if c.pinned]
    applying = [c for c in pool if not c.pinned and all(holds(cond, brief) for cond in c.when)]
    applying.sort(key=lambda c: (-len(c.when), KIND_RANK.get(c.kind, 2), c.id))
    chosen = pinned + applying[:k]
    return [replace(c, title=fill(c.title, brief), do=fill(c.do, brief), avoid=fill(c.avoid, brief), safety=fill(c.safety, brief)) for c in chosen]


def as_prompt(cards: list[Card]) -> str:
    """The retrieved cards as compact text for the prompt: id, title, what to do, what it supports, evidence or source."""
    lines = []
    for c in cards:
        parts = [f"[{c.id}] ({c.kind}) {c.title}: {c.do}"]
        if c.avoid:
            parts.append(f"Avoid: {c.avoid}")
        if c.safety:
            parts.append(f"Safety: {c.safety}")
        if c.maps_to:
            parts.append(f"Supports: {json.dumps(c.maps_to)}")
        if c.evidence or c.source:
            parts.append(f"Basis: {c.evidence or c.source}")
        lines.append(" ".join(parts))
    return "\n".join(lines)
