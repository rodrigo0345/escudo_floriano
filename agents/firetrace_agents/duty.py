"""When a crew is really fighting: water, refills, fatigue and rest, as the backend counts them.

A crew's effect on the fire used to last its whole stay at full strength. The backend's own schedule (``CrewWorkSchedule``, the same one its unit simulator
uses for the tracks on the map) says otherwise, and the agents now follow it, with the numbers from ``GET /rules``:

* an engine works ``water / (pump × dutyCycle)`` minutes on a tank, then is away ``shuttleMinutes + setupMinutes`` refilling;
* effectiveness falls ``fatiguePctPerHour`` per hour worked, down to ``minimumEffectivenessPct``;
* after ``maxContinuousWorkMinutes`` the crew rests ``mandatoryRestMinutes``.

The crew's effect keeps its whole window but at the strength it really has on average over it (``duty_factor``: the share of the window it is working, weighted
by its fatigue). One effect per crew, not one per stretch: the backend validates a plan in time proportional to its effects (measured: 37 → 74 s, 282 → 143 s),
and its unit simulator already shows the stretches on the map.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Stretch:
    """One working stretch: minutes after arrival it starts, how long, and the share of its strength the crew still has."""

    start: float
    minutes: float
    fatigue: float


def work_stretches(minutes: float, water_l: float, pump_lpm: float, rules: dict[str, Any] | None) -> list[Stretch]:
    """The stretches of a crew that works ``minutes`` from its arrival (the backend's ``CrewWorkSchedule.Plan``)."""
    water = (rules or {}).get("water") or {}
    refill = water.get("refill") or {}
    crews = (rules or {}).get("crews") or {}
    duty = float(water.get("dutyCycle") or 0.5)
    gap = float(refill.get("shuttleMinutes") or 12) + float(refill.get("setupMinutes") or 4)
    floor = float(crews.get("minimumEffectivenessPct") or 40) / 100.0
    fatigue_per_hour = float(crews.get("fatiguePctPerHour") or 12)
    max_work = float(crews.get("maxContinuousWorkMinutes") or 240)
    rest = float(crews.get("mandatoryRestMinutes") or 60)
    per_fill = water_l / (pump_lpm * duty) if water_l > 0 and pump_lpm > 0 and duty > 0 else math.inf
    stretches: list[Stretch] = []
    t = worked = 0.0
    while t < minutes - 1e-9:
        span = min(per_fill, minutes - t, max(0.0, max_work - worked))
        if span <= 1e-9:
            t += rest
            worked = 0.0
            continue
        stretches.append(Stretch(t, span, max(floor, 1 - fatigue_per_hour / 100 * (worked + span / 2) / 60)))
        t += span
        worked += span
        if math.isfinite(per_fill) and span >= per_fill - 1e-9:
            t += gap
    return stretches


def duty_factor(minutes: float, water_l: float, pump_lpm: float, rules: dict[str, Any] | None) -> float:
    """The share of its full strength a crew delivers on average over ``minutes``: working time weighted by fatigue, over the whole window (refills and rest count as 0)."""
    if minutes <= 0:
        return 1.0
    return sum(s.minutes * s.fatigue for s in work_stretches(minutes, water_l, pump_lpm, rules)) / minutes
