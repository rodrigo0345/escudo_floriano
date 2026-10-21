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
| `gnr.py` | **GNR**: closes the roads `GET /simulations/{id}/road-status` says the fire cuts (or has cut), joins touching segments into one closure and puts a patrol at each end (`traffic_control_point`), the nearest unit that arrives before the fire does. Closures carry `exemptions: [emergency_vehicles]` (the backend's routing lets those through) unless the fire is above the rules' `noEffectFromKwm`. |
| `orchestrator.py` | Builds the team from the live fleet, collects decisions, guards them (tier matrix, `/capabilities`, resource conflicts), validates with `POST /plans/validate`, publishes plans A and B. |
| `alternatives.py` | Plans A (offensive: every unit that can work safely, plus fuel breaks ahead of the fire) and B (defensive: only what is needed, the reserve kept back, houses defended) as two real alternatives, each judged by the engine (area, buildings, units, wrong wind). |
| `judge.py` | **The safety rule: a plan that predicts a crew casualty is never published, A or B.** Each plan is judged on the forecast and on two runs with the wind wrong by 30° either way; the crews caught have their stay cut short or are not sent. |
| `fuelbreak.py` | Squads that are not on the fire's outline clear a fuel strip ahead of the fire (`fuel_removal`), only where they can get there, finish (15 m/h per person, the backend's rate) and be gone 20 min before the fire arrives. The engine applies a strip from minute 0, so this feasibility check is the plan's only realism guard. |
| `adaptation.py` | **Re-planning along the fire.** Every `AGENTS_REPLAN_MINUTES` (45) the agents read the plan's what-if run: if the fire is not under control they decide again with the units that are free (the reserve, those waiting at a staging point, those whose work ended, those still on the road) on the fire as the plan left it; a wave is kept only if the engine says it helps and keeps zero casualties, first trying to attack the fire, then to defend what is in its way. |
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

## As a service (docker compose)

The `agents` service in `docker-compose.yaml` runs `firetrace_agents/watcher.py`: every 10 s it asks `GET /simulations?kind=baseline&status=succeeded&updatedAfter=…`,
and for each baseline with no plans (`GET /plans?simulationId=`) it publishes plans A and B and asks for both what-if runs (`POST /plans/{id}/simulate`).
A baseline started from the UI has its plans in tab **Planos** about 45 s later (Falperra, measured), with no terminal involved.

```powershell
docker compose up -d --build agents      # needs the backend; never `down -v`
docker compose logs -f agents
```

Settings are the `AGENTS_*` variables listed at the top of `watcher.py` (poll interval, minute the plans decide on, house zones on/off...). Baselines whose label
starts with `[lab]` (the experiments of the scripts) are left alone, and a restart never plans twice. The image is built from `agents/` (the root `.dockerignore`
leaves it out) and reads the contract from the mounted `api-spec/`.

**The map replays the plan's units** (`frontend/src/domain/planUnits.ts`): when a plan is on the map each vehicle leaves its station when its action starts, follows the road the
backend stored for it (`resources[].route`), is on the spot at the backend's `etaMinutes`, works until its effect ends and then leaves the map. Everything comes from the plan the
backend stored and simulated, and the playback clock moves them; a helicopter or a crew on foot (no stored route) goes straight from its station. There is no water or fatigue in it
(the agents do not model them yet) in that fallback. The map reads the backend's own unit simulator first (`GET /simulations/{id}/units` and `/units/{unitId}/track`: route, arrival,
water, refills, rest, return) and only falls back to the plan on a server without it.

**Units arrive in waves (off by default: `OrchestratorAgent.arrival_waves`).** Measured: it helped Penha plan B (4.3 → 3.6 ha) and hurt Falperra (A 254 → 301 ha, B 340 → 424 ha), so the
single lead stays until the placement is per unit on arrival. The fire grows while the slower units drive, so the units are split by arrival time (before the median and after) and each wave is placed on the fire
where it will be when it gets there; a wave that arrives after the fire passed the intensity direct attack stops working at blocks ahead of the fire instead. A crew registered to
its organization and not to a station (the generic pool) leaves from the organization's station nearest the target.

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
* **Initial attack (`Orchestrator._initial_attack`, `_fit_on_outline`).** The backend weakens direct attack with the fire's intensity (nothing from `noEffectFromKwm`), so *when*
  and *where* the crews go decides everything. The orchestrator times the drive of each unit (the median is the lead); if the fire is still below that intensity when they arrive,
  crews go on the fire's own outline at that minute (not on lines ahead of it) and work as long as a crew can (`crews.maxContinuousWorkMinutes`); otherwise it blocks ahead as before.
  The backend multiplies the effect of crews on the same ground without limit, but its rules cap one crew at `maxEffectiveness`: crews fill a zone only up to that, the outline has
  `perimeter / (2 × zone radius)` zones, and the rest are in reserve. Measured on Penha, the same plan decided at T+0 / 15 / 30 / 45 / 60 min: **−100% / −99% / −98% / −37% / −1%**
  burned area against the base (travel times included). One scenario, with the forecast being the real fire; the backend warns `crew_in_fire` for these crews (casualties not
  measured), and the service now decides at T+0 (`AGENTS_AT_MINUTE`): at T+60 the same agents gain about 1%.
* **Plans A and B (`alternatives.py`) are two plans judged by the engine, not two orderings of one.** A is the maximum attack; B is the same fire fought so that no crew is caught
  (the backend's `CrewSafety` says a crew is caught if the ground it stands on burns while it is there: each exposed crew's stay is cut to end before the fire, or it is not sent) with
  the spare engines defending houses. To know what a plan costs the agent publishes it, asks for its what-if, reads `stats` and `crewExposures` and deletes it. Measured, A against B:
  Penha 3.2 ha / 12 casualties vs 3.2 ha / 0; São Sabagudo 377 ha / 12 vs 377 ha / 0; Santa Marinha identical (no casualties in either). **B was never worse than A in burned area**, so
  in these scenarios there is no real trade-off between them: the crews taken out were redundant. A genuine second axis (robustness to a wrong forecast, or the number of units committed) is still to do.
  The agent also sets `expectedDurationMinutes` from the crew's real stay: without it the backend counts casualties over a 30 min default window instead.
* **Units that cannot reach the fire are not dropped**: they go as near as the routing says is safe (800 m, then 1.6, 3.2, 6.4 km out) and wait there (`stage_resources`, one per organization).
  In São Bento that is 38 units that used to disappear. Building a pair of plans takes about 2.5 min per baseline (a candidate plan is published, simulated and deleted for each judgement).
* **GNR closures have no effect on the fire** (the backend uses closures for routing and road status, not for the spread). Every road the fire cuts until the end of the simulation is closed (at most 60 closures, the most urgent first; a road is shut *before* the fire reaches it, by the action's trigger). A road is cut into closures of at most 1500 m whose
  segments the fire cuts within 30 min of each other (`MAX_CLOSURE_M`, `MAX_CUT_SPREAD_MIN`), and the map draws them (orange: emergency vehicles pass, red: nobody) with the
  control points. Known rough edges: the intensity that decides whether emergency vehicles may cross is the fire's maximum at that minute (the contract has no intensity per
  road), many road ends are already inside the burned area by the time a patrol could arrive (at T+120 in Penha no end is reachable in time), and the firefighters' ETAs are
  computed before the plan's closures exist (a closure without the emergency exemption would lengthen their routes once activated).
* **Continuing from an outline is not exact**: a chained run ends ~9% larger than the uninterrupted one. Compare with the chained control, not the original run.
* **The backend never applies an evacuation** to `populationExposed` (checked in code and by experiment), so lives are the agents' own model with
  explicit assumptions (`life.py`). Only 2 of the 6 built-in scenarios put people in the fire's way.
* **Planning sees the forecast's own fire** (perfect foresight unless `--forecast-wind-shift` is used) and has no water or fatigue yet.
* **Travel time (`travel.py`)**: each unit's arrival comes from `POST /routing/route` (station → target, avoiding closures and the predicted fire; helicopters fly
  straight), the effect starts then (the backend uses each effect's own `start`, not the action's `etaMinutes`), and a unit with no route is not assigned.
  With it the Penha campaign gains **−0%** area against the chained control (without it, −15%, and −70% buildings with house zones): those gains came from units that
  were on site at minute 0. The campaign sends every unit from its station again each stage (it does not remember who is already deployed), which undervalues it.
  The last stretch off the network uses the backend's own limits (`Routing.WalkKmh` 3 km/h, `Routing.MaxSnapM` 500 m: constants in `travel.py`, since the contract does not expose them).
  The backend now checks plans the same way (`target_unreachable`, `route_off_network`) and stores its own route and `etaMinutes` for every ground vehicle of an action whose
  target it can read, so fire-attack actions carry `line` / `anchorPoint`. `--no-travel` restores the old assumption, but those plans are then rejected by the backend when a unit cannot get there.
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
