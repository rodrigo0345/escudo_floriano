"""The commander's decision: a strategy per plan, chosen from parameters the orchestrator already executes.

The LLM never writes coordinates, routes or times. Its answer is validated against ``DECISION_SCHEMA`` (JSON Schema), every value clamped
to a safe range, and turned into ``run_cycle`` keyword arguments by ``PlanStrategy.cycle_kwargs``. ``rules_strategy`` is today's rule-based
choice for each plan: the fallback when there is no LLM, and the baseline the commander is measured against.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

import jsonschema

MODES = ("auto", "contain")
AIRCRAFT = ("head_corridor", "timed_with_crews")

PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["variant", "intent", "mode", "house_zones", "defend_whole_run", "engines_per_zone", "fuel_breaks", "aircraft", "reserve_share",
                 "concentration", "cards", "rationale"],
    "properties": {
        "variant": {"enum": ["A", "B"]},
        "intent": {"type": "string", "maxLength": 200},
        "mode": {"enum": list(MODES)},
        "house_zones": {"type": "integer", "minimum": 0, "maximum": 16},
        "defend_whole_run": {"type": "boolean"},
        "engines_per_zone": {"type": "integer", "minimum": 2, "maximum": 6},
        "fuel_breaks": {"type": "boolean"},
        "aircraft": {"enum": list(AIRCRAFT)},
        "reserve_share": {"type": "number", "minimum": 0, "maximum": 0.4},
        "concentration": {"type": "integer", "minimum": 0, "maximum": 8},
        "cards": {"type": "array", "items": {"type": "string"}, "maxItems": 20},
        "rationale": {"type": "string", "maxLength": 1200},
    },
}
DECISION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["assessment", "plans"],
    "properties": {
        "assessment": {"type": "string", "maxLength": 800},
        "plans": {"type": "array", "minItems": 2, "maxItems": 2, "items": PLAN_SCHEMA},
    },
}


@dataclass
class PlanStrategy:
    """One plan's strategy. ``source`` says who chose it: ``llm`` or ``rules`` (the fallback)."""

    variant: str
    intent: str
    mode: str = "auto"
    house_zones: int = 4
    defend_whole_run: bool = False
    engines_per_zone: int = 3
    fuel_breaks: bool = False
    aircraft: str = "head_corridor"
    reserve_share: float = 0.0
    concentration: int = 6
    cards: list[str] = field(default_factory=list)
    rationale: str = ""
    source: str = "rules"

    def cycle_kwargs(self) -> dict[str, Any]:
        """The ``OrchestratorAgent.run_cycle`` arguments that carry this strategy out."""
        return {
            "building_zones": self.house_zones,
            "defend_whole_run": self.defend_whole_run,
            "defenders_per_zone": self.engines_per_zone,
            "fuel_breaks": self.fuel_breaks,
            "air_support": True,
            "early_air": self.aircraft == "head_corridor",
            "reserve_share": self.reserve_share,
            "lean": self.reserve_share > 0,
            "force_contain": self.mode == "contain",
            "concentration": self.concentration or None,
        }

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def parse_decision(raw: dict[str, Any], known_cards: set[str]) -> tuple[str, dict[str, PlanStrategy]]:
    """Validate an LLM answer and return (assessment, {variant: strategy}); raises ``ValueError`` if it does not hold.

    Cards the base does not have are dropped (an LLM may invent ids); both variants must be present, once each."""
    try:
        jsonschema.validate(raw, DECISION_SCHEMA)
    except jsonschema.ValidationError as error:
        raise ValueError(f"the decision does not match the schema: {error.message} at {list(error.absolute_path)}") from error
    plans: dict[str, PlanStrategy] = {}
    for item in raw["plans"]:
        if item["variant"] in plans:
            raise ValueError(f"plan {item['variant']} given twice")
        plans[item["variant"]] = PlanStrategy(**{**item, "cards": [c for c in item["cards"] if c in known_cards]}, source="llm")
    if set(plans) != {"A", "B"}:
        raise ValueError("the decision must give plan A and plan B")
    return str(raw["assessment"]), plans


def rules_strategy(variant: str, *, house_zones_b: int = 10, concentration: int | None = 6) -> PlanStrategy:
    """Today's rule-based choice (the options ``alternatives.build_alternatives`` has used): A saves area, B saves houses and people."""
    if variant == "A":
        return PlanStrategy("A", "save area: attack with everything that can work safely", house_zones=4, fuel_breaks=True, concentration=concentration or 0,
                            rationale="Regras: ataque com todos os meios que podem trabalhar em segurança, faixas corta-fogo à frente.")
    return PlanStrategy("B", "save houses and people: defend every patch of houses in the fire's path", house_zones=house_zones_b, defend_whole_run=True,
                        engines_per_zone=5, reserve_share=0.25, concentration=concentration or 0,
                        rationale="Regras: defende todas as zonas de casas que o fogo atinge, com reserva quando é preciso conter.")
