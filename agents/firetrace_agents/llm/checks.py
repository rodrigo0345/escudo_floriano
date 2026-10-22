"""What an agent's answer must satisfy before it is used, and the feedback it gets when it does not.

Two kinds of rule. *Structural*: every id it names exists in the briefing it was given (``advisor.valid_*``). *Doctrinal*: a few things a commander does not do, whatever
the argument for them (a crew on foot sent up a steep slope the fire is running up). An answer that breaks one is sent back once or twice with the list of what was wrong;
what still breaks a rule after that is thrown away item by item, so one bad choice does not cost the good ones.
"""
from __future__ import annotations

import unicodedata
from typing import Any

from ..advisor import valid_closures, valid_evacuation_order, valid_sector_choice, valid_shelters, valid_standby
from .schemas import BombeirosDecision, ClosureDecision, EvacuationOrder, ReviewNote, ShelterChoice, StandbyDecision

STEEP_UPHILL_RUN_DEG = 25.0  # on foot, never into a slope at least this steep that the fire is running up
UNWORKABLE = 0.3  # a crew on foot is not sent where it does less than this share of its normal work
UNWORKABLE_ENGINE = 0.2
HAND_CREW_MAX_KWM = 1700.0  # Haul chart: above ~2.4 m flames (Byram ≈1700 kW/m) a crew on foot cannot hold the fire
MAX_NOTE_WORDS = 120


def sector_problems(decision: BombeirosDecision, brief: dict[str, Any]) -> list[str]:
    """Problems with a sector assignment; each one names the unit so the offending item can be dropped."""
    units = {u["id"]: u for u in brief.get("units", [])}
    sectors = {s["id"]: s for s in brief.get("sectors", [])}
    _kept, problems = valid_sector_choice({a.unit_id: a.sector_id for a in decision.assignments}, units, sectors)
    seen: set[str] = set()
    for a in decision.assignments:
        if a.unit_id in seen:
            problems.append(f"a unidade '{a.unit_id}' aparece mais de uma vez")
        seen.add(a.unit_id)
        unit, sector = units.get(a.unit_id), sectors.get(a.sector_id)
        if unit and sector and unit["kind"] == "squad" and (sector.get("crownFire") or float(sector.get("intensityKwM") or 0) >= HAND_CREW_MAX_KWM):
            problems.append(f"a equipa '{a.unit_id}' a pé não pode ir para {a.sector_id}: {sector.get('intensityKwM')} kW/m" + (" com fogo de copas" if sector.get("crownFire") else "") + " está acima do que uma equipa a pé controla (1700 kW/m)")
        terrain = (sector or {}).get("terrain")
        if not unit or not terrain:
            continue
        if unit["kind"] == "squad" and terrain.get("fireRunsUphill") and float(terrain.get("slopeDeg") or 0) >= STEEP_UPHILL_RUN_DEG:
            problems.append(f"a equipa '{a.unit_id}' a pé não pode ir para {a.sector_id}: o fogo sobe uma encosta de {terrain['slopeDeg']}°")
        if unit["kind"] == "squad" and float(terrain.get("workability") or 1.0) < UNWORKABLE:
            problems.append(f"a equipa '{a.unit_id}' a pé rende demasiado pouco em {a.sector_id} (workability {terrain['workability']})")
        if unit["kind"] == "truck" and float(terrain.get("workability") or 1.0) < UNWORKABLE_ENGINE:
            problems.append(f"a viatura '{a.unit_id}' rende demasiado pouco em {a.sector_id} (workability {terrain['workability']})")
    return problems


def drop_bad_sector_items(decision: BombeirosDecision, brief: dict[str, Any]) -> tuple[BombeirosDecision, list[str]]:
    """The assignments that satisfy every rule, and what was dropped (unit by unit): what is used when the retries ran out."""
    kept, dropped = [], []
    for a in decision.assignments:
        single = BombeirosDecision(reasoning=decision.reasoning, assignments=[a])
        problems = sector_problems(single, brief)
        if problems:
            dropped.extend(problems)
        elif a.unit_id not in {k.unit_id for k in kept}:
            kept.append(a)
    return BombeirosDecision(reasoning=decision.reasoning, assignments=kept), dropped


def order_problems(decision: EvacuationOrder, brief: dict[str, Any]) -> list[str]:
    return valid_evacuation_order(decision.order, brief.get("places", []))[1]


def shelter_problems(decision: ShelterChoice, brief: dict[str, Any]) -> list[str]:
    options = {c["placeId"]: [o["id"] for o in c["options"]] for c in brief.get("evacuations", [])}
    return valid_shelters({p.place_id: p.shelter_id for p in decision.picks}, options)[1]


def closure_problems(decision: ClosureDecision, brief: dict[str, Any]) -> list[str]:
    kept, problems = valid_closures(decision.enforce, [c["id"] for c in brief.get("closures", [])])
    if not kept and brief.get("closures"):
        problems.append("não impuseste nenhum corte: indica pelo menos o mais urgente")
    return problems


def standby_problems(decision: StandbyDecision, brief: dict[str, Any]) -> list[str]:
    return valid_standby({"backM": decision.back_m, "ambulances": decision.ambulances}, brief.get("safeDistancesBehindCrewsM", []), int(brief.get("ambulancesAvailable") or 1))[1]


def _foreign_letters(text: str) -> str:
    """Letters outside the Latin script (a model sometimes slips a word into another alphabet): the operator cannot read them."""
    return "".join(sorted({c for c in text if c.isalpha() and not ("LATIN" in unicodedata.name(c, "") or c in "ºª")}))


def review_problems(decision: ReviewNote, brief: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    words = len(decision.note.split())
    if words > MAX_NOTE_WORDS:
        problems.append(f"a nota tem {words} palavras: no máximo {MAX_NOTE_WORDS}")
    foreign = _foreign_letters(" ".join([decision.note, *decision.concerns]))
    if foreign:
        problems.append(f"há letras fora do alfabeto português ({foreign}): reescreve só em português")
    return problems


CHECKS = {
    "bombeiros": sector_problems,
    "protecao_civil_ordem": order_problems,
    "protecao_civil_abrigos": shelter_problems,
    "gnr": closure_problems,
    "inem": standby_problems,
    "comandante": review_problems,
}
