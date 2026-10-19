---
name: firetrace-api-standard
description: Use this whenever you're about to write, review, or mock backend, frontend, or agents code in this repo that calls, implements, or talks to the FireTrace Coordination API in any way — or whenever you (or a teammate's agent) are new to this repo and need to understand how backend/frontend/agents/api-spec fit together. Establishes api-spec/openapi.json as the single source of truth for every endpoint, field, and enum the system uses: read it (or GET /capabilities, or run the Prism mock) before writing any code that calls or implements an endpoint — never guess a field name, enum value, status code, or response shape. Also covers the contract's house conventions (camelCase, units in field names, GeoJSON vs LatLon, pagination, PATCH semantics, error format, async operations, capability gating) so every agent — human-driven or autonomous — produces code that already matches the spec instead of needing to be reconciled with it later.
---

# FireTrace API standard

This is the shared background every agent working in this repo — a Claude Code session, a teammate's agent, or one of the runtime planning agents in `agents/` — should load before touching anything that crosses the backend/frontend boundary. Its purpose is to stop the most common way multi-person, multi-agent projects drift apart: everyone quietly inventing their own idea of what an endpoint returns.

## The repo, in one picture

```
backend/    the API implementation (FireTrace Coordination API)
frontend/   the operator UI
agents/     AI planning agents: read simulation results, propose response plans
engine/     the fire spread & ensemble simulation worker (see docker-compose.yaml)
api-spec/   openapi.json — the contract. The one thing all of the above must agree with.
```

None of `backend/`, `frontend/`, or `agents/` get to define the contract by what they happen to implement. `api-spec/openapi.json` defines it; the three folders are all, equally, clients of that definition. The spec's own `info.description` says this explicitly: it is "a fonte de verdade" (the source of truth) — any contract change goes through that file, in a pull request, *before* it's implemented anywhere.

## What the system actually does

Worth internalizing before writing any endpoint or any planning logic, because it explains why the API is shaped the way it is:

1. Each organization (GNR, Bombeiros, INEM, Proteção Civil, ...) registers its own resources in the frontend — stations, vehicles, personnel, equipment.
2. Anyone can define a **scenario** (an ignition point, weather that can change over time, which resources are available) and run a **simulation** against it.
3. An **agent** (one of the services in `agents/`) reads the simulation's results plus the live state — fire perimeter, available resources, roads, water sources, weather — and publishes **two plans, A and B**, each made of per-organization **actions** (send a vehicle, close a road, evacuate an area, ...). These are starting points, not final orders.
4. An **operator** picks one plan (or adjusts it), organizations execute their actions through the frontend and report progress, and those actions feed back into the fire model — e.g. firefighters holding a line in one spot actually stop the spread there. `POST /plans/{id}/simulate` is how you ask "what happens if we do this?" before committing.

The spec groups its resources the same way:

| Group | What it is | Tags |
|---|---|---|
| **Resources** | The map and everything stateful that gets created/read/updated/deleted. All have `id` and `updatedAt`. | Locations, Terrain, Organizations, Stations, Vehicles, Personnel, Equipment, Resources, Road Closures, Weather, Scenarios |
| **Simulation & analysis** | Async calculations and their results. Read-only. | Simulations, Results, Routing |
| **Decisions** | Dispatching resources with people and responsibility attached, and the A/B plans an operator picks and organizations execute. | Dispatches, Plans, Actions |

The spec documents the typical decision-maker's call sequence; it's worth reading as a tour of the whole API surface, not just a cheat sheet:

```
GET  /simulations/{id}/perimeters      → where the fire is (and /vectors for where it's heading)
GET  /simulations/{id}/threatened      → what the fire threatens in the next few hours
GET  /locations/{id}/area-stats        → houses, people, vulnerable population in a zone
GET  /vehicles?near=lat,lon&capability=wildfire_attack&availableAt=…
GET  /locations/{id}/water-points/near → where to refill
GET  /simulations/{id}/road-status     → which roads are cut, and when
POST /routing/route                    → a realistic ETA for a given vehicle
POST /plans/validate                   → check before publishing
POST /dispatches/validate              → check people, capabilities, and access
POST /dispatches                       → dispatch vehicles (headcount + responsibility)
GET  /locations/{id}/deployment        → who's doing what right now
POST /plans                            → publish plan A (and another POST for B)
POST /plans/{id}/simulate              → "what if we did this?"
GET  /plans?simulationId=…             → operator sees A and B; POST /plans/{id}/select picks one
```
If the operator corrects course or the situation changes, that's `PATCH /plans/{id}`.

## The hard rule: the spec is not documentation, it's the interface

Every agent working in this repo — whatever's writing backend code, whatever's writing frontend code, and the runtime planning agents in `agents/` that call the live API at decision time — follows the same rule:

**Before writing or generating a single line of code that calls, implements, or asserts the shape of an endpoint, read `api-spec/openapi.json` for that endpoint (or the relevant schema), or confirm it live via `GET /capabilities`.** Don't recall a field name from a previous task, don't infer an enum value from what "seems reasonable," and don't pattern-match off a similar-looking REST API you've seen before. If the spec doesn't answer the question, that's a sign the contract itself needs a PR, not that it's fine to improvise around it.

Two concrete ways to get the answer without running the real backend yet:
- **Mock it**: `npx @stoplight/prism-cli mock api-spec/openapi.json` serves the spec's own examples over HTTP — frontend and agents work can develop and test against this without waiting for `backend/` to exist.
- **Generate clients instead of hand-writing request code**: `openapi-generator` can produce TypeScript and Python clients straight from `api-spec/openapi.json`. A generated client can't drift from the contract the way hand-written `fetch`/`httpx` calls can.

And the reverse check for anyone implementing `backend/`: implement by **tag**, and expose real status through `GET /capabilities` — the `Capabilities` schema's own description says why: *"O contrato pode definir mais do que o motor já faz: a UI e os clientes consultam isto para desativar o que ainda não existe, e o servidor responde `422 unsupported_capability` se o ignorarem."* (The contract can define more than the engine already does: the UI and clients check this to disable what doesn't exist yet, and the server responds `422 unsupported_capability` if they ignore it.) In other words, it's completely normal for `api-spec/openapi.json` to describe an endpoint `backend/` hasn't built yet — that's a feature of working in parallel, not a bug. Check `/capabilities` (or the spec's examples) to tell "not implemented yet" apart from "I got the contract wrong."

Contract tests (`schemathesis` or `dredd`, run against the live backend in CI) are what actually enforces all of this over time — if you add or change an endpoint, the spec changes first, the tests are what catch an implementation that quietly drifted from it.

## Conventions you'll hit constantly

These come straight from the spec's own `info.description` — read them once so you stop re-deriving them per-endpoint:

- **Casing**: JSON fields are `camelCase`; enum *values* are `snake_case`; every `id` is an opaque string — never assume it's numeric or parseable.
- **Time**: RFC 3339 with timezone. Inside a scenario, a `TimeSpec` is *either* `offsetMinutes` (from the scenario start) *or* an absolute `time` — check which the field expects. To poll for changes on a list, use `?updatedAfter=<instant>` rather than re-fetching everything.
- **Units live in the field name** — don't add a unit you don't see: `…Kmh`, `…C`, `…Pct`, `…M` (metres), `…Ha`, `…Kwm` (kW/m), `…Mmin` (m/min), `…Minutes`. Headings are degrees, 0 = north. **Wind direction is "from," not "to"** — a field like `windFromDeg` describing a NW wind means air is moving *out of* the NW, i.e. blowing toward the SE. This one bites people — double-check it rather than assuming "direction" means "where it's heading."
- **Geometry**: shapes are GeoJSON, coordinates as `[lon, lat]` (GeoJSON order, not `[lat, lon]`); a single point uses `LatLon {lat, lon}` instead — a different shape on purpose, don't conflate them.
- **Lists are cursor-paginated**: request with `?limit=` (max 200) and `?cursor=`; response is `{items, nextCursor}`. Multi-value filters are comma-separated (`?status=available,assigned`), not repeated query params.
- **Partial updates are `PATCH` with `application/merge-patch+json`** (RFC 7396) — send only the fields you're changing; sending a full resource back as a "patch" will blow away anything you didn't include.
- **Errors are `application/problem+json`** (RFC 9457): a stable, machine-readable `code` (e.g. `validation_failed`, `resource_conflict`, `unsupported_capability`, `version_conflict`) plus `errors[]` for field-level detail. Branch your error handling on `code`, never on the human-readable `message`.
- **Long operations are async by default**: creating a simulation returns `202` with the resource in `queued` state; poll `GET /simulations/{id}` for progress. If you'd rather block, send `Prefer: wait=<seconds>` — if the server finishes within that window it responds `201` with the full result instead of making you poll.
- **Unknown fields are not errors**: adding an optional field is not a breaking change, and clients must ignore fields they don't recognize. This is what lets backend/frontend/agents evolve independently without constant version bumps — don't write a client that fails on an unexpected field.

## When this skill isn't enough

This covers orientation and the contract-first rule — it's deliberately not a backend/frontend coding-style guide (there isn't one yet; this is a fresh repo). For the exact shape of a specific endpoint or schema, go read it directly in `api-spec/openapi.json` (search for the path or schema name — it's large, don't read it start to finish) or, once `backend/` exists and is running, its live `/swagger`/`/capabilities`.
