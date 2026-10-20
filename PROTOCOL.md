# Cross-Vertical Coordination & Handover Protocol — Escudo Floriano (FireTrace)

> **Role of this file:** [`AGENTS.md`](AGENTS.md) (imported by [`CLAUDE.md`](CLAUDE.md) via `@AGENTS.md`) holds the daily execution and contract rules, while `PROTOCOL.md` is the **extension for cross-vertical communication**—how our 4 teammates (`engine/`, `backend/`, `frontend/`, `agents/`) propose contract changes, report boundary bugs across verticals, and hand off sessions without walls of text.

## 1. Proposing & Syncing `api-spec/openapi.json` Changes

`api-spec/openapi.json` is enforced 1:1 against `backend/` by automated tests (`backend/tests/FireTrace.Tests/Api/EndpointCoverageTests.cs` and `ContractTests.cs`), and `frontend/src/api/schema.ts` is generated from it via `openapi-typescript`.

Any teammate can propose a contract change, but **no agent may edit `api-spec/openapi.json` unilaterally**:
1. **Propose first:** Stop and present the proposed contract diff to the teammate running the session (using your tool's interactive question feature if multiple design options exist).
2. **Output a Contract Change Packet in chat and suggest opening a GitHub Issue:**
   Always print the packet below in your response first (so it can be copy-pasted directly), and ask the teammate running the session if you should also open a GitHub Issue via `gh issue create`:
   ```markdown
   [CONTRACT PROPOSAL: <vertical> → openapi.json]
   - Endpoint / Schema: <e.g. POST /plans/validate or PlanAction>
   - Proposed change: <exact field, type, enum, or status code>
   - Reason: <1-line reason why the vertical needs this>
   ```
3. **Lockstep update once approved:** Update together:
   - `api-spec/openapi.json` (including its `example` payloads, which `ContractTests.cs` validates!)
   - `backend/src/FireTrace.Core/Models/` & `Controllers/` (verify with `dotnet test`)
   - `frontend/src/api/schema.ts` (regenerate via `openapi-typescript` if consumed by the UI)

## 2. Cross-Vertical Boundary Debugging ("Earliest Split")

When two verticals fail to talk to each other (`400`, `422`, `500`, missing fields, or raster mismatch):
1. **Do not silently edit the other teammate's vertical.**
2. **Localize the single earliest split:**
   - **REST boundary (`frontend ↔ backend` or `agents ↔ backend`):** Compare the exact HTTP method, URL, status code, and JSON payload against `api-spec/openapi.json`.
   - **Engine seam (`backend ↔ engine`):** Compare `/jobs/<id>` (`meta.json`, `landscape.i16`, `adj.f32`, `adj_<m>.f32`, `phi0.u8`, `wind_<m>.f32`, `wx_<m>.csv`, `toa.i16`, `flin.u16`, `crown.u8`) between `backend/src/FireTrace.Engine/Elmfire/ElmfireJobFiles.cs` and `engine/runner.py`.
3. **If the fault is in your OWN vertical → Fix it directly:**
   Do NOT output a packet or create an issue for bugs in your own vertical (unless instructed otherwise). Fix the code directly, verify it, and move on.
4. **If the fault is in ANOTHER vertical → Output a Boundary Bug Packet in chat and suggest opening a GitHub Issue (`gh issue create`):**
   Always print the packet below in your response first (so it can be copy-pasted), and ask if you should open a GitHub Issue (`gh issue create --title "[BOUNDARY SPLIT: <caller> ↔ <callee>] <short summary>" --body "..."`) so the owning teammate and their agent (`gh issue list` / `gh issue view`) can track and close it directly:
   ```markdown
   [BOUNDARY SPLIT: <caller vertical> ↔ <callee vertical>]
   - Endpoint / File: <URL or /jobs/<id> file>
   - Expected (per openapi.json / runner.py): <exact field/dtype>
   - Actual (at file:line): <what was sent or returned>
   ```

## 3. Session Handover Brief (`DONE` / `OPEN` / `NEXT`)

When handing off a session to another agent or teammate, ship **three bullet lists only** (no narrative):
- **DONE:** Endpoints, simulation mechanics, UI views, or MAS flows wired (`file:line`, and whether verified live or **`untested`**).
- **OPEN:** Decisions taken on the user's behalf, **`UNWIRED`** code with no live caller yet, mocked dependencies, or pending `openapi.json` proposals.
- **NEXT:** The single next task on the critical path.
