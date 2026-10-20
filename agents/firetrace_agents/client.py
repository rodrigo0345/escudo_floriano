"""Thin, spec-shaped HTTP client for the FireTrace Coordination API.

Only the endpoints the agent runtime needs today:

* ``GET  /capabilities``
* ``GET  /simulations/{id}`` (+ polling helper)
* ``GET  /simulations/{id}/threatened``
* ``GET  /simulations/{id}/summary``
* ``GET  /vehicles``
* ``GET  /personnel-pools``
* ``POST /locations/{id}/area-stats``
* ``POST /plans`` (publish plans A and B)
* ``POST /plans/{id}/simulate`` (contract-conformance check on what-if runs)

Every request the client *sends with a body* is validated against the contract schema
first (see the AGENTS.md hard rule); every ``problem+json`` answer is raised with its
stable ``code`` so callers branch on ``code``, not on the human message.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx

from .contracts import validate_against_spec

log = logging.getLogger(__name__)

# The spec's server base is `/api/v1` (`servers[0].url`): the real backend answers 404 on unprefixed paths.
DEFAULT_BASE_URL = "http://localhost:8080/api/v1"


class ApiProblem(Exception):
    """The server answered ``application/problem+json``."""

    def __init__(self, status_code: int, problem: dict[str, Any]) -> None:
        self.status_code = status_code
        self.code = problem.get("code", "unknown")
        self.problem = problem
        super().__init__(f"HTTP {status_code} [{self.code}]: {problem.get('title') or problem.get('detail')}")


class NotReady(Exception):
    """A polled resource is not done yet (simulation still queued/running)."""


class FiretraceClient:
    def __init__(
        self,
        base_url: str | None = None,
        *,
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,
        validate_sent_payloads: bool = True,
    ) -> None:
        self._validate = validate_sent_payloads
        kwargs: dict[str, Any] = {"timeout": timeout}
        if transport is not None:  # httpx.MockTransport in tests; real backend in production
            kwargs["transport"] = transport
        # precedence: explicit argument > FIRETRACE_BASE_URL env > localhost:8080
        resolved = base_url or os.environ.get("FIRETRACE_BASE_URL") or DEFAULT_BASE_URL
        self._http = httpx.Client(base_url=resolved, **kwargs)

    # -- helpers ---------------------------------------------------------------
    def close(self) -> None:
        self._http.close()

    def _request(self, method: str, path: str, *, json_body: Any | None = None, params: dict[str, Any] | None = None) -> Any:
        response = self._http.request(method, path, json=json_body, params=params)
        if response.status_code >= 400:
            content_type = response.headers.get("content-type", "")
            if "application/problem+json" in content_type:
                raise ApiProblem(response.status_code, response.json())
            detail = response.text[:400]
            raise ApiProblem(response.status_code, {"code": "http_error", "title": detail})
        payload: Any = response.json()
        return payload

    def _fill(self, path: str, **values: Any) -> str:
        return path.format(**values)

    # -- capabilities ----------------------------------------------------------
    def get_capabilities(self) -> dict[str, Any]:
        """What the server *actually* supports right now (gates the agents' effects)."""
        return self._request("GET", "/capabilities")

    def get_rules(self) -> dict[str, Any]:
        """``GET /rules``: the backend's own numbers (safety distances, suppression, aerial limits)."""
        return self._request("GET", "/rules")

    # -- simulations -----------------------------------------------------------
    def get_simulation(self, simulation_id: str) -> dict[str, Any]:
        return self._request("GET", self._fill("/simulations/{simulationId}", simulationId=simulation_id))

    def wait_for_simulation(self, simulation_id: str, *, poll_seconds: float = 1.0, timeout_seconds: float = 120.0) -> dict[str, Any]:
        """Poll until the simulation is terminal and return it: ``succeeded``, ``failed`` or ``cancelled``.

        A failed or cancelled simulation is *returned*, not raised: the caller branches on ``status``
        (``error.code`` / ``error.message`` explain a failure) and the planning service keeps running.
        Only a timeout raises :class:`NotReady`.
        """
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            simulation = self.get_simulation(simulation_id)
            status = simulation.get("status")
            if status == "succeeded":
                return simulation
            if status in {"failed", "cancelled"}:
                error = simulation.get("error") or {}
                log.warning("simulation %s is %s: [%s] %s", simulation_id, status, error.get("code", "-"), error.get("title") or error.get("message", ""))
                return simulation
            time.sleep(poll_seconds)
        raise NotReady(f"simulation {simulation_id} not done within {timeout_seconds:.0f}s")

    def get_threatened(self, simulation_id: str, *, horizon_minutes: int = 60, t_min: int | None = None) -> dict[str, Any]:
        """What the fire threatens in the next ``horizon_minutes`` *from* ``t_min`` (minutes since ignition).

        Without ``t_min`` the server answers for the **end** of the simulation, when there is little
        left to threaten: pass the decision instant.
        """
        params: dict[str, Any] = {"horizonMin": horizon_minutes}
        if t_min is not None:
            params["tMin"] = t_min
        return self._request(
            "GET",
            self._fill("/simulations/{simulationId}/threatened", simulationId=simulation_id),
            params=params,
        )

    def get_vectors(self, simulation_id: str, *, t_min: int, window_minutes: int = 15) -> dict[str, Any]:
        """``GET /simulations/{id}/vectors``: where the fire front is at ``t_min`` and how it is spreading
        (a ``FeatureCollection`` of points with ``bearingDeg``, ``speedMmin``, ``intensityKwm``)."""
        return self._request(
            "GET",
            self._fill("/simulations/{simulationId}/vectors", simulationId=simulation_id),
            params={"tMin": t_min, "windowMin": window_minutes},
        )

    def get_summary(self, simulation_id: str, *, step_minutes: int = 15) -> dict[str, Any]:
        return self._request(
            "GET",
            self._fill("/simulations/{simulationId}/summary", simulationId=simulation_id),
            params={"step": step_minutes},
        )

    # -- resources -------------------------------------------------------------
    def list_vehicles(self, *, status: str | None = None, capability: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": limit}
        if status:
            params["status"] = status
        if capability:
            params["capability"] = capability
        page = self._request("GET", "/vehicles", params=params)
        items: list[dict[str, Any]] = list(page.get("items", []))
        cursor = page.get("nextCursor")
        while cursor:
            params["cursor"] = cursor
            page = self._request("GET", "/vehicles", params=params)
            items.extend(page.get("items", []))
            cursor = page.get("nextCursor")
        return items

    def list_organizations(self, org_type: str | None = None) -> list[dict[str, Any]]:
        """``GET /organizations`` (optionally of one ``type``, e.g. ``civil_protection``)."""
        params: dict[str, Any] = {"limit": 200}
        if org_type:
            params["type"] = org_type
        return list(self._request("GET", "/organizations", params=params).get("items", []))

    def list_personnel_pools(self) -> list[dict[str, Any]]:
        page = self._request("GET", "/personnel-pools")
        items: list[dict[str, Any]] = list(page.get("items", []))
        cursor = page.get("nextCursor")
        while cursor:
            page = self._request("GET", "/personnel-pools", params={"cursor": cursor})
            items.extend(page.get("items", []))
            cursor = page.get("nextCursor")
        return items

    def get_area_stats(self, location_id: str, geometry: dict[str, Any]) -> dict[str, Any]:
        if self._validate:
            validate_against_spec("AreaStatsRequest", {"geometry": geometry})
        return self._request(
            "POST",
            self._fill("/locations/{locationId}/area-stats", locationId=location_id),
            json_body={"geometry": geometry},
        )

    def route(self, request: dict[str, Any]) -> dict[str, Any]:
        """``POST /routing/route``: the ``Route`` of a vehicle (``found``, ``durationMin``, ``geometry``, ``blockedBy``, ``warnings``)."""
        if self._validate:
            validate_against_spec("RouteRequest", request)
        return self._request("POST", "/routing/route", json_body=request)

    def get_station(self, station_id: str) -> dict[str, Any]:
        """``GET /stations/{id}``: where a unit is based (``position``)."""
        return self._request("GET", self._fill("/stations/{stationId}", stationId=station_id))

    def get_location(self, location_id: str) -> dict[str, Any]:
        """``GET /locations/{id}``: bounds and the grid (size, cell size, north-west corner) every simulation of it uses."""
        return self._request("GET", self._fill("/locations/{locationId}", locationId=location_id))

    def list_buildings(self, location_id: str, *, limit: int = 20000) -> list[dict[str, Any]]:
        """``GET /locations/{id}/buildings``: one point per grid cell with its building count and estimated people."""
        page = self._request("GET", self._fill("/locations/{locationId}/buildings", locationId=location_id), params={"limit": limit})
        return list(page.get("features", []))

    def get_ignition_grid(self, simulation_id: str) -> bytes:
        """``GET /simulations/{id}/grids/ignition``: the raw int16 grid (minute the fire reaches each cell, -1 = never)."""
        response = self._http.get(self._fill("/simulations/{simulationId}/grids/ignition", simulationId=simulation_id))
        if response.status_code >= 400:
            content_type = response.headers.get("content-type", "")
            problem = response.json() if "application/problem+json" in content_type else {"code": "http_error", "title": response.text[:400]}
            raise ApiProblem(response.status_code, problem)
        return response.content

    # -- decisions -------------------------------------------------------------
    def create_plan(self, plan_input: dict[str, Any], *, prefer_wait: int | None = None) -> dict[str, Any]:
        """``POST /plans`` — publish a plan (variant ``A`` or ``B``), in ``proposed`` status."""
        if self._validate:
            validate_against_spec("PlanInput", plan_input)
        headers = {"Prefer": f"wait={prefer_wait}"} if prefer_wait else None
        response = self._http.post("/plans", json=plan_input, headers=headers)
        if response.status_code >= 400:
            content_type = response.headers.get("content-type", "")
            if "application/problem+json" in content_type:
                raise ApiProblem(response.status_code, response.json())
            raise ApiProblem(response.status_code, {"code": "http_error", "title": response.text[:400]})
        return response.json()

    def run_scenario(self, scenario: dict[str, Any], *, label: str, wait_seconds: int = 120, timeout_seconds: float = 600.0) -> dict[str, Any]:
        """``POST /simulations`` with an inline scenario (not stored as a scenario), waited for. Returns the terminal simulation:
        a failed one is returned too (see :meth:`wait_for_simulation`), so callers branch on ``status``."""
        if self._validate:
            validate_against_spec("ScenarioInput", scenario)
        response = self._http.post(
            "/simulations",
            json={"scenario": scenario, "label": label, "kind": "baseline"},
            headers={"Prefer": f"wait={wait_seconds}"},
        )
        if response.status_code >= 400:
            content_type = response.headers.get("content-type", "")
            if "application/problem+json" in content_type:
                raise ApiProblem(response.status_code, response.json())
            raise ApiProblem(response.status_code, {"code": "http_error", "title": response.text[:400]})
        simulation: dict[str, Any] = response.json()
        if simulation.get("status") in {"queued", "running"}:
            simulation = self.wait_for_simulation(simulation["id"], timeout_seconds=timeout_seconds)
        return simulation

    def list_simulations(self, *, kind: str | None = None, status: str | None = None, updated_after: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        """``GET /simulations`` (all pages): filter by ``kind``, ``status`` (comma list) and ``updatedAfter`` (RFC 3339)."""
        params: dict[str, Any] = {"limit": limit}
        if kind:
            params["kind"] = kind
        if status:
            params["status"] = status
        if updated_after:
            params["updatedAfter"] = updated_after
        page = self._request("GET", "/simulations", params=params)
        items: list[dict[str, Any]] = list(page.get("items", []))
        cursor = page.get("nextCursor")
        while cursor:
            params["cursor"] = cursor
            page = self._request("GET", "/simulations", params=params)
            items.extend(page.get("items", []))
            cursor = page.get("nextCursor")
        return items

    def get_perimeters(self, simulation_id: str, *, t_min: int) -> dict[str, Any]:
        """``GET /simulations/{id}/perimeters?tMin=``: the fire's outline at ``t_min`` (a ``FeatureCollection``)."""
        return self._request("GET", self._fill("/simulations/{simulationId}/perimeters", simulationId=simulation_id), params={"tMin": t_min})

    def validate_plan(self, plan_input: dict[str, Any]) -> dict[str, Any]:
        """``POST /plans/validate``: the backend's ``PlanValidation`` (``valid`` + ``issues[]`` with stable ``code``)."""
        if self._validate:
            validate_against_spec("PlanInput", plan_input)
        return self._request("POST", "/plans/validate", json_body=plan_input)

    def simulate_plan(self, plan_id: str, *, baseline_simulation_id: str | None = None, wait_seconds: int | None = 60) -> dict[str, Any]:
        """``POST /plans/{id}/simulate`` — the what-if run of a published plan."""
        body: dict[str, Any] = {"label": f"what-if {plan_id}"}
        if baseline_simulation_id:
            body["baselineSimulationId"] = baseline_simulation_id
        response = self._http.post(
            self._fill("/plans/{planId}/simulate", planId=plan_id),
            json=body,
            headers={"Prefer": f"wait={wait_seconds}"} if wait_seconds else None,
        )
        if response.status_code >= 400:
            content_type = response.headers.get("content-type", "")
            if "application/problem+json" in content_type:
                raise ApiProblem(response.status_code, response.json())
            raise ApiProblem(response.status_code, {"code": "http_error", "title": response.text[:400]})
        body_json: dict[str, Any] = response.json()
        return body_json

    def list_plans(self, simulation_id: str) -> list[dict[str, Any]]:
        page = self._request("GET", "/plans", params={"simulationId": simulation_id})
        items: list[dict[str, Any]] = list(page.get("items", []))
        cursor = page.get("nextCursor")
        while cursor:
            page = self._request("GET", "/plans", params={"simulationId": simulation_id, "cursor": cursor})
            items.extend(page.get("items", []))
            cursor = page.get("nextCursor")
        return items
