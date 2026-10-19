# firetrace-agents

AI planning agents for wildfire response, written **contract-first** against
[`api-spec/openapi.json`](../api-spec/openapi.json) — the single source of truth for
every endpoint, field and enum they use (see [`AGENTS.md`](../AGENTS.md)).

## What's in here

| Module | Role |
|---|---|
| `firetrace_agents/contracts.py` | Loads the OpenAPI contract and exposes `validate_against_spec` — runtime checks that any payload the agents send **validates against the spec** before it leaves the process. Also holds the enum pools (`INTERVENTION_TYPES`, `ACTION_TYPES`, `OBJECTIVES`, `RESPONSIBILITIES`) pulled from the spec. |
| `firetrace_agents/client.py` | `FiretraceClient`: thin typed wrapper over the API (capabilities, simulations, threatened report, summary, vehicles, personnel-pools, plans, plan-simulation). Rejects `problem+json` errors by machine-readable `code`, and validates outgoing payloads itself. |
| `firetrace_agents/tiers.py` | The **tier matrix**: who may perform which `Intervention`. Squad and truck can never perform `aerial_drop`; `road_closure` and `backfire` are orchestrator-only (command level). |
| `firetrace_agents/firefighter.py` | One agent per combat unit — squad member (personnel pool), fire truck (vehicle), combat helicopter (vehicle). Perceives via `GET /simulations/{id}/threatened` + `/summary`, decides with a quantified `reason`. |
| `firetrace_agents/orchestrator.py` | Central command: builds the team from the live fleet, collects decisions, guards them (tier matrix + `GET /capabilities` gating + resource conflicts), and publishes **plans A and B** via `POST /plans` (A = life first, B = area first). Eventual non-firefighter agents plug into `AgentRegistry` without touching this logic. |

## The priority rules

* **Fire reaching people within the decision horizon** → objective `protect_life`:
  ground tiers *evacuate first, combat only afterwards* (the combat action carries
  `trigger: {kind: on_action_complete, actionId: <evacuation action>}` and
  `dependsOn` the evacuation). The helicopter cannot evacuate people — its
  life-saving move is an `aerial_drop` with retardant *ahead* of the fire head, and
  its reason says explicitly "não evacuo; travo a frente".
* **Fire in an isolated region** → objective `minimize_burned_area`: each tier uses
  its strongest tool(s) — helicopter → `aerial_drop` on the head; truck → direct
  `crew_deployment`, switching to an indirect wet `fire_line` when the fire outruns
  crews; squad → `fire_line` handline, or `fuel_removal` (hand tools) when the fire
  is tame enough.
* Every `DecisionMessage` carries a **reason** — quantified (arrival minutes, people
  at risk, intensities) — which the orchestrator forwards verbatim into
  `action.rationale`, so the operator sees each agent's justification.

Interventions used: `aerial_drop`, `crew_deployment`, `fire_line`, `fuel_removal`,
`structure_protection`, `evacuation`. `road_closure`, `backfire` and other
command-level moves are reserved for the orchestrator/command agent.

## Setup (once)

The package is installed editable into `agents/.venv`, so `import firetrace_agents`
works from **anywhere** — everything below runs from the **repo root**:

```powershell
& .\agents\.venv\Scripts\python -m pip install -e agents  # already done; rerun after pulling
```

## Tests (contract tests)

```powershell
# from the repo root
.\agents\.venv\Scripts\python -m pytest agents -q
```

(From inside `agents/`, `.\.venv\Scripts\python -m pytest` still works.)

Individual test files also run standalone — `python agents\tests\test_tiers.py`
executes that file's tests via pytest (the modules detect direct execution —
e.g. the VS Code "Run Python File" button — and delegate to pytest instead of
failing on relative imports).

The suite is **pure contract testing**: every payload the runtime can emit (each
intervention type, every action, plans A and B for both situations) is validated with
`jsonschema` (Draft 2020-12) against the whole `api-spec/openapi.json` document.
Fixtures use `httpx.MockTransport` — no live backend needed. When the contract
changes, the tests fail loudly instead of the real server.

There is deliberately **no live-fire progress demo yet**: no `backend/` exists in the
repo. Two ways to get one later:

```powershell
# 1) mock from the spec itself
npx @stoplight/prism-cli mock api-spec/openapi.json

# 2) or a real backend when it lands
$env:FIRETRACE_BASE_URL = "http://localhost:8000"
```

* `FiretraceClient` reads `FIRETRACE_BASE_URL` for endpoint URLs (default: `http://localhost:8080`), validates outgoing payloads itself, and raises `ApiProblem` when the server answers `problem+json` — always branch on `code`, not message. `FIRETRACE_SPEC` points at an alternative spec file for the validators.
* `OrchestratorAgent.run_cycle` and `simulate_plan` will then exercise `POST /plans` → `POST /plans/{id}/simulate` against the live data in plan-conformance tests.

## Running the agents against a server

```powershell
# terminal 1 — from the repo root: a server built from the spec itself
npx @stoplight/prism-cli mock api-spec/openapi.json

# terminal 2 — from the repo root
.\agents\.venv\Scripts\python -m firetrace_agents --base-url http://localhost:4010
# (equivalent console script when the venv is activated: firetrace-run --base-url …)
```

Or set `$env:FIRETRACE_BASE_URL` once and use `--simulate` to also run the
what-if (`POST /plans/{id}/simulate`) of plan A. Useful flags: `--simulation-id`,
`--horizon 60`, `--location-id`, `--no-publish` (compose, don't POST),
`--plans-json` (dump the full payloads).

## Environment

`httpx`, `jsonschema`, `pytest` — pinned in `pyproject.toml`. Python ≥ 3.11.

## Adding an agent kind

The orchestrator keeps an `AgentRegistry`; any agent object answering `decide(...)`
with a message carrying `objective`, `reason` (never empty) and typed proposals can
register — the guard step only needs `tier`/`can_execute` equivalents. Firefighter
white-lists live in `tiers.py`; extend `TIER_PERMISSIONS` there, and add the matching
`Intervention*` schema to the spec (PR first) before the agents can emit it.
