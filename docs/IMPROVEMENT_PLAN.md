# FireTrace — Improvement Plan

> Audit of **2026-10-20**, re-verified against the code on **2026-10-22** (`main` = `eb977c6`, clean tree).
>
> **Goal of every task below:** one authoritative loop of data
> **Scenario (incl. dynamic weather) → Backend + fire engine → Agents propose A/B → Operator decides → Backend simulates the operation (fire *and* units on roads) → Frontend renders only what the backend says → feedback into the next decision.**
>
> The tool is for Bombeiros, GNR and Proteção Civil to **train** and to **support decisions** in a real incident. That means: every number on screen must come from the backend, every vehicle must move on a real road, and the operator must always know *which* fire, *which* plan and *which* minute they are looking at.

Submission is **23 Oct 2026, 16:30 UTC — tomorrow**. Tasks are tagged **P0** (needed for a coherent demo), **P1** (next), **P2** (after the hackathon), and each names its vertical. Contract changes follow `PROTOCOL.md` §1 (proposal first, then lockstep).

**How to read the status column:** ✅ code-verified landed · ◐ partially landed, with the gap named · ❌ not started · ⚠️ new defect found in this audit. A status here is derived from reading the code and the spec, not from commit messages. No `dotnet test` and no live run were made in this audit (see §6).

---

## Status update — 2026-10-22

`main` is `eb977c6`; the A6/D1/E6 changes below are in the working tree (uncommitted). There is no `.github/` CI, no `scripts/` directory, and the frontend has no test script (`package.json` has `dev`, `build`, `preview`, `typecheck`, `generate:api-types`). The spec has 71 paths and 261 schemas.

**Landed since the previous status update (`8dff00a`):**

- **Phase 2 on 2026-10-22 (A6, D1, E6).** The operator now edits an agent plan in the Planos panel (`PlanEditor`: remove an action or a vehicle, add a vehicle, move the target, fix the start minute), validates it with `POST /plans/validate`, saves with `PATCH /plans/{id}` and re-runs its what-if; the row is marked `ajustado`/`B′` next to A and B. Open-Meteo now also stores and serves `visibility`, `cape` and `is_day` (`008_weather_visibility.sql`, `detail_version=2`; `WeatherSample` gained `visibilityM`/`capeJkg`/`isDay`). The 3D scene has a moving cumulonimbus cell, a ground outflow gust ring, a bolt on the scene's own lightning pulse and synthesised thunder (`stormLayer.ts`); it follows the storm event's wind today, ready for D3's explicit path.

- **A7 — plan requests, end to end.** `POST /simulations/{id}/plan-requests`, `GET /plan-requests/{id}`, `PATCH /plan-requests/{id}`, `POST /plan-requests/{id}/claim`; backend service + tests; the watcher claims and reports progress; `PlanRequestBox` in the Planos panel.
- **F2–F5 — the other organizations.** GNR road closures/checkpoints (`agents/firetrace_agents/gnr.py`), Proteção Civil evacuation/shelters/command post/alerts (`support.py`, `life.py`), INEM medical standby, and water/refill/fatigue duty cycles (`duty.py`), all composed by the orchestrator.
- **F6/F7/F9 — plans judged by the engine.** Candidate comparison, ±30° wrong-wind robustness, and a Reviser that watches selected/active plans and PATCHes them (`alternatives.py`, `judge.py`, `revision.py`, `campaign.py`).
- **Backoffice + API protection.** `frontend/src/components/resources/ResourcesView.tsx` (organizations, stations, vehicles, personnel, equipment); global + `planning`-policy rate limiting (`backend/src/FireTrace.Core/Hosting/ServiceCollectionExtensions.cs:102-135`, `Program.cs:19`).
- **Combat timeline + logos + map work** (`AttackTimeline.tsx`, `#28`, `#24`), demo resource seeding (`AGENTS_SEED_DEMO=1`), and the native physics/weather integration (`948563e`).
- **New subsystem not in the original plan:** the LLM commander (`agents/firetrace_agents/commander/`, `agents/LLM_COMMANDER_PLAN.md`), opt-in via `AGENTS_COMMANDER=llm` (default `rules`). See Epic K.

**Corrections to the previous status update (these were false positives):**

1. **B4 is not landed.** `PlanValidator.CheckAccess` (`PlanValidator.cs:216-222`) and `ArrivalEstimator.EstimateAsync` (`ArrivalEstimator.cs:49-50`) never pass `simulationId`/`avoid.predictedFire`; only the agents' `/routing/route` calls do. The plan is validated against *active closures*, not against the predicted fire. The previous "closures + predicted fire" claim was wrong.
2. **D2's "gusts are informational" is wrong.** `FireBehaviorModel.cs:46` blends the gust into the midflame wind (`GustFactor: 0.5` in `appsettings.json:227`). The stale statement lives in code: `CapabilityCatalog.cs:17` still says "só informativa: o motor usa o vento médio" — a truthfulness bug (J2).
3. **R10's "7 top tabs" is wrong.** There are 6 (`TopBar.tsx:9-16`).
4. **A6 was not implemented in the UI at the start of this audit; it is now.** `PlanEditor.tsx` calls `POST /plans/validate`, `PATCH /plans/{id}` and `POST /plans/{id}/simulate`; `plansApi.patchAction` remains reserved for execution progress (G5).
5. **F9 is landed, not open.** `revision.py` polls `selected`/`active` plans, re-plans from their own basis and PATCHes actions + summary. It does not use `/locations/{id}/deployment`, and `campaign.py` remains an offline evaluator — but the rolling re-plan outcome is there.
6. **F8 is partial, not open.** The spec and the agents use `on_fire_arrival` and `on_action_complete`; the backend accepts them but ignores them when timing a plan (J3).
7. **G7 is landed, not open.** `PlansPanel.tsx:339-346` has loading / error / "no plans yet" states; `useSimulationActions.ts:228-231` surfaces a failed simulation's `error.detail` instead of drawing nothing.

**New defects found on 2026-10-22 (Epic J):**

- **J1 (P0, one line):** `DispatchService.cs:46` comments out `Notes`, `Status`, `EtaMinutes` and `Position` in the `Dispatch` initializer. `POST /dispatches` stores `etaMinutes: null`, `notes: null` and no position; `ResourceOverview.cs:70` then shows a blank ETA. `Status` survives only because its default is `Ordered`.
- **J2 (P1, one line):** the stale gust note in `CapabilityCatalog.cs:17`.
- **J3 (P1):** `PlanTiming.StartMinutes` (`PlanTiming.cs`) only understands `AtTimeTrigger`; `on_fire_arrival` / `on_action_complete` start at minute 0 in validation, what-if and unit tracks.
- **J4 (P1):** the pure `OperationSimulator.Simulate` entry point draws a straight line when an assignment has no route (`OperationSimulator.cs:122`). The HTTP path always estimates a road route, so the endpoints are safe; the tested entry point can put a vehicle off-road and tests would not catch a routing regression.

**Capability note (C2):** the `Capabilities` schema has no `units` flag, so there is nothing to "flip". The endpoints are implemented and discoverable by path; adding a flag would require a spec PR.

**Contract deviation (B7):** still the only P0 contract item. The `Route` schema has no `access`/`parkAt`/`snapDistanceM`/`walkM`/`walkMinutes`, and `no_road_access`, `route_off_network` and `target_unreachable` are emitted but undocumented.

---

## 1. What the audit found (root causes, not symptoms)

| # | Status | Problem | Evidence (2026-10-22) |
|---|---|---|---|
| R1 | ✅ resolved | **Two planners that don't know about each other.** The client-side `DispatchPlanner` and its demo store are gone; agents are the only planner. | `frontend/src/domain/dispatchPlanner.ts`, `usecases/dispatchDemo.ts`, `store/demoStore.ts`, `hooks/useDemoSync.ts`, `components/demo/` do not exist. |
| R2 | ✅ resolved | **The "Operação" tab silently replaced the fire.** The tab is gone; nothing re-runs a baseline behind the operator. | 6 tabs in `TopBar.tsx:9-16`; no `dispatchDemo`. |
| R3 | ✅ resolved | **Two "simulation" entry points with different semantics.** There is one simulation form (Incidente / Meteo) and one response panel; plan requests live in Planos. | `SimulationForm.tsx`, `PlansPanel.tsx:335`. |
| R4 | ✅ resolved | **Movement authority used to live in the browser.** The backend owns tracks and serves them. | `OperationSimulator.cs`, `SimulationResultsController.cs:67,72`, `useUnitsSync.ts`, `unitLayer.ts`. Residual: J4 in the static simulator. |
| R5 | ◐ mostly resolved | **Roads are mandatory in the backend, not in the contract.** Routing enforces `MaxSnapM=500` (`appsettings.json:354`) and the walk leg; plans prefer the server route. Residual: personnel-pool ETAs still trust `etaMinutes` (`PlanInterventions.cs:84,112,133`), the access-time helpers still snap without a bound (`RoutingService.cs:120,155`, `FireResults.cs:180-184`), and B7 is missing. | `RoutingService.cs:44-51`, `PlanRouter.cs:21-41`, `PlanValidator.cs:198,216-222`. |
| R6 | ✅ resolved | **Agents were only firefighters.** GNR, INEM, Proteção Civil, water/refill/fatigue are composed into both plans. | `gnr.py`, `support.py`, `life.py`, `duty.py`; `orchestrator.py:321-331,522-531`. |
| R7 | ◐ mostly resolved | **Weather is more capable in the backend than the UI exposed.** The timeline now edits ranged events with a popover (rain, storm, clouds, wind shift, gust factor, heat/dry) and previews them; base weather has sliders. Missing: `front_passage`, `wind_set`, explicit `humidity_shift`/`temperature_shift`, and arbitrary keyframe curves. | `PlaybackBar.tsx:89-263`, `SimulationForm.tsx:80-120`; spec event enum at `openapi.json:9814-9821`. |
| R8 | ✅ resolved | **Real weather has gusts/rain/clouds/visibility/CAPE/daylight.** Open-Meteo fetches and stores gusts, precipitation, clouds, visibility, CAPE and `is_day`; the fire model uses gusts/rain/clouds, the UI exposes visibility/day-night. Weather is still one point for the whole map (D3). | `OpenMeteoSource.cs`, `008_weather_visibility.sql`; `FireBehaviorModel.cs:46,56`. |
| R9 | ✅ resolved (visual) | **The 3D scene has a dynamic atmosphere and a storm cell.** Sun/sky/fog/clouds/rain exist, and `stormLayer.ts` adds a moving cumulonimbus, outflow rings, bolts and thunder. The backend still has no spatial weather/`storm_cell` (D3). | `sceneEngine.ts`, `cloudLayer.ts`, `rainLayer.ts`, `stormLayer.ts`; no `storm_cell` in the spec. |
| R10 | ◐ partial | **Frontend UX is still tab soup.** 6 top tabs, no workflow stepper; Incidente still mixes live stats with the scenario editor; the Recursos admin view was added; there are no frontend tests. | `TopBar.tsx:9-16`, `package.json`, `ResourcesView.tsx`. |

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

| ID | Pri | Vertical | Task | Status / done when |
|---|---|---|---|---|
| A1 ✅ | P0 | [AG] | **Agents as a service.** `agents/Dockerfile` + the `agents` service run `watcher.py`; it polls baselines, skips ones with plans, publishes A/B and requests both what-ifs. | **Landed** (`docker-compose.yaml` agents service, `watcher.py`). A baseline started from the UI gets A/B and their what-ifs with no terminal. |
| A2 ✅ | P0 | [FE] | **Remove the client-side planner.** Delete `domain/dispatchPlanner.ts`, `usecases/dispatchDemo.ts`, `store/demoStore.ts`, `hooks/useDemoSync.ts`, `components/demo/`. | **Landed.** Files gone, the Operação tab gone, the map uses backend tracks. |
| A3 ✅ | P0 | [FE] | **Merge "Planos" and "Operação" into one "Resposta" flow** for the baseline in focus: plans A/B with status; side-by-side metrics vs baseline; "Ver no mapa" A/B/base at the same minute; "Selecionar" → "Ativar" → "Encerrar"; per-action list grouped by organization with rationale visible. | **Landed** (`PlansPanel.tsx:348-419`). Also: combat timeline per plan (`AttackTimeline.tsx`). |
| A4 ✅ | P0 | [FE] | **Single focus model.** One store field `focus: { baselineId, shown: 'base' \| planId }`. Nothing re-runs a baseline behind the operator's back. Persistent header chip: *Cenário · base/plano A/B · simulation id · T+min*. | **Landed** with the existing `baseSimulationId`/`activePlan` state; no separate `focus` field. `TopBar.tsx:85-99`. |
| A5 ✅ | P0 | [FE] | Delete `api/scenarios/operationalIncidentScenario.ts` (UNWIRED, buggy). | **Landed.** |
| A6 ✅ | P1 | [FE] | **Operator edits a plan** instead of building one: remove/add a vehicle, move a target, change a trigger time → `PATCH /plans/{id}` (merge-patch) → `POST /plans/validate` → re-simulate. | **Landed (2026-10-22):** `PlanEditor.tsx` edits the plan's actions (remove an action/vehicle, add a vehicle with personnel, translate the target and its what-if geometry, fix the start minute and move the effect windows), runs validation, saves with `PATCH /plans/{id}` (`metadata["operator.editedAt"]`), re-simulates and shows the row as `B′`/`ajustado` with its own what-if. `patchAction` remains for G5's execution progress, not for plan content (the spec reserves it for the executor). Plans published without `resources` (hand-seeded demo plans, requests composed before the fleet exists) get a hint and a capability-matched **Sugerir meios** button per action instead of a bare empty list. |
| A7 ✅ | P1 | [SPEC]+[BE]+[AG] | **"Pedir planos" button.** The UI asks the agents for a new pair, with status. | **Landed:** spec paths `/simulations/{id}/plan-requests`, `/plan-requests`, `/plan-requests/{id}`, `/plan-requests/{id}/claim`; backend service + tests; watcher claims and reports `claimed → composing → judging → adapting → publishing → simulating → done`; `PlanRequestBox`. |
| A8 ✅ | P1 | [AG] | Tag/label hygiene: agents stop titling with `[lab]` in service mode; plans carry `variant`, `strategy`, `alertLevel` and `objectives` the UI can show as "A: vidas primeiro / B: área ardida". | **Landed:** `alternatives.relabel` sets `variant`/`title`/`strategy`/`objectives`; `orchestrator.py:1403` sets `alertLevel`; `PlansPanel.tsx:367-369` shows strategy/alert level; `[lab]` is reserved for evaluator runs (`AGENTS_SKIP_LABEL_PREFIX`). |

### Epic B — Roads are mandatory, enforced by the backend (fixes R5)

| ID | Pri | Vertical | Task | Status / done when |
|---|---|---|---|---|
| B1 ✅ | P0 | [BE] | **Max snap distance.** `RoutingService` rejects (`no_road_access`) when origin/target is farther than `Routing.MaxSnapM` (500 m) and warns above a lower threshold. | **Landed** (`RoutingService.cs:44-51`, `appsettings.json:354`). `RoadGraph.Snap` itself is still unbounded, and the access-time helpers keep using it directly (`RoutingService.cs:120,155`, `FireResults.cs:180-184`), so those paths snap any point to the nearest edge regardless of distance. |
| B2 ◐ | P0 | [BE] | **Last-mile leg.** The route returns the parking point and the on-foot distance/time to the target. The crew's effect starts at *drive + walk* time. | **Internal only:** `RouteAccess` + `ArrivalEstimator` use the sum; not exposed in the API (B7). |
| B3 ◐ | P0 | [BE] | **Backend computes ETAs, never trusts them.** Compute ETA with `RoutingService` from the vehicle's station/position at the trigger time; only compare client `etaMinutes`. No ETA ⇒ unreachable ⇒ no effect, never 0. | **Vehicles done** (`PlanRouter` rewrites route + ETA, `ArrivalEstimator`), **personnel pools still trust `r.EtaMinutes`** (`PlanInterventions.cs:84,112,133`), and the unknown-origin fallback returns the client value. |
| B4 ◐ | P0 | [BE] | **Validate routes in plans and dispatches.** `DispatchService` does not prefer `input.Route` blindly; `PlanValidator` checks every ground resource is routable at its trigger time (closures + predicted fire + vehicle profile) and emits `target_unreachable` / `route_off_network`. | **Partially landed, corrected:** server routes win (`DispatchService.cs:46,71-76`), off-network routes are replaced with a `route_replaced` warning, unreachable targets are an error, and `PlanValidator` checks active closures + vehicle profile. **Predicted-fire avoidance is NOT checked** (`ArrivalEstimator.EstimateAsync` passes no `SimulationId`/`Avoid`). |
| B5 ✅ | P1 | [BE] | **Vehicle state is road-constrained.** `PATCH /vehicles/{id}/state` snaps ground-vehicle positions to the network (or rejects beyond `MaxSnapM`) unless `source=gps`. | **Landed** (`VehicleStateService.cs`, `PositionToleranceM=100`). |
| B6 ❌ | P1 | [BE] | Re-route on change: when a road closure is created or the fire cuts a road on an active route, recompute affected active dispatches' routes and ETAs (and log it). | **Not started.** `MaxReroutes` is only the routing loop inside one request (`RoutingService.cs:62`). |
| B7 ❌ | P0 | [SPEC] | Contract packet: `RoutePlan.access { parkAt: LatLon, snapDistanceM, walkM, walkMinutes }`, new issue codes `no_road_access`, `route_off_network`, `target_unreachable`. | **Not landed.** The `Route` schema has none of these; the codes are absent. Must be a spec PR before the UI consumes them. |
| B8 ❌ | P1 | [BE] | `RoadCutsCache` key includes the road-network version (agents README proposal 5). | **Not started.** Key is `{simulationId}:{key}:{radiusCells}` (`RoadCutsCache.cs:19`); re-ingesting a network keeps stale cuts. |

### Epic C — Server-side operation simulation (fixes R4)

| ID | Pri | Vertical | Task | Status / done when |
|---|---|---|---|---|
| C1 ✅ | P0 | [BE] | **`OperationSimulator`** in `Services/Operations/`: given a plan (or active dispatches) and the what-if fire run, step every unit minute by minute — order → drive → park/walk → work → refill → rest → return. | **Landed:** deterministic tracks, water/refill/rest (`CrewWorkSchedule`), plan actions *and* plan-linked dispatches; DB and static entry points harmonized. Residual: J4 (static path can fall back to a straight line). |
| C2 ✅ | P0 | [BE] | **`GET /simulations/{simulationId}/units` and `/units/{unitId}/track`** from C1 output. Contract params are `tMin` and `stepMin`. | **Landed** (`SimulationResultsController.cs:67,72`). There is no `units` capability flag; do not invent one without a spec PR. |
| C3 ❌ | P0 | [BE] | Couple C1 with the fire: crew effect windows come from the *actual* simulated arrival/refill windows, and a unit whose route is cut by fire is delayed or rerouted. Crew exposures use real positions. | **Not started.** `OperationSimulator` uses `CrewWorkSchedule.Plan(arrive, until, …)` (planned windows), not the fire's arrival; `ArrivalEstimator` has no fire input; `PlanInterventions`/`PlanValidator` never re-route around the predicted fire. This is the biggest remaining product gap. |
| C4 ✅ | P0 | [FE] | **Render units from the backend.** `unitLayer.ts` reads `/units` + `/track`; interpolation uses the track geometry. Remove any client position math. | **Landed:** `useUnitsSync` loads metadata + one-minute tracks; the layer interpolates between backend samples. The spec exposes positions, not route geometry. |
| C5 ❌ | P1 | [BE] | Live mode: when a plan is active, the backend (not the browser) advances dispatch status and vehicle state from C1 against wall clock or exercise clock. Delete the browser "writer". | **Not started.** The browser writer is already gone, but nothing advances active dispatches server-side. |

### Epic D — Dynamic weather in the backend (fixes R8)

| ID | Pri | Vertical | Task | Status / done when |
|---|---|---|---|---|
| D1 ✅ | P0 | [BE] | **Fetch more from Open-Meteo:** `wind_gusts_10m`, `precipitation`, `cloud_cover` are in; `visibility`, `cape`, `is_day` are not. | **Landed (2026-10-22):** `OpenMeteoSource` requests and stores `visibility`, `cape` and `is_day` (migration `008_weather_visibility.sql`, `detail_version=2`); `WeatherSample`/`WeatherPoint` expose `visibilityM`, `capeJkg`, `isDay`; `WeatherTimeline` carries them (nearest hour; manual series derive day/night from solar radiation); `/weather/resolve` and `/simulations/{id}/weather` return them, and the Meteo panel shows visibility/instability/day-night. ERA5 archive has no visibility/CAPE (they stay omitted); forecast dates return them. The agents' `daylight.py` sunset computation is untouched. |
| D2 ✅ | P1 | [BE]+[EN] | Use what we fetch: precipitation → dead-fuel wetting, cloud cover → solar term, intensity-dependent rain extinction. | **Landed, corrected:** gusts **do** affect the fire (`FireBehaviorModel.cs:46` with `GustFactor=0.5`), rain wets fuel and damps spread (`RainFactor`), clouds reduce solar heating. The capability note in code is stale (J2). |
| D3 ❌ | P1 | [SPEC]+[BE] | **Storm cells (spatial weather).** Event `storm_cell { path: LineString, speedKmh, radiusM, start/end, outflowWindKmh, gustKmh, precipitationMmH, lightningPerMin }`, per-member wind grids, `GET /simulations/{id}/weather/field?tMin=`. | **Not started.** No `storm_cell`, no `weather/field` in the spec. |
| D4 ❌ | P2 | [SPEC]+[BE] | **Dry lightning ignitions:** `lightningIgnitions: true` on a storm cell → deterministic new ignitions by fuel moisture. | **Not started.** |
| D5 ✅ | P1 | [BE] | `POST /weather/resolve` returns the effective series so the UI preview equals what the engine will see. | **Landed (Phase 3):** `WeatherResolveResponse` now also echoes the applied `events` (active only, in order) and `keyframes`; the endpoint description says the same recipe feeds `GET /simulations/{id}/weather`. `EndToEndApiTests.Weather_resolve_echoes_the_applied_recipe_and_matches_the_engine_track` posts keyframes + all nine event types and asserts every sample equals `WeatherTimeline.Build` (the engine path). |

### Epic E — Dynamic weather & visual weather in the frontend (fixes R7, R9)

| ID | Pri | Vertical | Task | Status / done when |
|---|---|---|---|---|
| E1 ✅ | P0 | [FE] | **Weather timeline editor** (replaces the 4 sliders): a time axis with draggable **keyframes** (wind, direction, gust, humidity, temp, rain) and **event chips** for every backend event. Every edit calls `POST /weather/resolve` and redraws the chart. | **Landed (Phase 3):** the event track covers every weather event — rain/storm/clouds/heat-dry composites plus explicit `wind_shift`, `wind_scale`, `wind_set`, `gust_burst`, `front_passage`, `temperature_shift` and `humidity_shift`; scenario snapshots are re-parsed into chips for all of them. Sparse keyframes (`WeatherSpec.keyframes`) are created from the run's current weather, drawn as draggable diamonds on the axis, and edited in a popover (wind/direction/gust/temp/humidity/rain/cloud/transition). `SimulationForm` has the same curve list, quick-add buttons for the new events, and a debounced auto-preview: every edit calls `POST /weather/resolve` and redraws `WeatherChart`, surfacing `warnings` and the echoed event/keyframe counts. |
| E2 ✅ | P0 | [FE] | **Wind on the map:** animated wind particles/streamlines following `windFromDeg` (FROM) and speed; gusts as pulses. | **Landed** (`windLayer.ts`). |
| E3 ✅ | P0 | [FE] | **Sky & atmosphere driven by weather + time:** sun position from date/time/location, sky colour and fog from cloud/visibility/smoke, lights dimmed under overcast. | **Landed** (`sceneEngine.ts`, `WeatherHud.tsx`). |
| E4 ✅ | P0 | [FE] | **Clouds:** instanced layer whose coverage = `cloudCoverPct`, moving with the wind. | **Landed** (`cloudLayer.ts`). |
| E5 ✅ | P1 | [FE] | **Rain:** GPU particle rain (density from `precipitationMmH`), wet-terrain darkening, reduced visibility. | **Landed** (`rainLayer.ts`, wet sheen). |
| E6 ✅ | P1 | [FE] | **Storms:** cumulonimbus cell following the storm path (D3), lightning flashes, outflow gust ring, optional thunder. | **Landed (2026-10-22, frontend; reworked after review):** `stormLayer.ts` draws a dense per-instance-shaded cumulonimbus cluster (dark rain base, lit cauliflower tower, pale anvil) above the fair-weather deck, moves it with the storm event's wind (or the local spot), draws cold-pool outflow rings, and renders lightning as the classic fractal midpoint-displacement bolt (Drilian) — a camera-facing ribbon with core+glow, branches, upward return-stroke sweep, restrike flicker, ground flash and synthesised thunder (`Som de trovão` toggle). Rain and the cloud deck now span the loaded map (8 km detail vs 22 km concelho), so no weather over the void; the cell footprint is capped at 30% of the map. D3's explicit `storm_cell.path` can replace the derived centre point-for-point. |
| E7 ✅ | P1 | [FE] | Meteo tab becomes useful: current conditions + full chart with gusts/rain/cloud bands + **fire-weather indicators** (30-30-30), fine-fuel moisture. | **Landed** (`WeatherPanel.tsx:23-105`). |
| E8 ✅ | P1 | [FE] | Weather HUD: rain, clouds, visibility, day/night, "upcoming change in N min". | **Landed** (`WeatherHud.tsx`, `Viewport.tsx:45`). |

### Epic F — Agents grow up (fixes R6)

| ID | Pri | Vertical | Task | Status / done when |
|---|---|---|---|---|
| F1 ✅ | P0 | [AG] | **Travel time for every ground unit** via `POST /routing/route`; trigger + ETA drive when the action starts; unreachable units are not assigned. | **Landed** (`agents/firetrace_agents/routing.py`, `plan.py`, PR #13). |
| F2 ✅ | P0 | [AG] | **GNR agent:** closures on roads the fire cuts within the horizon, control points at closure ends, closure timed before the predicted cut. | **Landed** (`gnr.py`, wired at `orchestrator.py:321-331`); plans carry GNR actions with reasons and reopening times. |
| F3 ✅ | P1 | [AG] | **Proteção Civil agent:** evacuation vs shelter-in-place, transport, shelters, command post, public alerts. | **Landed** (`life.py` transport + `support.py` shelters/`establish_command_post`/alerts; `SupportAgents`). |
| F4 ✅ | P1 | [AG] | **INEM agent:** medical standby near the most exposed crews/places; reacts to `crewExposures` from the what-if. | **Landed** (`support.py:73-110`, placed behind crew sites). |
| F5 ✅ | P1 | [AG] | **Water & fatigue** in agent reasoning (reachable refill points, work/rest from `/rules`). | **Landed** (`duty.py`, `water_points_near`, `duty_factor` applied to both effects and metrics). |
| F6 ◐ | P1 | [AG] | **Choose with the engine:** generate N candidates, simulate each, publish the best two by objective. | **Code landed, off by default:** `alternatives.py` supports N candidates and judges each; the watcher defaults `AGENTS_CANDIDATES=1` (each extra candidate costs ~75 s). Set 2 for the demo if time allows. |
| F7 ✅ | P1 | [AG] | **Robustness by default:** evaluate each published plan on a ±30° wrong-wind run and say so. | **Landed** (`judge.py`, `alternatives.py:113-131`; `WIND_ERROR_DEG = 30`), with the robustness line in the plan summary. |
| F8 ◐ | P2 | [AG] | **Conditional triggers:** actions with `trigger` on fire reaching an area / wind change instead of only `at_time`. | **Partial:** `on_fire_arrival` and `on_action_complete` exist in the spec and are emitted by the agents (`support.py:234`, `firefighter.py`), but the backend ignores them when timing a plan (J3), and there is no wind-change or arbitrary geofence trigger. |
| F9 ✅ | P2 | [AG] | Campaign mode wired to live operations: re-plan from the active plan's state and propose `PATCH /plans/{id}`. | **Landed via `revision.py`:** watches `selected`/`active` plans, re-plans from each plan's basis, PATCHes actions + summary, respects the operator's edit. It does not read `/locations/{id}/deployment`; `campaign.py` is still an offline evaluator. |

### Epic G — Frontend gets better (fixes R10)

| ID | Pri | Vertical | Task | Status / done when |
|---|---|---|---|---|
| G1 ❌ | P0 | [FE] | **New navigation = the workflow:** `Cenário → Simulação → Resposta → Execução → Revisão` stepper; roads/meios/meteo become map layers + drawers. | **Not started.** 6 top tabs (`TopBar.tsx:9-16`). |
| G2 ❌ | P0 | [FE] | **Scenario editor:** pick location, click ignition(s), start, duration, weather timeline (E1), ensemble size; save via `POST /scenarios`. | **Not started.** `scenariosApi` only has `listForLocation` and `get` (`api/services/scenarios.ts`). |
| G3 ◐ | P0 | [FE] | **Comparison view:** split-screen or swipe between base / A / B at the same minute + delta table. | **Read-only comparison card landed** (`CompareTable` in `PlansPanel.tsx:337`, metrics + deltas). Split-screen/swipe remains P1. |
| G4 ◐ | P1 | [FE] | **Timeline events on the playback bar:** markers for weather events, action triggers, unit arrivals, roads cut, places threatened; click to jump. | **Partial:** weather + ignition markers and an editable event track (`PlaybackBar.tsx:89-106,297-340`); no action/arrival/road-cut markers. |
| G5 ◐ | P1 | [FE] | **Per-organization view:** each org sees its actions, units and status, and can report progress (`PATCH /plans/{id}/actions/{actionId}`). | **Partial:** actions grouped by organization with logos and rationale (`PlansPanel.tsx:405-419`); no org filter, no progress reporting, `patchAction` unused. |
| G6 ◐ | P1 | [FE] | Capability gating everywhere (`/capabilities`): unsupported weather fields/events/interventions disabled with the note as tooltip. | **Partial:** capabilities are fetched (`useBootstrap.ts:15-16`) but only `limits` is used (`SimulationForm.tsx:57`); no gating of events/interventions. |
| G7 ✅ | P1 | [FE] | Error/empty states: failed simulation shows `error.code`/`detail`, "agents still working", "no plans yet", without blank panels. | **Landed** (`PlansPanel.tsx:339-346`, `PlanRequestBox.tsx:100,169,181`, `useSimulationActions.ts:228-231`). No retry button. |
| G8 ❌ | P1 | [FE] | Smoke-test suite (Playwright against Prism mock) for the 5 workflow steps. | **Not started.** No test script, no Playwright dependency. |

### Epic H — Training & decision-support features (what makes it a real tool)

| ID | Pri | Vertical | Task | Status / done when |
|---|---|---|---|---|
| H1 ❌ | P1 | [SPEC]+[BE]+[FE] | **Exercise mode:** an exercise clock (pause/resume/speed) owned by the backend. | **Not started.** No exercise endpoints; playback is client-side. |
| H2 ❌ | P1 | [SPEC]+[BE]+[FE] | **Injects:** trainer adds events during an exercise that re-run the forecast from "now". | **Not started.** |
| H3 ❌ | P1 | [BE]+[FE] | **After-action review:** event log of decisions vs outcome, exportable. | **Not started.** |
| H4 ❌ | P2 | [BE] | **Roles & organizations:** auth with org scope, audit trail. | **Not started.** |
| H5 ❌ | P2 | [BE]+[FE] | **Real incident mode:** live weather + GPS positions (`source=gps`) on the same loop. | **Not started.** |

### Epic I — Quality gates that keep the loop flawless

| ID | Pri | Vertical | Task | Status / done when |
|---|---|---|---|---|
| I1 ❌ | P0 | all | **End-to-end smoke script** (`scripts/e2e.ps1`): compose up → scenario with a front passage → baseline → agents publish A/B → what-ifs → `/units` tracks on roads. | **Not started.** No `scripts/` directory. |
| I2 ❌ | P1 | [FE] | Regenerate `src/api/schema.ts` in CI and fail on diff. | **Not started.** The script exists (`generate:api-types`), but there is no CI. |
| I3 ❌ | P1 | [AG] | Run agent tests against Prism mock in CI, plus one live run in the e2e script. | **Not started.** 9 agent test modules exist (`agents/tests/`), but no CI and no Prism run. |
| I4 ❌ | P1 | [BE] | Property test: every route point on the network; every ground-unit track point on the network or within the walk leg. | **Not started.** `RoutingTests.cs` is example-based. |

### Epic J — Correctness debt found in the 2026-10-22 audit

| ID | Pri | Vertical | Task | Status / done when |
|---|---|---|---|---|
| J1 ✅ | P0 | [BE] | **`DispatchService` drops four fields.** `DispatchService.cs:46` ends the initializer with `Route = route ?? input.Route, // … cliente` and comments out `Notes = input.Notes, Status = DispatchStatus.Ordered, EtaMinutes = eta, Position = subject.Position`. `POST /dispatches` therefore stores `etaMinutes: null`, `notes: null`, no position (status survives only because `Ordered` is the default). | **Fixed (2026-10-23):** `Notes`, `Status`, `EtaMinutes`, `Position` restored on their own line, explanatory comment kept above. Echo test still to add — verify with `dotnet test`. |
| J2 ✅ | P1 | [BE] | **Stale capability note.** `CapabilityCatalog.cs:17` says gusts are informational and the engine uses the mean wind; `FireBehaviorModel.cs:46` uses `GustFactor`. | **Fixed (2026-10-23):** note reads "entra no vento de meia-chama com `GustFactor`". |
| J3 ◐ | P1 | [BE] | **Conditional triggers are ignored when timing a plan.** `PlanTiming.StartMinutes` only handles `AtTimeTrigger`; `on_fire_arrival`/`on_action_complete` start at minute 0 in validation, what-if and unit tracks. | **Interim landed (2026-10-23):** `PlanValidator` now warns `trigger_not_simulated` per action, and `api-spec/openapi.json` documents the code in `ValidationIssue.code`. Proper resolution (resolve the trigger to a minute from the run) remains post-submission. |
| J4 ◐ | P1 | [BE] | **Static simulator can go off-road.** `OperationSimulator.Simulate` (`OperationSimulator.cs:122`) draws `home → site` when `r.Route` is null; the HTTP path always estimates a road route, so the endpoints are safe; the tested entry point can put a vehicle off-road and tests would not catch a routing regression. | **Fixed (2026-10-23):** the static `Timeline` now throws `route_off_network` for a ground unit without a route; only aerial units keep the straight-line fallback. Not yet run against `dotnet test`. |

### Epic K — LLM commander (new since the original audit)

> `agents/LLM_COMMANDER_PLAN.md` is the design; `agents/firetrace_agents/commander/` is a working T+0 implementation. It is **opt-in**: `docker-compose.yaml` sets `AGENTS_COMMANDER=rules`, so the demo uses the rule-based planner unless the environment changes.

| ID | Pri | Vertical | Task | Status / done when |
|---|---|---|---|---|
| K1 ✅ | P1 | [AG] | **Commander chooses the strategy for A/B at T+0**, with a JSON-schema-validated menu, rules fallback, and the judge still enforcing zero casualties. | **Landed:** `commander/` (6 modules — `commander`, `schema`, `llm`, `retrieval`, `cards`, `environment` — plus `__init__`), wired in `alternatives.py`; `AGENTS_COMMANDER=llm` + key turns it on. |
| K2 ❌ | P2 | [AG] | **Tactics knowledge base as YAML + embedding retrieval.** | **Not started:** cards are built-in Python (`commander/cards.py`); retrieval is rule-filtered, no embeddings. |
| K3 ❌ | P2 | [AG] | **Commander drives re-plans and revisions**, not just T+0. | **Not started:** waves call `orchestrator.run_cycle` with the fixed order; `revision.py` does not consult the commander. |
| K4 ❌ | P1 | [AG] | **Evaluation: commander vs rules on Penha + Falperra** (buildings, area, casualties, fallback rate). | **Not measured.** Needed before claiming the commander is better. |

---

## 4. What to do before 23 Oct 2026, 16:30 UTC

The old day-by-day schedule is gone. With one day left, optimize for **demo coherence and truthfulness**, not breadth.

### Track 0 — must ship (a few hours)

1. **J1** — restore `Notes`, `Status`, `EtaMinutes`, `Position` on their own line in `DispatchService.cs:46` (keep the explanatory comment above it), add a test that `POST /dispatches` echoes them, run `dotnet test`. A visible contract bug for one line of work.
2. **J2** — fix the capability note. One line; it is the API's own description of what the engine does.
3. **Live smoke, manually (I1-lite).** `docker compose up -d`, wait for the agents, select the demo scenario, and verify in one pass: baseline succeeds → A/B published → both what-ifs succeed → `/units` and `/track` return road-following tracks → select/activate/complete works → the PlanRequest button produces a new pair. Record the run (screenshots + the simulation ids) as the demo's evidence. Do not block this on writing `scripts/e2e.ps1`.
4. **B7 spec PR only if the UI will show the park/walk leg.** Otherwise keep it as a documented known gap; it does not block the current UI.
5. **Freeze the demo.** One scenario, one backup recording, a warm cache of the baseline. Any change after the freeze needs a re-run of step 3.

### Track 1 — stretch, only if Track 0 is green

- **G5 progress reporting** — wire `plansApi.patchAction` to an action row (A6's plan editing now uses `PATCH /plans/{id}` and is landed); small UI, existing endpoint, closes G5.
- **G6 capability gating** — disable unsupported events/interventions with the note as a tooltip; prevents a `422` in front of the jury.
- **F6 candidates=2** — set `AGENTS_CANDIDATES=2` in the demo environment and re-time the agents. Only if the demo has slack.
- **C3 fire coupling** — the right next product step, but a half-day with real regression risk. **Do not start it on submission day.**

### Presentation-critical items (jury-facing, decided 2026-10-23)

These are the agreed "wow" items. They carry the narrative; ship them before polish.

1. **HEADLINE NUMBER — cost of delay (must have).** Before the demo, compute two baselines on the same demo scenario (response at T+0 vs T+90) and put the delta on screen: *"decidir 90 min mais tarde = +X habitações perdidas, +Y ha ardidas"*. This is the one-slide answer to "why is this tool better than what they do today?" — it is composed entirely from metrics the backend already produces, so it is low-risk and jury-decisive. Owner: run both simulations and freeze the numbers into the demo script.
2. **Public alert moment (agreed).** When the Proteção Civil agent's alert action activates, raise a prominent "ALERTA PÚBLICO" toast on screen — the emotional beat that shows the population pipeline works end to end.
3. **README.md (currently empty — not yet written).** Write the pitch: what the tool is, the one-authoritative-loop architecture, screenshots, and the cost-of-delay number. The jury reads this first; an empty repo reads as unfinished work.
4. **Ensemble uncertainty — what it means and why it is invisible today.** The engine can run an ensemble (`EnsembleSpec`, `EnsembleDefaults`, `ResolvedEnsemble.cs`): several fire futures under slightly different weather/ignition assumptions, yielding per-minute quantiles (p10/p90) instead of one perimeter. The frontend, however, renders exactly one perimeter per minute (`useWorldSync.ts`), so all that uncertainty is invisible to the operator and the jury. Two options: (a) if the run exposes member/quantile perimeters via the API, add a translucent p10–p90 fan to the map (moderate FE work — the real "we don't predict one fire, we predict the cone of futures" wow); (b) if it needs a spec+backend change, skip it — do not gamble the demo loop. Feasibility check: query the run for quantile perimeters before committing.
5. **Agents without an LLM (F6 context).** The rules-based orchestrator (`AGENTS_COMMANDER=rules`, the default) composes plans A/B from deterministic agents — Bombeiros, GNR, INEM, Proteção Civil — judged by the engine with the zero-casualty rule and ±30° wrong-wind robustness. **No LLM is needed for the demo to work.** The LLM commander is opt-in (`AGENTS_COMMANDER=llm`) and layerable: it chooses strategy, the rules engine still does geometry, routing, water and safety. If the LLM is unavailable, everything falls back to rules. This is a presentation strength, not a limitation: "our plans are produced, validated and re-planned without any black box — and we can switch the AI commander on when we want its rationale."

### Do not start before submission

`G1` navigation refactor, `G2` scenario editor, `D3`/`D4` storm cells, `H1`–`H3` exercise mode, `F8` backend trigger resolution, `I2`–`I4` CI/property tests, `K2`/`K3` commander waves. All are valuable, none is demo-critical, and each can destabilise the loop.

**Priority change to flag:** `C3` remains P0 for the product but is removed from the submission-day critical path. The demo shows two coherent simulations (fire and units) rather than one fully coupled one; the gap is stated here rather than hidden.

---

## 5. Contract proposals to raise now (`PROTOCOL.md` §1)

> **B7 is still the only P0 contract item.** The UI cannot render the park/walk leg until the schema exists.

```markdown
[CONTRACT PROPOSAL: backend → openapi.json]
- Endpoint / Schema: RoutePlan / Route, ValidationIssue codes
- Proposed change: add `access { parkAt: LatLon, snapDistanceM, walkM, walkMinutes }`; new codes `no_road_access`, `route_off_network`, `target_unreachable`
- Reason: roads mandatory; crews park on the network and walk the last leg (B1/B2/B4). Backend already computes the legs and emits the codes.
- Status: NOT LANDED. The `Route` schema has none of these fields; the codes are absent.

[CONTRACT PROPOSAL: backend → openapi.json]
- Endpoint / Schema: WeatherEvent (new `storm_cell`), GET /simulations/{id}/weather/field
- Proposed change: moving storm cell event + coarse wind/precip field per minute
- Reason: spatial weather for storms and their rendering (D3/E6). Not needed for the submission.

[CONTRACT PROPOSAL: backend → openapi.json]   (correctness, J3)
- Endpoint / Schema: Trigger / Plan validation
- Proposed change: state that `on_fire_arrival` and `on_action_complete` are accepted but not simulated yet, or add a `trigger_not_simulated` warning code
- Reason: `PlanTiming` only honours `at_time`; clients must not assume conditional timing is applied.
```

`POST /simulations/{id}/plan-requests` was the previous optional proposal — it **landed** (A7), so it is no longer listed here.

Still open from `agents/README.md` (verify before acting): `InterventionFuelRemoval` shape mismatch, evacuation not reducing `populationExposed`, `fuel_break` missing from `ActionType`, what-if → plan back-link. B8: confirmed that the cache key has no road-network version (`RoadCutsCache.cs:19`); the `/threatened` failure after a re-ingest was not reproduced.

---

## 6. How this audit was verified

- **Repo state:** `git log`, `git status` (clean), `main = eb977c6` (2026-10-22), no `.github/`, no `scripts/`, frontend `package.json` has no test script.
- **Contract:** `api-spec/openapi.json` read with targeted searches — 71 paths / 261 schemas; `plan-requests` and `units` present; no `storm_cell`, no `weather/field`; `Route` lacks the access fields; trigger kinds `at_time`, `on_fire_arrival`, `on_action_complete`.
- **Backend:** `DispatchService`, `PlanRouter`, `PlanValidator`, `ArrivalEstimator`, `PlanInterventions`, `CrewSafety`, `OperationSimulator`, `CrewWorkSchedule`, `RoadCutsCache`, `RoutingService`, `CapabilityCatalog`, `FireBehaviorModel`, `OpenMeteoSource`, `PlanTiming`, rate-limiting wiring.
- **Frontend:** `TopBar`, `PlaybackBar`, `PlansPanel`, `PlanRequestBox`, `AttackTimeline`, `SimulationForm`, `WeatherPanel`, `WeatherHud`, `useSimulationActions`, `useBootstrap`, `api/services/plans.ts`, `api/services/scenarios.ts`, `package.json`.
- **Agents:** `watcher.py`, `orchestrator.py`, `gnr.py`, `support.py`, `life.py`, `duty.py`, `judge.py`, `alternatives.py`, `campaign.py`, `revision.py`, `commander/`, `agents/tests/`.
- **Not verified live:** no backend, agents, engine or frontend were started in this session; `dotnet test` was not run. Statuses are code/spec reads, not runtime checks. The Track 0 smoke is precisely there to close that gap.

---

## 7. Phase 3 completion (2026-10-22)

Two items were finished after the audit above; the rest of the document is unchanged except the D5/E1 rows.

- **D5 — landed.** `WeatherResolveResponse` now echoes `events` (active only, in application order) and `keyframes` in `api-spec/openapi.json`; the response DTO and `WeatherService.ResolveAsync` emit them. A new API test covers keyframes plus all nine event types and verifies every preview sample against `WeatherTimeline.Build`, the exact path the engine uses. Files: `api-spec/openapi.json` (`WeatherResolveResponse`), `backend/src/FireTrace.Core/Models/Weather/WeatherResolveResponse.cs`, `backend/src/FireTrace.Core/Services/Weather/WeatherService.cs`, `backend/tests/FireTrace.Tests/Api/EndToEndApiTests.cs`.
- **E1 — landed.** The timeline now covers every backend weather event (`wind_shift`, `wind_scale`, `wind_set`, `gust_burst`, `front_passage`, `temperature_shift`, `humidity_shift`, `precipitation`, plus the rain/storm/clouds/heat-dry composites), and supports arbitrary sparse keyframe curves created from the current run, dragged on the timeline and edited in a popover. `SimulationForm` auto-resolves on every edit (debounced) and shows the resolved events/keyframes and warnings. Files: `frontend/src/domain/simulationForm.ts`, `frontend/src/store/appStore.ts`, `frontend/src/store/types.ts`, `frontend/src/components/layout/PlaybackBar.tsx`, `frontend/src/components/layout/TimelineKeyframeEditor.tsx`, `frontend/src/components/panels/SimulationForm.tsx`, `frontend/src/components/common/Icon.tsx`, `frontend/src/hooks/useFrameLoop.ts`, `frontend/src/components/{layout,panels}/*.module.css`.

**Verification:** `npm run typecheck` and `npm run build` pass; the full backend suite was run in `mcr.microsoft.com/dotnet/sdk:10.0` with host networking and the compose PostGIS database: **226 passed, 0 failed**. The 3 failures seen without the DB were pre-existing DB-dependent tests, not these changes. The weather UI was built but not driven in a browser in this session.

## 8. Difficulty of Epics G–J (planning estimate)

Scale: **S** ≤ 1 engineer-day · **M** 1–3 d · **L** 3–5 d · **XL** > 5 d. Estimates are for one engineer who already knows the repo, including the contract change, tests and review fixes; they exclude queue/review latency. No G–J code was written in this phase.

### Epic G — Frontend workflow (total ≈ 11–17 d)

| Item | Difficulty | Estimate | Why / blockers |
|---|---|---|---|
| G1 workflow stepper | L | 3–4 d | Replaces 6 tabs and re-homes roads/meios/meteo into layers + drawers. Touches `TopBar`, `SidePanel`, app shell and panel CSS; no backend, but high visual-regression risk and no frontend tests. A read-only stepper over today's tabs is a 1-day spike. |
| G2 scenario editor | M/L | 2–3 d | `POST /scenarios` and ignition picking already exist; needs `scenariosApi.create`, save-vs-simulate semantics, and composition of the existing `SimulationForm` (incl. E1) into one editor. Main risk is state ownership, not API. |
| G3 base/A/B comparison | M/L | 2–4 d | Metric delta table already exists (`CompareTable`). Swipe between cached runs is 2 d; a true split-screen 3D needs a second renderer/context and is 4–6 d. Recommend swipe. |
| G4 timeline markers | S/M | 0.5–1 d | Data is already served (`/units`, `/units/{id}/track`, `/road-status`, plan actions). Add markers + click-to-jump on `PlaybackBar`; low risk. |
| G5 per-org view + progress | S/M | 1–1.5 d | Actions are already grouped by organization; `plansApi.patchAction` exists but is UNWIRED. Needs org filter and progress buttons (A6 closed at the same time). |
| G6 capability gating | S/M | 0.5–1 d | `/capabilities` already fetched and typed (`CapabilityItem`). Map `weatherEvents`/`weatherVariables`/`interventions` to controls and tooltips; low risk. |
| G7 error/empty states | — | 0 | Landed. |
| G8 Playwright smoke suite | M | 1.5–2.5 d | No test script/dependency. Prism mock is workable, but 5 workflow steps need stable selectors and a seeded compose profile; flakiness is the real cost. Do after G1/G2 are stable. |

### Epic H — Training & decision support (total ≈ 17–27 d)

| Item | Difficulty | Estimate | Why / blockers |
|---|---|---|---|
| H1 exercise clock | L | 3–5 d | New contract endpoints + backend-owned clock/pause/speed, persistence across restarts, and frontend playback sync. High risk: every time consumer (simulations, plans, units) must agree on one clock. |
| H2 injects | L | 3–5 d | Needs H1 first; trainer event → invalidate current forecast → re-run from "now" → notify agents/operator. Complex invalidation and idempotency rules. |
| H3 after-action review | M | 2–3 d | Event log of decisions vs outcome plus export. Backend audit storage is straightforward; value depends on H1/H2 producing trustworthy timestamps. |
| H4 roles & organizations | XL | 5–8 d | There is no auth model in the contract at all. Org-scoped authorization across 71 paths, audit trail, token/session lifecycle, and client plumbing. Highest-risk item in G–J. |
| H5 real incident mode | L | 4–6 d | Live weather already exists; GPS ingestion (`source=gps` on vehicle state) exists as a contract hook but there is no ingest pipeline, offline buffering or freshness policy. Operationally sensitive. |

### Epic I — Quality gates (total ≈ 3–5.5 d)

| Item | Difficulty | Estimate | Why / blockers |
|---|---|---|---|
| I1 end-to-end smoke script | S/M | 0.5–1 d | `scripts/e2e.ps1` around the existing compose stack: wait for health, create scenario/baseline, poll plans/what-ifs, assert `/units` tracks are on roads. Environment flakiness is the main cost. |
| I2 CI schema-diff gate | S | 0.5 d | Add `.github/workflows`, run `npm run generate:api-types`, fail on diff. Almost mechanical. |
| I3 agents tests against Prism + one live run | M | 1–2 d | Nine test modules already exist; need a Prism-backed fixture, contract startup, and one live assertion in I1. Medium only because agent runs are slow and network-dependent. |
| I4 route/track property tests | M | 1–2 d | `RoutingTests` is example-based. Either add a property library or a seeded randomized xUnit loop over the real network; assert every route point is on an edge and every ground track is on-network (or within the walk leg). Medium because fixtures and tolerances need care. |

### Epic J — Correctness debt (total ≈ 2–3.5 d; 1.2–2 d if J3 is warning-only)

| Item | Difficulty | Estimate | Why / blockers |
|---|---|---|---|
| J1 dispatch fields dropped | S | 1–2 h | One-line initializer fix + one API test; trivial and high demo value. |
| J2 stale gust capability note | S | 15 min | One string; no code path change. |
| J3 conditional triggers ignored | M (proper) / S (interim) | 1–2 d / 0.25–0.5 d | Proper resolution needs the fire run + action dependency graph (`on_fire_arrival`, `on_action_complete`, cycles) in validation, what-if and unit tracks. Interim: emit `trigger_not_simulated` and document it; that pairs with the open contract proposal. |
| J4 static simulator can go off-road | S/M | 0.5–1 d | Require a route in `OperationSimulator.Simulate` or return a validation error; add the route-on-network assertion. Low risk. |

### Recommended order (after the submission)

1. **J1 + J2** (hours, no risk) → then **G5 + G6** (closes A6/G5 and prevents `422`s in front of users).
2. **G4** (cheap, visible) → **G3 swipe** (high demo/training value) → **G2** → **G1** → **G8**.
3. **I2 + I4** in parallel with G work (CI is cheap and protects the schema).
4. **H1 → H2 → H3** only once the core loop is stable; **H4** is a separate project, and **H5** should not start before H4.
5. **J3 proper** before F8 backend work; **I1/I3** once the workflow steps stop moving.
