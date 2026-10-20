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
        const precipMmH = w?.precipitationMmH ?? 0;
        const rainVisM = precipMmH > 4 ? Math.max(1200, 5200 - precipMmH * 320) : null;
        const effectiveVisM = smokeVisM != null && rainVisM != null ? Math.min(smokeVisM, rainVisM) : smokeVisM ?? rainVisM ?? null;

        engine.updateAtmosphere(run.startMs + tf * 60000, w?.cloudCoverPct ?? 0, world.geo.centerLat, world.geo.centerLon, effectiveVisM);

        world.terrain.setWetness(precipMmH > 0 ? Math.min(1, precipMmH / 8) : 0);

        const rainDt = lastRainTs ? Math.min((ts - lastRainTs) / 1000, 0.1) : 0.016;
        lastRainTs = ts;
        world.rain.update(
          rainDt,
          precipMmH,
          w?.windKmh ?? 0,
          w?.windFromDeg ?? 0,
          engine.controls.target,
        );
      }
      world.units.update(tf);
    });
  }, [engine, world]);
}
