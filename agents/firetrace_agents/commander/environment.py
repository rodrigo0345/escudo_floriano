"""The environment brief: the facts of THIS fire, THIS fleet and THESE rules that the commander decides on and the tactics are retrieved by.

Everything comes from the backend and from the orchestrator's own reading of it (the same calls a cycle makes, so the routes it computes are cached
for the cycles that follow): the forecast fire (``/summary``, ``/vectors``), the rules (``/rules``), the weather the run used (``/simulations/{id}/weather``),
the places threatened (``/threatened``), the fleet and when each unit gets there (``POST /routing/route``), sunset (``daylight.py``). Minutes are counted
from the decision. No geometry: the brief is small enough to send to an LLM whole.
"""
from __future__ import annotations

import logging
import math
import statistics
from typing import Any

from ..client import ApiProblem, FiretraceClient
from ..daylight import minutes_to_sunset
from ..firefighter import situation_from_simulation
from ..gnr import DEFAULT_NO_EFFECT_KWM, intensity_lookup
from ..sectors import plan_sectors
from ..tiers import FirefighterTier
from ..travel import TravelPlanner

log = logging.getLogger("firetrace.commander")

# = the backend's InterventionSettings (appsettings.json): a finished line holds up to the first, is breached from the second (not in /rules)
LINE_HOLD_KWM, LINE_BREACH_KWM = 20000.0, 50000.0  # DEMO BOOST (realistic: 3500, 10000)
DEFAULT_FULL_KWM = 12000.0  # DEMO BOOST (realistic: 2500)
ARRIVAL_STEP_MIN = 15


def _angle(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


def build_brief(orchestrator: Any, client: FiretraceClient, simulation_id: str, *, location_id: str, at_minute: int = 0,
                horizon_minutes: int = 60, life_horizon_minutes: int = 180) -> dict[str, Any]:
    """The facts the commander decides on (a nested dict; its dotted paths are what the tactic cards' conditions read)."""
    simulation = client.get_simulation(simulation_id)
    snapshot = simulation.get("scenarioSnapshot") or {}
    ignitions = snapshot.get("ignitions") or []
    where = ignitions[0].get("position") if ignitions else None
    rules = orchestrator._load_rules() or {}  # noqa: SLF001 — the rules the cycles use
    suppression = rules.get("suppression") or {}
    full = float(suppression.get("fullEffectUpToKwm") or DEFAULT_FULL_KWM)
    none = float(suppression.get("noEffectFromKwm") or DEFAULT_NO_EFFECT_KWM)
    summary = client.get_summary(simulation_id)
    threatened = client.get_threatened(simulation_id, horizon_minutes=max(horizon_minutes, life_horizon_minutes), t_min=at_minute)
    situation = situation_from_simulation(simulation_id, threatened=threatened, summary=summary, horizon_minutes=horizon_minutes, at_minute=at_minute,
                                          rules=rules, ignition=where, life_horizon_minutes=life_horizon_minutes)
    if not orchestrator.agents:
        orchestrator.pull_fleet()

    # when the units get there, and whether the engine's own test says the fire can be attacked then (the same as a cycle's)
    _situation, lead, initial = orchestrator._initial_attack(situation, location_id, True)  # noqa: SLF001
    arrivals = sorted(orchestrator._arrival.values())  # noqa: SLF001
    first_group = [e for e in arrivals if e <= arrivals[0] + ARRIVAL_STEP_MIN] if arrivals else []
    first_min = float(statistics.median(first_group)) if first_group else None
    bulk_min = float(statistics.median(arrivals)) if arrivals else None
    lookup = intensity_lookup(summary)
    milestones = sorted(summary.get("milestones") or [], key=lambda m: m.get("tMin", 0))
    crown_onset = next((float(m.get("tMin") or 0) - at_minute for m in milestones
                        if float(m.get("tMin") or 0) > at_minute and float(m.get("maxIntensityKwm") or 0) >= full), None)
    end = milestones[-1] if milestones else {}

    workable = None
    if first_min is not None:
        try:
            stretches = plan_sectors(client.get_vectors(simulation_id, t_min=int(round(at_minute + first_min))), zone_radius_m=situation.zone_radius_m, limit=50)
            workable = round(sum(s.intensity_kwm < none for s in stretches) / len(stretches), 2) if stretches else None
        except ApiProblem:
            workable = None

    # the fleet: what there is, what is pre-positioned or comes from other districts, which aircraft are overhead before the fire crowns
    tags = {}
    try:
        tags = {str(v.get("id")): set(v.get("tags") or []) for v in client.list_vehicles()}
    except ApiProblem:
        pass
    agents = orchestrator.agents
    aircraft = [a for a in agents if a.tier is FirefighterTier.HELICOPTER]
    engines = [a for a in agents if a.tier is FirefighterTier.TRUCK]
    squads = [a for a in agents if a.tier is FirefighterTier.SQUAD]
    reinforcements = [a for a in agents if a.observation.mobilization_min > 0 and a.tier is not FirefighterTier.HELICOPTER]
    reinforcement_first = min((orchestrator._arrival[a.agent_id] for a in reinforcements if a.agent_id in orchestrator._arrival), default=None)  # noqa: SLF001
    air_etas: list[float] = []
    try:
        anchor = situation.anchor
        planner = TravelPlanner(client, location_id=location_id, simulation_id=simulation_id, at=situation.snapshot_time, rules=rules,
                                cache=orchestrator._routes, avoid_fire=False, origins=orchestrator.origins)  # noqa: SLF001
        air_etas = sorted(t for a in aircraft if (t := planner.eta(a, anchor).arrival_minutes) is not None)
    except ValueError:
        anchor = None

    # the weather the run used
    weather: dict[str, Any] = {}
    try:
        samples = client.get_weather(simulation_id).get("samples") or []
    except ApiProblem:
        samples = []
    if samples:
        winds = [float(s.get("windKmh") or 0) for s in samples]
        gusts = [float(s.get("gustKmh") or s.get("windKmh") or 0) for s in samples]
        dirs = [float(s["windFromDeg"]) for s in samples if s.get("windFromDeg") is not None]
        hum = [float(s["humidityPct"]) for s in samples if s.get("humidityPct") is not None]
        weather = {
            "wind_kmh_max": round(max(winds), 1), "gust_kmh_max": round(max(gusts), 1),
            "wind_from_deg_start": dirs[0] if dirs else None, "wind_shift_deg": round(max((_angle(d, dirs[0]) for d in dirs), default=0.0)),
            "humidity_min_pct": min(hum) if hum else None, "humidity_end_pct": hum[-1] if hum else None,
            "humidity_rises": bool(hum) and hum[-1] - min(hum) >= 10, "temp_max_c": max((float(s.get("tempC") or 0) for s in samples), default=None),
        }

    duration = int(snapshot.get("durationMinutes") or 0)
    sunset = minutes_to_sunset(str(snapshot["start"]), float(where["lat"]), float(where["lon"])) - at_minute if snapshot.get("start") and where else None
    stats = simulation.get("stats") or {}
    places = situation.threatened_places
    first_threat = situation.first_arrival_minutes()
    return {
        "decision": {"at_minute": at_minute, "scenario": snapshot.get("name")},
        "rules": {"full_kwm": full, "none_kwm": none, "line_hold_kwm": LINE_HOLD_KWM, "line_breach_kwm": LINE_BREACH_KWM,
                  "day_only": bool(((rules.get("aerial") or {}).get("limits") or {}).get("dayOnly", True))},
        "fire": {
            "area_now_ha": float((situation.latest_milestone or {}).get("burnedHa") or 0.0),
            "head_kwm_now": lookup(at_minute), "head_kwm_at_arrival": lookup(at_minute + first_min) if first_min is not None else None,
            "head_speed_mmin": situation.head_speed_mmin, "crown_onset_min": crown_onset,
            "crowns_before_crews": crown_onset is not None and bulk_min is not None and crown_onset <= bulk_min,
            "workable_edge_share": workable,
            "no_response_area_ha": float(stats.get("burnedHa") or end.get("burnedHa") or 0.0),
            "no_response_crown_ha": float(stats.get("crownFireHa") or 0.0),
        },
        "attack": {"initial_attack": bool(initial), "first_group_min": first_min, "bulk_min": bulk_min, "lead_min": lead},
        "fleet": {
            "ground": len(engines) + len(squads), "engines": len(engines), "squads": len(squads), "aircraft": len(aircraft),
            "aircraft_heavy": sum(1 for a in aircraft if float((a.observation.aerial or {}).get("bucketCapacityL") or 0) > 3500),
            "aircraft_before_crown": sum(1 for t in air_etas if crown_onset is not None and t <= crown_onset),
            "aircraft_first_min": air_etas[0] if air_etas else None,
            "prepositioned": sum(1 for a in agents if "prepositioned" in tags.get(str(a.observation.vehicle_id), set())),
            "reinforcements": len(reinforcements), "reinforcement_first_min": reinforcement_first,
        },
        "people": {"at_risk": situation.people_at_risk, "vulnerable": sum(int(p.get("vulnerable") or 0) for p in places),
                   "places": len(places), "first_threat_min": (float(first_threat) - at_minute) if first_threat is not None else None},
        "houses": {"affected_no_response": int(stats.get("buildingsAffected") or 0)},
        "weather": weather,
        "time": {"run_minutes": max(0, duration - at_minute), "minutes_to_sunset": round(sunset) if sunset is not None and math.isfinite(sunset) else None,
                 "start": snapshot.get("start")},
    }


def lookup_path(brief: dict[str, Any], path: str) -> Any:
    """``brief["fire"]["crown_onset_min"]`` for ``"fire.crown_onset_min"``; ``None`` when any step is missing."""
    value: Any = brief
    for key in path.split("."):
        if not isinstance(value, dict) or key not in value:
            return None
        value = value[key]
    return value
