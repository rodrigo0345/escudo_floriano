import { useEffect, useState } from 'react';

import { compass } from '@/domain/georef';
import { useEngine, useWorld } from '@/engine/EngineContext';
import { Picker } from '@/engine/picking';
import { useAppStore } from '@/store/appStore';

export interface Tooltip {
  text: string;
  x: number;
  y: number;
}

export interface TerrainReadout {
  elevationM: number;
  slopeDeg: number;
  aspect: string;
  vegetation: string;
  lat: number;
  lon: number;
}

const HOVER_THROTTLE_MS = 60;
const CLICK_SLOP_PX = 4;

/**
 * Pointer interaction on the map: hover tooltips for facilities/places/water points, a terrain
 * readout under the cursor, and click-to-pick for the ignition point. Raycasting is throttled
 * and uses the engine's `Picker`; the three.js scene graph is never touched from React render.
 */
export function useMapPointer(): { tooltip: Tooltip | null; readout: TerrainReadout | null } {
  const engine = useEngine();
  const world = useWorld();
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [readout, setReadout] = useState<TerrainReadout | null>(null);

  useEffect(() => {
    if (!engine || !world) return;
    const canvas = engine.canvas;
    let downAt: [number, number] | null = null;
    let lastMove = 0;

    const onDown = (e: PointerEvent) => {
      downAt = [e.clientX, e.clientY];
    };

    const onUp = (e: PointerEvent) => {
      const s = useAppStore.getState();
      if (!s.pickIgnition || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > CLICK_SLOP_PX) return;
      const hit = engine.picker.pick(e.clientX, e.clientY, canvas.getBoundingClientRect(), [world.terrain.mesh]);
      if (!hit) return;
      const [lat, lon] = world.geo.toLatLon(hit.point.x, hit.point.z);
      s.setIgnition({ lat, lon });
      world.fire.setIgnition(lat, lon, 'Ignição');
      s.setPickIgnition(false);
      s.setHint('');
    };

    const onMove = (e: PointerEvent) => {
      const now = performance.now();
      if (now - lastMove < HOVER_THROTTLE_MS) return;
      lastMove = now;
      const bounds = canvas.getBoundingClientRect();
      engine.picker.setPointThreshold(Math.max(1.6, engine.camera.position.distanceTo(engine.controls.target) * 0.012)); // ~8 px in world units

      const text = Picker.tooltipFor(engine.picker.pick(e.clientX, e.clientY, bounds, world.pickables));
      setTooltip(text ? { text, x: e.clientX + 12, y: e.clientY + 12 } : null);

      const hit = engine.picker.pick(e.clientX, e.clientY, bounds, [world.terrain.mesh]);
      if (!hit) return;
      const geo = world.geo;
      const u = hit.point.x / geo.W + 0.5;
      const v = hit.point.z / geo.H + 0.5;
      const [slopeDeg, aspectDeg] = geo.slopeAspect(u, v);
      const [lat, lon] = geo.toLatLon(hit.point.x, hit.point.z);
      const data = useAppStore.getState().data;
      const [col, row] = geo.cellAt(lat, lon);
      const landcoverId = data?.landcover[row * geo.gridWidth + col];
      setReadout({
        elevationM: geo.elevAtUV(u, v),
        slopeDeg,
        aspect: compass(aspectDeg),
        vegetation: data?.vegetation.classes.find((k) => k.id === landcoverId)?.label ?? 'Sem dados',
        lat,
        lon,
      });
    };

    const onLeave = () => setTooltip(null);

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, [engine, world]);

  return { tooltip, readout };
}
