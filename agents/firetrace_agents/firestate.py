"""Is the fire out? The firefighters' goal is to put the fire out, not to hold it: a plan is measured by whether, and when, the fire stops burning.

``GET /simulations/{id}/summary`` gives, every 15 minutes, the burned area, how fast it grows and the fire's maximum intensity. The fire is **out** from the first
milestone after which nothing burns any more: no intensity left (``OUT_KWM``) and no area growing (``OUT_GROWTH_HA_H``), until the end of the run.
"""
from __future__ import annotations

from dataclasses import dataclass

from .client import ApiProblem, FiretraceClient

OUT_KWM = 50.0  # a fire burning at less than this is smouldering, not spreading
OUT_GROWTH_HA_H = 0.5  # and its area grows by less than this per hour


@dataclass(frozen=True)
class FireState:
    """How a run ends: when the fire went out (``None`` = still burning at the end), and how it was doing at the last milestone."""

    out_at: int | None
    final_area_ha: float
    final_growth_ha_h: float
    final_intensity_kwm: float

    def line(self) -> str:
        if self.out_at is not None:
            return f"fogo extinto às T+{self.out_at} min"
        return f"fogo ainda ativo no fim ({self.final_growth_ha_h:.1f} ha/h, {self.final_intensity_kwm:.0f} kW/m)"


def fire_state(client: FiretraceClient, run_id: str) -> FireState | None:
    """The run's ending, from its summary; ``None`` if the summary is not there."""
    try:
        summary = client.get_summary(run_id, step_minutes=15)
    except ApiProblem:
        return None
    milestones = sorted((m for m in summary.get("milestones") or [] if m.get("tMin") is not None), key=lambda m: m["tMin"])
    if not milestones:
        return None
    out_at: int | None = None
    for milestone in milestones:  # the first milestone from which every later one is out
        burning = float(milestone.get("maxIntensityKwm") or 0.0) > OUT_KWM or float(milestone.get("areaGrowthHaPerHour") or 0.0) > OUT_GROWTH_HA_H
        if burning:
            out_at = None
        elif out_at is None:
            out_at = int(milestone["tMin"])
    last = milestones[-1]
    return FireState(out_at, float(last.get("areaHa") or 0.0), float(last.get("areaGrowthHaPerHour") or 0.0), float(last.get("maxIntensityKwm") or 0.0))
