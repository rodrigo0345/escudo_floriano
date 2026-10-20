"""How much line a unit can build in a stage.

Without a limit every unit could lay a long line every stage for free and *where* the lines go would not matter. With one,
the metres are scarce and the orchestrator has to spend them where they count.

Only one build rate is stated by the backend: ``FuelRemoval.CrewRateMPerHourPerPerson = 15`` (appsettings; a validator
warns ``fuel_break_slow`` with it). The rest are **assumptions to calibrate** with the corporations, kept here in one place.
"""
from __future__ import annotations

from typing import Any

GROUND_RATE_M_PER_H_PER_PERSON = 15.0  # backend: FuelRemoval.CrewRateMPerHourPerPerson
WET_LINE_FACTOR = 2.0  # assumption: a hose line goes down faster than a hand line
AERIAL_WATER_DISTANCE_KM = 5.0  # assumption (Rules.aerial.limits.maxDistanceToWaterKm is 10)
DROP_LENGTH_M = 80.0  # assumption: the length one bucket drop covers
MIN_LINE_M = 20.0


def line_budget_m(tier: str, crew: int, stage_minutes: float, rules: dict[str, Any] | None = None) -> float:
    """Metres of line one unit builds (or drops) in ``stage_minutes``; 0 for a tier that does not build lines."""
    hours = stage_minutes / 60.0
    if tier == "squad":
        return max(MIN_LINE_M, GROUND_RATE_M_PER_H_PER_PERSON * crew * hours)
    if tier == "truck":
        return max(MIN_LINE_M, GROUND_RATE_M_PER_H_PER_PERSON * WET_LINE_FACTOR * crew * hours)
    if tier == "helicopter":
        heli = ((rules or {}).get("aerial") or {}).get("helicopter") or {}
        speed = float(heli.get("cruiseSpeedKmh") or 180.0)
        cycle = 2 * AERIAL_WATER_DISTANCE_KM / speed * 60 + float(heli.get("loadMinutes") or 1.0) + float(heli.get("dropMinutes") or 1.0)
        return max(MIN_LINE_M, int(stage_minutes // cycle) * DROP_LENGTH_M)
    return 0.0
