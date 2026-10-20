# firetrace-agents

Wildfire response agents, written **contract-first** against [`api-spec/openapi.json`](../api-spec/openapi.json) — the single
source of truth for every endpoint, field and enum they use (see [`AGENTS.md`](../AGENTS.md) and [`PROTOCOL.md`](../PROTOCOL.md)).

An **orchestrator** (central command) and **firefighter agents** (squad, fire truck, combat helicopter) read the backend's fire
simulation, decide what to do with a stated reason, publish plans **A** (life first) and **B** (burned area first), and — in a
*campaign* — keep deciding as the fire evolves over the whole simulated period.

## Modules (`firetrace_agents/`)

| Module | Role |
|---|---|
| `contracts.py` | Loads the contract; `validate_against_spec` checks every payload before it leaves. `UNSAFE_ON_WIRE`: interventions the spec lists but the live backend rejects (today `fuel_removal`). |
| `client.py` | `FiretraceClient`: typed wrapper over the API. Base URL **includes `/api/v1`**. Errors come as `ApiProblem` with the stable `code`. A failed simulation is *returned*, not raised. |
| `tiers.py` | The tier matrix: who may perform which intervention (a squad or a truck never performs `aerial_drop`). |
| `firefighter.py` | One agent per unit. Perceives `threatened` + `summary` (+ `/rules`), decides with a quantified `reason`. Works the sector it was given. |
| `sectors.py` | Turns the backend's predicted spread vectors into ranked **sectors** of the fire front and assigns units to them (or lays their lines end to end as one barrier). |
| `capacity.py` | How many metres of line a unit builds in a stage. **Only one rate is the backend's** (`FireLineRateMPerHourPerPerson`, 30 m/h per person); the rest are assumptions, marked in the file. |
| `life.py` | **Lives**: for each place in the fire's way, evacuate in time or shelter in place; vulnerable first. A model, not a backend measure (see limits). |
| `orchestrator.py` | Builds the team from the live fleet, collects decisions, guards them (tier matrix, `/capabilities`, resource conflicts), validates with `POST /plans/validate`, publishes plans A and B. |
| `campaign.py` | The rolling-horizon loop: forecast → plan → choose → execute → next state, with a **chained control** (same chain, no response). |

## Scripts (`scripts/`), run from the repo root

Start the backend first (`docker compose up -d --build backend`; the first start loads the map data, see `backend/README.md`).

```powershell
python agents\scripts\seed_fleet.py                         # demo fleet for Guimarães (idempotent; the backend also seeds its own)
python agents\scripts\compare_plans.py --scenario sc-penha --at-minute 60    # plans A/B with the full fleet, then without helicopters/trucks/squads
python agents\scripts\robustness.py --scenario sc-penha --at-minute 60       # the same plans on a wrong wind forecast
python agents\scripts\run_campaign.py --scenario sc-penha --start 60         # decide every 30 min; compares with the chained control
python -m firetrace_agents --simulation-id <id> --at-minute 60               # one decision, plans A and B
```

Results are printed, never written to files. Everything created in the backend is titled `[lab]`; nothing is deleted.
Open any simulation in the UI with `http://localhost:8081/?sim=<simulation id>` (tab **Planos** lists the plans of a baseline and draws them).

## How a plan is made

1. `GET /simulations/{id}/threatened`, `/summary`, `/vectors` and `GET /rules` give the situation (never a guessed position).
2. The orchestrator ranks the fire-front **sectors** and gives each unit one (and a place, if the life planner picks it).
3. Each agent proposes with a reason; plans A and B are composed (B: trucks fight from the start, squads evacuate), validated, published.
4. In a **campaign** this is repeated every stage on a fresh forecast, and fire lines (permanent) are carried to the next stage.

## Limits you should know before trusting a number

* **The backend now honours `start`, `durationMinutes` and `effectDurationMinutes`** (checked after merging `main`). Offsets count from the scenario start,
  so a decision taken at T+N is written with `start` = N. A campaign is still a chain of short simulations starting at `initialFire`, because there is no exact "resume".
* **What the campaign gains depends on how the backend models effects.** With the `native` engine (effects are time windows; a fire line is not direct
  suppression) `scripts/evaluate.py` gives a median change in burned area against the chained control of **−5%** (response from minute 0) and **−1%** (from
  minute 90), across 5 scenarios; only Penha (−15%) and Santa Marinha (−25%) gain with an early start, and without trucks nothing does. Before `main` was merged
  (effects held from the start of the window) the same matrix gave −61% and −28%: those numbers are obsolete. Fire lines alone cut ~3% in a probe; a
  `fuel_removal` break cut ~12% (see proposal 1).
* **Continuing from an outline is not exact**: a chained run ends ~9% larger than the uninterrupted one. Compare with the chained control, not the original run.
* **The backend never applies an evacuation** to `populationExposed` (checked in code and by experiment), so lives are the agents' own model with
  explicit assumptions (`life.py`). Only 2 of the 6 built-in scenarios put people in the fire's way.
* **Planning sees the forecast's own fire** (perfect foresight unless `--forecast-wind-shift` is used), starts the response with the whole fleet on site, and
  has no water, fatigue or travel time yet. Treat reductions as upper bounds.
* `fuel_removal` (the only tool that truly blocks the fire) is disabled: the spec and the backend disagree on its shape.

## Open proposals for the spec / backend (not applied: they belong to those verticals)

Each was found by running the agents against the live backend; the evidence is in the limits above.

1. **`InterventionFuelRemoval`**: the spec requires `effectiveness` and has no `removal`; the backend requires `removal` (`all|understory|trees`) and knows no `effectiveness`.
   The spec's shape answers HTTP 400. It is the only tool that truly blocks the fire (a 30 m break with `removal: all` stopped ~4x more than a fire line of the same length).
2. **Evacuation has no effect** on `GET /simulations/{id}/impact` (`populationExposed`), although `/capabilities` says it does. Nothing in `Services/` consumes `EvacuationIntervention`.
3. **`fuel_break`** is a supported action type in `/capabilities` and the backend, but missing from the spec's `ActionType`.
4. **A what-if does not point back to its plan** (`parentSimulationId` is empty; `?planId=` is not a filter): add `GET /plans/{id}/simulations` or fill `parentSimulationId`.
5. **`RoadCutsCache` key** is only the simulation id: after the road network is ingested, cached cuts have 0 edges and `/threatened` answers 500 until a restart. Key it by network version.
6. **Exact continuation**: `initialFire` from an outline restarts the fire and ends ~9% larger. A "resume from simulation X at minute T" would remove the error.
7. Nice to have: facilities such as camp sites report no `population`; the seeder creates no helicopters and no evacuation transport.

## Tests

```powershell
.\agents\.venv\Scripts\python -m pytest agents -q      # or: uv run --with httpx --with jsonschema --with pytest python -m pytest agents -q
```

The suite is contract and logic testing against `httpx.MockTransport` (no live backend); the scripts above are the live checks.

## Adding an agent kind

The orchestrator keeps an `AgentRegistry`; any agent answering `decide(situation, assignment)` with a message carrying `objective`, a non-empty
`reason` and typed proposals can register. Firefighter white-lists live in `tiers.py`; a new `Intervention*` needs its schema in the spec first.
