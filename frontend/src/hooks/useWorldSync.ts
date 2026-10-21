import { useEffect, useRef } from 'react';

import { simulationsApi, type PerimeterCollection, type Smoke, type SpreadVectorCollection } from '@/api';
import { lineStringCoordinates } from '@/domain/geojson';
import { loadBackendTracks } from '@/domain/backendUnits';
import { tracksFromPlan } from '@/domain/planUnits';
import { ORG_COLOR } from '@/domain/resourceLabels';
import { useWorld } from '@/engine/EngineContext';
import { useAppStore } from '@/store/appStore';
import { useResourcesStore } from '@/store/resourcesStore';

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
    // a road closure names road ids: the layer needs their shape (forest tracks are not in the road layer, and are not closed by the agents)
    const roadShape = (id: string) => {
      const at = world.roads.indexById.get(id);
      return at === undefined ? [] : lineStringCoordinates(world.roads.features[at].geometry);
    };
    world.plan.setPlan(activePlan, where, roadShape);
  }, [world, activePlan, locationData]);

  // the plan's units: leave their station, follow the route the backend stored for them, work, and leave the map (see `domain/planUnits`)
  const resourcesLoaded = useResourcesStore((s) => s.loaded);
  const planUnitsOnMap = useRef(false);
  useEffect(() => {
    if (!resourcesLoaded) void useResourcesStore.getState().load();
  }, [resourcesLoaded]);
  useEffect(() => {
    if (!world) return;
    if (!activePlan || !run || !resourcesLoaded) {
      if (planUnitsOnMap.current) {
        world.units.clear(); // only what this effect drew: the rehearsal tab draws its own
        planUnitsOnMap.current = false;
      }
      return;
    }
    const resources = useResourcesStore.getState();
    const typeOf = (id: string) => resources.organizations.find((o) => o.id === id)?.type ?? 'other';
    const nameOf = (id: string) => resources.organizations.find((o) => o.id === id)?.shortName ?? id;
    let cancelled = false;
    void (async () => {
      // the backend simulates the units of a plan's what-if (route, arrival, water, refills, rest, return); only a server without that falls back to the plan's stored routes
      const fromBackend = await loadBackendTracks(run.id, run, resources).catch(() => []);
      if (cancelled) return;
      world.units.setTracks(fromBackend.length ? fromBackend : tracksFromPlan(activePlan, run, resources), (id) => ORG_COLOR[typeOf(id)] ?? '#9aa0a8', nameOf);
      planUnitsOnMap.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [world, activePlan, run?.id, resourcesLoaded]);

  // a new run invalidates cached per-minute detail
  useEffect(() => {
    detailCache.current.clear();
    smokeCache.current.clear();
  }, [run?.id]);

  // perimeter + spread arrows for the current minute
  useEffect(() => {
    if (!world || !run) return;

    const key = `${run.id}:${t}`;
    const cached = detailCache.current.get(key);
    if (cached) {
      world.fire.setPerimeter(cached[0]);
      world.fire.setArrows(cached[1]);
      return;
    }

    if (playing) {
      if (inFlightDetail.current) return;

      const fetchNext = async (wantedT: number) => {
        inFlightDetail.current = true;
        try {
          const detail = await Promise.all([
            simulationsApi.perimeter(run.id, wantedT),
            simulationsApi.vectors(run.id, wantedT),
          ]);
          detailCache.current.set(`${run.id}:${wantedT}`, detail);
          if (useAppStore.getState().run?.id === run.id) {
            world.fire.setPerimeter(detail[0]);
            world.fire.setArrows(detail[1]);
          }
        } catch (e) {
          console.warn('detalhe do fogo:', (e as Error).message);
        } finally {
          inFlightDetail.current = false;
          const currentT = latestDetailT.current;
          const currentRun = useAppStore.getState().run;
          const isPlaying = useAppStore.getState().playing;
          if (isPlaying && currentRun?.id === run.id && currentT !== wantedT) {
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

      void fetchNext(t);
    } else {
      let cancelled = false;
      const timer = setTimeout(async () => {
        try {
          const detail = await Promise.all([
            simulationsApi.perimeter(run.id, t),
            simulationsApi.vectors(run.id, t),
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
