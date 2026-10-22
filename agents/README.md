# firetrace-agents

Wildfire response agents, written **contract-first** against [`api-spec/openapi.json`](../api-spec/openapi.json) — the single
source of truth for every endpoint, field and enum they use (see [`AGENTS.md`](../AGENTS.md) and [`PROTOCOL.md`](../PROTOCOL.md)).

An **orchestrator** (central command) and **firefighter agents** (squad, fire truck, combat helicopter) read the backend's fire
simulation, decide what to do with a stated reason, publish plans **A** (life first) and **B** (burned area first), and — in a
*campaign* — keep deciding as the fire evolves over the whole simulated period.

## Modules (`firetrace_agents/`)

| Module | Role |
|---|---|
| `contracts.py` | Loads the contract; `validate_against_spec` checks every payload before it leaves. `UNSAFE_ON_WIRE`: interventions the spec lists but the live backend rejects (empty: `fuel_removal` is sent with the backend's extra `removal` field). |
| `client.py` | `FiretraceClient`: typed wrapper over the API. Base URL **includes `/api/v1`**. Errors come as `ApiProblem` with the stable `code`. A failed simulation is *returned*, not raised. |
| `tiers.py` | The tier matrix: who may perform which intervention (a squad or a truck never performs `aerial_drop`). |
| `firefighter.py` | One agent per unit. Perceives `threatened` + `summary` (+ `/rules`), decides with a quantified `reason`. Works the sector it was given. |
| `sectors.py` | Turns the backend's predicted spread vectors into ranked **sectors** of the fire front and assigns units to them (or lays their lines end to end as one barrier). |
| `capacity.py` | How many metres of line a unit builds in a stage. **Only one rate is the backend's** (`FireLineRateMPerHourPerPerson`, 30 m/h per person); the rest are assumptions, marked in the file. |
| `life.py` | **Lives**: for each place in the fire's way, evacuate in time or shelter in place; vulnerable first. A model, not a backend measure (see limits). |
| `gnr.py` | **GNR**: closes the roads `GET /simulations/{id}/road-status` says the fire cuts (or has cut), joining touching segments into one closure. **A road is closed only with a patrol at every end, and from the moment the last one gets there** (a closure nobody enforces is one no driver knows about); otherwise it is not closed, and the plan says so. Emergency vehicles always pass (`exemptions: [emergency_vehicles]`). A GNR vehicle fighting the fire is not also sent to a road. |
| `placement.py` | **Safe placement.** With the forecast's ignition grid: a crew on the outline works from the burned side of the edge (the black does not burn again), at the minute it arrives; a crew working ahead of the fire leaves 10 min before it gets there; a crew with no safe spot is not sent (it stays free for later). |
| `duty.py` | **Water and fatigue** (F5): the backend's `CrewWorkSchedule` (tank ÷ pump, refill trips, fatigue, rest) gives the share of its strength a crew really delivers over its window (an engine with 3000 L works ~51% of 4 h, a crew on foot ~76%); its effect carries that effectiveness. One effect per crew: splitting them doubled the backend's validation time. |
| `support.py` | **Proteção Civil** (F3): shelter, route and people for every evacuation, ambulances for those who need help to move, public alerts (a second one `on_fire_arrival` for the places that shelter), the command post. **INEM** (F4): two ambulances on standby behind the crews where the fire never gets, the nearest hospitals on alert. |
| `revision.py` | **Revisions** (F9): when the operator selects or edits a plan, the agents check it again (safety, then re-plans) and revise it with `PATCH /plans/{id}`. |
| `firestate.py` | **The goal is to put the fire out**, not to hold it: when (and whether) the fire stops burning in a plan's what-if. The re-plans stop only once the plan puts it out, and the candidates are compared on it (after lives and houses). |

**How the firefighters read the fire.** Every plan starts with an assessment: the fire's intensity when the units get there. Weak enough for direct attack → **attack to put it
out** (crews from the burned side, as they arrive). Too strong → **contain it first** (people, then houses, then blocking ahead only where the crews leave before the fire comes) and
attack it when it weakens: each re-plan reads the fire again and says which it does.

**Plan B's reserve waits forward**: a quarter of its units at a safe point near the fire (`stage_resources`), not at their stations, so the next re-plan (or a new outbreak) has
them in minutes. It is held **only when the fire must be contained**: while it can still be put out, B too sends every unit that gets there in time (on Penha, holding back
two engines meant for the head let the fire escape: 9 ha with them, 612 ha without). A combat unit that would arrive with under 20 min of the run left is not sent.

**A fire too strong to attack head-on** (the new crown-fire physics): each stretch of the edge is judged by the intensity in its own direction (`sectors.plan_sectors`:
the head's intensity scaled by how fast that stretch spreads, as the backend now fights it), so the flanks are attacked while the head cannot be; where nothing can be
attacked, engines lay wet lines and squads open fuel strips ahead, only where they finish before the fire arrives (`fuelbreak.plan_wet_line` / `plan_strip`). The
initial attack is on if the **first group** of units to arrive can still work the fire. **Aircraft**: when the fire will outgrow direct attack before the bulk of
the crews arrives, every aircraft drops on the corridor its head runs along until then (spreading the late ones over the flanks was tried and did worse); each
works in rotations (drop, refill at the nearest water point or, amphibious aircraft, a large water body, come back: `Rules.aerial.cycleTime`) and flies by day
only (`daylight.py`). `scripts/seed_air_and_prepositioning.py` adds a maximum-alert day's resources (demo data, to be checked with CDOS/DECIR): 6 aircraft and
6 crews pre-positioned at forest points chosen from the map. On the new physics (forecast, ±30° wind safety): Penha 1013 ha / 105 buildings with no response →
626 ha / 52; Falperra 360 ha / 8 → 199 ha / 7; zero predicted crew casualties. **Reinforcements from the neighbouring districts** (`scripts/seed_reinforcements.py`: GRIF Porto, Viana do Castelo and Vila Real, and the district of Braga) enter the
municipality by its main roads `agents.mobilizationMinutes` after the call (30–90 min, example numbers to check with the CDOS); their actions are triggered then, and they show on the
map in orange. **Each plan carries the other organizations' numbers** (`metadata["agents.metrics"]`, shown in the plans panel): people evacuated in time (the agents' own model: the
backend does not count evacuations), roads closed and left open for lack of a patrol, ambulances on standby, units in reserve or without a safe spot, and whether the fire goes out.
| `orchestrator.py` | Builds the team from the live fleet, collects decisions, guards them (tier matrix, `/capabilities`, resource conflicts), validates with `POST /plans/validate`, publishes plans A and B. |
| `alternatives.py` | Plans A and B, both with the same priorities (**1. lives: crews and the people evacuated, 2. houses, 3. burned area**) and two ways to meet them: **A offensive** (every unit that can work safely attacks, aircraft prepare the ground just before the crews go in, fuel breaks ahead where there is time, the houses the fire reaches first defended) and **B defensive** (people and houses first, attack only where it is safe, aircraft timed with the crews as in A, no fuel breaks, a quarter of the units kept back as a reserve when the fire must be contained). Each is the best of a few candidates (F6), judged by the engine in that order of priorities. |
| `judge.py` | **The safety rule: a plan that predicts a crew casualty is never published, A or B.** Each plan is judged on the forecast and on two runs with the wind wrong by 30° either way; the crews caught have their stay cut short or are not sent. |
| `fuelbreak.py` | Squads that are not on the fire's outline clear a fuel strip ahead of the fire (`fuel_removal`), only where they can get there, finish (15 m/h per person, the backend's rate) and be gone 20 min before the fire arrives. The engine applies a strip from minute 0, so this feasibility check is the plan's only realism guard. |
| `adaptation.py` | **Re-planning along the fire.** Every `AGENTS_REPLAN_MINUTES` (45) the agents read the plan's what-if run: if the fire is not under control they decide again with the units that are free (the reserve, those waiting at a staging point, those whose work ended, those still on the road) on the fire as the plan left it; a wave is kept only if the engine says it helps and keeps zero casualties, first trying to attack the fire, then to defend what is in its way. |
| `campaign.py` | The rolling-horizon loop: forecast → plan → choose → execute → next state, with a **chained control** (same chain, no response). |
| `terrain.py` | **The ground where a crew works.** The backend slows a *road trip* on a slope but not a *crew* on one, so the agents do: a crew's effect is scaled by its slope, fuel (eucalyptus is not grass), whether the fire is running up the slope at it, and for an engine how far it is from a road; the plan says why in `safetyNotes`. Sectors are ranked by workability as well as danger, and an engine's refill trip is the real drive to water (`GET /locations/{id}/water-points/near?routeFrom`), not the backend's generic 12+4 min. Every number is an assumption to calibrate with the corporations, marked in the file. Switches: `AGENTS_TERRAIN`, `AGENTS_REAL_REFILL`. |
| `advisor.py` | The contract of an **advisor** (an LLM commander): at five places it is shown the options the rules have worked out (each with an id and the facts a commander wants) and chooses among them. It never writes ids, coordinates or action JSON; a choice that names something it was not shown, or breaks a rule, is discarded and the rules decide. No LLM in this module: contract, briefs and validators are plain Python. |
| `llm/` | **The LLM commander** (optional, `pip install .[llm]`): a LangGraph with one agent per organization (Bombeiros, Proteção Civil, GNR, INEM) and a commander's review, through `ChatOpenAI`. Doctrine and instructions in `prompts.py` (to be reviewed by the corporations), answer schemas in `schemas.py`, hard rules in `checks.py`. |

## Scripts (`scripts/`), run from the repo root

Start the backend first (`docker compose up -d --build backend`; the first start loads the map data, see `backend/README.md`).

```powershell
python agents\scripts\seed_fleet.py                         # demo fleet for Guimarães (idempotent; the backend also seeds its own)
python agents\scripts\seed_reinforcements.py                # reinforcement groups from the neighbouring districts (--dry-run, --remove)
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

The operator can also ask for a new pair at any time with **Pedir novo plano aos agentes** in tab **Planos** (optional note, and the minute on screen as the
decision minute), even when the baseline already has plans. That creates a plan request (`POST /simulations/{id}/plan-requests`); each poll the watcher claims the
oldest queued one (`POST /plan-requests/{id}/claim`), reports every step (`PATCH /plan-requests/{id}`) and closes it `done` with the plan ids or `failed` with the
reason. The UI follows the request live, so nobody has to tell the agents a simulation id.

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

**Units are placed as they arrive.** They are grouped every 15 min of arrival and each group is given ground on the fire as it will be when that group gets there; a stretch
too intense to attack head-on gets its crews working ahead of it instead, while that is safe (`placement.py`). (The earlier two-wave split, without safe placement, hurt Falperra:
A 254 → 301 ha, B 340 → 424 ha.) A crew registered to its organization and not to a station (the generic pool) leaves from the organization's station nearest the target, and in a
re-plan a crew that has finished a job leaves from where it is (`RouteRequest.from`).

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
  In São Bento that is 38 units that used to disappear. A pair of plans takes about 20-80 s per baseline (see *Speed* below; it was 2.5-7 min): a candidate plan is published, simulated and deleted for each judgement.
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

## Speed

A plan pair used to take 2.5-7 minutes (and failed outright when the backend answered HTTP 429). Measured on the same baselines, with **identical plans** (every action, effect, resource and route, and the summaries, compared with the ones the slow version published):

| baseline | before | now |
|---|---|---|
| Penha (T+0, 34 units) | ~415 s | **21 s** |
| Falperra heavy case | 136 s | **42 s** |

What changed:

* **Backend** (`PlanValidator`, `SmokePlume`, `FireResults`, `RoadGraph`...): publishing a plan went from 10-49 s to ~0.3 s. The smoke check scanned the whole grid for 121 past minutes for every action; the plan was validated twice on every publish; every stored route was re-checked against the road network; route costs were recomputed per vehicle. All are memoizations or hoistings that return exactly what they returned (the golden outputs of every results endpoint are byte-identical, and there are oracle tests for the rewritten arithmetic).
* **Limits**: the `planning` endpoints allow 6 at a time (was 1, with 5 queued), plan requests have their own light limiter, and the per-IP window is 6000/min (was 300). All are keys in `appsettings.json`.
* **Agents**: a 429 is waited out with `Retry-After` instead of failing the request; the judge remembers what it has already asked the engine (a plan is identified by a hash of its actions), runs A and B at the same time, and asks the engine for the central member only on the two wrong-wind runs (same casualties and area, checked on published plans; the forecast run keeps its ensemble because the next decision reads its probabilities). The contract check follows the spec's `discriminator`, so each action is checked against its own schema instead of all fifteen (8.5 s -> 0.4 s for a 33-action plan). `AGENTS_JUDGE_CENTRAL_ONLY=0` turns the central-only saving off.
* The backend logs where the time of each publish goes (`plano criado: ... rotas x ms, validação y ms`), and which limiter rejected each 429.

## The LLM commander

`AGENTS_COMMANDER=llm` (with `OPENAI_API_KEY` and `AGENTS_LLM_MODEL`; the account may be allowed only some models, and a refused one is detected at start) adds **one more candidate plan**: the first rules candidate with the commander's choices where it has them. The engine judges both exactly the same way and the better ships; a tie goes to the commander, because the engine measures what burns, not what a closure, a shelter or an ambulance spot is worth.

| agent | decides | among |
|---|---|---|
| Bombeiros | which sector each unit works | the stretches of the fire front, each with slope, fuel, fire-runs-uphill, road distance and workability |
| Proteção Civil | the order of the evacuations and the shelter of each | the places at risk; the shelters far enough and not reached by the fire |
| GNR | which closures are enforced and in what order the patrols are committed | the roads the fire cuts |
| INEM | where the ambulances wait and how many | the safe distances behind the crews |
| Comando | a note to the operator: what the plan does and what to confirm on the ground | the finished plan |

Safety is structural, not a matter of trusting the model: it answers with ids it was shown; an id it was not shown, or a rule it breaks (a crew on foot sent up a 25°+ slope the fire is running up, an evacuation order that puts a place the fire reaches 20 min sooner behind a later one), sends the answer back with what was wrong (twice), and what still breaks a rule is dropped item by item. A model error, a timeout, no key or a model the account cannot use means the rules decide that point (or the whole plan): the service always starts and always plans. The plan says what the commander decided and how the engine judged it against the rules (`summary` and `metadata["agents.llm"]`: model, calls, tokens, seconds, what was applied and discarded); every call is also logged as JSON lines (brief, answer, tokens) under `data/agents-logs` for audit. The re-plans along the fire (`adaptation.py`) and the operator's revisions use the rules only.

The doctrine in `llm/prompts.py` is a written-down starting point (LACES, uphill fire, direct attack vs containment, refill cycle, vulnerable first, patrols at both ends of a closure): **to be validated with the corporations**, like the assumptions in `terrain.py`, `life.py` and `capacity.py`. A model that accepts only its default temperature is fine (nothing is sent unless `AGENTS_LLM_TEMPERATURE` is set), so answers are not reproducible run to run: the judge, not the model, decides what ships.

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
8. **A crew on a steep slope is not slower in the engine**: `crew_deployment` strength is `f(people, water)` only (slope slows road trips, not crews). The agents scale `effectiveness` themselves (`terrain.py`); the engine should know the slope and fuel under a crew.
9. **`CrewWorkSchedule` refills with a fixed 12+4 min shuttle**: the agents use the real drive to the nearest water point in their plans, so the unit tracks on the map (the backend's) show a shorter refill than the plan assumed.
10. **Aerial wind and visibility limits** (`Rules.aerial.limits.maxWindKmh`, `minVisibilityM`) are published but enforced by nobody; evacuations, closures and standby spots have no effect in the engine, so it cannot judge them.

## Tests

```powershell
.\agents\.venv\Scripts\python -m pytest agents -q      # or: uv run --with httpx --with jsonschema --with pytest python -m pytest agents -q
```

The suite is contract and logic testing against `httpx.MockTransport` (no live backend); the scripts above are the live checks.
The LLM commander's tests (`tests/test_llm_graph.py`) run against a scripted stand-in for the model (no network, no key) and are skipped unless the extra is installed: `pip install -e "agents[test,llm]"`.

## Adding an agent kind

The orchestrator keeps an `AgentRegistry`; any agent answering `decide(situation, assignment)` with a message carrying `objective`, a non-empty
`reason` and typed proposals can register. Firefighter white-lists live in `tiers.py`; a new `Intervention*` needs its schema in the spec first.
