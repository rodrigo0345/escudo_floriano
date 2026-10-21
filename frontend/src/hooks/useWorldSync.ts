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
  const windEnabled = useAppStore((s) => s.windEnabled);
  const cityEnabled = useAppStore((s) => s.cityEnabled);
  const citySource = useAppStore((s) => s.citySource);
  const cityKey = useAppStore((s) => s.cityKey);
  const windDensity = useAppStore((s) => s.windDensity);
  const run = useAppStore((s) => s.run);
  const activePlan = useAppStore((s) => s.activePlan);
  const locationData = useAppStore((s) => s.data);
  const t = useAppStore((s) => s.t);
  const playing = useAppStore((s) => s.playing);
  const probMode = useAppStore((s) => s.probMode);
  const detailCache = useRef(new Map<string, Detail>());
  const smokeCache = useRef(new Map<string, Smoke>());
  const inFlightDetail = useRef(false);
  const latestDetailT = useRef(t);
  latestDetailT.current = t;
  const inFlightSmoke = useRef(false);
  const latestSmokeT = useRef(t);
  latestSmokeT.current = t;

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

  // the photoreal 3D city from local tiles (only ever on when the operator asked for it)
  useEffect(() => {
    if (!world) return;
    const { showBanner, setCityEnabled } = useAppStore.getState();
    if (!world.setCity(cityEnabled, citySource, cityKey) && cityEnabled) {
      setCityEnabled(false);
      showBanner(citySource === 'live' ? 'Cidade 3D ao vivo: falta a chave ou já se usaram as sessões de hoje.' : 'Cidade 3D: não há tiles locais.', 'warn');
    }
    // a live session ends with the layer: the key is cleared from memory when it is switched off
    if (!cityEnabled && citySource === 'live' && cityKey) useAppStore.getState().setCityKey('');
  }, [world, cityEnabled, citySource, cityKey]);

  // convective-wind field: reload with the run, then follow the playback minute
  useEffect(() => {
    if (!world) return;
    world.wind.setEnabled(windEnabled);
    world.wind.setDensity(windDensity);
    if (!run) {
      world.wind.setRun(null);
      return;
    }
    world.wind.setRun(run);
    world.wind.setTime(t);
  }, [world, run?.id, windEnabled]);
  useEffect(() => {
    if (world) {
      world.wind.setDensity(windDensity);
      if (run) world.wind.setTime(t);
    }
  }, [world, run?.id, t, windDensity]);

  // the agents' plan on the terrain (a structure-protection effect names a place, so places and facilities are looked up by id)
  useEffect(() => {
    if (!world) return;
    const where = new Map<string, { lat: number; lon: number }>();
    for (const p of locationData?.places ?? []) where.set(p.id as string, p.position);
    for (const f of locationData?.facilities ?? []) where.set(f.id as string, f.position);
    world.plan.setPlan(activePlan, where);
  }, [world, activePlan, locationData]);

  // a new run invalidates cached per-minute detail
  useEffect(() => {
    detailCache.current.clear();
    smokeCache.current.clear();
  }, [run?.id]);

  // perimeter + spread arrows for the current minute
  useEffect(() => {
    if (!world || !run) return;

    const minute = Math.floor(t);
    const key = `${run.id}:${minute}`;
    const cached = detailCache.current.get(key);
    if (cached) {
      world.fire.setPerimeter(cached[0]);
      world.fire.setArrows(cached[1]);
      return;
    }

    if (playing) {
      if (inFlightDetail.current) return;

      const fetchNext = async (wantedT: number) => {
        const intT = Math.floor(wantedT);
        inFlightDetail.current = true;
        try {
          const detail = await Promise.all([
            simulationsApi.perimeter(run.id, intT),
            simulationsApi.vectors(run.id, intT),
          ]);
          detailCache.current.set(`${run.id}:${intT}`, detail);
          if (useAppStore.getState().run?.id === run.id) {
            world.fire.setPerimeter(detail[0]);
            world.fire.setArrows(detail[1]);
          }
        } catch (e) {
          console.warn('detalhe do fogo:', (e as Error).message);
        } finally {
          inFlightDetail.current = false;
          const currentT = Math.floor(latestDetailT.current);
          const currentRun = useAppStore.getState().run;
          const isPlaying = useAppStore.getState().playing;
          if (isPlaying && currentRun?.id === run.id && currentT !== intT) {
            const nextKey = `${run.id}:${currentT}`;
            if (detailCache.current.has(nextKey)) {
              const nextCached = detailCache.current.get(nextKey)!;
              world.fire.setPerimeter(nextCached[0]);
              world.fire.setArrows(nextCached[1]);
            } else {
              void fetchNext(currentT);
            }
          }
        }
      };

      void fetchNext(minute);
    } else {
      let cancelled = false;
      const timer = setTimeout(async () => {
        try {
          const detail = await Promise.all([
            simulationsApi.perimeter(run.id, minute),
            simulationsApi.vectors(run.id, minute),
          ]);
          detailCache.current.set(key, detail);
          if (!cancelled && useAppStore.getState().run?.id === run.id) {
            world.fire.setPerimeter(detail[0]);
            world.fire.setArrows(detail[1]);
          }
        } catch (e) {
          console.warn('detalhe do fogo:', (e as Error).message);
        }
      }, DETAIL_DEBOUNCE_MS);

      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }
  }, [world, run, t, playing]);

  // smoke resource (plume height, roads without visibility) for the current minute
  useEffect(() => {
    if (!run || !smokeEnabled) {
      useAppStore.getState().setSmokeInfo(null);
      return;
    }

    const key = `${run.id}:${t}`;
    const cached = smokeCache.current.get(key);
    if (cached) {
      useAppStore.getState().setSmokeInfo(cached);
      return;
    }

    if (playing) {
      if (inFlightSmoke.current) return;

      const fetchNextSmoke = async (wantedT: number) => {
        inFlightSmoke.current = true;
        try {
          const info = await simulationsApi.smoke(run.id, wantedT);
          smokeCache.current.set(`${run.id}:${wantedT}`, info);
          if (useAppStore.getState().run?.id === run.id) {
            useAppStore.getState().setSmokeInfo(info);
          }
        } catch (e) {
          console.warn('fumo:', (e as Error).message);
        } finally {
          inFlightSmoke.current = false;
          const currentT = latestSmokeT.current;
          const currentRun = useAppStore.getState().run;
          const isPlaying = useAppStore.getState().playing;
          if (isPlaying && currentRun?.id === run.id && currentT !== wantedT) {
            const nextKey = `${run.id}:${currentT}`;
            if (smokeCache.current.has(nextKey)) {
              useAppStore.getState().setSmokeInfo(smokeCache.current.get(nextKey)!);
            } else {
              void fetchNextSmoke(currentT);
            }
          }
        }
      };

      void fetchNextSmoke(t);
    } else {
      let cancelled = false;
      const timer = setTimeout(async () => {
        try {
          const info = await simulationsApi.smoke(run.id, t);
          smokeCache.current.set(key, info);
          if (!cancelled && useAppStore.getState().run?.id === run.id) {
            useAppStore.getState().setSmokeInfo(info);
          }
        } catch (e) {
          console.warn('fumo:', (e as Error).message);
        }
      }, DETAIL_DEBOUNCE_MS);

      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }
  }, [run?.id, t, smokeEnabled, playing]);
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
