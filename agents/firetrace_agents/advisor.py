"""What an advisor (an LLM commander) may decide, and the only way it may decide it.

The rule-based agents propose, the backend validates and the engine judges. An advisor sits between the first two: at five places in a planning cycle it is shown
the *options the rules code has already worked out* (each with an id and the facts a commander would want) and chooses among them:

* **sectors**: which stretch of the fire front each unit works (Bombeiros);
* **evacuations**: the order places are evacuated in, and the shelter each one goes to (Proteção Civil);
* **closures**: which road closures are enforced, and in what order the patrols are committed (GNR);
* **standby**: where the ambulances wait (INEM);
* **review**: a commander's note on the finished picture.

It never writes coordinates, ids or action JSON: it returns ids it was given. An id it was not given, or a choice that breaks a hard rule (the validators below), is
discarded and the rules decide that point, so an advisor that is wrong, slow or offline can only cost its own candidate plan, never produce an invalid one. And its
candidate plan competes with the rules' under the engine's judge (``alternatives.py``): it ships only if it is at least as good.

This module has no LLM in it (see ``llm/`` for the one that does): the contracts, the briefs and the validators are plain Python, and are tested without a network.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

MAX_EVACUATION_REORDER_MIN = 20.0  # an advisor may put a place later than another that the fire reaches this much sooner only if the later one is vulnerable


# ------------------------------------------------------------------------------------------------------------------ the contract
class Advisor(Protocol):
    """A commander the orchestrator may ask at five places. Every method answers ``None`` for "no opinion": the rules decide."""

    name: str

    def assign_sectors(self, brief: dict[str, Any]) -> dict[str, str] | None:
        """``unit id`` → ``sector id`` for the units that should not take the rules' sector."""

    def order_evacuations(self, brief: dict[str, Any]) -> list[str] | None:
        """Place ids, first to evacuate first."""

    def choose_shelters(self, brief: dict[str, Any]) -> dict[str, str] | None:
        """``place id`` → ``shelter facility id`` among the options given for that place."""

    def order_closures(self, brief: dict[str, Any]) -> list[str] | None:
        """Closure ids to enforce, in the order the patrols are committed; closures not listed are not enforced."""

    def choose_standby(self, brief: dict[str, Any]) -> dict[str, Any] | None:
        """``{"backM": one of the safe distances behind the crews, "ambulances": 1..N}``."""

    def review(self, brief: dict[str, Any]) -> str | None:
        """A commander's note on the finished plan, in Portuguese."""

    def drain_notes(self) -> list[dict[str, Any]]:
        """The reasons given since the last call (``{"agent", "text"}``), for the plan's summary; empties the log."""


class NullAdvisor:
    """No opinion anywhere: the rules decide everything (what runs when ``AGENTS_COMMANDER`` is not ``llm``)."""

    name = "rules"

    def assign_sectors(self, brief: dict[str, Any]) -> dict[str, str] | None:
        return None

    def order_evacuations(self, brief: dict[str, Any]) -> list[str] | None:
        return None

    def choose_shelters(self, brief: dict[str, Any]) -> dict[str, str] | None:
        return None

    def order_closures(self, brief: dict[str, Any]) -> list[str] | None:
        return None

    def choose_standby(self, brief: dict[str, Any]) -> dict[str, Any] | None:
        return None

    def review(self, brief: dict[str, Any]) -> str | None:
        return None

    def drain_notes(self) -> list[dict[str, Any]]:
        return []


# ------------------------------------------------------------------------------------------------------------------ briefs
def sector_id(index: int) -> str:
    return f"S{index + 1}"


def sector_brief(sectors: Sequence[Any], terrain_of: Callable[[Any], Any | None]) -> list[dict[str, Any]]:
    """The stretches of the fire front, most dangerous first, each with what the ground there does to a crew (``terrain.TerrainAssessment.facts``)."""
    out: list[dict[str, Any]] = []
    for index, sector in enumerate(sectors):
        entry: dict[str, Any] = {
            "id": sector_id(index), "headingDeg": round(sector.bearing_deg), "spreadMPerMin": round(sector.speed_mmin, 1), "intensityKwM": round(sector.intensity_kwm),
            "crownFire": bool(sector.crown), "danger": round(sector.danger),
        }
        assessment = terrain_of(sector)
        if assessment is not None:
            entry["terrain"] = assessment.facts()
        out.append(entry)
    return out


def unit_brief(agent: Any, eta_minutes: float | None, refill_gap_minutes: float | None) -> dict[str, Any]:
    """One unit as a commander sees it: what it is, what it carries and how soon it can be at the fire."""
    observation = agent.observation
    entry: dict[str, Any] = {
        "id": agent.agent_id, "kind": agent.tier.value, "callsign": getattr(observation, "callsign", None) or agent.agent_id, "crew": int(observation.crew_onboard),
        "waterL": float(observation.water_capacity_l or 0.0), "pumpLpm": float(observation.pump_lpm or 0.0),
    }
    if eta_minutes is not None:
        entry["etaToFireMin"] = round(eta_minutes)
    if refill_gap_minutes is not None:
        entry["refillTripMin"] = round(refill_gap_minutes)
    return entry


def evacuation_brief(items: Iterable[Any], now: float, margin_min: float) -> list[dict[str, Any]]:
    """The places the fire is predicted to reach: how many people, whether they need help to move, and when (pessimistic, likely)."""
    return [{
        "id": item.id, "name": item.name, "kind": item.kind, "people": int(item.people), "vulnerable": bool(item.vulnerable),
        "fireArrivalMin": {"pessimistic": round(item.arrival_p10), "likely": round(item.arrival_p50)}, "minutesLeft": round(item.arrival_p10 - now - margin_min),
    } for item in items]


# ------------------------------------------------------------------------------------------------------------------ validators
def valid_sector_choice(choice: dict[str, str] | None, units: Iterable[str], sector_ids: Iterable[str]) -> tuple[dict[str, str], list[str]]:
    """The part of a sector assignment that is about units and sectors that exist; the problems found, for the advisor to fix or for the log."""
    units, sectors = set(units), set(sector_ids)
    kept: dict[str, str] = {}
    problems: list[str] = []
    for unit, sector in (choice or {}).items():
        if unit not in units:
            problems.append(f"a unidade '{unit}' não existe")
        elif sector not in sectors:
            problems.append(f"o setor '{sector}' (unidade '{unit}') não existe")
        else:
            kept[unit] = sector
    return kept, problems


def valid_evacuation_order(order: Sequence[str] | None, places: Sequence[dict[str, Any]]) -> tuple[list[str] | None, list[str]]:
    """The evacuation order if it is a permutation of the places and does not push a place the fire reaches much sooner behind a later one that is not vulnerable.

    Returns ``(order, problems)``; the order is ``None`` when it is not acceptable.
    """
    by_id = {p["id"]: p for p in places}
    problems: list[str] = []
    order = list(order or [])
    if sorted(order) != sorted(by_id):
        missing = sorted(set(by_id) - set(order))
        unknown = sorted(set(order) - set(by_id))
        if missing:
            problems.append(f"faltam locais na ordem: {', '.join(missing)}")
        if unknown:
            problems.append(f"locais que não existem: {', '.join(unknown)}")
        if len(order) != len(set(order)):
            problems.append("há locais repetidos")
        return None, problems or ["a ordem não é uma permutação dos locais"]
    for i, later_id in enumerate(order):
        later = by_id[later_id]
        for earlier_id in order[:i]:
            earlier = by_id[earlier_id]
            soonest = later["fireArrivalMin"]["pessimistic"]
            if soonest + MAX_EVACUATION_REORDER_MIN < earlier["fireArrivalMin"]["pessimistic"] and not earlier["vulnerable"] and later["people"] > 0:
                problems.append(f"'{later['name']}' (fogo daqui a ~{soonest} min) não pode ficar atrás de '{earlier['name']}' (~{earlier['fireArrivalMin']['pessimistic']} min), que não é vulnerável")
    return (order if not problems else None), problems


def valid_shelters(choice: dict[str, str] | None, options: dict[str, Sequence[str]]) -> tuple[dict[str, str], list[str]]:
    """The shelter choices that name one of the options offered for that place."""
    kept: dict[str, str] = {}
    problems: list[str] = []
    for place, shelter in (choice or {}).items():
        if place not in options:
            problems.append(f"o local '{place}' não tem escolha de abrigo")
        elif shelter not in options[place]:
            problems.append(f"o abrigo '{shelter}' não é uma opção para '{place}'")
        else:
            kept[place] = shelter
    return kept, problems


def valid_closures(order: Sequence[str] | None, closure_ids: Iterable[str]) -> tuple[list[str], list[str]]:
    """The closures named that exist, each once, in the advisor's order; the unknown ones are problems."""
    known = set(closure_ids)
    seen: set[str] = set()
    kept: list[str] = []
    problems: list[str] = []
    for closure in order or []:
        if closure not in known:
            problems.append(f"o corte '{closure}' não existe")
        elif closure not in seen:
            seen.add(closure)
            kept.append(closure)
    return kept, problems


def valid_standby(choice: dict[str, Any] | None, safe_distances_m: Sequence[float], max_ambulances: int) -> tuple[dict[str, Any] | None, list[str]]:
    """The standby choice if its distance is one of the safe ones offered and the ambulance count is possible."""
    if not choice:
        return None, ["sem escolha"]
    problems: list[str] = []
    back = choice.get("backM")
    if back is None or not any(abs(float(back) - d) < 1.0 for d in safe_distances_m):
        problems.append(f"a distância {back} não é uma das opções seguras {list(safe_distances_m)}")
    count = choice.get("ambulances")
    if not isinstance(count, int) or not 1 <= count <= max_ambulances:
        problems.append(f"o número de ambulâncias {count} não está entre 1 e {max_ambulances}")
    return (None if problems else {"backM": float(back), "ambulances": int(count)}), problems


@dataclass
class AdvisorLog:
    """What an advisor did in a cycle: for the plan's summary and metadata (``agents.llm``)."""

    advisor: str = "rules"
    notes: list[dict[str, Any]] = field(default_factory=list)  # {"agent": ..., "text": ...}, in the order given
    discarded: list[str] = field(default_factory=list)  # choices thrown away and why
    applied: list[str] = field(default_factory=list)  # which decisions were taken from the advisor
    review: str | None = None

    @property
    def used(self) -> bool:
        return bool(self.applied)
