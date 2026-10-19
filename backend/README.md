# FireTrace backend

.NET 10. Three projects, one responsibility each; the contract they implement is `../api-spec/openapi.json` (see `../AGENTS.md`).

```
FireTrace.Engine         Runs a fire. Calls the engine (native C# or the ELMFIRE container) and keeps finished simulations on disk so they are never recomputed.
FireTrace.ExternalData   Everything that comes from third-party APIs (OpenStreetMap, Open-Meteo, terrain/imagery/land-cover services). Fetched once, stored locally (PostGIS + files), read from there. Also the `ingest` command line.
FireTrace.Core           The API: controllers, services, repositories. All the application logic. Uses the other two.
tests/FireTrace.Tests    Unit, API and architecture tests.
```

`Engine` and `ExternalData` know nothing about `Core` (nor about each other); only `Core` looks at the other two. `tests/.../Architecture` fails the build of the team if that changes.

## Inside FireTrace.Core

| Folder | What lives there |
|---|---|
| `Controllers/` | HTTP only: bind the request, call one service, return the result. No logic. |
| `Services/<Area>/` | The application logic, by area (Fire, Operations, Resources, Routing, Weather, Map, Crud, Policies). Functions of their inputs. |
| `Repositories/` | The only code that stores or loads things (PostgreSQL documents, run files). Services depend on the interfaces. |
| `Domain/<Area>/` | The persisted entities and value objects (records, enums). |
| `Models/<Area>/` | Request/response shapes that are not persisted. |
| `Configuration/` | Typed settings bound from `appsettings.json` (no value is hidden in code). |
| `Hosting/` | Composition root, background workers. |
| `Middleware/`, `Serialization/`, `Common/` | Problem+json errors, JSON options, small shared abstractions (`IIdGenerator`). |

## Rules (enforced by tests in `tests/FireTrace.Tests/Architecture`)

* **One type per file**, named like the file.
* **No side effects in the logic.** Time comes from `TimeProvider`, ids from `IIdGenerator`, files/HTTP/database only from repositories and the adapters in `Engine`/`ExternalData`. No static mutable state; caches are injected singletons.
* **Dependencies point inwards:** Domain ← Models ← Repositories/Services ← Controllers.
* **Settings, not constants:** every tunable value lives in `appsettings.json` (`Core`, `Engine`) or `externaldata.settings.json` (`ExternalData`).

## Run it

```bash
docker compose up --build backend          # from the repo root: API on http://localhost:8080, docs at /swagger
dotnet test backend/FireTrace.sln -c Release
docker compose --profile ingest run --rm ingest --location guimaraes   # load a location's third-party data
```
