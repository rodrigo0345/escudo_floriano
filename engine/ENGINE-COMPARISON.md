# Fire-spread engines: corrected native engine vs ELMFIRE

This note records the model correction, the Guimarães fuel mapping, and the decision between the two engines that the backend can run
(`FireTrace:Engine:Provider` = `native` or `elmfire`). It is the reference for why the native engine is the default and what ELMFIRE is still for.

## 1. Decision

**Keep the corrected native engine as the default. Keep ELMFIRE as the high-fidelity validation/research provider.**

| Criterion | Native (corrected) | ELMFIRE |
|---|---|---|
| Surface physics | Rothermel (1972) with the full Scott & Burgan 40 table, size-class weighting, live/dead moisture, WAF and vector wind+slope | Rothermel + level-set PDE, full spatial wind/slope interaction |
| Crown fire | Van Wagner initiation and active-crowning test, crown intensity | Crown fire and torching, coupled with the level set |
| Spotting | Not implemented (`Spotting` is currently ignored) | Yes |
| Rain / gusts / live moisture | Rain wetting + extinction, gust factor, live herb/woody damping, aspect drying | Gust enters the `ws` column of `wx_<m>.csv` (`wind + GustFactor·(gust − wind)`, same factor as the native engine), foliar moisture feeds `FOLIAR_MOISTURE_CONTENT`; rain still reaches it only through the dead-fuel moisture series (ELMFIRE has no rain input) |
| Timed suppression | Yes (`SuppressionPlan` windows, direct attack fades with intensity) | No: the integration runs one shot and applies every intervention from minute 0 (`timed = provider != "elmfire"`) |
| Ensemble | In-process, one task per member, no container or file round-trip | One container job per simulation, per-member files and process overhead |
| Operational fit | Always available, deterministic, sub-second on a 60×60 test grid | Needs the engine container and its data; slower feedback loop |
| Best use | Interactive what-if, plan comparison, operational ensemble, water/rain/crown studies | Independent high-fidelity validation, spotting-sensitive research, model intercomparison |

The native engine now uses the same published surface-fire equations as ELMFIRE, so the remaining difference is the **front propagation
method** (minimum-travel-time Dijkstra vs level-set PDE) and the extra ELMFIRE features (spotting, full 3-D wind/slope coupling). For the
Guimarães decision-support loop, the native engine's speed and timed suppression outweigh those extras; for a formal validation exercise,
run both on the same job and compare `toa`, `flin` and the crown mask.

No OpenAPI change was needed: the provider is configuration, not a scenario field. A per-scenario engine choice would be a new
`EngineOptions` property and must be agreed in `api-spec/openapi.json` first.

## 2. What the native engine computes now

The physics lives in `backend/src/FireTrace.Engine/Native/`:

| File | Role |
|---|---|
| `FuelModelCatalog.cs` | The Scott & Burgan 40 table (loads, SAV, depth, moisture of extinction, heat content) in Rothermel's US units. |
| `RothermelSurfaceFire.cs` | The full Rothermel solution: size-class weighting, reaction intensity, heat sink, no-wind rate, wind and slope factors, effective-wind cap, Byram intensity. |
| `WindAdjustmentFactor.cs` | Andrews' 20-ft → midflame WAF; open and sheltered values blended by canopy cover (patchy Mediterranean stands). |
| `FireBehaviorModel.cs` | Per-cell orchestration: moisture/aspect, gust, WAF, crown fire, rain damping. |
| `MinimumTravelTimeSolver.cs` | Elliptical Huygens front expanded by minimum travel time, with suppression and local adjustment. |

Key equations and conventions:

- **Fuel bed.** Six classes: 1 h, 10 h, 100 h dead, dead herbaceous, live herbaceous, live woody. Dynamic grass models split the herbaceous
  load into cured (dead) and green (live) fractions from the live moisture: `green = clamp(M_live/0.9 − 1/3, 0, 1)`.
- **Rothermel.** `β = Σw/(ρ_p δ)`, `β_op = 3.348 σ'^(−0.8189)`, size-class weights `f_ij`, Albini `g_ij`, moisture damping
  `η_M = 1 − 2.59r + 5.11r² − 3.52r³`, mineral damping `η_s = 0.174 S_e^(−0.19)`, reaction intensity `I_R`, propagating flux `ξ`,
  effective heating number `ε`, heat of preignition `Q_ig`, no-wind rate `R₀ = I_R ξ / heat sink`, residence time `384/σ'`, flame depth
  `D_A = R₀ t_r`. Live moisture of extinction follows Albini's adjustment, so live fuel damping depends on the dead/live load ratio.
- **Wind.** The API/provider gives the 10-m wind. It becomes a 20-ft wind (×0.93) and then the midflame wind through the WAF. A gust enters
  as `wind + GustFactor × max(0, gust − wind)` (`GustFactor = 0.5`).
- **Slope and direction.** `φ_w = (C/F) U^B`, `φ_s = 5.275 β^(−0.3) tan²φ`; the two are added as vectors. The combined factor is capped
  by Rothermel's `0.9 I_R` effective-wind limit. The ellipse is elongated along the resulting vector, not along the wind alone.
- **Moisture.** Simard equilibrium from RH and temperature, first-order time lags for 1/10/100 h, rain wetting per mm, live herb/woody
  moisture from the scenario or settings. South/west aspects dry the 1-h fuel by `AspectMoistureSwingPct` (4 points by default).
- **Crown fire.** Van Wagner initiation `I₀ = (0.010 CBH (460 + 25.9 FMC))^1.5`; potential crown rate `R_active = 3.34 R_surface`; active if
  `R_active ≥ 3/CBD`; crown intensity from the crown load `CBD × (height − base)` and the crown rate. Passive torching burns a fraction of
  the crown load and does not accelerate the front beyond the surface rate.
- **Rain.** No damping below 0.5 mm/h, linear to zero at 4 mm/h, and the dead fuel absorbs 6 / 2.5 / 1.0 % per mm for the 1/10/100 h classes.
- **Weather source.** A scenario may use the provider (`base: provider`, ERA5/forecast) or be fully manual (`base: none`). The manual
  OpenAPI recipes are supported: `keyframes`, and a `custom_series` event whose samples carry time, wind, direction, temperature, humidity,
  gust and rain. A manual recipe never calls Open-Meteo; the first keyframe/sample also covers the fuel spin-up window. The `/weather/series`
  endpoint and the provider base remain available for real weather.
- **Water and barriers.** Riparian distance (`WaterInfluence`), rivers/roads/firebreaks (`BarrierSet`), and suppression windows
  (`SuppressionIndex`) still act through the per-cell adjustment; direct attack loses power as fireline intensity rises, and a fully
  effective direct attack can stop the front.

## 3. Guimarães vegetation → fuel model

`appsettings.json` (`FireTrace:Fuels`) is the only place the map classes are translated. The FBFM40 code is the **surface** fuel; the canopy
bands (`CanopyCoverPct`, `CanopyHeightM`, `CanopyBaseHeightM`, `CanopyBulkDensity`) drive the crown-fire tests.

| Id | Class | FBFM40 | Surface fuel | Canopy | SpreadFactor | Why |
|---:|---|---|---|---|---:|---|
| 0 | `sem_dados` | 99 (NB9) | none | — | 1.0 | No data is not a fuel; the old 161 (TU5) made unknown ground burn. |
| 1 | `agricola` | 101 (GR1) | short grass | — | 0.15 | Vineyards/row crops: low, discontinuous fuel. |
| 2 | `pasto` | 102 (GR2) | short grass | — | 1.0 | Pasture/meadow. |
| 3 | `rocha` | 99 (NB9) | none | — | 1.0 | Rock/bare soil. |
| 4 | `mato` | 145 (SH5) | high-load shrub | — | 0.7 | Tojo/giesta/urze: the dominant Portuguese shrub fuel. |
| 5 | `floresta` | 163 (TU3) | timber understory | 50 %, 16 m, base 4.5 m, CBD 0.10 | 1.0 | Mixed stand with a herb/shrub layer. |
| 6 | `urbano` | 91 (NB1) | none | — | 1.0 | Urban. |
| 7 | `agua` | 98 (NB8) | none | — | 1.0 | Water. |
| 8 | `eucalipto` | 147 (SH7) | very high-load shrub | 35 %, 22 m, base 4 m, CBD 0.10 | 1.2 | Eucalyptus litter + dense understory; low base height and volatile oils make Torching/active crown plausible. |
| 9 | `pinheiro` | 145 (SH5) | high-load shrub | 50 %, 18 m, base 8 m, CBD 0.08 | 0.7 | Pine stand with a shrub understory; the high base height makes crown initiation harder than eucalyptus. |
| 10 | `folhosas` | 162 (TU2) | timber understory | 70 %, 15 m, base 6 m, CBD 0.10 | 0.9 | Oak/chestnut: denser, moister litter, lower surface spread. |

The old mapping used SH5 for eucalyptus and `SpreadFactor 3.6`, which double-counted the fuel and hid the real difference between eucalyptus
and pine. The corrected mapping separates the surface model (SH7 vs SH5) from the canopy structure and keeps `SpreadFactor` as a small local
calibration (1 = no calibration).

## 4. Validation performed

All engine/configuration tests pass (46/46), including:

- `RothermelTests` — the C# solution against independent Rothermel/Behave reference rates for GR2 and SH5 (no-wind, 200 and 550 ft/min),
  vector wind+slope, curing, live moisture and the wind-adjustment blend.
- `NativeWeatherInteractionTests` — drizzle slows the fire, heavy rain extinguishes it, gusts push it further than the mean wind, hot/dry air
  burns more than cool/humid air, and green/wet live fuel slows it.
- `NativeFireEngineTests` — wind direction, wind strength, vegetation order (eucalyptus > pine > broadleaf), uphill spread, south vs north
  aspect, canopy shelter, crown fire in eucalyptus, river/road/cleared-strip barriers, coupled convective wind, and the sub-second 60×60 run.
- `WeatherTests` — manual keyframes and a keyframe-free `custom_series` carry gust and rain, and the manual first sample covers the spin-up.
- `EndToEndApiTests` — `/weather/resolve` accepts `base: none` with keyframes (including `gustKmh`/`precipitationMmH`) and with only a
  `custom_series` event; scenario create/get/patch preserves the manual weather recipe.

The full suite was run in the .NET 10 SDK container with the repository mounted and PostgreSQL reachable: **188 passed, 0 failed**. The run
needs the `guimaraes` location ingested (terrain, land cover, roads, water points, places, buildings) and migration
`006_weather_gust_precip.sql` applied, because the tests use the real PostGIS reader. The four landscape/fuel-removal tests that asserted the
old eucalyptus code were updated to 147.

### Measured Guimarães run

The original provider-seeded detail scenario `sc-penha-pior-hora-2026` (280x280 cells of 30 m, 180 min, 12 members) was run through
the API against the ingested PostGIS landscape, using the **provider** path. ERA5 at the Penha weather point: 36.1 °C, 16-17 % RH, mean wind
6.8 -> 15.5 km/h from 325-335°, gusts 20.9 -> 35.6 km/h and no rain; the 1-h fine fuel moisture settles at 3.5-3.7 %. Result: **961 ha
burned (401 ha/h), 528 ha crown (55 %), head 10.3 m/min at 146°** (downwind of the 332° wind), about 45.6 MW/m peak intensity, 83
buildings and 185 road segments affected. The first 12-member run took about 2.1 s including the Open-Meteo fetch; a repeat with the
weather already in PostgreSQL took about 0.6 s. The 360x360 concelho warm-ups were about 0.4-0.9 s per scenario.

For comparison, the same scenario run before the gust/precipitation fields were carried from Open-Meteo into the weather track burned
22.7 ha with 7.7 ha of crown (4.7 MW/m peak). The gust bridge in section 6 is therefore not cosmetic: it materially changes the answer.
This is a plausibility check on a hypothetical scenario, not a validation against an observed fire.

### Manual-weather run (current API recipe)

The same Penha ignition was run with the manual OpenAPI recipe: `base: none`, 180 min, 12 members, wind 35 km/h from 335°, gusts
55 -> 45 km/h, 34 -> 31 °C and 18 -> 22 % RH, no rain. No network request was made. The 1-h fine fuel moisture settles at 3.7 -> 4.2 %.
Result: **1214 ha burned, 755 ha crown (62 %), head 11.8 m/min at 141°**, peak intensity at the `u16` ceiling (65,535 kW/m), 111
buildings and 118 road segments affected. The 12-member run took **0.57 s**. The higher area than the provider run follows directly from
the stronger manual wind (35 km/h versus 15.5 km/h); it is a sensitivity result, not a forecast.

On a fresh database the seeder now creates `sc-penha-pior-hora-2026` in this manual mode (35 °C, 17 % RH, 35 km/h from 335°, gust
55 km/h); the same 12-member run produced **1192 ha, 735 ha crown (62 %), 111 buildings**, again at the `u16` ceiling. This is the
scenario a new installation runs without any Open-Meteo request. The provider path is still available by setting `base: provider`.

Run the same checks (host has no .NET 10 SDK, so use the SDK image):

```powershell
docker run --rm -v "${PWD}:/repo" -w /repo/backend `
  mcr.microsoft.com/dotnet/sdk:10.0 dotnet test --nologo --filter "FullyQualifiedName~FireTrace.Tests.Engine"
```

For a live ELMFIRE comparison, start the worker and run the same physical checks against it:

```powershell
docker compose up -d engine
docker run --rm -v "${PWD}:/repo" -w /repo/backend `
  mcr.microsoft.com/dotnet/sdk:10.0 dotnet test --nologo --filter "FullyQualifiedName~FireTrace.Tests.Engine.FireBehaviourTests"
```

No ELMFIRE benchmark was run in this session (the worker container was not running), so the performance comparison above is structural, not a
measured head-to-head. The native 60×60 sub-second result is measured by `NativeFireEngineTests.Runs_in_well_under_a_second_for_a_grid_this_size`.

## 5. ELMFIRE runtime (measured)

The container was benchmarked in place (`DUMP_TIMINGS = .TRUE.`, 280×280 cells at 30 m, 180 min, one member) before changing anything. The
whole simulation was 301 s, and the internal timer showed **145.9 s of 147.0 s inside the Lagrangian ember transport** (timer bucket 46,
`LAGRANGIAN_SPOTTING_MAIN`). The cause is not the number of firebrands: `CLEAR_USED_EMBER` allocates and copies `SPOTTING_STATS` every
timestep, and that array is dimensioned `EMBER_TRACKER_SIZE = 10_000_000` — a compile-time parameter. Lowering `EMBER_GR` by 100× or
enabling `STOCHASTIC_SPOTTING` changed the wall time by less than 1%, which confirms the diagnosis.

Two changes were made in `engine/runner.py`:

| Change | Effect |
|---|---|
| `ACCUMULATION_MODEL = 'EULERIAN'` (was `'LAGRANGIAN'`) | 147 s → 0.8 s on the 90-min benchmark; burned area 872.9 → 872.2 acres (< 0.1%) |
| `STOCHASTIC_SPOTTING = .TRUE.` | the configured `GLOBAL_SURFACE_FIRE_SPOTTING_PERCENT_MIN/MAX` (0.1–0.5 %) is actually applied; without it ELMFIRE keeps `SURFACE_FIRE_SPOTTING_PERCENT = 100` and every qualifying front cell spots |

End-to-end, through the HTTP worker on the same grid and duration: **one member 301.3 s → 1.7 s; thirteen members 7.3 s** (2 waves of 8 on
`WORKERS=8`). A coupled 12-member simulation therefore drops from ~15–18 min to roughly 12 s. `TARGET_CFL` stays at ELMFIRE's reference 0.4;
it is env-overridable (`ELMFIRE_TARGET_CFL`), and 0.8 was measured to halve the remaining time with a 0.3% area change, if ever needed.

## 6. Known limits / next steps

- **Spotting.** `FireJob.Spotting` is ignored by the native engine. If spotting-sensitive runs matter, use ELMFIRE until an ember-transport
  model (intensity/wind-dependent launch, deterministic seeded landing) is added.
- **3-D wind/slope projection.** The native model adds wind and slope as horizontal vectors; ELMFIRE projects them onto the slope plane.
- **Live fuel seasonality.** Live herb/woody moisture comes from the scenario or settings; the dynamic grass curing is derived from live
  herbaceous moisture, but there is no independent phenology/drought index. The API already allows a scenario to set `fuelMoisture`.
- **Rain.** It is a moisture source plus a spread damping, not a full soil/water balance.
- **Aerial drops.** Water volume is translated into suppression effectiveness/duration by `InterventionApplier`; it is not a grid water-depth
  balance.
- **Per-scenario engine choice.** Not exposed in `api-spec/openapi.json`; only the server configuration selects the provider.

## 7. Contract impact

None. `api-spec/openapi.json` was not modified. The weather samples now fill optional fields that the contract already defines —
`gustKmh`, `precipitationMmH` and `fuelMoisture` — from the same moisture series the engine uses (`SimulationService`), so the UI and the
agents see the rain/gust/live-fuel state that actually drove the run.

The manual weather path uses the existing `WeatherSpec` contract: `base: none` plus `keyframes`, or `base: none` plus a `custom_series`
event. Both are accepted by `/weather/resolve` and by simulations, and neither calls Open-Meteo. The scenario seeder now leaves an existing
built-in scenario untouched, so a manual weather correction made through the API survives a backend restart; `/weather/series` and
`base: provider` remain the explicit real-weather paths.

The gust and foliar-moisture corrections stay inside the internal `backend ↔ engine` seam, so the public contract is untouched as well:
`ElmfireJobFiles` folds the gust into the `ws` column of `wx_<m>.csv` (same `GustFactor` as the native engine) and adds the optional
`foliar_pct` key to `meta.json`, which `runner.py` reads with `.get("foliar_pct", 90)` and writes as `FOLIAR_MOISTURE_CONTENT`. No
`api-spec/openapi.json` schema, route or example changed.
