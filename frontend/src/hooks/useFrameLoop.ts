import { useEffect } from 'react';

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
        world.flames.update(tf, ts / 1000, engine.camera, engine.renderer.domElement.height / engine.renderer.getPixelRatio(), w?.windKmh ?? 0, w?.windFromDeg ?? 0);

        // Check active custom weather events at minute `tf`
        const activeEvents = s.customEvents.filter(
          (ev) => ev.enabled && tf >= ev.startMinute && tf <= ev.endMinute,
        );
        const activeRain = activeEvents.find((e) => e.type === 'rain' || e.type === 'storm');
        const activeClouds = activeEvents.find((e) => e.type === 'clouds');

        let effectivePrecipMmH = w?.precipitationMmH ?? 0;
        if (activeRain) {
          effectivePrecipMmH = Math.max(
            effectivePrecipMmH,
            activeRain.intensityMmH ?? (activeRain.type === 'storm' ? 15 : 6),
          );
        }

        let effectiveCloudCoverPct = w?.cloudCoverPct ?? 0;
        if (activeRain) {
          effectiveCloudCoverPct = Math.max(effectiveCloudCoverPct, 85);
        } else if (activeClouds) {
          effectiveCloudCoverPct = Math.max(effectiveCloudCoverPct, activeClouds.cloudCoverPct ?? 80);
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

        // Check if an active custom weather event at current minute `tf` has a localized spot & dimension (Point 2)
        const activeLocalEvent = activeEvents.find(
          (ev) =>
            ev.scope === 'local' &&
            ev.centerLat != null &&
            ev.centerLon != null,
        );

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
      const viewportPx = engine.renderer.domElement.height / engine.renderer.getPixelRatio();
      world.units.update(tf, engine.camera, ts / 1000, viewportPx);
      world.fleet.update(engine.camera, ts / 1000);
    });
  }, [engine, world]);
}
