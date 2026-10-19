# FireTrace frontend

React 18 + TypeScript + Vite operator console: a GPU-rendered 3D terrain/fire viewer with playback and decision panels. It talks to the backend **only** through the typed axios layer in `src/api`, whose types are generated from `../api-spec/openapi.json` (the contract; see `AGENTS.md`).

## Run

```bash
npm install
npm run dev                      # http://localhost:5173, proxies /api/v1 → VITE_API_PROXY_TARGET (default http://localhost:8080)
npm run build                    # tsc -b && vite build
npm run generate:api-types       # regenerate src/api/schema.ts after the spec changes
docker compose up --build frontend   # from the repo root: http://localhost:8081 (nginx; proxies /api and /swagger to BACKEND_URL)
```

## Layers (dependencies point downward only)

| Layer | Folder | Responsibility |
|---|---|---|
| UI | `components/` | React components; no I/O, no three.js objects. `layout/` shell, `panels/` side tabs, `viewport/` map overlays, `common/` shared bits. |
| Hooks | `hooks/` | Glue: bootstrap, world lifecycle, per-frame loop, store→GPU sync, simulation orchestration. |
| Use cases | `usecases/` | Pure async "load a location / load a run" compositions of API calls. |
| State | `store/` | One Zustand store (plain data + setters). Components subscribe to narrow selectors. |
| GPU engine | `engine/` | three.js: `SceneEngine` (renderer/camera/loop), `World` (terrain, layers, smoke), the fire GLSL. Knows nothing about React or HTTP. |
| Domain | `domain/` | Pure logic: georeferencing, color ramps, weather interpolation, impact model, simulation-form → request mapping. |
| API | `api/` | axios client (`httpClient`), generic helpers (`pagination`, `binaryGrids`), one service per resource, generated `schema.ts`. |

## GPU

Fire, terrain shading and smoke are drawn by the GPU. The CPU uploads a result once per simulation (ignition-time/intensity float texture) and then sets a single `fireTime` uniform per frame; flame shape, flicker and color are computed per pixel in `engine/fireShader.ts`. Smoke is a shader-drawn point sprite system, roads are one vertex-colored mesh, arrows are instanced. The renderer requests the high-performance GPU (`powerPreference`).

## Not carried over from the old UI (the contract has no endpoint for them)

The spec has no `/simulations/{id}/wind`, no `/simulations/{id}/smoke/field` and no `barriers`/`riparian` location grids, so the wind-arrow overlay, the ground smoke-visibility layer and the "what stops the fire" overlay are not implemented. The weather HUD still shows ambient wind from `/simulations/{id}/weather`. If those overlays are wanted, add the endpoints to `api-spec/openapi.json` first.
