# FireTrace — Improvement Plan (audit of 2026-10-20)

> **Goal of every task below:** one authoritative loop of data
> **Scenario (incl. dynamic weather) → Backend + fire engine → Agents propose A/B → Operator decides → Backend simulates the operation (fire *and* units on roads) → Frontend renders only what the backend says → feedback into the next decision.**
>
> The tool is for Bombeiros, GNR and Proteção Civil to **train** and to **support decisions** in a real incident. That means: every number on screen must come from the backend, every vehicle must move on a real road, and the operator must always know *which* fire, *which* plan and *which* minute they are looking at.

Submission is **23 Oct 2026, 16:30 UTC** (3 days). Tasks are tagged **P0** (needed for a coherent demo), **P1** (next), **P2** (after the hackathon). Each task names its vertical so it can be handed to that teammate's agent. Contract changes follow `PROTOCOL.md` §1 (proposal first, then lockstep).

---

## 1. What the audit found (root causes, not symptoms)

| # | Problem | Evidence |
|---|---|---|
| R1 | **Two planners that don't know about each other.** The "Operação" tab runs a 737-line *client-side* `DispatchPlanner` that decides who goes where, simulates movement/water/fuel per minute in the browser and publishes a plan tagged `demo`. The "Planos" tab lists *agent* plans, which only exist if someone runs `python -m firetrace_agents` in a terminal. Demo plans also show up in the Planos list, mixed with A/B. | `frontend/src/domain/dispatchPlanner.ts`, `frontend/src/usecases/dispatchDemo.ts:237-405`, `PlansPanel.tsx:128` (tells the operator to run a CLI) |
| R2 | **The "Operação" tab silently replaces the fire on screen.** It re-runs the baseline itself, so the Planos tab and the Incidente tab suddenly point at a different simulation. | `dispatchDemo.ts:251-262` |
| R3 | **Two "simulation" entry points with different semantics.** Incidente → "Simular com outra meteorologia" (custom scenario) and Operação → "Planear despacho" (baseline re-run + plan). Neither links to the other or to Planos. | `IncidentPanel.tsx:111`, `SimulationForm.tsx`, `DemoPanel.tsx:58` |
| R4 | **Movement authority lives in the browser.** Unit positions are computed client-side and pushed with `PATCH /vehicles/{id}/state`; the backend accepts any position. The contract already has `GET /simulations/{id}/units` and `/units/{unitId}/track` but both throw `UnsupportedException`. | `dispatchDemo.ts:462-469`, `VehicleStateService.cs:12-18`, `SimulationResultsController.cs:65-69` |
| R5 | **Roads are not mandatory end-to-end in the backend.** (a) `RoadGraph.Snap` takes the nearest network node with **no max distance and no warning**; the route ends at that node, not at the target, so there is no "park here, walk N m". (b) A dispatch's client-sent `route` wins over the computed one and is never checked. (c) `PlanValidator` never checks `resources[].route` or `etaMinutes`. (d) `PlanInterventions` trusts the client's `etaMinutes` (missing ⇒ 0 ⇒ crews teleport onto the fire). (e) Agents have **no travel time at all**. | `RoadGraph.cs:55-64,103-121`, `DispatchService.cs:46`, `PlanValidator.cs`, `PlanInterventions.cs` (`eta = Math.Max(eta, r.EtaMinutes ?? 0)`), `agents/README.md` "Limits" |
| R6 | **Agents are only firefighters, offline, and optimistic.** No GNR (closures, traffic, evacuation corridors), INEM (medical standby, triage), Proteção Civil (evacuation, shelters, command) agents; no water/fatigue/travel; not a service in `docker-compose.yaml`. | `agents/firetrace_agents/*`, `docker-compose.yaml` |
| R7 | **Weather is far more capable in the backend than the UI exposes.** Backend supports keyframes + 10 event types (`wind_set`, `gust_burst`, `front_passage`, `precipitation`, `custom_series`, …). The UI exposes 4 global sliders + one wind shift. | `WeatherTimeline.cs`, `simulationForm.ts:57-68` |
| R8 | **Real weather has no rain/cloud/gust data.** Open-Meteo is queried for 4 variables only. `cloudCoverPct` is accepted but unused. Weather is one point for the whole map: there is no notion of a storm *cell* that moves. | `OpenMeteoSource.cs:47`, `CapabilityCatalog.cs:18` |
| R9 | **The 3D scene has fixed sky, fog and sun.** No clouds, rain, lightning, day/night, visibility. | `sceneEngine.ts:9,36-41` |
| R10 | **Frontend UX is tab soup.** 7 top tabs, read-only Meteo tab, Incidente mixes live stats with a scenario editor, no stepper/workflow, no frontend tests. `api/scenarios/operationalIncidentScenario.ts` is **UNWIRED** dead code with a bug (`plans.list({simulationId: scenario.id})`). | `TopBar.tsx:8-16`, `operationalIncidentScenario.ts:76` |

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

| ID | Pri | Vertical | Task | Done when |
|---|---|---|---|---|
| A1 | P0 | [AG] | **Agents as a service.** Add `agents/Dockerfile` + `agents` service in `docker-compose.yaml` running a watcher: poll `GET /simulations?updatedAfter=…` for `kind=baseline, status=succeeded`, skip ones that already have plans (`GET /plans?simulationId=`), run the orchestrator, publish A and B, call `POST /plans/{id}/simulate` for both. | A baseline started from the UI has A and B plans *and* their what-if runs within N minutes, with no terminal involved. |
| A2 | P0 | [FE] | **Remove the client-side planner.** Delete `domain/dispatchPlanner.ts`, `usecases/dispatchDemo.ts`, `store/demoStore.ts`, `hooks/useDemoSync.ts`, `components/demo/`. Before deleting, list its features that agents lack (water cycles, refuel retreat, air limits by daylight/wind, standoff retries) as input to Epic F. | `grep -r DispatchPlanner frontend/src` is empty; build passes. |
| A3 | P0 | [FE] | **Merge "Planos" and "Operação" into one "Resposta" flow** for the baseline in focus: (1) plans A/B with status "a aguardar agentes / pronto", (2) side-by-side metrics vs baseline, (3) "Ver no mapa" toggle A / B / base at the same minute, (4) "Selecionar" → "Ativar" → "Encerrar" (`/select`, `/activate`, `PATCH status=completed`), (5) per-action list grouped by organization with rationale visible (not only in a tooltip). | Planos and Operação tabs are gone; one panel drives the decision. |
| A4 | P0 | [FE] | **Single focus model.** One store field `focus: { baselineId, shown: 'base' \| planId }`. Nothing re-runs a baseline behind the operator's back. Show a persistent header chip: *Cenário · base/plano A/B · simulation id · T+min*. | Switching tabs never changes the fire on screen; the chip always tells the truth. |
| A5 | P0 | [FE] | Delete `api/scenarios/operationalIncidentScenario.ts` (UNWIRED, buggy). | File gone. |
| A6 | P1 | [FE] | **Operator edits a plan** instead of building one: remove/add a vehicle, move a target, change a trigger time → `PATCH /plans/{id}` (merge-patch) → `POST /plans/validate` → re-simulate. | An edited plan B′ appears next to A/B with its own what-if. |
| A7 | P1 | [SPEC]+[BE]+[AG] | Optional: **"Pedir planos" button.** Needs a way for the UI to request plans (e.g. `POST /simulations/{id}/plan-requests` that the agents watcher consumes, with status). Until then A1's watcher is enough. | Proposal approved or rejected. |
| A8 | P1 | [AG] | Tag/label hygiene: agents stop titling with `[lab]` in service mode; plans carry `variant`, `strategy`, `alertLevel` and an `objective` the UI can show as "A: vidas primeiro / B: área ardida". | Plans read well in the UI without decoding. |

### Epic B — Roads are mandatory, enforced by the backend (fixes R5)

| ID | Pri | Vertical | Task | Done when |
|---|---|---|---|---|
| B1 | P0 | [BE] | **Max snap distance.** `RoadGraph.Snap` returns the node *and* its distance; `RoutingService` rejects (`no_road_access`) when origin/target is farther than `Routing.MaxSnapM` (settings, e.g. 300 m) and adds a warning above a lower threshold. | A target in the middle of a forest 2 km from any road gives `found:false` + reason, not a silent route to some node. |
| B2 | P0 | [BE] | **Last-mile leg.** The route returns the parking point (snapped node) and the on-foot distance/time to the target (walking speed from `Rules`). The crew's effect on the fire starts at *drive + walk* time. | `RoutePlan` exposes both legs (see B7 for the field); `PlanInterventions` uses the sum. |
| B3 | P0 | [BE] | **Backend computes ETAs, never trusts them.** In `PlanInterventions.CrewAsync/LineAsync` and `DispatchService`, compute ETA with `RoutingService` from the vehicle's station/position at the trigger time; ignore or only *compare* client `etaMinutes` (warn on > X% mismatch). No ETA ⇒ unreachable ⇒ no effect, never 0. | Removing `etaMinutes` from a plan does not make crews appear on the fire at T+0. |
| B4 | P0 | [BE] | **Validate routes in plans and dispatches.** `DispatchService.cs:46` must not prefer `input.Route` blindly; `PlanValidator` checks every ground resource is routable at its trigger time (closures + predicted fire + vehicle profile) and emits `target_unreachable` / `route_off_network`. | A plan with a hand-drawn straight-line route fails validation. |
| B5 | P1 | [BE] | **Vehicle state is road-constrained.** `PATCH /vehicles/{id}/state` snaps ground-vehicle positions to the network (or rejects beyond `MaxSnapM`) unless `source=gps` explicitly. | A ground vehicle cannot be placed in a field via the API. |
| B6 | P1 | [BE] | Re-route on change: when a road closure is created or the fire cuts a road on an active route, recompute affected active dispatches' routes and ETAs (and log it). | Closing a road mid-operation reroutes units on the next tick. |
| B7 | P0 | [SPEC] | Contract packet for B1/B2: `RoutePlan.access { parkAt: LatLon, snapDistanceM, walkM, walkMinutes }`, new issue codes `no_road_access`, `route_off_network`. | Approved and in `openapi.json` with examples. |
| B8 | P1 | [BE] | `RoadCutsCache` key includes road-network version (agents README proposal 5). | No 500 on `/threatened` after re-ingest. |

### Epic C — Server-side operation simulation (fixes R4; the keystone for B and the frontend)

| ID | Pri | Vertical | Task | Done when |
|---|---|---|---|---|
| C1 | P0 | [BE] | **`OperationSimulator`** in `Services/Operations/`: given a plan (or active dispatches) and the what-if fire run, step every unit minute by minute — order → drive (route geometry from `RoutingService`) → park/walk → work → refill at nearest reachable water point (`/water-points/near` logic) → refuel → rest (`Rules.crews.maxContinuousWorkMinutes`) → return. Port the useful behaviour of the deleted `DispatchPlanner` here. | Deterministic tracks for every unit of a plan's what-if. |
| C2 | P0 | [BE] | **Implement `GET /simulations/{id}/units` and `/units/{unitId}/track`** (already in the spec) from C1 output; flip the `units` capability to supported. | Endpoints return data; `dotnet test` passes contract tests. |
| C3 | P0 | [BE] | Couple C1 with the fire: crew effect windows (`CrewWorkSchedule`) come from the *actual* simulated arrival/refill windows, and a unit whose route is cut by fire is delayed or rerouted. Crew exposures (`crewExposures`) use real positions. | What-if fire and unit tracks agree with each other. |
| C4 | P0 | [FE] | **Render units from the backend.** `unitLayer.ts` reads `/units` + `/track`; road-following interpolation uses the track geometry. Remove any client position math. | Units on the map are exactly what the API returns. |
| C5 | P1 | [BE] | Live mode: when a plan is active, the backend (not the browser) advances dispatch status and vehicle state from C1 against wall clock or exercise clock (see Epic H). Delete the browser "writer" (`createWriter`). | Closing the browser does not stop or corrupt an exercise. |

### Epic D — Dynamic weather in the backend (fixes R8)

| ID | Pri | Vertical | Task | Done when |
|---|---|---|---|---|
| D1 | P0 | [BE] | **Fetch more from Open-Meteo:** `wind_gusts_10m`, `precipitation`, `cloud_cover`, `visibility`, `cape`, `is_day` (+ `weather_code` for the UI icon). Store in cache, expose in `WeatherSample` (`gustKmh`, `precipitationMmH`, `cloudCoverPct` already exist). | `/simulations/{id}/weather` shows rain/clouds for a rainy historical date. |
| D2 | P1 | [BE]+[EN] | Use what we fetch: gusts in spotting (native engine), precipitation → fuel moisture (already via humidity; also wet-fuel threshold that stops spread), cloud cover → solar term in `DeadFuelMoisture`. Mark each in `/capabilities` honestly. | Capability notes match behaviour. |
| D3 | P1 | [SPEC]+[BE] | **Storm cells (spatial weather).** New event `storm_cell { path: LineString, speedKmh, radiusM, start/end, outflowWindKmh, gustKmh, precipitationMmH, lightningPerMin }`. Backend turns it into per-member `wind_<m>.f32` grids (the engine seam already accepts them) + local precipitation. Expose `GET /simulations/{id}/weather/field?tMin=` (wind u/v + precip grid, coarse) for rendering. | A thunderstorm crossing the map visibly bends the fire and wets it locally. |
| D4 | P2 | [SPEC]+[BE] | **Dry lightning ignitions:** optional `lightningIgnitions: true` on a storm cell → new ignitions with probability by fuel moisture, listed in the simulation. Great for training. | New fires appear under a dry storm, deterministic by seed. |
| D5 | P1 | [BE] | `POST /weather/resolve` returns events *and* the derived series in one call so the UI preview equals what the engine will see (already close; verify with keyframes + all events). | Preview and run are byte-identical in weather. |

### Epic E — Dynamic weather & visual weather in the frontend (fixes R7, R9)

| ID | Pri | Vertical | Task | Done when |
|---|---|---|---|---|
| E1 | P0 | [FE] | **Weather timeline editor** (replaces the 4 sliders): a time axis over the scenario with draggable **keyframes** (wind speed, direction, gust, humidity, temp, rain) and **event chips** for every backend event (`wind_shift`, `wind_scale`, `wind_set`, `gust_burst`, `front_passage`, `precipitation`, `humidity_shift`, `temperature_shift`, `custom_series`). Base = "real for the date" or "manual". Every edit calls `POST /weather/resolve` and redraws the chart. | Operator builds "NW 20 km/h, front at T+90 swings to SW 45 km/h with rain at T+120" without typing JSON. |
| E2 | P0 | [FE] | **Wind on the map:** animated wind particles/streamlines over the terrain following `windFromDeg` (remember: FROM) and speed; gusts as pulses. Uses the global series now, the `weather/field` grid when D3 lands. | Wind direction is readable at a glance in 3D. |
| E3 | P0 | [FE] | **Sky & atmosphere driven by weather + time:** sun position from date/time/location (day/night, dusk), sky colour and fog density from `cloudCoverPct`/`visibility`/smoke, lights dimmed under overcast. Replace constants in `sceneEngine.ts:9,36-41`. | Night scenarios look like night; overcast looks overcast. |
| E4 | P0 | [FE] | **Clouds:** instanced billboard/volume cloud layer whose coverage = `cloudCoverPct`, moving with the wind at altitude. | Coverage visibly changes along the playback. |
| E5 | P1 | [FE] | **Rain:** GPU particle rain (density from `precipitationMmH`), wet-terrain darkening, reduced visibility; snow not needed. | Rain starts/stops when the series says so. |
| E6 | P1 | [FE] | **Storms:** cumulonimbus cell mesh following the storm path (D3), lightning flashes (`lightningPerMin`), outflow gust ring, optional thunder audio toggle. | A storm cell crosses the map in sync with the fire's reaction. |
| E7 | P1 | [FE] | Meteo tab becomes useful: current conditions card + full chart with gusts/rain/cloud bands + **fire-weather indicators** (e.g. "30-30-30" rule: T>30 °C, RH<30 %, wind>30 km/h highlighted), fine-fuel moisture. | Operator sees *why* the fire is accelerating. |
| E8 | P1 | [FE] | Weather HUD: add rain, clouds, visibility, day/night, and an "upcoming change in N min" alert from the series. | HUD warns before the wind shift. |

### Epic F — Agents grow up (fixes R6)

| ID | Pri | Vertical | Task | Done when |
|---|---|---|---|---|
| F1 | P0 | [AG] | **Travel time for every ground unit** via `POST /routing/route` (vehicle profile, `simulationId`, `avoid.predictedFire`); trigger + ETA drive when the action starts. Unreachable units are not assigned. (Until B3 lands the backend still trusts this ETA, so it must be right.) | README "whole fleet on site" limit removed. |
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
| G3 | P0 | [FE] | **Comparison view:** split-screen or swipe between base / A / B at the same minute + delta table (area, crown fire, buildings, population, crew exposures, roads cut). | Decision in one screen. |
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

## 4. Suggested order for the next 3 days

**Day 1 (critical path):** B7 proposal → B1, B2, B3, B4 [BE] · A1, F1, F2 [AG] · A2, A4, A5, E1 [FE]
**Day 2:** C1, C2, C3 [BE] · A3, C4, E2, E3, E4, G1 [FE] · D1 [BE]
**Day 3:** G2, G3 [FE] · E5 rain [FE] · I1 e2e script · demo rehearsal on one scripted scenario (front passage + rain + A/B + execution)

Everything P1/P2 goes after submission. Storm cells (D3/E6) and exercise mode (H1/H2) are the strongest post-hackathon features for training.

## 5. Contract proposals to raise now (PROTOCOL.md §1)

```markdown
[CONTRACT PROPOSAL: backend → openapi.json]
- Endpoint / Schema: RoutePlan, ValidationIssue codes
- Proposed change: add `access { parkAt: LatLon, snapDistanceM, walkM, walkMinutes }`; new codes `no_road_access`, `route_off_network`
- Reason: roads mandatory; crews park on the network and walk the last leg (B1/B2/B4)

[CONTRACT PROPOSAL: backend → openapi.json]
- Endpoint / Schema: WeatherEvent (new `storm_cell`), GET /simulations/{id}/weather/field
- Proposed change: moving storm cell event + coarse wind/precip field per minute
- Reason: spatial weather for storms and their rendering (D3/E6)

[CONTRACT PROPOSAL: agents → openapi.json]   (optional, A7)
- Endpoint / Schema: POST /simulations/{id}/plan-requests
- Proposed change: UI asks agents for plans; status queued/running/done
- Reason: "Pedir planos" button instead of a polling-only watcher
```

Still open from `agents/README.md` (verify before acting): `InterventionFuelRemoval` shape mismatch, evacuation not reducing `populationExposed`, `fuel_break` missing from `ActionType`, what-if → plan back-link.
