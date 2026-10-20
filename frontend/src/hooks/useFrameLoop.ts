import { useEffect } from 'react';

import type { TimelineRangeEvent } from '@/domain/simulationForm';
import { groundVisibilityFromSmoke, sampleWeatherAt } from '@/domain/weather';
import { useEngine, useWorld } from '@/engine/EngineContext';
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

        let effectivePrecipMmH = w?.precipitationMmH ?? 0;
        let effectiveCloudCoverPct = w?.cloudCoverPct ?? 0;
        let activeLocalEvent: TimelineRangeEvent | undefined;

        // Continuous atmospheric event lifecycle:
        // 1. Buildup phase BEFORE startMinute: [startMinute - buildupMinutes, startMinute] (clouds form & thicken, no rain)
        // 2. Active phase: [startMinute, endMinute] (full clouds + full rain/storm)
        // 3. Dissipation phase AFTER endMinute: [endMinute, endMinute + dissipationMinutes] (rain stops, clouds gradually dissipate)
        for (const ev of s.customEvents) {
          if (!ev.enabled) continue;

          const tStart = ev.startMinute;
          const tEnd = ev.endMinute;
          const tBuildup = Math.max(1, ev.buildupMinutes ?? (ev.type === 'storm' ? 30 : ev.type === 'clouds' ? 15 : 20));
          const tBuildStart = Math.max(0, tStart - tBuildup);
          const tDissipate = Math.max(1, ev.dissipationMinutes ?? 20);
          const tFinish = tEnd + tDissipate;

          if (tf >= tBuildStart && tf <= tFinish) {
            if (ev.scope === 'local' && ev.centerLat != null && ev.centerLon != null && !activeLocalEvent) {
              activeLocalEvent = ev;
            }

            const targetPrecip = ev.type === 'storm' ? (ev.intensityMmH ?? 15) : ev.type === 'rain' ? (ev.intensityMmH ?? 6) : 0;
            const targetCloud = ev.type === 'clouds' ? (ev.cloudCoverPct ?? 85) : (ev.type === 'storm' || ev.type === 'rain') ? 88 : 0;

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
              precipFactor = 1.0;
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
            effectiveCloudCoverPct,
            w?.windKmh ?? 0,
            w?.windFromDeg ?? 0,
            effectivePrecipMmH,
            engine.isNight,
            cloudSpot,
            engine.camera,
          );
        }
      }
      world.updateCity();
      world.units.update(tf);
    });
  }, [engine, world]);
}
