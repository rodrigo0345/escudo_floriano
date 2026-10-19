# Vertical Rules — `engine/` (Python + ELMFIRE Worker)

> **Seam Counterpart:** `backend/src/FireTrace.Engine/Elmfire/`

## 1. Internal Seam (`backend ↔ engine`)

`engine/runner.py` exposes an internal HTTP worker on `:9000` (`POST /run` with `{"job": "<id>"}`, `GET /progress/<id>`, and `GET /health`). It does **not** speak `openapi.json` directly—`backend/` writes `/jobs/<id>` via `ElmfireJobFiles.cs` and reads the results back:
- **Inputs in `/jobs/<id>`:**
  - `meta.json` (`w`, `h`, `cell_m`, `tstop_s`, `dt_met_s`, `ign` / `ignitions`, `members`, `spotting`, `spotting_params`, optional `wind`)
  - `landscape.i16` (`(8, h, w)` `<i2` — `dem`, `slp`, `asp`, `fbfm40`, `cc`, `ch`, `cbh`, `cbd`)
  - `adj.f32` (shared `<f4`) and optional per-member `adj_<m>.f32` (`<f4`)
  - optional `phi0.u8` (`u1`, initial burned perimeter) and optional `wind_<m>.f32` (`<f4`, `(2, nbands, rows, cols)`)
  - `wx_<m>.csv` with header `ws,wd,m1,m10,m100,lh,lw` (`ws` in km/h at 10 m, `wd` in degrees FROM, fuel moistures in `%`)
- **Outputs in `/jobs/<id>/<m>/`:** `toa.i16` (`<i2`, minutes to arrival, `-1` = unburned), `flin.u16` (`<u2`, kW/m), `crown.u8` (`u1`, `0/1/2`), `log.txt`.
- **Response payload:** `{"members": {"<m>": {"error": null, "seconds": ..., "burned_cells": ...}}}`.
- **Lockstep rule:** Never rename `/jobs/<id>` files, change binary dtypes/band counts, or alter CSV columns without updating `backend/src/FireTrace.Engine/Elmfire/ElmfireJobFiles.cs` and `ElmfireEngine.cs` in sync. Only add new `meta.json` fields as optional keys with `.get()` defaults.

## 2. Error Handling & Member Execution

- **Missing optional ELMFIRE outputs (`flin`, `crown_fire`):** As in `runner.py:192-201`, if optional rasters (`flin_*.bil` or `crown_fire_*.bil`) are absent, write zeroed `flin.u16` / `crown.u8` arrays so the member still completes cleanly.
- **Member failures:** Currently, `ElmfireJobFiles.ReadResults` (`ElmfireJobFiles.cs:35`) throws `EngineUnavailableException` if **any** member returns a string `"error"` in `{"members": {m: {"error": ...}}}` (which transitions the simulation in `backend/` to `status: "failed"`). Do not change this error contract on one side without updating both `runner.py` and `ElmfireJobFiles.cs`.
