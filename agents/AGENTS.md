# Vertical Rules — `agents/` (Multi-Agent System / MAS Planning)

> **Seam Counterpart:** `backend/` (via `api-spec/openapi.json`)

## 1. "MAS Agents Propose; Physics & Validation Dispose"

Your Multi-Agent System (MAS) coordinates organizational agents (**Bombeiros**, **GNR**, **INEM**, **Proteção Civil**) to generate two candidate response plans (**Plan A** and **Plan B**, `variant: "A"` / `"B"`) for a baseline simulation (`simulationId`).

Instead of guessing whether an action is physically valid or whether it stops the fire, **use the backend's validation and simulation endpoints as the MAS environment feedback loop**:

1. **Query operational parameters (`GET /rules`):**
   Read the nested `Rules` schema in `api-spec/openapi.json` (or call `GET /rules` live) for movement speeds, water/refill rules, crew rates, aerial limits, safety clearances, and suppression effectiveness rather than hardcoding magic numbers in agent heuristics.
2. **Validate before publishing (`POST /dispatches/validate`, `POST /plans/validate`, `POST /routing/route`):**
   Before committing a plan via `POST /plans`, send it to `POST /plans/validate`. Inspect `ValidationIssue` in `api-spec/openapi.json` and `backend/src/FireTrace.Core/Services/Operations/PlanValidator.cs` (and `VehicleDispatcher.cs` / `PersonnelDispatcher.cs` for `POST /dispatches/validate`) for the exact `code` values emitted (`resource_conflict`, `smoke_unsafe`, `fuel_break_no_crew`, `fuel_break_slow`, `missing_safety`, `crew_range`, `responsibility_not_supported`, `not_enough_personnel`, `not_enough_equipment`, `dependency_cycle`, `outside_location`, etc.) so your MAS negotiation loop can branch on `issue.code` and resolve conflicts automatically.
3. **Evaluate counterfactual impact (`POST /plans/{planId}/simulate`):**
   Check `ActionType` and the `Action*` schemas in `api-spec/openapi.json` before constructing plan actions. After publishing Plan A and Plan B (`POST /plans`), trigger `POST /plans/{planId}/simulate` and compare the resulting `SimulationSummary` / `PlanSummary` schemas against the baseline simulation.

## 2. Polling & Error Resilience

- **Never hang on failed simulations:** When polling `GET /simulations/{id}`, always branch on `status` (`SimulationStatus`):
  - `queued` / `running` → keep polling (or pass header `Prefer: wait=30` on `POST`).
  - `succeeded` → read `/perimeters`, `/threatened`, `/road-status`, `/summary`.
  - `failed` / `cancelled` → log `error.code` + `error.message` and stop polling that simulation ID without crashing the MAS service.
