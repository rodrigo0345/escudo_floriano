import { useEffect } from 'react';

import type { TimelineRangeEvent } from '@/domain/simulationForm';
import { groundVisibilityFromSmoke, sampleWeatherAt } from '@/domain/weather';
import { useEngine, useWorld } from '@/engine/EngineContext';
import type { StormCell } from '@/engine/layers/stormLayer';
import { useAppStore } from '@/store/appStore';

const MIN_STEP_MS = 50;
const MAX_DT_S = 0.25;

/**
 * The per-frame loop: advances playback time, then pushes the current fractional minute to
 * the GPU (one uniform) and repositions smoke. Time lives in the store; the GPU draw happens in
 * the engine's own `requestAnimationFrame`, so React never re-renders on a frame boundary —
 * only the few components that display the whole minute subscribe to `t`.
 */
export function useFrameLoop(): void {
  const engine = useEngine();
  const world = useWorld();

  useEffect(() => {
    if (!engine || !world) return;
    let last = 0;
    let lastRainTs = 0;
    return engine.onFrame((ts) => {
      const s = useAppStore.getState();
      const run = s.run;
      const dt = last ? Math.min((ts - last) / 1000, MAX_DT_S) : 0.016;
      if (s.playing && run && ts - last > MIN_STEP_MS) {
        last = ts;
        const next = s.tf + s.speed * dt;
        if (next >= run.durationMinutes) {
          s.setPlaying(false);
          s.setTime(run.durationMinutes);
        } else if (Math.floor(next) !== s.t) {
          s.setTime(Math.floor(next), next);
        } else {
          s.setFractionalTime(next);
        }
      } else if (!s.playing) {
        last = ts;
      }
      const tf = useAppStore.getState().tf;
      if (run) {
        world.terrain.setFireTime(tf);
        world.fire.updatePulse(tf);
        world.wind.updateFlow(tf);
        world.smoke.update(tf, engine.camera, engine.renderer.domElement.height / engine.renderer.getPixelRatio());

        const w = sampleWeatherAt(run.weather, run.startMs, tf);
        const smokeVisM = groundVisibilityFromSmoke(s.smokeInfo);
        world.flames.update(tf, ts / 1000, engine.camera, engine.renderer.domElement.height / engine.renderer.getPixelRatio(), w?.windKmh ?? 0, w?.windFromDeg ?? 0);
        // the aftermath cloud is built once per simulation, the first frame that shows it
        if (world.aftermath.runId !== run.id && s.data) {
          world.aftermath.setRun(run.id, { ign: run.ign, dur: s.data.burnMinutes, width: run.gridWidth, height: run.gridHeight });
        }
        world.aftermath.points.visible = s.aftermathEnabled;
        if (s.aftermathEnabled) {
          world.aftermath.update(tf, ts / 1000, engine.camera, engine.renderer.domElement.height / engine.renderer.getPixelRatio(), w?.windKmh ?? 0, w?.windFromDeg ?? 0);
        }

        let effectivePrecipMmH = w?.precipitationMmH ?? 0;
        let effectiveCloudCoverPct = w?.cloudCoverPct ?? 0;
        let activeLocalEvent: TimelineRangeEvent | undefined;
        let activeStorm: { event: TimelineRangeEvent; buildStart: number; finish: number } | undefined;
        let stormIntensity = 0;

        // Continuous atmospheric event lifecycle:
        // 1. Buildup phase BEFORE startMinute: [startMinute - buildupMinutes, startMinute] (clouds form & thicken, no rain)
        // 2. Active phase: [startMinute, endMinute] (full clouds + full rain/storm)
        // 3. Dissipation phase AFTER endMinute: [endMinute, endMinute + dissipationMinutes] (rain stops, clouds gradually dissipate)
        for (const ev of s.customEvents) {
          if (!ev.enabled) continue;

          const tStart = ev.startMinute;
          const tEnd = ev.endMinute;
          // A front passage is an abrupt air-mass change: no cloud buildup before it and no lingering rain after it.
          const tBuildup = ev.type === 'front_passage' ? 0 : Math.max(1, ev.buildupMinutes ?? (ev.type === 'storm' ? 30 : ev.type === 'clouds' ? 15 : 20));
          const tBuildStart = Math.max(0, tStart - tBuildup);
          const tDissipate = ev.type === 'front_passage' ? 0 : Math.max(1, ev.dissipationMinutes ?? 20);
          const tFinish = tEnd + tDissipate;

          if (tf >= tBuildStart && tf <= tFinish) {
            if (ev.scope === 'local' && ev.centerLat != null && ev.centerLon != null && !activeLocalEvent) {
              activeLocalEvent = ev;
            }

            const targetPrecip =
              ev.type === 'storm' ? (ev.intensityMmH ?? 15)
              : ev.type === 'front_passage' ? (ev.intensityMmH ?? 4)
              : ev.type === 'rain' ? (ev.intensityMmH ?? 6)
              : 0;
            const targetCloud =
              ev.type === 'clouds' ? (ev.cloudCoverPct ?? 85)
              : ev.type === 'storm' || ev.type === 'rain' || ev.type === 'front_passage' ? 88
              : 0;

            let cloudFactor = 0;
            let precipFactor = 0;

            if (tf < tStart) {
              // 1. Buildup phase BEFORE startMinute:
              const u = (tf - tBuildStart) / (tStart - tBuildStart);
              cloudFactor = u * u * (3 - 2 * u); // smoothstep curve
              precipFactor = 0; // rain has not started yet
            } else if (tf <= tEnd) {
              // 2. Active event phase:
              cloudFactor = 1.0;
              const dur = Math.max(1, tEnd - tStart);
              const rainRamp = Math.min(ev.type === 'storm' ? 10 : 8, Math.max(2, dur * 0.15));
              if (tf < tStart + rainRamp) {
                precipFactor = (tf - tStart) / rainRamp;
              } else if (tf > tEnd - rainRamp) {
                precipFactor = Math.max(0, (tEnd - tf) / rainRamp);
              } else {
                precipFactor = 1.0;
              }
            } else {
              // 3. Post-event dissipation phase AFTER endMinute:
              const v = (tf - tEnd) / (tFinish - tEnd);
              cloudFactor = 1.0 - (v * v * (3 - 2 * v)); // smoothstep dissipation
              precipFactor = 0; // rain ceased at tEnd
            }

            if (targetPrecip > 0) {
              effectivePrecipMmH = Math.max(effectivePrecipMmH, targetPrecip * precipFactor);
            }
            if (targetCloud > 0) {
              effectiveCloudCoverPct = Math.max(effectiveCloudCoverPct, Math.round(targetCloud * cloudFactor));
            }
            if (ev.type === 'storm') {
              activeStorm ??= { event: ev, buildStart: tBuildStart, finish: tFinish };
              stormIntensity = Math.max(stormIntensity, cloudFactor); // the cell grows and fades with the same envelope as the rain
            }
          }
        }

        const rainVisM = effectivePrecipMmH > 4 ? Math.max(1200, 5200 - effectivePrecipMmH * 320) : null;
        const effectiveVisM = smokeVisM != null && rainVisM != null ? Math.min(smokeVisM, rainVisM) : smokeVisM ?? rainVisM ?? null;

        engine.updateAtmosphere(
          run.startMs + tf * 60000,
          effectiveCloudCoverPct,
          world.geo.centerLat,
          world.geo.centerLon,
          effectiveVisM,
          effectivePrecipMmH,
        );

        world.terrain.setWetness(effectivePrecipMmH > 0 ? Math.min(1, effectivePrecipMmH / 8) : 0);

        let cloudSpot: { x: number; z: number; radiusUnits: number } | null = null;
        if (activeLocalEvent && activeLocalEvent.centerLat != null && activeLocalEvent.centerLon != null) {
          const [u, v] = world.geo.uv(activeLocalEvent.centerLat, activeLocalEvent.centerLon);
          const x = world.geo.x(u);
          const z = world.geo.z(v);
          const radiusKm = activeLocalEvent.radiusKm ?? 4;
          const radiusUnits = (radiusKm * 1000) / world.geo.unit;
          cloudSpot = { x, z, radiusUnits };
        }

        const rainDt = lastRainTs ? Math.min((ts - lastRainTs) / 1000, 0.1) : 0.016;
        lastRainTs = ts;

        // One moving cumulonimbus per storm event (Epic E6): it crosses the territory (or the local spot) along the storm's own wind.
        // D3 will replace this derived path with the explicit `storm_cell.path`; the layer already only draws where it is told.
        let stormCell: StormCell | null = null;
        if (activeStorm && s.cloudsEnabled && stormIntensity > 0.02) {
          const ev = activeStorm.event;
          const fromRad = ((ev.windFromDeg ?? w?.windFromDeg ?? 0) * Math.PI) / 180;
          const dirX = -Math.sin(fromRad); // wind FROM: the air (and the cell) move towards the opposite bearing
          const dirZ = Math.cos(fromRad);
          const local = ev.scope === 'local' && ev.centerLat != null && ev.centerLon != null;
          const radiusUnits = ((ev.radiusKm ?? (local ? 2.5 : 3)) * 1000) / world.geo.unit;
          const progress = Math.max(0, Math.min(1, (tf - activeStorm.buildStart) / Math.max(1, activeStorm.finish - activeStorm.buildStart)));
          const travel = local ? radiusUnits * 1.1 : Math.max(world.geo.W, world.geo.H) * 0.55;
          let cx = 0, cz = 0;
          if (local) {
            const [u, v] = world.geo.uv(ev.centerLat as number, ev.centerLon as number);
            cx = world.geo.x(u);
            cz = world.geo.z(v);
          }
          const x = cx + dirX * (progress * 2 - 1) * travel;
          const z = cz + dirZ * (progress * 2 - 1) * travel;
          const gu = Math.max(0, Math.min(1, 0.5 + x / world.geo.W));
          const gv = Math.max(0, Math.min(1, 0.5 + z / world.geo.H));
          stormCell = { x, z, radiusUnits, intensity: stormIntensity, groundY: world.geo.y(world.geo.elevAtUV(gu, gv), x, z) };
          if (local) cloudSpot = { x, z, radiusUnits }; // rain falls under the moving cell, not at a fixed pin on the map
        }

        world.rain.update(
          rainDt,
          effectivePrecipMmH,
          w?.windKmh ?? 0,
          w?.windFromDeg ?? 0,
          cloudSpot,
        );

        world.clouds.setVisible(s.cloudsEnabled);
        if (s.cloudsEnabled) {
          world.clouds.update(
            rainDt,
            // Under a storm cell the deck is still overcast, but thinner on screen: the cell's tower and anvil must read as the
            // storm, not disappear inside a uniform grey wall. The atmosphere (sun, fog, visibility) keeps the full cloud cover.
            stormCell ? effectiveCloudCoverPct * 0.55 : effectiveCloudCoverPct,
            w?.windKmh ?? 0,
            w?.windFromDeg ?? 0,
            effectivePrecipMmH,
            engine.isNight,
            cloudSpot,
            engine.camera,
          );
        }
        world.storm.setThunderEnabled(s.thunderEnabled);
        world.storm.setListener(engine.camera.position);
        world.storm.update(rainDt, stormCell, engine.camera, engine.isLightningFlashingNow);
      }
      world.updateCity();
      const viewportPx = engine.renderer.domElement.height / engine.renderer.getPixelRatio();
      world.units.update(tf, engine.camera, ts / 1000, viewportPx);
      world.fleet.update(engine.camera, ts / 1000);
    });
  }, [engine, world]);
}
