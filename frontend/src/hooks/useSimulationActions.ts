import { useCallback } from 'react';

import { plansApi, simulationsApi, type Simulation, type SimulationRequest } from '@/api';
import { Impact } from '@/domain/impact';
import { formatDateTime, formatTime } from '@/domain/weather';
import { useWorld } from '@/engine/EngineContext';
import type { Milestone } from '@/engine/layers/fireLayer';
import { useAppStore } from '@/store/appStore';
import type { Job } from '@/store/types';
import { loadRunData } from '@/usecases/loadRun';

/** The impact (roads cut / place access) is computed every IMPACT_STEP minutes on large maps; between steps the last one is reused. */
const IMPACT_STEP = 3;
const MILESTONE_MINUTES = [15, 30, 60, 120, 180];

/** The camera frames the first loaded ignition once; later runs keep wherever the operator navigated to. (Module-level: several components share these actions.) */
let framedFirstRun = false;

const describeProgress = (sim: Simulation): string => {
  const p = sim.progress;
  const members = p?.membersTotal ? ` · ${p.membersDone}/${p.membersTotal} corridas` : '';
  const eta = p?.etaSeconds ? ` · ~${Math.max(1, Math.round(p.etaSeconds / 60))} min restantes` : '';
  return `A simular… ${p?.phase ?? 'em fila'} ${Math.round(p?.percent ?? 0)}%${members}${eta}`;
};

/**
 * The orchestration of "pick a scenario → get a simulation (cached or freshly run) → load its
 * result into the store and onto the GPU". It is a hook (not a store action) because it needs
 * the imperative `World` from context; the state it produces all lands in the Zustand store.
 */
export function useSimulationActions() {
  const world = useWorld();

  const setProgress = useCallback((text: string, percent: number) => {
    const { hint, setHint, setProgress: storeSetProgress } = useAppStore.getState();
    storeSetProgress(text ? { text, percent } : null);
    if (text) setHint(text);
    else if (hint.startsWith('A simular') || hint === 'A carregar a simulação…' || hint === 'A carregar o resultado…') setHint('');
  }, []);

  const loadImpact = useCallback(async (runId: string) => {
    if (!world) return;
    const { origin, setImpact } = useAppStore.getState();
    const [roadStatus, access] = await Promise.all([
      simulationsApi.roadStatus(runId),
      simulationsApi.placeAccess(runId, origin, IMPACT_STEP),
    ]);
    const placeIndex = new Map<string, number>(world.assets.places.map((p, i): [string, number] => [p.id as string, i]));
    setImpact(new Impact(roadStatus, access, world.roads.indexById, placeIndex));
  }, [world]);

  const loadRun = useCallback(
    async (simulation: Simulation) => {
      const state = useAppStore.getState();
      if (!world || !state.data) return;
      if (simulation.locationId && state.locationId && simulation.locationId !== state.locationId) {
        // Location mismatch: the 3D terrain, heightmap, and georef belong to another location.
        // Navigate to the correct location URL to load the matching terrain and simulation!
        window.location.search = `?loc=${encodeURIComponent(simulation.locationId)}&sim=${encodeURIComponent(simulation.id as string)}`;
        return;
      }
      const run = await loadRunData(simulation);
      const { data } = state;
      world.terrain.setFireData(run.ign, run.gridWidth, run.gridHeight, data.burnMinutes, run.inten);
      world.flames.setRun({ ign: run.ign, inten: run.inten, flags: run.flags, dur: data.burnMinutes, width: run.gridWidth, height: run.gridHeight });
      world.smoke.setRun({
        ign: run.ign,
        inten: run.inten,
        flags: run.flags,
        width: run.gridWidth,
        height: run.gridHeight,
        dur: data.burnMinutes,
        weather: run.weather,
        startMs: run.startMs,
        durationMinutes: run.durationMinutes,
      });
      const points = simulation.scenarioSnapshot.ignitions.map((ig, i) => ({
        ...ig,
        label: ig.label ?? `Foco ${i + 1}`,
      }));
      const first = points[0]?.position;
      state.setRun(run);
      state.setIgnitions(points);
      world.fire.setIgnitions(points);

      // opened by id the picker must name *this* fire, not the first one: by scenario id, else by the snapshot's name, else "custom"
      const ownScenario = simulation.scenarioId ?? data.scenarios.find((s) => s.name === simulation.scenarioSnapshot.name)?.id ?? 'custom';
      if (simulation.kind !== 'what_if') {
        state.setBaseSimulationId(run.id); // the plans panel lists plans made for this baseline
        state.setScenario(ownScenario);
      } else if (!useAppStore.getState().scenarioId) {
        state.setScenario(ownScenario); // a plan's run opened directly; from the plans panel the picker already points at its fire
      }

      // draw the plan whose what-if this is; a baseline has none
      if (simulation.kind === 'what_if' && simulation.planId) {
        plansApi
          .get(simulation.planId as string)
          .then((plan) => {
            const store = useAppStore.getState();
            if (store.run?.id !== run.id) return; // another simulation was loaded meanwhile
            store.setActivePlan(plan);
            // a plan's run opened directly (`?sim=`): its baseline is named in the plan, so the plans panel can list its siblings
            if (!store.baseSimulationId && plan.basis?.simulationId) store.setBaseSimulationId(plan.basis.simulationId as string);
          })
          .catch((e: Error) => console.warn('plano no mapa:', e.message));
      } else state.setActivePlan(null);

      if (!first) return;
      if (!framedFirstRun) {
        world.focusOnLatLon(first.lat, first.lon);
        framedFirstRun = true;
      }
      const marks: Milestone[] = MILESTONE_MINUTES.filter((m) => m <= run.durationMinutes)
        .map((m) => {
          const row = run.summary.find((x) => x.tMin === m);
          if (!row?.headPosition) return null;
          const label = m >= 60 ? `${m / 60} h · ${formatTime(row.time ?? run.startMs + m * 60000)}` : `${m} min`;
          return { label, lat: row.headPosition.lat, lon: row.headPosition.lon };
        })
        .filter((m): m is Milestone => m !== null);
      world.fire.setMilestones(marks, [first.lat, first.lon]);
      await loadImpact(run.id);
      // Flipping between the base and a plan from the plans panel keeps the minute on screen, so the two fires can be compared at the
      // same moment; any other load starts at T+30 (back at T+30 a fire that had grown would seem to have vanished).
      const currentTab = useAppStore.getState().tab;
      const comparing = currentTab === 'plans' && state.run !== null;
      state.setTime(Math.min(comparing ? state.t : 30, run.durationMinutes));
      if (!comparing && currentTab !== 'plans' && currentTab !== 'resources') state.setTab('incident');
    },
    [world, loadImpact],
  );

  const cancelJob = useCallback(async () => {
    const { job, setJob } = useAppStore.getState();
    if (!job) return;
    job.cancelled = true;
    setJob(null);
    setProgress('', 0);
    if (job.id) await simulationsApi.cancel(job.id).catch(() => undefined); // already finished or deleted: nothing to do
  }, [setProgress]);

  /**
   * Shows a simulation. Only one job at a time: a user request cancels the automatic first-scenario
   * run, but never a run the user started themselves (it warns instead of silently doing nothing).
   */
  const showSimulation = useCallback(
    async (getSimulation: (job: Job) => Promise<Simulation>, auto = false) => {
      const store = useAppStore.getState();
      if (store.job) {
        if (!store.job.auto) {
          store.showBanner('Já há uma simulação em curso. Cancele-a para lançar outra.', 'warn');
          return;
        }
        await cancelJob();
      }
      const job: Job = { id: null, auto, cancelled: false };
      store.setJob(job);
      setProgress('A carregar a simulação…', 0);
      try {
        const simulation = await getSimulation(job);
        if (job.cancelled) return;
        setProgress('A carregar o resultado…', 100);
        await loadRun(simulation);
      } catch (e) {
        if (!job.cancelled) {
          useAppStore.getState().showBanner(`Erro: ${(e as Error).message}`);
          console.error(e);
        }
      } finally {
        if (useAppStore.getState().job === job) {
          useAppStore.getState().setJob(null);
          setProgress('', 0);
        }
      }
    },
    [cancelJob, loadRun, setProgress],
  );

  const runSimulation = useCallback(
    (request: SimulationRequest, auto = false) =>
      showSimulation(
        (job) =>
          simulationsApi.run(request, {
            onStart: (s) => {
              job.id = s.id as string;
            },
            onProgress: (s) => setProgress(describeProgress(s), s.progress?.percent ?? 0),
          }),
        auto,
      ),
    [showSimulation, setProgress],
  );

  const selectScenario = useCallback(
    async (scenarioId: string) => {
      const store = useAppStore.getState();
      store.setScenario(scenarioId);
      if (scenarioId === 'custom' || !store.data || !world) {
        store.setTab('incident');
        return;
      }
      const scenario = store.data.scenarios.find((s) => s.id === scenarioId);
      if (!scenario) return;
      const points = scenario.ignitions.map((ig, i) => ({ ...ig, label: ig.label ?? `Foco ${i + 1}` }));
      store.setIgnitions(points);
      world.fire.setIgnitions(points);
      // a built-in scenario never changes, so reuse an already computed result instead of re-running it
      const previous = await simulationsApi.latestSucceeded(scenarioId);
      if (previous) {
        try {
          await showSimulation(async () => previous, true);
          return;
        } catch (err) {
          console.warn(`Simulação em cache ${previous.id} sem ficheiros no disco, a recalcular:`, err);
        }
      }
      await runSimulation({ scenarioId }, true);
    },
    [world, showSimulation, runSimulation],
  );

  /** Shows any finished simulation by id: a baseline or a plan's what-if (`?sim=<id>`, or the plans panel). */
  const showSimulationById = useCallback(
    (simulationId: string) =>
      showSimulation(async () => {
        const simulation = await simulationsApi.get(simulationId);
        if (simulation.status !== 'succeeded') {
          // failed / cancelled / still running: say why instead of drawing nothing
          throw new Error(simulation.error?.detail ?? simulation.error?.title ?? `A simulação ${simulationId} está ${simulation.status}.`);
        }
        return simulation;
      }),
    [showSimulation],
  );

  const reloadImpact = useCallback(async () => {
    const run = useAppStore.getState().run;
    if (run) await loadImpact(run.id);
  }, [loadImpact]);

  return { selectScenario, showSimulation, showSimulationById, runSimulation, cancelJob, reloadImpact };
}
