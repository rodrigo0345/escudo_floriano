# Vertical Rules — `backend/` (.NET 10 Coordination API & Fire Engine)

> **Seam Counterparts:** `frontend/` & `agents/` (via `api-spec/openapi.json`), `engine/` (via `:9000` & `/jobs/<id>`)

## 1. Enforced C# Architecture & Contract Gate (`dotnet test`)

Read `backend/tests/FireTrace.Tests/Architecture/*.cs` and `backend/tests/FireTrace.Tests/Api/*.cs` before adding or moving types. Always run **`dotnet test`** before claiming a backend change is verified—these tests fail the build immediately on any violation:
- **One top-level type per `.cs` file (`ProjectStructureTests.cs`):** Every `.cs` file declares **exactly 1 top-level type**, and the filename must match the type name (`Foo.cs` → `class Foo`).
- **Layer boundaries (`LayerRulesTests.cs`):**
  - Inside `FireTrace.Core`: `Domain ← Models ← (Repositories | Services) ← Controllers` (and `Hosting` / `Middleware` sit at the outer edge).
  - Across projects: `FireTrace.Engine` and `FireTrace.ExternalData` must **not** reference `FireTrace.Core` or each other.
  - Controllers hold no domain/storage logic: never reference `IDocumentStore<`, `Npgsql`, `IMapReader`, or `IFireEngine` in `Controllers/`—only call `Services`.
- **No direct ambient state, I/O, or static collections (`SideEffectTests.cs`):**
  - Across **all** backend projects: never call `DateTime(Offset).(UtcNow|Now|Today)`, `Guid.NewGuid`, `Random.Shared`, or parameterless `new Random()` (allowed only in `ShortGuidIdGenerator.cs`, `ServiceCollectionExtensions.cs`, `FileFireResultCache.cs`). Inject `TimeProvider` and `IIdGenerator`, or pass an explicit seed `new Random(seed)`.
  - Inside `FireTrace.Core` (`Domain`, `Models`, `Services`, `Controllers`, `Middleware`): never call `File.*`, `Directory.*`, `Environment.*`, `Console.*`, or `Process.*`.
  - No static collection fields (`Dictionary`, `ConcurrentDictionary`, `List`, `HashSet`, `Queue`, `ConditionalWeakTable`, `Lazy`—even if `readonly`!) outside `Program.cs`.
  - Read configuration only through typed settings classes—never call `.GetValue("FireTrace…")` or `config["FireTrace…"]`.
- **1:1 OpenAPI coverage (`EndpointCoverageTests.cs` & `ContractTests.cs`):** Every route and example in `api-spec/openapi.json` is validated against the controllers and DTOs (`UnmappedMemberHandling.Disallow`).

## 2. Simulation & Engine Seam

- **Engine seam (`ElmfireJobFiles.cs` & `ElmfireEngine.cs`):** Keep `/jobs/<id>` binary/CSV formats (`landscape.i16` 8 bands, `adj.f32`, `adj_<m>.f32`, `phi0.u8`, `wind_<m>.f32`, `wx_<m>.csv`, `meta.json`) in lockstep with `engine/runner.py`.
- **Seeded ensemble & counterfactual runs (`Ensemble.cs`, `PlanInterventions.cs`, `SimulationService.cs`):**
  - `Ensemble.Members` (`Ensemble.cs:10`) derives each member's RNG seed deterministically from `(spec.Seed, memberIndex)`.
  - On `POST /plans/{planId}/simulate`, `PlanInterventions.ForPlanAsync` (`PlanInterventions.cs:24`) + `InterventionApplier.Apply` translate the plan's actions into physical interventions against the scenario.
- **Never leave failed jobs stuck in `running`:** Keep the `try/catch` in `SimulationService.RunAsync` (`SimulationService.cs:125-129`) so exceptions transition the simulation to `SimulationStatus.Failed` with `ProblemInfo` (`ApiException.Code` or `"internal_error"`).
