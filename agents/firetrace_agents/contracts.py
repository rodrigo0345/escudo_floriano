"""Intervention, action and capability vocabulary — straight from ``api-spec/openapi.json``.

Everything here mirrors a schema in the contract:

* ``INTERVENTION_TYPES``        — oneOf ``Intervention`` (+ ``InterventionFuelRemoval``).
* ``ACTION_TYPES``              — enum ``ActionType``.
* ``RESPONSIBILITIES``          — enum ``Responsibility``.
* ``OBJECTIVES``                — enum used by ``Objective``.
* ``validate_against_spec``     — runtime check that a payload the agents are about to
  send conforms to the schema they claim (the contract-first rule from AGENTS.md).

Nothing in this file is invented: if a name is not in the spec, payloads fail validation
and the tests fail loudly, which is exactly the signal that the contract needs a PR first.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema import RefResolver
from jsonschema.exceptions import SchemaError

# ---------------------------------------------------------------------------
# Enum values (snake_case, as required by the contract conventions).
# ---------------------------------------------------------------------------

INTERVENTION_TYPES: frozenset[str] = frozenset(
    {
        "road_closure",
        "fire_line",
        "aerial_drop",
        "backfire",
        "fuel_removal",
        "crew_deployment",
        "structure_protection",
        "evacuation",
    }
)
"""Types accepted by the ``Intervention`` oneOf (aerial_drop, fire_line, fuel_removal,
backfire, crew_deployment, structure_protection, road_closure, evacuation)."""

UNSAFE_ON_WIRE: frozenset[str] = frozenset({"fuel_removal"})
"""Interventions the spec lists and ``/capabilities`` calls supported, but that the live backend
rejects with HTTP 400: its ``FuelRemovalIntervention`` requires a ``removal`` field and has no
``effectiveness``, while the spec's ``InterventionFuelRemoval`` has the opposite. Until spec and backend
are reconciled (a contract proposal, not an agents decision) the agents do not emit them."""

ACTION_TYPES: frozenset[str] = frozenset(
    {
        "dispatch_units",
        "stage_resources",
        "establish_command_post",
        "road_closure",
        "traffic_control_point",
        "evacuation",
        "shelter_in_place",
        "structure_protection",
        "fire_attack",
        "medical_standby",
        "air_support_request",
        "public_alert",
        "request_reinforcements",
        "reconnaissance",
        "custom",
    }
)

RESPONSIBILITIES: frozenset[str] = frozenset(
    {
        "firefighting",
        "structure_protection",
        "water_supply",
        "evacuation",
        "traffic_control",
        "perimeter_security",
        "medical",
        "rescue",
        "command",
        "reconnaissance",
        "logistics",
        "standby",
    }
)

OBJECTIVES: frozenset[str] = frozenset(
    {
        "protect_life",
        "protect_buildings",
        "keep_access_routes",
        "protect_infrastructure",
        "protect_environment",
        "minimize_burned_area",
        "protect_responders",
    }
)

# How simulations/plans map onto FIRE-PROGRESS effects — the ``Action`` schema
# carries this as ``simulationEffects: Intervention[]``.
ACTION_TYPE_INTERVENTIONS: dict[str, str] = {
    "fire_attack": "crew_deployment",
    "dispatch_units": "crew_deployment",
    "evacuation": "evacuation",
    "road_closure": "road_closure",
    "structure_protection": "structure_protection",
}

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SPEC = REPO_ROOT / "api-spec" / "openapi.json"

_validator_cache: dict[str, Draft202012Validator] = {}
_registry: dict[str, Any] | None = None
_resolver: RefResolver | None = None


def load_registry(path: str | Path | None = None) -> dict[str, Any]:
    """Load ``openapi.json`` (default: ``api-spec/openapi.json``) and cache it."""
    global _registry, _resolver
    target = Path(path or os.environ.get("FIRETRACE_SPEC", DEFAULT_SPEC))
    cached = _registry.get(str(target)) if _registry else None
    if cached is not None:
        return cached
    with target.open("r", encoding="utf-8") as handle:
        doc = json.load(handle)
    if _registry is None:
        _registry = {}
    _registry[str(target)] = doc
    return doc


def get_schema(name: str, *, spec_path: str | Path | None = None) -> dict[str, Any]:
    """Return component schema ``name`` from the contract."""
    doc = load_registry(spec_path)
    schemas = doc.get("components", {}).get("schemas", {})
    if name not in schemas:
        raise KeyError(f"schema {name!r} does not exist in the openapi contract")
    return schemas[name]


def validator(schema_name: str, *, spec_path: str | Path | None = None) -> Draft202012Validator:
    """A schema validator bound to the whole contract document (so ``$ref`` works)."""
    cache_key = f"{spec_path or os.environ.get('FIRETRACE_SPEC', DEFAULT_SPEC)}::{schema_name}"
    if cache_key in _validator_cache:
        return _validator_cache[cache_key]
    doc = load_registry(spec_path)
    schema = get_schema(schema_name, spec_path=spec_path)
    global _resolver
    if _resolver is None:
        # The OpenAPI document itself is the root resource every "#/components/..."
        # pointer points into. RefResolver is deprecated upstream but stable and exact
        # for whole-document pointer resolution; when jsonschema removes it we pin.
        _resolver = RefResolver(base_uri="", referrer=doc)
    resolved = Draft202012Validator(schema, resolver=_resolver)
    _validator_cache[cache_key] = resolved
    return resolved


class ContractViolation(Exception):
    """A payload the agents were about to send does not validate against the contract."""


def validate_against_spec(
    schema_name: str,
    payload: Any,
    *,
    spec_path: str | Path | None = None,
    strict: bool = True,
) -> list[str]:
    """Validate ``payload`` against component schema ``schema_name``.

    Returns the error list (empty when valid). With ``strict`` (default) raises
    :class:`ContractViolation` so a payload that would be rejected by the real server
    never leaves the agent runtime silently.
    """
    errors = sorted(
        validator(schema_name, spec_path=spec_path).iter_errors(payload),
        key=lambda err: list(err.path),
    )
    messages = [
        ("/".join(str(part) for part in err.absolute_path) or "<root>") + f": {err.message}"
        for err in errors
    ]
    if messages and strict:
        raise ContractViolation(f"payload does not conform to {schema_name}: {messages}")
    return messages
