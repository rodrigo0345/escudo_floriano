"""When a crew is really fighting: water, refills, fatigue and rest, as the backend counts them.

A crew's effect on the fire used to last its whole stay at full strength. The backend's own schedule (``CrewWorkSchedule``, the same one its unit simulator
uses for the tracks on the map) says otherwise, and the agents now follow it, with the numbers from ``GET /rules``:

* an engine works ``water / (min(pump, attackFlowLpm) × dutyCycle)`` minutes on a tank (two hose lines, not the pump's full flow), then is away refilling: the
  drive to the water point it reaches soonest and back, the setup and the fill at that point's flow (``terrain.RefillSource``; the backend's generic
  ``shuttleMinutes + setupMinutes`` when the agents do not know it);
* its tank of fuel (``Rules.fuel``) runs down with the pump and with every trip to water; below ``refuelBelowPct`` it is away refuelling (``refuel_gap``);
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


# the drive to a fuel station and back is not asked to the backend for every engine: fuel stations are in the towns, and one refuel in a long shift is what
# matters (an assumption, as the backend's unit simulator routes the real trip on the map)
FUEL_STATION_DRIVE_MIN = 12.0
ROAD_KMH = 45.0  # to turn the minutes of a water trip into km of fuel


@dataclass(frozen=True)
class Fuel:
    """An engine's fuel over its work: what it starts with, what it burns working and per trip to water, and when and for how long it goes to refuel."""

    capacity_l: float
    start_l: float
    per_work_minute_l: float
    per_water_trip_l: float
    refuel_below_l: float
    refuel_gap_minutes: float


def fuel_of(rules: dict[str, Any] | None, *, capacity_l: float | None = None, level_pct: float | None = None, water_trip_drive_minutes: float | None = None) -> Fuel | None:
    """The fuel model of an engine from ``Rules.fuel`` (``None`` when the backend publishes none)."""
    fuel = (rules or {}).get("fuel") or {}
    if not fuel:
        return None
    capacity = float(capacity_l or fuel.get("defaultCapacityL") or 200.0)
    per_km = float(fuel.get("drivingLPer100Km") or 40.0) / 100.0
    trip_km = 2.0 * float(water_trip_drive_minutes or 0.0) * ROAD_KMH / 60.0
    return Fuel(capacity, capacity * max(0.0, min(100.0, level_pct if level_pct is not None else 100.0)) / 100.0, float(fuel.get("workingLph") or 12.0) / 60.0,
                trip_km * per_km, capacity * float(fuel.get("refuelBelowPct") or 25.0) / 100.0, 2.0 * FUEL_STATION_DRIVE_MIN + float(fuel.get("refuelMinutes") or 10.0))


def working_lpm(pump_lpm: float, rules: dict[str, Any] | None) -> float:
    """Litres a minute an engine uses working (``Rules.water``: ``min(pump, attackFlowLpm) × dutyCycle``), as the backend counts it."""
    water = (rules or {}).get("water") or {}
    duty = float(water.get("dutyCycle") or 0.5)
    attack = float(water.get("attackFlowLpm") or 0.0)
    return (min(pump_lpm, attack) if attack > 0 else pump_lpm) * duty if pump_lpm > 0 else 0.0


@dataclass(frozen=True)
class Stretch:
    """One working stretch: minutes after arrival it starts, how long, and the share of its strength the crew still has."""

    start: float
    minutes: float
    fatigue: float


def refill_setup_minutes(rules: dict[str, Any] | None) -> float:
    """Minutes of setup at the refill point (``Rules.water.refill.setupMinutes``): what is added to the drive there and back."""
    return float((((rules or {}).get("water") or {}).get("refill") or {}).get("setupMinutes") or 4)


def work_stretches(minutes: float, water_l: float, pump_lpm: float, rules: dict[str, Any] | None, gap_minutes: float | None = None, fuel: Fuel | None = None) -> list[Stretch]:
    """The stretches of a crew that works ``minutes`` from its arrival (the backend's ``CrewWorkSchedule.Plan``).

    ``gap_minutes`` is how long each refill takes away from the fire when the agents know the real distance to water (``terrain.TerrainReader.refill_gap_minutes``);
    without it, the backend's generic ``shuttleMinutes + setupMinutes`` (which is what its unit simulator draws on the map).
    """
    water = (rules or {}).get("water") or {}
    refill = water.get("refill") or {}
    crews = (rules or {}).get("crews") or {}
    gap = gap_minutes if gap_minutes is not None else float(refill.get("shuttleMinutes") or 12) + float(refill.get("setupMinutes") or 4)
    floor = float(crews.get("minimumEffectivenessPct") or 40) / 100.0
    fatigue_per_hour = float(crews.get("fatiguePctPerHour") or 12)
    max_work = float(crews.get("maxContinuousWorkMinutes") or 240)
    rest = float(crews.get("mandatoryRestMinutes") or 60)
    lpm = working_lpm(pump_lpm, rules)
    per_fill = water_l / lpm if water_l > 0 and lpm > 0 else math.inf
    stretches: list[Stretch] = []
    t = worked = 0.0
    tank = per_fill  # minutes of water left
    fuel_l = fuel.start_l if fuel else math.inf
    for _guard in range(10_000):
        if t >= minutes - 1e-9:
            break
        if fuel is not None and fuel_l <= fuel.refuel_below_l + 1e-9:
            t += fuel.refuel_gap_minutes
            fuel_l = fuel.capacity_l
            continue
        span = min(tank, minutes - t, max(0.0, max_work - worked))
        if fuel is not None and fuel.per_work_minute_l > 0:
            span = min(span, max(0.0, (fuel_l - fuel.refuel_below_l) / fuel.per_work_minute_l))
        if span <= 1e-9:
            if worked >= max_work - 1e-9:
                t += rest
                worked = 0.0
            elif tank <= 1e-9:
                t += gap
                tank = per_fill
                fuel_l -= fuel.per_water_trip_l if fuel else 0.0
            continue
        stretches.append(Stretch(t, span, max(floor, 1 - fatigue_per_hour / 100 * (worked + span / 2) / 60)))
        t += span
        worked += span
        tank -= span
        fuel_l -= span * (fuel.per_work_minute_l if fuel else 0.0)
    return stretches


def duty_factor(minutes: float, water_l: float, pump_lpm: float, rules: dict[str, Any] | None, gap_minutes: float | None = None, fuel: Fuel | None = None) -> float:
    """The share of its full strength a crew delivers on average over ``minutes``: working time weighted by fatigue, over the whole window (refills and rest count as 0)."""
    if minutes <= 0:
        return 1.0
    return sum(s.minutes * s.fatigue for s in work_stretches(minutes, water_l, pump_lpm, rules, gap_minutes, fuel)) / minutes
