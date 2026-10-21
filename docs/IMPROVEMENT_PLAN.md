# FireTrace — Improvement Plan (audit of 2026-10-20)

> **Goal of every task below:** one authoritative loop of data
> **Scenario (incl. dynamic weather) → Backend + fire engine → Agents propose A/B → Operator decides → Backend simulates the operation (fire *and* units on roads) → Frontend renders only what the backend says → feedback into the next decision.**
>
> The tool is for Bombeiros, GNR and Proteção Civil to **train** and to **support decisions** in a real incident. That means: every number on screen must come from the backend, every vehicle must move on a real road, and the operator must always know *which* fire, *which* plan and *which* minute they are looking at.

Submission is **23 Oct 2026, 16:30 UTC** (3 days). Tasks are tagged **P0** (needed for a coherent demo), **P1** (next), **P2** (after the hackathon). Each task names its vertical so it can be handed to that teammate's agent. Contract changes follow `PROTOCOL.md` §1 (proposal first, then lockstep).

---

## Status update — 2026-10-21 (post-#17 merge)

`main` is now `8dff00a` (PR #17 merged). The original audit was accurate on 20 Oct, but a large part of the P0 work landed in the following 24 hours. This file is now a **backlog with status**, not a day-by-day schedule.

- **Landed:** A1 (agents compose service + watcher), A5 (dead scenario file removed), B1/B2/B4/B5 and the vehicle half of B3, F1 (agent travel time via `/routing/route`), D1 (gusts, rain, cloud cover), E2–E5/E7/E8 (3D wind/sky/clouds/rain and the weather panel/HUD), and A8 partly (service titles no longer `[lab]`; plans carry `variant`/`strategy`/`alertLevel`).
- **Landed on 2026-10-21 (Task 2):** Rothermel surface fire + dynamic fuel moisture/weather/terrain is integrated as commit `db782b9` on `integrate/native-physics-weather` (cherry-pick of `2defb3a`; `835cc0d` explicitly excluded). `dotnet test` passes 210/210 against PostgreSQL.
- **Landed on 2026-10-21 (Task 3):** A3 (select → activate → complete, per-organization action grouping, visible rationale/status), A4 (persistent scenario · base/plan · simulation id · T+min chip), A2 (browser planner deleted), C1 (`OperationSimulator`), C2 (`GET /units` + `/units/{unitId}/track`), C4 (map reads backend `/units` + per-minute tracks), and G3 as the read-only comparison card. C1/C2 produce deterministic sampled tracks; fire coupling (C3) and live mode (C5) remain open.
- **Partly landed:** B3 (vehicles use server ETAs; personnel pools and the unknown-origin fallback still trust `etaMinutes`), D2 (rain wetting and cloud→solar are in; gusts are still unused by the fire model; no explicit rain-extinction threshold), E1 (weather event chips + preview; not a full keyframe editor for all nine events), E6 (procedural lightning; no storm-cell path/outflow), G3 (comparison table done; split-screen/swipe is P1).
- **Still open:** A6/A7, B6/B7/B8, C3/C5, D3/D4, F2–F9, G1/G2/G4–G8, H1–H5, I1–I4.
- **Capability note (C2):** the `Capabilities` schema has no `units` flag, so there is nothing to "flip"; the endpoints are implemented and are discoverable by path. Adding a flag would require a spec PR.
- **Corrected execution order (A2 vs A3):** the original plan was inverted. A3/A4 had to land **before** A2. `frontend/src/usecases/dispatchDemo.ts:223-240` was the only caller of `plansApi.select`/`plansApi.activate`; deleting the browser planner first would have left the operator unable to approve a plan. The order actually executed was A3/A4 → C1 → C2 → C4 → A2 → G3.
- **Audit findings status:** R5 is mostly resolved (server routing/ETAs and plan validation are in); R6–R10 are **outdated** — they describe the 20 Oct state before the agent service, weather pipeline, atmosphere and tab cleanup landed. Treat them as history, not as current defects.
- **Contract deviation (B7):** B7 was marked P0 but never landed. `api-spec/openapi.json`'s `Route` schema (line 11704) has no `access/parkAt/walk*`, and the codes `no_road_access`, `route_off_network` and `target_unreachable` are emitted by the backend but not documented in the spec. This must be a spec PR before the UI can show the park/walk leg.
- **Physics task (#18):** the Rothermel work is commit `2defb3a`; the ELMFIRE runner optimisation is `835cc0d`. Only `2defb3a` is in scope for the demo. Do not merge the `engine-not-tested` tip.

---

## 1. What the audit found (root causes, not symptoms)

> **Historical note (2026-10-21):** R1–R5 have been fixed or mostly fixed by A2/A3/A4/C1/C2/C4/B1/B2/B4. R6–R10 describe the 20 Oct state and are **outdated**; keep them as history, not as a current defect list.

| # | Problem | Evidence |
|---|---|---|
| R1 | **Two planners that don't know about each other.** The "Operação" tab still runs the 737-line client-side `DispatchPlanner` and publishes a plan tagged `demo`; the "Planos" tab lists agent plans. Demo plans still mix with A/B. | `frontend/src/domain/dispatchPlanner.ts`, `frontend/src/usecases/dispatchDemo.ts:65-73,180`, `PlansPanel.tsx` |
| R2 | **The "Operação" tab silently replaces the fire on screen.** It re-runs the baseline itself, so the Planos and Incidente tabs point at a different simulation. | `dispatchDemo.ts:65-73` |
| R3 | **Two "simulation" entry points with different semantics.** Incidente → "Simular com outra meteorologia" and Operação → "Planear despacho" (baseline re-run + plan). Neither links to the other or to Planos. | `IncidentPanel.tsx`, `SimulationForm.tsx`, `DemoPanel.tsx` |
| R4 | **Movement authority used to live in the browser.** Unit positions were computed client-side; the backend now produces tracks and `GET /simulations/{id}/units` + `/units/{unitId}/track` serve them. **Resolved by C1/C2/C4.** | `OperationSimulator.cs`, `SimulationResultsController.cs`, `frontend/src/hooks/useUnitsSync.ts` |
| R5 | **Roads are now mostly mandatory in the backend — but not in the contract.** `RoutingService` enforces `MaxSnapM` and the walk leg, `DispatchService`/`PlanRouter` prefer the server route, and `PlanValidator` checks it. Residual: `PlanInterventions` still trusts `etaMinutes` for personnel pools and when the vehicle origin is unknown; `RoadGraph.AccessTimes` still snaps without a bound. **Mostly resolved; the contract packet (B7) is still missing.** | `RoutingService.cs:44-51`, `PlanRouter.cs:24-27`, `PlanValidator.cs:198-200`, `PlanInterventions.cs:84,112,133`, `RoadGraph.cs:55-65,96-105` |
| R6 | **Agents are a service and travel by road, but are still only firefighters.** No GNR (closures/traffic/evacuation corridors), INEM (medical/triage) or Proteção Civil (evacuation/shelters/command) agent; no water/fatigue in agent reasoning. | `agents/firetrace_agents/*`, `docker-compose.yaml:94-111`, `agents/README.md` limits |
| R7 | **Weather is much more capable in the backend than the UI exposes.** The UI now has event chips (rain, storm, clouds, wind shift, wind scale, heat/dry) and a preview; it is not yet a full time-axis keyframe editor for all nine backend events. | `WeatherTimeline.cs`, `SimulationForm.tsx`, `simulationForm.ts` |
| R8 | **Real weather has gusts/rain/clouds but still no spatial weather.** Open-Meteo now fetches `wind_gusts_10m`, `precipitation`, `cloud_cover`; `visibility`, `cape` and `is_day` are not fetched. Weather is still one point for the whole map; there is no moving storm cell. | `OpenMeteoSource.cs:47`, `CapabilityCatalog.cs:15-23` |
| R9 | **The 3D scene now has dynamic atmosphere.** Sun position, day/night, sky colour, fog/visibility, clouds, rain and lightning exist; storm cells with a path/outflow are still missing. | `sceneEngine.ts:157-309`, `world.ts:48-49`, `rainLayer.ts`, `cloudLayer.ts` |
| R10 | **Frontend UX is still tab soup.** 7 top tabs remain; the Meteo tab is now useful; Incidente still mixes live stats with a scenario editor; no frontend tests. `api/scenarios/operationalIncidentScenario.ts` is already gone (A5 done). | `TopBar.tsx:9-16`, `frontend/package.json` (no test script) |

---

## 2. Target architecture (what "flawless streamline" means)

```
                ┌───────────── Frontend (renders, edits, decides — never computes physics) ─────────────┐
 Scenario editor│ ignition · start · duration · WEATHER TIMELINE (keyframes, events, storm cells)         │
                └──────┬──────────────────────────────────────────────────────────────▲──────────────┘
                       │ POST /scenarios, POST /simulations                            │ GET /simulations/{id}/*
                       ▼                                                               │  (perimeters, weather,
                ┌──────────── Backend (single source of truth) ────────────┐           │   units, tracks, smoke)
                │ WeatherTimeline → Engine (native / ELMFIRE)              │───────────┘
                │ RoutingService = the ONLY mover of ground vehicles       │
                │ OperationSimulator → /units, /units/{id}/track           │◄─── POST /plans (A, B)
                └──────┬───────────────────────────────────────────────────┘          ▲
                       │ new baseline succeeded (poll ?updatedAfter=)                  │
                       ▼                                                               │
                ┌──────────── Agents service (docker) ─────────────────────┐           │
                │ Bombeiros · GNR · INEM · Proteção Civil · Orchestrator   │───────────┘
                │ use /routing/route for every ETA, /plans/validate,       │
                │ /plans/{id}/simulate to choose                           │
                └──────────────────────────────────────────────────────────┘
```

Rules this implies:
1. **Only the backend moves ground vehicles**, and only along `RoutingService` routes.
2. **Only agents (or the operator, editing an agent plan) create plans.** The frontend has no planner.
3. **One baseline in focus at a time**, owned by one store field; every panel reads it.
4. **Weather is a timeline the operator edits**, previews, and sees on the map.

---

## 3. Task breakdown

Legend: **[BE]** backend · **[FE]** frontend · **[AG]** agents · **[EN]** engine · **[SPEC]** contract proposal (needs approval before code).

### Epic A — One operation pipeline (fixes R1, R2, R3)

> **Order correction (2026-10-21): A3/A4 before A2.** `dispatchDemo.ts:223-240` is the only frontend caller of `plansApi.select`/`activate`; `PlansPanel.tsx` has no execution controls. Add the new response flow first, then delete the browser planner.

| ID | Pri | Vertical | Task | Done when |
|---|---|---|---|---|
| A1 ✅ | P0 | [AG] | **Agents as a service.** `agents/Dockerfile` + the `agents` service in `docker-compose.yaml` run `watcher.py`; it polls baselines, skips ones with plans, publishes A/B and requests both what-ifs. | A baseline started from the UI has A and B plans and their what-if runs with no terminal involved. **Landed** (`docker-compose.yaml:94-111`, `agents/firetrace_agents/watcher.py`). |
| A2 ✅ | P0 | [FE] | **Remove the client-side planner.** Delete `domain/dispatchPlanner.ts`, `usecases/dispatchDemo.ts`, `store/demoStore.ts`, `hooks/useDemoSync.ts`, `components/demo/`. Before deleting, record the features agents lack (water cycles, refuel retreat, air limits by daylight/wind, standoff retries) as input to Epic F. | `grep -r DispatchPlanner frontend/src` is empty; build passes; `PlansPanel` can select/activate/complete a plan and `/units` drives the map. **Landed:** files deleted, `Operação` tab removed, map uses backend tracks. |
| A3 ✅ | P0 | [FE] | **Merge "Planos" and "Operação" into one "Resposta" flow** for the baseline in focus: plans A/B with status; side-by-side metrics vs baseline; "Ver no mapa" A/B/base at the same minute; "Selecionar" → "Ativar" → "Encerrar"; per-action list grouped by organization with rationale visible. | Planos and Operação tabs are gone; one panel drives the decision. **Landed:** status tags, select/activate/complete, organization groups, visible rationale and action status. |
| A4 ✅ | P0 | [FE] | **Single focus model.** One store field `focus: { baselineId, shown: 'base' \| planId }`. Nothing re-runs a baseline behind the operator's back. Persistent header chip: *Cenário · base/plano A/B · simulation id · T+min*. | Switching tabs never changes the fire on screen; the chip always tells the truth. **Landed:** the existing `baseSimulationId`/`activePlan` state drives the chip; no separate `focus` field was introduced. |
| A5 ✅ | P0 | [FE] | Delete `api/scenarios/operationalIncidentScenario.ts` (UNWIRED, buggy). | File gone. **Landed.** |
| A6 | P1 | [FE] | **Operator edits a plan** instead of building one: remove/add a vehicle, move a target, change a trigger time → `PATCH /plans/{id}` (merge-patch) → `POST /plans/validate` → re-simulate. | An edited plan B′ appears next to A/B with its own what-if. |
| A7 | P1 | [SPEC]+[BE]+[AG] | Optional: **"Pedir planos" button.** Needs a way for the UI to request plans (e.g. `POST /simulations/{id}/plan-requests` that the agents watcher consumes, with status). Until then A1's watcher is enough. | Proposal approved or rejected. |
| A8 ◐ | P1 | [AG] | Tag/label hygiene: agents stop titling with `[lab]` in service mode; plans carry `variant`, `strategy`, `alertLevel` and an `objective` the UI can show as "A: vidas primeiro / B: área ardida". | Plans read well in the UI without decoding. **Partial:** service titles and variant/strategy/alertLevel exist; check the objective text. |

### Epic B — Roads are mandatory, enforced by the backend (fixes R5)

> **Contract gap (2026-10-21): B7 did not land.** `RoutingService` already returns `no_road_access` and `ArrivalEstimator` returns `target_unreachable`/`route_off_network`, and `RouteAccess` carries the origin/target walk metres internally, but `api-spec/openapi.json`'s `Route` schema still has no `access`, `parkAt`, `snapDistanceM`, `walkM` or `walkMinutes`, and the new codes are undocumented. The UI cannot show the park/walk leg until a spec PR lands.

| ID | Pri | Vertical | Task | Done when |
|---|---|---|---|---|
| B1 ✅ | P0 | [BE] | **Max snap distance.** `RoutingService` rejects (`no_road_access`) when origin/target is farther than `Routing.MaxSnapM` (500 m in settings) and adds a warning above a lower threshold. | A target 2 km from any road gives `found:false` + reason. **Landed** (`RoutingService.cs:44-51`, `appsettings.json:335`). `RoadGraph.Snap` itself is still unbounded; only `/routing/access` still uses it without a pre-check. |
| B2 ◐ | P0 | [BE] | **Last-mile leg.** The route returns the parking point and the on-foot distance/time to the target (walking speed from `Rules`). The crew's effect starts at *drive + walk* time. | `RouteAccess` + `ArrivalEstimator.EstimateAsync` use the sum; **internal only**, not exposed in the API (B7). |
| B3 ◐ | P0 | [BE] | **Backend computes ETAs, never trusts them.** In `PlanInterventions.CrewAsync/LineAsync` and `DispatchService`, compute ETA with `RoutingService` from the vehicle's station/position at the trigger time; only compare client `etaMinutes`. No ETA ⇒ unreachable ⇒ no effect, never 0. | Removing `etaMinutes` does not make crews appear at T+0. **Vehicles done** (`PlanRouter`, `ArrivalEstimator`); personnel pools and the unknown-origin fallback still use `r.EtaMinutes` (`PlanInterventions.cs:84,112,133`). |
| B4 ✅ | P0 | [BE] | **Validate routes in plans and dispatches.** `DispatchService` does not prefer `input.Route` blindly; `PlanValidator` checks every ground resource is routable at its trigger time (closures + predicted fire + vehicle profile) and emits `target_unreachable` / `route_off_network`. | A hand-drawn straight-line route fails validation. **Landed** (`DispatchService.cs:46,73-74`, `PlanValidator.cs:198-200`). |
| B5 ✅ | P1 | [BE] | **Vehicle state is road-constrained.** `PATCH /vehicles/{id}/state` snaps ground-vehicle positions to the network (or rejects beyond `MaxSnapM`) unless `source=gps` explicitly. | A ground vehicle cannot be placed in a field via the API. **Landed** (`VehicleStateService.cs:14-25`, `PositionToleranceM=100`). |
| B6 | P1 | [BE] | Re-route on change: when a road closure is created or the fire cuts a road on an active route, recompute affected active dispatches' routes and ETAs (and log it). | Closing a road mid-operation reroutes units on the next tick. |
| B7 ❌ | P0 | [SPEC] | Contract packet for B1/B2: `RoutePlan.access { parkAt: LatLon, snapDistanceM, walkM, walkMinutes }`, new issue codes `no_road_access`, `route_off_network`. | **Not landed.** `Route` schema at `openapi.json:11704` has none of these; codes absent. Must be a spec PR before the UI consumes them. |
| B8 | P1 | [BE] | `RoadCutsCache` key includes road-network version (agents README proposal 5). | No 500 on `/threatened` after re-ingest. |

### Epic C — Server-side operation simulation (fixes R4; the keystone for B and the frontend)

> **Dependency correction (2026-10-21): C2 is blocked by C1.** There is no `OperationSimulator` in the backend, so the `/units` endpoints cannot be implemented as a controller wrapper. C4 is blocked by C2. Do C1 → C2 → C4, then C3/C5.

| ID | Pri | Vertical | Task | Done when |
|---|---|---|---|---|
| C1 ✅ | P0 | [BE] | **`OperationSimulator`** in `Services/Operations/`: given a plan (or active dispatches) and the what-if fire run, step every unit minute by minute — order → drive (route geometry from `RoutingService`) → park/walk → work → refill at nearest reachable water point (`/water-points/near` logic) → refuel → rest (`Rules.crews.maxContinuousWorkMinutes`) → return. Port the useful behaviour of the deleted `DispatchPlanner` here. | Deterministic tracks for every unit of a plan's what-if. **Landed:** water/refill/rest cycles and deterministic seeded tracks; static water-point discovery and fire coupling remain for C3. |
| C2 ✅ | P0 | [BE] | **Implement `GET /simulations/{simulationId}/units` and `/units/{unitId}/track`** (already in the spec) from C1 output; flip the `units` capability to supported. Contract params are `tMin` for `/units` and `stepMin` for `/track`, not `?time=`. | Endpoints return data; `dotnet test` passes contract tests. **Landed:** both endpoints implemented. There is no `units` flag in `Capabilities`; do not invent one without a spec PR. |
| C3 | P0 | [BE] | Couple C1 with the fire: crew effect windows (`CrewWorkSchedule`) come from the *actual* simulated arrival/refill windows, and a unit whose route is cut by fire is delayed or rerouted. Crew exposures (`crewExposures`) use real positions. | What-if fire and unit tracks agree with each other. |
| C4 ✅ | P0 | [FE] | **Render units from the backend.** `unitLayer.ts` reads `/units` + `/track`; road-following interpolation uses the track geometry. Remove any client position math. | Units on the map are exactly what the API returns. **Landed:** `useUnitsSync` loads metadata + one-minute tracks; the layer interpolates only between backend samples. The spec exposes positions, not route geometry, so interpolation is linear between samples. |
| C5 | P1 | [BE] | Live mode: when a plan is active, the backend (not the browser) advances dispatch status and vehicle state from C1 against wall clock or exercise clock (see Epic H). Delete the browser "writer" (`createWriter`). | Closing the browser does not stop or corrupt an exercise. |

### Epic D — Dynamic weather in the backend (fixes R8)

| ID | Pri | Vertical | Task | Done when |
|---|---|---|---|---|
| D1 ◐ | P0 | [BE] | **Fetch more from Open-Meteo:** `wind_gusts_10m`, `precipitation`, `cloud_cover` are in; `visibility`, `cape`, `is_day` are not. Store in cache, expose in `WeatherSample` (`gustKmh`, `precipitationMmH`, `cloudCoverPct` already exist). | `/simulations/{id}/weather` shows rain/clouds for a rainy historical date. **Partial** (`OpenMeteoSource.cs:47`). |
| D2 ◐ | P1 | [BE]+[EN] | Use what we fetch: precipitation → fuel moisture (landed: `DeadFuelMoisture` wetting), cloud cover → solar term (landed: `SolarRadiation.Wm2`), gusts in spotting (not used; `CapabilityCatalog` still says informational), and an explicit wet-fuel extinction threshold (not implemented). Mark each in `/capabilities` honestly. | Capability notes match behaviour. **Partial.** |
| D3 | P1 | [SPEC]+[BE] | **Storm cells (spatial weather).** New event `storm_cell { path: LineString, speedKmh, radiusM, start/end, outflowWindKmh, gustKmh, precipitationMmH, lightningPerMin }`. Backend turns it into per-member `wind_<m>.f32` grids (the engine seam already accepts them) + local precipitation. Expose `GET /simulations/{id}/weather/field?tMin=` (wind u/v + precip grid, coarse) for rendering. | A thunderstorm crossing the map visibly bends the fire and wets it locally. |
| D4 | P2 | [SPEC]+[BE] | **Dry lightning ignitions:** optional `lightningIgnitions: true` on a storm cell → new ignitions with probability by fuel moisture, listed in the simulation. Great for training. | New fires appear under a dry storm, deterministic by seed. |
| D5 ◐ | P1 | [BE] | `POST /weather/resolve` returns the effective series in one call so the UI preview equals what the engine will see (already close; it returns `samples` + `warnings`, not an echo of the event list). Verify with keyframes + all events. | Preview and run are byte-identical in weather. **Partial.** |

### Epic E — Dynamic weather & visual weather in the frontend (fixes R7, R9)

| ID | Pri | Vertical | Task | Done when |
|---|---|---|---|---|
| E1 ◐ | P0 | [FE] | **Weather timeline editor** (replaces the 4 sliders): a time axis over the scenario with draggable **keyframes** (wind speed, direction, gust, humidity, temp, rain) and **event chips** for every backend event. Base = "real for the date" or "manual". Every edit calls `POST /weather/resolve` and redraws the chart. | Operator builds "NW 20 km/h, front at T+90 swings to SW 45 km/h with rain at T+120" without typing JSON. **Partial:** range event chips for rain/storm/clouds/wind_shift/wind_scale/heat_dry + preview exist; no full keyframe editor for all nine events. |
| E2 ✅ | P0 | [FE] | **Wind on the map:** animated wind particles/streamlines over the terrain following `windFromDeg` (FROM) and speed; gusts as pulses. | Wind direction is readable at a glance in 3D. **Landed** (`windLayer.ts`). |
| E3 ✅ | P0 | [FE] | **Sky & atmosphere driven by weather + time:** sun position from date/time/location (day/night, dusk), sky colour and fog density from `cloudCoverPct`/`visibility`/smoke, lights dimmed under overcast. | Night looks like night; overcast looks overcast. **Landed** (`sceneEngine.ts:157-309`). |
| E4 ✅ | P0 | [FE] | **Clouds:** instanced billboard/volume cloud layer whose coverage = `cloudCoverPct`, moving with the wind at altitude. | Coverage visibly changes along the playback. **Landed** (`cloudLayer.ts`). |
| E5 ✅ | P1 | [FE] | **Rain:** GPU particle rain (density from `precipitationMmH`), wet-terrain darkening, reduced visibility; snow not needed. | Rain starts/stops when the series says so. **Landed** (`rainLayer.ts`, `terrainMesh` wet sheen). |
| E6 ◐ | P1 | [FE] | **Storms:** cumulonimbus cell mesh following the storm path (D3), lightning flashes (`lightningPerMin`), outflow gust ring, optional thunder audio toggle. | A storm cell crosses the map in sync with the fire's reaction. **Partial:** procedural lightning exists; no D3 storm path/outflow. |
| E7 ✅ | P1 | [FE] | Meteo tab becomes useful: current conditions card + full chart with gusts/rain/cloud bands + **fire-weather indicators** (30-30-30 rule), fine-fuel moisture. | Operator sees *why* the fire is accelerating. **Landed** (`WeatherPanel.tsx`). |
| E8 ✅ | P1 | [FE] | Weather HUD: rain, clouds, visibility, day/night, and an "upcoming change in N min" alert from the series. | HUD warns before the wind shift. **Landed** (`WeatherHud.tsx`). |

### Epic F — Agents grow up (fixes R6)

| ID | Pri | Vertical | Task | Done when |
|---|---|---|---|---|
| F1 ✅ | P0 | [AG] | **Travel time for every ground unit** via `POST /routing/route` (vehicle profile, `simulationId`, `avoid.predictedFire`); trigger + ETA drive when the action starts. Unreachable units are not assigned. (Until B3 lands the backend still trusts this ETA, so it must be right.) | README "whole fleet on site" limit removed. **Landed** (`agents/firetrace_agents/routing.py` / `plan.py`; see PR #13 / `c15740c`). |
| F2 | P0 | [AG] | **GNR agent:** road closures on roads the fire cuts within the horizon (`/simulations/{id}/road-status`), traffic-control points at closure ends, keep evacuation corridors open (`keep_access_routes`). | Plans contain GNR actions with reasons. |
| F3 | P1 | [AG] | **Proteção Civil agent:** owns evacuation vs shelter-in-place (move `life.py` decisions here), assigns transport (buses), opens shelters, establishes the command post (`establish_command_post`). | Evacuations have transport, route and destination. |
| F4 | P1 | [AG] | **INEM agent:** medical standby near the most exposed crews/places; reacts to `crewExposures` from the what-if. | Medical actions exist and move with exposure. |
| F5 | P1 | [AG] | **Water & fatigue** in agent reasoning (refill points reachable by road, work/rest windows from `/rules`). Port from the deleted frontend planner (A2 list). | Assignments respect duty cycles. |
| F6 | P1 | [AG] | **Choose with the engine:** generate N candidate plans, simulate each (`/plans/{id}/simulate`), publish the best two by objective (A lives, B area). Report deltas in the plan `summary`. | A/B are the best of N, not first guesses. |
| F7 | P1 | [AG] | **Robustness by default:** evaluate each candidate on a perturbed weather ensemble (wrong-forecast wind shift, `scripts/robustness.py` logic) and say so in `rationale`. | Plans carry "robust to ±30° wind" type statements. |
| F8 | P2 | [AG] | **Conditional triggers:** actions with `trigger` on fire reaching an area / wind change instead of only `at_time`. | Plans express "if the fire crosses the N-101, close…". |
| F9 | P2 | [AG] | Campaign mode wired to live operations: every stage re-plans from the active plan's state (`/locations/{id}/deployment`) and proposes `PATCH /plans/{id}`. | Rolling re-plan visible in the UI as plan revisions. |

### Epic G — Frontend gets better (fixes R10)

| ID | Pri | Vertical | Task | Done when |
|---|---|---|---|---|
| G1 | P0 | [FE] | **New navigation = the workflow:** `Cenário → Simulação → Resposta → Execução → Revisão` stepper (left), map always centre, contextual right drawer. Roads/Meios/Meteo become **map layers + drawers**, not top tabs. Recursos stays as an admin view. | ≤ 5 top-level entries; a first-time user follows the steps. |
| G2 | P0 | [FE] | **Scenario editor** (Cenário step): pick location, click ignition(s), start, duration, weather timeline (E1), ensemble size; save as scenario (`POST /scenarios`) so agents and colleagues see the same thing. | Custom scenarios are saved, not "custom" throwaways. |
| G3 ◐ | P0 | [FE] | **Comparison view:** split-screen or swipe between base / A / B at the same minute + delta table (area, crown fire, buildings, population, crew exposures, roads cut). | Decision in one screen. **Landed as the read-only comparison card** in `PlansPanel` (base/A/B metrics + deltas); split-screen is the remaining P1 part. |
| G4 | P1 | [FE] | **Timeline events on the playback bar:** markers for weather events, action triggers, unit arrivals, roads cut, places threatened; click to jump. | The operator can scrub to "what happens at the wind shift". |
| G5 | P1 | [FE] | **Per-organization view** (filter by Bombeiros / GNR / INEM / PC): each org sees its actions, units and status, can report progress (`PATCH /plans/{id}/actions/{actionId}`). | Matches AGENTS.md step 4 of "what the system does". |
| G6 | P1 | [FE] | Capability gating everywhere (`/capabilities`): unsupported weather fields/events/interventions disabled with the note as tooltip. | No `422 unsupported_capability` reachable from the UI. |
| G7 | P1 | [FE] | Error/empty states: failed simulation shows `error.code`/`detail`, "agents still working", "no plans yet", without blank panels. | No silent empty panel. |
| G8 | P1 | [FE] | Smoke-test suite (Playwright against Prism mock: `npx @stoplight/prism-cli mock api-spec/openapi.json`) for the 5 workflow steps. | CI runs it. |

### Epic H — Training & decision-support features (what makes it a real tool)

| ID | Pri | Vertical | Task | Done when |
|---|---|---|---|---|
| H1 | P1 | [SPEC]+[BE]+[FE] | **Exercise mode:** an exercise clock (pause/resume/speed) owned by the backend; trainer and trainees see the same minute. | Two browsers stay in sync. |
| H2 | P1 | [SPEC]+[BE]+[FE] | **Injects:** trainer adds events during an exercise (wind shift, new ignition, road blocked, vehicle breakdown, crew casualty) that re-run the forecast from "now". Needs exact resume (agents README proposal 6). | A wind-shift inject changes the fire and triggers re-planning. |
| H3 | P1 | [BE]+[FE] | **After-action review:** event log of decisions vs outcome (who ordered what, when, predicted vs simulated), exportable. | A PDF/JSON debrief per exercise. |
| H4 | P2 | [BE] | **Roles & organizations:** auth with org scope (GNR sees/acts on GNR actions), audit trail. | Actions are attributable. |
| H5 | P2 | [BE]+[FE] | **Real incident mode:** ingest live weather (forecast) and GPS positions (`source=gps`, B5) to run the same loop on a real fire. | Same UI, live data. |

### Epic I — Quality gates that keep the loop flawless

| ID | Pri | Vertical | Task | Done when |
|---|---|---|---|---|
| I1 | P0 | all | **End-to-end smoke script** (`scripts/e2e.ps1`): compose up → create scenario with a front passage → baseline → agents publish A/B → what-ifs → `/units` tracks all on roads (every track point within N m of a road edge). | One command proves the whole loop. |
| I2 | P1 | [FE] | Regenerate `src/api/schema.ts` in CI and fail on diff. | No contract drift in the UI. |
| I3 | P1 | [AG] | Run agent tests against Prism mock in CI, plus one live run in the e2e script. | Agents can't silently break on a contract change. |
| I4 | P1 | [BE] | Property test: every route geometry point lies on the network; every unit track point of a ground vehicle lies on the network or within the walk leg. | Road rule is tested, not hoped. |

---

## 4. Suggested order from 2026-10-21 (Task 2 + Task 3; Task 1 stays out)

The old "Day 1 / Day 2 / Day 3" schedule is obsolete: Day 1 already happened. The remaining work splits into two parallel tracks.

**Task 2 — physics / weather / fuels / terrain (issue #18):**

1. ✅ Branch `integrate/native-physics-weather` from `main` (`8dff00a`); **cherry-pick only `2defb3a`** (landed as `db782b9`).
2. ✅ Resolve the conflicts by keeping the newer weather pipeline (PR #14/#15/#17) and adding the Rothermel surface-fire model + fuel catalog.
3. ✅ Verify `DeadFuelMoisture` → `RothermelSurfaceFire` in the native engine; `dotnet test` in `backend/` passes 210/210 against PostgreSQL.
4. ✅ Do **not** cherry-pick `835cc0d` (ELMFIRE runner optimisation). Task 1 stays out.

**Task 3 — EPIC plans (frontend A3/A4 → backend C1/C2/C4 → A2/G3):**

1. ✅ **A3/A4 first** (frontend): select/activate/complete in `PlansPanel`, actions grouped by organization, visible rationale, and the persistent focus chip.
2. ✅ **C1** (backend): `OperationSimulator` producing deterministic unit tracks from a plan.
3. ✅ **C2** (backend): `/units` + `/units/{unitId}/track` from C1. No `units` capability flag exists in the schema; adding one needs a spec PR.
4. ✅ **C4** (frontend): `unitLayer` reads the backend tracks; no client position math.
5. ✅ **A2** (frontend): browser planner deleted (`dispatchPlanner` / `dispatchDemo` / `demoStore` / `useDemoSync` / `components/demo`).
6. ◐ **G3** (frontend): the read-only comparison card (base/A/B metrics + deltas) is in `PlansPanel`; split-screen/swipe at the same minute remains P1.

**Contract and polish (after the critical path):** B7 spec PR, C3 fire coupling, F2 GNR agent, G1/G2 navigation, I1 e2e smoke. Everything P1/P2 goes after submission; storm cells (D3/E6) and exercise mode (H1/H2) are the strongest post-hackathon features.

## 5. Contract proposals to raise now (PROTOCOL.md §1)

> **B7 is the only P0 contract item and it is still missing.** Land this first; the UI cannot render the park/walk leg until the schema exists.

```markdown
[CONTRACT PROPOSAL: backend → openapi.json]
- Endpoint / Schema: RoutePlan / Route, ValidationIssue codes
- Proposed change: add `access { parkAt: LatLon, snapDistanceM, walkM, walkMinutes }`; new codes `no_road_access`, `route_off_network`
- Reason: roads mandatory; crews park on the network and walk the last leg (B1/B2/B4). Backend already emits the codes and computes the legs internally.
- Status: NOT LANDED. `Route` schema at `openapi.json:11704` has none of these fields; the codes are absent.

[CONTRACT PROPOSAL: backend → openapi.json]
- Endpoint / Schema: WeatherEvent (new `storm_cell`), GET /simulations/{id}/weather/field
- Proposed change: moving storm cell event + coarse wind/precip field per minute
- Reason: spatial weather for storms and their rendering (D3/E6)

[CONTRACT PROPOSAL: agents → openapi.json]   (optional, A7)
- Endpoint / Schema: POST /simulations/{id}/plan-requests
- Proposed change: UI asks agents for plans; status queued/running/done
- Reason: "Pedir planos" button instead of a polling-only watcher
```

Still open from `agents/README.md` (verify before acting): `InterventionFuelRemoval` shape mismatch, evacuation not reducing `populationExposed`, `fuel_break` missing from `ActionType`, what-if → plan back-link. Also verify whether `RoadCutsCache` still needs the road-network version key (B8) before closing it.
