"""The judge asks the engine about the same plans again and again, and the backend answers 429 when asked too fast: neither may cost a plan request.

No backend here: a fake client counts what the judge asks of it, and ``httpx.MockTransport`` plays the rate limiter.
"""
from __future__ import annotations

import copy
from typing import Any

import httpx
import pytest

from firetrace_agents import client as client_module
from firetrace_agents.alternatives import central_engine
from firetrace_agents.client import FiretraceClient
from firetrace_agents.judge import Judge, plan_fingerprint

SNAPSHOT: dict[str, Any] = {
    "name": "base", "locationId": "loc", "start": "2026-08-17T14:00:00+00:00", "durationMinutes": 120, "ignitions": [{"position": {"lat": 41.4, "lon": -8.3}}],
    "weather": {"base": "provider", "ensemble": {"members": 12, "windDirectionSigmaDeg": 15}}, "engine": {"spotting": True, "seed": 7, "ensemble": {"members": 12, "windDirectionSigmaDeg": 15}},
}


def plan(stay: int = 60) -> dict[str, Any]:
    return {"locationId": "loc", "basis": {"simulationId": "sim-base"}, "title": "t", "actions": [{"id": "a1", "type": "fire_attack", "expectedDurationMinutes": stay, "resources": [{"resourceType": "vehicle", "resourceId": "v1"}]}]}


# ------------------------------------------------------------------------------------------------------------------ 429 and polling
def test_a_429_is_waited_out_not_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    pauses: list[float] = []
    monkeypatch.setattr(client_module.time, "sleep", pauses.append)
    answers = iter([429, 429, 200])

    def handler(request: httpx.Request) -> httpx.Response:
        status = next(answers)
        if status == 429:
            return httpx.Response(429, headers={"retry-after": "2", "content-type": "application/problem+json"}, json={"code": "rate_limited", "title": "slow down"})
        return httpx.Response(200, json={"items": []})

    client = FiretraceClient("http://test/api/v1", transport=httpx.MockTransport(handler))
    assert client.list_organizations() == []
    assert pauses == [2.0, 2.0]  # honours Retry-After


def test_a_patch_is_retried_too(monkeypatch: pytest.MonkeyPatch) -> None:
    """The progress ``PATCH`` that used to fail a whole plan request when the limiter said no."""
    monkeypatch.setattr(client_module.time, "sleep", lambda _s: None)
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        return httpx.Response(429, json={"code": "rate_limited"}, headers={"content-type": "application/problem+json"}) if len(calls) == 1 else httpx.Response(200, json={"id": "preq-1"})

    client = FiretraceClient("http://test/api/v1", transport=httpx.MockTransport(handler), validate_sent_payloads=False)
    assert client.patch_plan_request("preq-1", {"progress": {"phase": "judging", "percent": 40}})["id"] == "preq-1"
    assert calls == ["PATCH", "PATCH"]


def test_a_limit_that_never_lifts_ends_as_the_429_it_is(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client_module.time, "sleep", lambda _s: None)
    monkeypatch.setattr(client_module, "MAX_429_WAIT_SECONDS", 3.0)
    client = FiretraceClient("http://test/api/v1", transport=httpx.MockTransport(lambda r: httpx.Response(429, json={"code": "rate_limited", "title": "no"}, headers={"content-type": "application/problem+json"})))
    with pytest.raises(client_module.ApiProblem) as info:
        client.list_organizations()
    assert info.value.status_code == 429 and info.value.code == "rate_limited"


def test_other_errors_are_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client_module.time, "sleep", lambda _s: pytest.fail("a 404 is not worth waiting for"))
    client = FiretraceClient("http://test/api/v1", transport=httpx.MockTransport(lambda r: httpx.Response(404, json={"code": "not_found"}, headers={"content-type": "application/problem+json"})))
    with pytest.raises(client_module.ApiProblem):
        client.list_organizations()


def test_polling_starts_quick_and_backs_off(monkeypatch: pytest.MonkeyPatch) -> None:
    pauses: list[float] = []
    monkeypatch.setattr(client_module.time, "sleep", pauses.append)
    states = iter(["queued", "running", "running", "running", "running", "running", "running", "succeeded"])
    client = FiretraceClient("http://test/api/v1", transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"id": "s", "status": next(states)})))
    assert client.wait_for_simulation("s", poll_seconds=1.0)["status"] == "succeeded"
    assert pauses[0] == 0.25 and pauses == sorted(pauses) and max(pauses) == 1.0  # quick first, never above the cap


# ------------------------------------------------------------------------------------------------------------------ central-only runs
def test_central_engine_keeps_everything_but_the_member_count() -> None:
    engine = central_engine(SNAPSHOT)
    assert engine["spotting"] is True and engine["seed"] == 7
    assert engine["ensemble"] == {"members": 0, "windDirectionSigmaDeg": 15}
    assert SNAPSHOT["engine"]["ensemble"]["members"] == 12  # the baseline's own options are not touched


def test_central_engine_falls_back_to_the_weather_ensemble() -> None:
    snapshot = {k: v for k, v in SNAPSHOT.items() if k != "engine"}
    assert central_engine(snapshot) == {"ensemble": {"members": 0, "windDirectionSigmaDeg": 15}}
    assert central_engine({}) == {"ensemble": {"members": 0}}


# ------------------------------------------------------------------------------------------------------------------ the judge
class FakeEngine:
    """Stands for the client: every published plan is 'simulated' at once, and the calls are counted."""

    def __init__(self) -> None:
        self.created: list[str] = []
        self.simulated: list[dict[str, Any]] = []
        self.scenarios: list[dict[str, Any]] = []
        self.deleted: list[str] = []

    def create_plan(self, plan_input: dict[str, Any]) -> dict[str, Any]:
        self.created.append(plan_fingerprint(plan_input))
        return {"id": f"pla-{len(self.created)}"}

    def simulate_plan(self, plan_id: str, *, baseline_simulation_id: str | None = None, wait_seconds: int | None = 60, engine: dict[str, Any] | None = None) -> dict[str, Any]:
        self.simulated.append({"plan": plan_id, "baseline": baseline_simulation_id, "engine": engine})
        return {"id": f"run-{plan_id}"}

    def wait_for_simulation(self, simulation_id: str, **_kwargs: Any) -> dict[str, Any]:
        return {"id": simulation_id, "status": "succeeded", "stats": {"burnedHa": 12.5, "buildingsAffected": 2, "crewCasualties": 0}, "crewExposures": []}

    def delete_plan(self, plan_id: str) -> None:
        self.deleted.append(plan_id)

    def run_scenario(self, scenario: dict[str, Any], *, label: str, **_kwargs: Any) -> dict[str, Any]:
        self.scenarios.append(scenario)
        return {"id": f"idle-{len(self.scenarios)}", "status": "succeeded", "stats": {"burnedHa": 80.0}}


def test_a_plan_already_judged_is_not_simulated_again() -> None:
    engine = FakeEngine()
    judge = Judge(engine, "sim-base", SNAPSHOT)  # type: ignore[arg-type]
    p = plan()
    first = judge.verdict(p, wrong_wind=False)
    again = judge.verdict(p, wrong_wind=False)
    assert first is not None and again is not None
    assert len(engine.created) == 1 and len(engine.simulated) == 1  # the second look was free
    assert again.forecast.burned_ha == first.forecast.burned_ha == 12.5
    assert again.forecast is not first.forecast  # callers fill fields in: each gets its own copy
    again.forecast.units = 99
    assert judge.verdict(p, wrong_wind=False).forecast.units == 0  # type: ignore[union-attr]


def test_a_changed_plan_is_judged_again() -> None:
    engine = FakeEngine()
    judge = Judge(engine, "sim-base", SNAPSHOT)  # type: ignore[arg-type]
    judge.verdict(plan(stay=60), wrong_wind=False)
    judge.verdict(plan(stay=30), wrong_wind=False)  # a crew's stay was cut: a different plan
    assert len(engine.simulated) == 2


def test_the_forecast_inside_a_full_verdict_comes_from_memory() -> None:
    engine = FakeEngine()
    judge = Judge(engine, "sim-base", SNAPSHOT)  # type: ignore[arg-type]
    p = plan()
    judge.verdict(p, wrong_wind=False)
    full = judge.verdict(p)
    assert full is not None and len(full.shifted) == 2
    assert len(engine.simulated) == 1 + 2  # the forecast once, then only the two wrong-wind runs
    assert len(engine.scenarios) == 2  # the two no-response baselines


def test_only_the_wrong_wind_runs_use_the_central_run() -> None:
    engine = FakeEngine()
    judge = Judge(engine, "sim-base", SNAPSHOT)  # type: ignore[arg-type]
    judge.verdict(plan())
    forecast = [s for s in engine.simulated if s["baseline"] == "sim-base"]
    shifted = [s for s in engine.simulated if s["baseline"] != "sim-base"]
    assert len(forecast) == 1 and forecast[0]["engine"] is None  # the next decision is read from this run's ensemble: it keeps it
    assert len(shifted) == 2 and all(s["engine"]["ensemble"]["members"] == 0 for s in shifted)
    assert all(s["engine"]["spotting"] is True and s["engine"]["seed"] == 7 for s in shifted)
    assert all(sc["engine"]["ensemble"]["members"] == 0 for sc in engine.scenarios)  # and so do the no-response baselines


def test_the_saving_can_be_turned_off() -> None:
    engine = FakeEngine()
    judge = Judge(engine, "sim-base", SNAPSHOT, central_only=False)  # type: ignore[arg-type]
    judge.verdict(plan())
    assert all(s["engine"] is None for s in engine.simulated)
    assert all(sc["engine"] == SNAPSHOT["engine"] for sc in engine.scenarios)


def test_two_plans_judged_at_once_share_the_baseline_runs() -> None:
    from concurrent.futures import ThreadPoolExecutor

    engine = FakeEngine()
    judge = Judge(engine, "sim-base", SNAPSHOT)  # type: ignore[arg-type]
    plans = [plan(stay=60), plan(stay=45)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        verdicts = list(pool.map(lambda p: judge.verdict(copy.deepcopy(p)), plans))
    assert all(v is not None and len(v.shifted) == 2 for v in verdicts)
    assert len(engine.scenarios) == 2  # the two shifted baselines were made once, not once per plan
    assert len(engine.simulated) == 2 * 3


def test_the_fingerprint_ignores_prose_and_follows_the_actions() -> None:
    a, b = plan(), plan()
    b["summary"], b["title"] = "other words", "other title"
    assert plan_fingerprint(a) == plan_fingerprint(b)
    b["actions"][0]["expectedDurationMinutes"] = 5
    assert plan_fingerprint(a) != plan_fingerprint(b)
