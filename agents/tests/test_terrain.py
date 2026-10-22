"""Fighting fire on a steep slope is hard, and the backend's engine does not say so for a crew: the agents do (``terrain.py``).

The assessment is a pure function of the backend's ``terrain-at`` answer, so it is tested on plain dicts; the integration test runs a whole planning cycle against a
stand-in backend on flat ground and then on a steep eucalyptus slope with the fire running up it.
"""
from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from firetrace_agents.client import FiretraceClient
from firetrace_agents.duty import duty_factor, refill_setup_minutes
from firetrace_agents.orchestrator import OrchestratorAgent
from firetrace_agents.terrain import (
    FUEL_FACTOR, MIN_FACTOR, TerrainReader, apply_to_effect, assess, bearing_difference, slope_factor,
)

from .conftest import SUMMARY_RAGING, THREATENED_TOWN, mock_client
from .test_orchestrator import POOLS, VEHICLES


def point(slope: float = 0.0, aspect: float = 180.0, fuel: str = "pasto", road_m: float | None = 10.0) -> dict[str, Any]:
    return {"position": {"lat": 41.43, "lon": -8.27}, "elevationM": 400.0, "slopeDeg": slope, "aspectDeg": aspect, "vegetation": {"id": 1, "key": fuel, "label": fuel.title()},
            **({"nearestRoad": {"id": "rd-1", "highway": "unclassified", "distanceM": road_m}} if road_m is not None else {})}


# ---------------------------------------------------------------------------------------------------- the numbers
def test_slope_slows_a_crew_more_and_more() -> None:
    assert slope_factor(0) == slope_factor(8) == 1.0
    values = [slope_factor(s) for s in range(0, 61, 5)]
    assert values == sorted(values, reverse=True)  # never gets easier as it gets steeper
    assert slope_factor(20) == pytest.approx(0.8) and slope_factor(30) == pytest.approx(0.55)
    assert 0.2 <= slope_factor(75) <= slope_factor(40)  # a cliff is not worse than the worst band


def test_bearings_wrap_around_north() -> None:
    assert bearing_difference(350, 10) == 20 and bearing_difference(0, 180) == 180 and bearing_difference(90, 90) == 0


def test_easy_ground_changes_nothing_and_says_nothing() -> None:
    a = assess(point(slope=3, fuel="pasto"), head_bearing_deg=90, tier="squad")
    assert a.factor == pytest.approx(1.0) and a.flags == () and a.note() == ""


def test_a_steep_eucalyptus_slope_with_the_fire_running_up_it_is_the_worst_case() -> None:
    # the slope faces south (aspect 180), so uphill is north (0°); the fire heads north: it runs up the slope
    a = assess(point(slope=32, aspect=180, fuel="eucalipto"), head_bearing_deg=10, tier="squad")
    assert a.fire_runs_uphill and a.uphill_bearing_deg == 0
    assert a.factor < 0.35 and a.factor >= MIN_FACTOR
    assert any("sobe esta encosta" in f for f in a.flags) and any("combustível pesado" in f for f in a.flags) and any("muito íngreme" in f for f in a.flags)
    assert "×" in a.note() and a.note().startswith("Terreno:")


def test_the_fire_going_across_the_slope_is_not_running_uphill() -> None:
    assert not assess(point(slope=32, aspect=180), head_bearing_deg=90, tier="squad").fire_runs_uphill  # heading east, uphill is north
    assert not assess(point(slope=6, aspect=180), head_bearing_deg=0, tier="squad").fire_runs_uphill  # a gentle slope does not make it run
    assert not assess(point(slope=32, aspect=180), head_bearing_deg=None, tier="squad").fire_runs_uphill  # no heading, no claim


def test_an_engine_suffers_the_slope_less_than_a_crew_on_foot_but_needs_the_road() -> None:
    foot = assess(point(slope=30, fuel="mato", road_m=20), head_bearing_deg=90, tier="squad")
    engine = assess(point(slope=30, fuel="mato", road_m=20), head_bearing_deg=90, tier="truck")
    assert engine.factor > foot.factor
    far = assess(point(slope=30, fuel="mato", road_m=400), head_bearing_deg=90, tier="truck")
    assert far.factor < engine.factor and any("mangueiras" in f for f in far.flags)
    assert not any("mangueiras" in f for f in assess(point(slope=30, fuel="mato", road_m=400), head_bearing_deg=90, tier="squad").flags)  # a hose is an engine's problem


def test_an_aircraft_is_not_slowed_by_the_ground_but_the_note_points_at_it() -> None:
    a = assess(point(slope=35, fuel="eucalipto"), head_bearing_deg=0, tier="helicopter")
    assert a.factor == 1.0
    assert any("meio aéreo" in f for f in a.flags)


def test_lighter_fuel_is_easier_than_heavier_fuel() -> None:
    assert FUEL_FACTOR["pasto"] > FUEL_FACTOR["mato"] > FUEL_FACTOR["eucalipto"]
    assert assess(point(fuel="pasto"), head_bearing_deg=0, tier="squad").factor > assess(point(fuel="eucalipto"), head_bearing_deg=0, tier="squad").factor
    assert assess(point(fuel="something-new"), head_bearing_deg=0, tier="squad").fuel_factor == pytest.approx(0.8)  # an unknown class is neither easy nor the worst


def test_the_note_does_not_claim_a_scaling_that_did_not_happen() -> None:
    a = assess(point(slope=30, fuel="mato"), head_bearing_deg=90, tier="squad")
    assert "Eficácia do meio no local" in a.note(applied=True)
    unscaled = a.note(applied=False)
    assert "Eficácia" not in unscaled and "mais devagar" in unscaled and f"×{a.factor:.2f}" in unscaled


def test_apply_scales_the_effect_of_crews_only() -> None:
    a = assess(point(slope=30, fuel="mato"), head_bearing_deg=90, tier="squad")
    crew = {"type": "crew_deployment", "effectiveness": 0.8}
    assert apply_to_effect(crew, a) and crew["effectiveness"] == pytest.approx(round(0.8 * a.factor, 2))
    drop = {"type": "aerial_drop", "effectiveness": 0.8}
    assert not apply_to_effect(drop, a) and drop["effectiveness"] == 0.8  # aircraft are not scaled
    assert not apply_to_effect({"type": "crew_deployment"}, a)  # no strength stated, nothing to scale
    flat = assess(point(slope=0, fuel="pasto"), head_bearing_deg=0, tier="squad")
    same = {"type": "fire_line", "effectiveness": 0.7}
    assert not apply_to_effect(same, flat) and same["effectiveness"] == 0.7


# ---------------------------------------------------------------------------------------------------- the reader
def reader_with(handler: Any) -> TerrainReader:
    return TerrainReader(FiretraceClient("http://test/api/v1", transport=httpx.MockTransport(handler)), "loc")


def test_a_place_is_asked_once() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, json=point(slope=20))

    reader = reader_with(handler)
    for _ in range(3):
        assert reader.assess({"lat": 41.43001, "lon": -8.27001}, head_bearing_deg=0, tier="squad") is not None
    assert reader.assess({"lat": 41.43002, "lon": -8.27002}, head_bearing_deg=0, tier="squad") is not None  # ~2 m away: the same place
    assert len(calls) == 1 and calls[0].endswith("/locations/loc/terrain-at")


def test_a_place_the_backend_cannot_describe_has_no_assessment() -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(422, json={"code": "validation_failed", "title": "fora do local"}, headers={"content-type": "application/problem+json"})

    reader = reader_with(handler)
    assert reader.assess({"lat": 0.0, "lon": 0.0}, head_bearing_deg=0, tier="squad") is None
    assert reader.assess({"lat": 0.0, "lon": 0.0}, head_bearing_deg=0, tier="squad") is None
    assert len(calls) == 1 and reader.assess(None, head_bearing_deg=0, tier="squad") is None


def test_the_refill_cycle_is_the_drive_to_the_nearest_source_and_back() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(dict(request.url.params))
        return httpx.Response(200, json={"items": [
            {"point": {"id": "wp-0", "kind": "swimming_pool"}, "distanceM": 50, "driveMinutes": 1.0},  # not a source the rules allow
            {"point": {"id": "wp-1", "kind": "hydrant"}, "distanceM": 90, "driveMinutes": 9.0},
            {"point": {"id": "wp-2", "kind": "pond", "name": "Charca", "flowLpm": 1000}, "distanceM": 300, "driveMinutes": 5.5},
            {"point": {"id": "wp-3", "kind": "tank"}, "distanceM": 600, "driveMinutes": None}]})

    reader = reader_with(handler)
    gap = reader.refill_gap_minutes({"lat": 41.43, "lon": -8.27}, setup_minutes=4, water_l=3000)
    assert gap == pytest.approx(2 * 5.5 + 4 + 3000 / 1000)  # the source fastest to reach by road (not the nearest in a straight line), and the fill at its flow
    assert reader.refill_source({"lat": 41.43, "lon": -8.27}).name == "Charca"
    assert seen["truckOnly"] == "true" and seen["routeFrom"] == "41.43,-8.27"


def test_no_refill_source_means_the_backends_generic_shuttle() -> None:
    reader = reader_with(lambda r: httpx.Response(200, json={"items": []}))
    assert reader.refill_gap_minutes({"lat": 41.43, "lon": -8.27}, setup_minutes=4) is None
    failing = reader_with(lambda r: httpx.Response(500, json={"code": "x"}, headers={"content-type": "application/problem+json"}))
    assert failing.refill_gap_minutes({"lat": 41.43, "lon": -8.27}, setup_minutes=4) is None


def test_a_longer_trip_to_water_costs_the_crew_working_time() -> None:
    rules = {"water": {"dutyCycle": 0.5, "refill": {"shuttleMinutes": 12, "setupMinutes": 4}}, "crews": {"fatiguePctPerHour": 12, "minimumEffectivenessPct": 40, "maxContinuousWorkMinutes": 240, "mandatoryRestMinutes": 60}}
    generic = duty_factor(240, 3000, 1000, rules)  # tank 6 min of work, then 16 away
    assert duty_factor(240, 3000, 1000, rules, gap_minutes=16.0) == pytest.approx(generic)  # the backend's own default, spelled out
    assert duty_factor(240, 3000, 1000, rules, gap_minutes=4.0) > generic > duty_factor(240, 3000, 1000, rules, gap_minutes=40.0)
    assert refill_setup_minutes(rules) == 4 and refill_setup_minutes(None) == 4
    assert duty_factor(240, 0, 0, rules, gap_minutes=99.0) == duty_factor(240, 0, 0, rules)  # no tank, no refill: the gap does not matter


# ---------------------------------------------------------------------------------------------------- a whole cycle
def cycle_effects(terrain_answer: dict[str, Any] | None, monkeypatch: pytest.MonkeyPatch, *, terrain: bool = True) -> tuple[list[dict[str, Any]], list[str]]:
    """Run a planning cycle with the stand-in backend plus a ``terrain-at`` answer; return the crews' effects and the actions' safety notes."""
    monkeypatch.setenv("AGENTS_TERRAIN", "1" if terrain else "0")
    _client, store = mock_client(vehicles=VEHICLES, pools=POOLS, threatened=THREATENED_TOWN, summary=SUMMARY_RAGING)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/terrain-at"):
            return httpx.Response(200, json=terrain_answer) if terrain_answer is not None else httpx.Response(404, json={"code": "not_found"}, headers={"content-type": "application/problem+json"})
        if request.url.path.endswith("/water-points/near"):
            return httpx.Response(200, json={"items": [{"point": {"id": "wp-1"}, "distanceM": 100, "driveMinutes": 3.0}]})
        return store.handle(request)

    orchestrator = OrchestratorAgent(FiretraceClient(base_url="mock://firetrace", transport=httpx.MockTransport(handler)))
    orchestrator.pull_fleet()
    result = orchestrator.run_cycle("sim-penanet", location_id="guimaraes-concelho", publish=False)
    plan = result.plan_a
    effects = [e for a in plan["actions"] for e in a.get("simulationEffects", []) if e.get("type") in {"crew_deployment", "fire_line"} and e.get("effectiveness") is not None]
    notes = [a["safetyNotes"] for a in plan["actions"] if "Terreno:" in (a.get("safetyNotes") or "")]
    return effects, notes


def test_a_cycle_on_steep_wooded_ground_gives_its_crews_less_effect_and_says_why(monkeypatch: pytest.MonkeyPatch) -> None:
    flat, flat_notes = cycle_effects(point(slope=2, fuel="pasto"), monkeypatch)
    steep, steep_notes = cycle_effects(point(slope=34, aspect=180, fuel="eucalipto"), monkeypatch)
    assert flat and len(flat) == len(steep)
    assert flat_notes == []  # easy ground: nothing to say
    assert steep_notes and all("Terreno:" in n for n in steep_notes)
    assert sum(e["effectiveness"] for e in steep) < sum(e["effectiveness"] for e in flat)


def test_the_cycle_is_unchanged_when_the_backend_cannot_describe_the_ground_or_the_switch_is_off(monkeypatch: pytest.MonkeyPatch) -> None:
    baseline, _ = cycle_effects(None, monkeypatch, terrain=False)
    unknown, unknown_notes = cycle_effects(None, monkeypatch)  # terrain-at answers 404: nothing is invented
    off, off_notes = cycle_effects(point(slope=34, aspect=180, fuel="eucalipto"), monkeypatch, terrain=False)
    assert unknown_notes == [] and off_notes == []
    assert [e["effectiveness"] for e in unknown] == [e["effectiveness"] for e in off] != []
    assert sorted(e["effectiveness"] for e in baseline) == sorted(e["effectiveness"] for e in off)


# ---------------------------------------------------------------------------------------------------- where the crews are sent
def vectors(*stretches: tuple[float, float, float, float]) -> dict[str, Any]:
    """A front of points ``(lat, lon, speed m/min, intensity kW/m)``, all heading north."""
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": {"bearingDeg": 0, "speedMmin": speed, "intensityKwm": intensity}}
        for lat, lon, speed, intensity in stretches]}


def test_crews_are_not_piled_onto_ground_they_cannot_work_while_an_easier_stretch_burns_as_hard() -> None:
    from firetrace_agents.sectors import plan_sectors

    front = vectors((41.430, -8.270, 10.0, 1600.0), (41.440, -8.270, 9.0, 1500.0))  # about the same fire, a kilometre apart
    plain = plan_sectors(front)
    assert (plain[0].lat, plain[1].lat) == (41.430, 41.440)  # the faster stretch first, as before
    steep_first = plan_sectors(front, workability_of=lambda s: 0.2 if s.lat < 41.435 else 1.0)  # the first stretch is steep wooded ground
    assert steep_first[0].lat == 41.440 and steep_first[0].workability == 1.0 and steep_first[1].workability == pytest.approx(0.2)


def test_workability_only_discounts_it_never_hides_a_stretch() -> None:
    from firetrace_agents.sectors import WORKABILITY_FLOOR, plan_sectors

    front = vectors((41.430, -8.270, 10.0, 1600.0))
    (sector,) = plan_sectors(front, workability_of=lambda s: 0.0)
    assert sector.danger == pytest.approx(10.0 * 1600.0 * WORKABILITY_FLOOR)  # a fast fire on bad ground still counts


def test_without_terrain_the_ranking_is_the_old_one() -> None:
    from firetrace_agents.sectors import plan_sectors

    front = vectors((41.430, -8.270, 10.0, 2000.0), (41.440, -8.270, 9.0, 1900.0))
    assert [s.danger for s in plan_sectors(front)] == [s.danger for s in plan_sectors(front, workability_of=lambda s: 1.0)]
