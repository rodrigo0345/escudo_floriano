"""Firefighter tiers and what each one can execute.

The user-facing rule: *common sense decides which intervention each tier of firefighter
performs*. Concretely — a squad member on foot or a fire truck can never perform an
aerial drop, and a helicopter cannot put a handline in the ground. All of that is
encoded here as one explicit matrix used both by the agents (when proposing) and by
the orchestrator (when validating), plus by the tests (when asserting no invalid
proposal ever reaches a published plan).

The matrix says:

* ``HELICOPTER`` — ``aerial_drop`` only (water/retardant/foam on the fire or on its
  projected path). Helicopters do not evacuate, close roads, digest the area with
  hand tools, or deploy ground crews.
* ``TRUCK`` — ``crew_deployment`` (its crew, its water), ``fire_line`` (machine /
  wet line), ``fuel_removal`` (crew with hand tools), ``structure_protection``
  (wetting buildings), ``evacuation`` (transport + door-to-door), ``backfire``.
* ``SQUAD`` — ``fire_line`` (handline), ``fuel_removal`` (hand tools),
  ``crew_deployment`` (the squad itself), ``evacuation`` (on foot, guiding people).
* ``ORCHESTRATOR`` (central command, not a firefighter) — ``road_closure`` plus
  ``backfire`` authorization: closing roads is a command-level net (police/civil
  protection in real life) and backfires are only ever lit on the order of the
  incident commander.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from .contracts import INTERVENTION_TYPES


class FirefighterTier(str, Enum):
    """The three firefighter tiers of the first implementation."""

    SQUAD = "squad"
    TRUCK = "truck"
    HELICOPTER = "helicopter"

    def __str__(self) -> str:  # nicer audit lines
        return self.value


def _intervention_types(*names: str) -> frozenset[str]:
    """Tiny helper that fails loudly on a typo against the contract vocabulary."""
    for name in names:
        if name not in INTERVENTION_TYPES:
            raise KeyError(f"{name!r} is not an intervention type in api-spec/openapi.json")
    return frozenset(names)


ORCHESTRATOR_ONLY: frozenset[str] = _intervention_types("road_closure", "backfire")
"""Command-level interventions: no firefighter tier light backfires or seals roads."""


@dataclass(frozen=True)
class TierPermission:
    """What a tier may execute, including the method constraints per intervention."""

    interventions: frozenset[str]
    """Intervention types (the ``Intervention`` oneOf ``type`` values)."""

    fire_line_methods: frozenset[str] = field(default_factory=frozenset)
    """Allowed ``method`` values when the tier builds a ``fire_line``."""

    fuel_removal_methods: frozenset[str] = field(default_factory=frozenset)
    """Allowed ``method`` values when the tier removes fuel."""

    aerial_drop_agents: frozenset[str] = field(default_factory=frozenset)
    """Allowed ``agent`` values for ``aerial_drop`` (water/retardant/foam)."""


TIER_PERMISSIONS: dict[FirefighterTier, TierPermission] = {
    FirefighterTier.SQUAD: TierPermission(
        interventions=_intervention_types(
            "crew_deployment", "fire_line", "fuel_removal", "evacuation"
        ),
        fire_line_methods=frozenset({"handline"}),
        fuel_removal_methods=frozenset({"hand_tool"}),
    ),
    FirefighterTier.TRUCK: TierPermission(
        interventions=_intervention_types(
            "crew_deployment",
            "fire_line",
            "fuel_removal",
            "structure_protection",
            "evacuation",
            "backfire",
        ),
        fire_line_methods=frozenset({"handline", "machine", "wet_line"}),
        fuel_removal_methods=frozenset({"hand_tool", "machine"}),
        aerial_drop_agents=frozenset(),  # a truck is never an aircraft
    ),
    FirefighterTier.HELICOPTER: TierPermission(
        interventions=_intervention_types("aerial_drop"),
        aerial_drop_agents=frozenset({"water", "retardant", "foam"}),
    ),
}


def allowed_interventions(tier: FirefighterTier) -> frozenset[str]:
    """Intervention types this tier can propose (schema types of ``Intervention``)."""
    return TIER_PERMISSIONS[tier].interventions


def can_execute(tier: FirefighterTier, intervention_type: str) -> bool:
    """True only when ``intervention_type`` is a real contract type the tier may execute."""
    if intervention_type not in INTERVENTION_TYPES:
        return False
    if intervention_type in ORCHESTRATOR_ONLY:
        return False
    return intervention_type in allowed_interventions(tier)


def explain_denial(tier: FirefighterTier, intervention_type: str) -> str:
    """Human-readable reason for a denied tier/intervention pair (audit + tests)."""
    if intervention_type not in INTERVENTION_TYPES:
        return f"{intervention_type!r} does not exist in the openapi contract."
    if intervention_type in ORCHESTRATOR_ONLY:
        return f"{intervention_type!r} is a command-level decision (orchestrator only), not a {tier.value} task."
    allowed = TIER_PERMISSIONS[tier].interventions
    if intervention_type not in allowed:
        return (
            f"a {tier.value} cannot execute {intervention_type!r} "
            f"(allowed: {sorted(allowed)})"
        )
    return f"{tier.value} may execute {intervention_type!r}."


# ---------------------------------------------------------------------------
# Vehicle typing: which fleet entries become which tier of agent.
# ---------------------------------------------------------------------------
GROUND_FIRE_TYPES: frozenset[str] = frozenset(
    {
        "forest_firefighting_vehicle",
        "light_firefighting_vehicle",
        "urban_firefighting_vehicle",
        "tanker_forest",
        "tanker_urban",
        "tanker_large",
    }
)
"""``VehicleType`` values that mean a fire truck (ground crew vehicle)."""

AERIAL_FIRE_TYPES: frozenset[str] = frozenset({"helicopter", "airtanker"})
"""``VehicleType`` values that mean a combat aerial vehicle."""

PERSONNEL_POOL_ROLES: frozenset[str] = frozenset({"firefighter", "forest_firefighter", "crew_leader"})
"""``PersonnelRole`` values that build a squad agent (vs medical/police pools, etc.)."""


def tier_for_vehicle(vehicle_type: str) -> FirefighterTier | None:
    if vehicle_type in GROUND_FIRE_TYPES:
        return FirefighterTier.TRUCK
    if vehicle_type in AERIAL_FIRE_TYPES:
        return FirefighterTier.HELICOPTER
    return None
