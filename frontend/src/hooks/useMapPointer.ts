import { useEffect, useState } from 'react';
import type * as THREE from 'three';

import { compass } from '@/domain/georef';
import { useEngine, useWorld } from '@/engine/EngineContext';
import { Picker } from '@/engine/picking';
import type { VehicleActor } from '@/engine/vehicles/vehicleActor';
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
/** How long a vehicle's tag stays after the cursor leaves it. */
const UNHOVER_GRACE_MS = 250;

/** The vehicle a picked object belongs to (any mesh of its model, or its tag), found by walking up to the object that carries `userData.actor`. */
function actorOf(object: THREE.Object3D | undefined): VehicleActor | null {
  for (let o: THREE.Object3D | null | undefined = object; o; o = o.parent) {
    const actor = (o.userData as { actor?: VehicleActor }).actor;
    if (actor) return actor;
  }
  return null;
}

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
    let hovered: VehicleActor | null = null;
    let unhoverTimer: ReturnType<typeof setTimeout> | undefined;

    // the vehicle under the cursor shows its tag; it stays a moment after the cursor leaves it, so a jittery pointer does not make the tag flicker
    const unhover = () => {
      clearTimeout(unhoverTimer);
      unhoverTimer = undefined;
      if (hovered) hovered.hovered = false;
      hovered = null;
    };
    const hoverActor = (actor: VehicleActor | null) => {
      if (actor === hovered) {
        clearTimeout(unhoverTimer);
        unhoverTimer = undefined;
        return;
      }
      if (actor) {
        unhover();
        hovered = actor;
        actor.hovered = true;
      } else if (hovered && unhoverTimer === undefined) {
        unhoverTimer = setTimeout(unhover, UNHOVER_GRACE_MS);
      }
    };

    const onDown = (e: PointerEvent) => {
      downAt = [e.clientX, e.clientY];
    };

    const onUp = (e: PointerEvent) => {
      const s = useAppStore.getState();
      if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > CLICK_SLOP_PX) return;
      if (s.pickIgnitionSlot == null) {
        // a click on a vehicle: the side panel shows the action it is doing
        const clicked = actorOf(engine.picker.pick(e.clientX, e.clientY, canvas.getBoundingClientRect(), world.pickables)?.object);
        const unitId = clicked ? world.units.unitIdOf(clicked) : null;
        if (unitId) s.selectUnit(unitId);
        return;
      }
      const hit = engine.picker.pick(e.clientX, e.clientY, canvas.getBoundingClientRect(), [world.terrain.mesh]);
      if (!hit) return;
      const [lat, lon] = world.geo.toLatLon(hit.point.x, hit.point.z);
      const slot = s.pickIgnitionSlot;
      // a fire moved off a built-in scenario is no longer that scenario's fire: drop the preset's place name for a generic one
      // (a name the operator typed is theirs and stays), and the picker shows a custom scenario
      const presetLabels = new Set((s.data?.scenarios ?? []).flatMap((sc) => [sc.name, ...sc.ignitions.map((ig) => ig.label)]));
      const movedLabel = (label: string | undefined) => (!label || presetLabels.has(label) ? `Foco ${slot + 1}` : label);
      const next = s.ignitions.map((ig, i) => (i === slot ? { ...ig, position: { lat, lon }, label: movedLabel(ig.label) } : ig));
      while (next.length <= slot) next.push({ position: { lat, lon }, label: `Foco ${next.length + 1}` });
      s.setIgnitions(next);
      world.fire.setIgnitions(next);
      if (s.scenarioId && s.scenarioId !== 'custom') s.setScenario('custom');
      s.setPickIgnitionSlot(null);
      s.setHint('');
    };

    const onMove = (e: PointerEvent) => {
      const now = performance.now();
      if (now - lastMove < HOVER_THROTTLE_MS) return;
      lastMove = now;
      const bounds = canvas.getBoundingClientRect();
      engine.picker.setPointThreshold(Math.max(1.6, engine.camera.position.distanceTo(engine.controls.target) * 0.012)); // ~8 px in world units

      const picked = engine.picker.pick(e.clientX, e.clientY, bounds, world.pickables);
      const actor = actorOf(picked?.object);
      hoverActor(actor);
      // a vehicle shows its own status tag instead of the tooltip
      const text = actor ? null : Picker.tooltipFor(picked);
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

    const onLeave = () => {
      setTooltip(null);
      unhover();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      unhover();
    };
  }, [engine, world]);

  return { tooltip, readout };
}
