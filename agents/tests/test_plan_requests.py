"""The operator's plan requests: the watcher claims the oldest queued one, reports each step, and closes it with the plans or the reason."""
from __future__ import annotations

import json
from typing import Any

import httpx

from firetrace_agents.client import FiretraceClient
from firetrace_agents.watcher import Watcher, WatcherSettings


class _Backend:
    """Just the /plan-requests and /simulations/{id} endpoints, with the backend's own rules for claim and close."""

    def __init__(self, requests: list[dict[str, Any]]) -> None:
        self.requests = {r["id"]: r for r in requests}
        self.patches: list[tuple[str, dict[str, Any]]] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        if method == "GET" and path.endswith("/plan-requests"):
            wanted = set((request.url.params.get("status") or "").split(",")) - {""}
            return httpx.Response(200, json={"items": [r for r in self.requests.values() if not wanted or r["status"] in wanted], "nextCursor": None})
        if method == "POST" and path.endswith("/claim"):
            item = self.requests[path.split("/")[-2]]
            if item["status"] != "queued":
                return httpx.Response(409, json={"code": "plan_request_claimed", "title": "claimed"}, headers={"content-type": "application/problem+json"})
            item.update(status="planning", claimedBy=json.loads(request.content)["agent"])
            return httpx.Response(200, json=item)
        if method == "PATCH" and "/plan-requests/" in path:
            item, patch = self.requests[path.split("/")[-1]], json.loads(request.content)
            self.patches.append((item["id"], patch))
            item.update(patch)
            return httpx.Response(200, json=item)
        if method == "GET" and "/simulations/" in path:
            return httpx.Response(200, json={"id": path.split("/")[-1], "kind": "baseline", "status": "succeeded", "scenarioSnapshot": {"durationMinutes": 180}})
        return httpx.Response(404, json={"code": "not_found"}, headers={"content-type": "application/problem+json"})


class _Watcher(Watcher):
    """The planning itself is the orchestrator's (tested elsewhere): here it reports two steps and publishes, or fails."""

    def __init__(self, client: FiretraceClient, published: dict[str, str]) -> None:
        super().__init__(client, orchestrator=None, settings=WatcherSettings(revise_selected=False, agent_name="agents@test"))  # type: ignore[arg-type]
        self.published = published
        self.asked: list[tuple[str, int | None]] = []

    def _publish(self, simulation, *, at_minute=None, progress=lambda *_: None, metadata=None):  # type: ignore[override]
        self.asked.append((simulation["id"], at_minute))
        progress("composing", 10, "A compor o plano A")
        progress("publishing", 75, "A publicar")
        return dict(self.published), ([] if self.published else ["nenhum dos dois se mostrou seguro"])

    def _simulate(self, baseline_id, published, progress=lambda *_: None):  # type: ignore[override]
        progress("simulating", 90, "What-if do plano A")


def _client(backend: _Backend) -> FiretraceClient:
    return FiretraceClient(base_url="mock://firetrace/api/v1", transport=httpx.MockTransport(backend.handle))


def test_the_oldest_queued_request_is_claimed_reported_and_closed_with_its_plans() -> None:
    backend = _Backend([
        {"id": "preq-2", "simulationId": "sim-2", "status": "queued", "createdAt": "2026-10-21T10:05:00Z"},
        {"id": "preq-1", "simulationId": "sim-1", "status": "queued", "createdAt": "2026-10-21T10:00:00Z", "atMinute": 45, "note": "defender Sande"},
    ])
    watcher = _Watcher(_client(backend), {"A": "pla-a", "B": "pla-b"})

    assert watcher.serve_requests() == "sim-1"
    assert watcher.asked == [("sim-1", 45)]  # the operator's minute, not the service's
    done = backend.requests["preq-1"]
    assert done["status"] == "done" and done["planIds"] == ["pla-a", "pla-b"] and done["claimedBy"] == "agents@test"
    phases = [p["progress"]["phase"] for rid, p in backend.patches if rid == "preq-1"]
    assert phases == ["composing", "publishing", "simulating", "simulating", "done"]
    assert backend.requests["preq-2"]["status"] == "queued"  # one per poll
    assert "sim-1" in watcher.handled  # the automatic poll will not plan it again


def test_a_request_with_no_safe_plan_fails_with_the_reason() -> None:
    backend = _Backend([{"id": "preq-1", "simulationId": "sim-1", "status": "queued", "createdAt": "2026-10-21T10:00:00Z"}])
    _Watcher(_client(backend), {}).serve_requests()
    failed = backend.requests["preq-1"]
    assert failed["status"] == "failed" and "seguro" in failed["error"]


def test_a_request_left_open_by_this_agent_before_a_restart_is_closed() -> None:
    backend = _Backend([
        {"id": "preq-old", "simulationId": "sim-1", "status": "planning", "claimedBy": "agents@test"},
        {"id": "preq-other", "simulationId": "sim-2", "status": "planning", "claimedBy": "someone-else"},
    ])
    assert _Watcher(_client(backend), {"A": "pla-a"}).serve_requests() is None
    assert backend.requests["preq-old"]["status"] == "failed"
    assert backend.requests["preq-other"]["status"] == "planning"
