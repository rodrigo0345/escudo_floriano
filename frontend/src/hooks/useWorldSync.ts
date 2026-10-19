import { useEffect, useRef } from 'react';

import { simulationsApi, type PerimeterCollection, type Smoke, type SpreadVectorCollection } from '@/api';
import { useWorld } from '@/engine/EngineContext';
import { useAppStore } from '@/store/appStore';

const DETAIL_DEBOUNCE_MS = 160;

type Detail = [PerimeterCollection, SpreadVectorCollection];

/**
 * Keeps the GPU world in step with store state: base layer, smoke toggle, the current minute's
 * perimeter/arrows (debounced while scrubbing, cached per run+minute) and the roads/places
 * colored by the impact at that minute.
 */
export function useWorldSync(): void {
  const world = useWorld();
  const baseLayer = useAppStore((s) => s.baseLayer);
  const smokeEnabled = useAppStore((s) => s.smokeEnabled);
  const run = useAppStore((s) => s.run);
  const t = useAppStore((s) => s.t);
  const probMode = useAppStore((s) => s.probMode);
  const detailCache = useRef(new Map<string, Detail>());

  // base layer (satellite / topo / species)
  useEffect(() => {
    if (!world) return;
    const { setHint } = useAppStore.getState();
    let cancelled = false;
    if (baseLayer !== 'satellite') setHint('A gerar a camada…');
    world.terrain
      .setLayer(baseLayer)
      .then(() => !cancelled && setHint(''))
      .catch((e: Error) => !cancelled && setHint(e.message));
    return () => {
      cancelled = true;
    };
  }, [world, baseLayer]);

  useEffect(() => {
    if (world) world.smoke.enabled = smokeEnabled;
  }, [world, smokeEnabled]);

  // a new run invalidates cached per-minute detail
  useEffect(() => {
    detailCache.current.clear();
  }, [run?.id]);

  // perimeter + spread arrows for the current minute
  useEffect(() => {
    if (!world || !run) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const key = `${run.id}:${t}`;
      let detail = detailCache.current.get(key);
      if (!detail) {
        try {
          detail = await Promise.all([simulationsApi.perimeter(run.id, t), simulationsApi.vectors(run.id, t)]);
        } catch (e) {
          console.warn('detalhe do fogo:', (e as Error).message);
          return;
        }
        detailCache.current.set(key, detail);
      }
      if (cancelled) return;
      world.fire.setPerimeter(detail[0]);
      world.fire.setArrows(detail[1]);
    }, DETAIL_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [world, run, t]);

  // smoke resource (plume height, roads without visibility) for the current minute
  const smokeCache = useRef(new Map<string, Smoke>());
  useEffect(() => {
    if (!run || !smokeEnabled) {
      useAppStore.getState().setSmokeInfo(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const key = `${run.id}:${t}`;
      let info = smokeCache.current.get(key);
      if (!info) {
        try {
          info = await simulationsApi.smoke(run.id, t);
        } catch (e) {
          console.warn('fumo:', (e as Error).message);
          return;
        }
        smokeCache.current.set(key, info);
      }
      if (!cancelled) useAppStore.getState().setSmokeInfo(info);
    }, DETAIL_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [run?.id, t, smokeEnabled]);
  const smokeInfo = useAppStore((s) => s.smokeInfo);

  // roads and places colored by impact (and roads obscured by smoke)
  useEffect(() => {
    if (!world || !run?.impact) return;
    const state = run.impact.at(t);
    const prob = probMode ? new Map<number, number>(state.prob.map(([i, p]): [number, number] => [i, p / 100])) : null;
    const smoky = new Set<number>();
    if (smokeEnabled) {
      smokeInfo?.affectedRoadIds?.forEach((id) => {
        const index = world.roads.indexById.get(id);
        if (index != null) smoky.add(index);
      });
    }
    world.roads.update({ cut: new Set(state.cut), prob, smoky });
    world.assets.paintPlaces(state.layerStatus, probMode ? state.layerIsolated : null);
  }, [world, run?.impact, t, probMode, smokeEnabled, smokeInfo]);
}
