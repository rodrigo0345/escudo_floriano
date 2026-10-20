import {
  dispatchesApi,
  metaApi,
  plansApi,
  simulationsApi,
  vehiclesApi,
  type ActionDispatchUnits,
  type CrewExposure,
  type DispatchInput,
  type DispatchStatus,
  type InterventionAerialDrop,
  type PlanInput,
  type Simulation,
} from '@/api';
import { crewAt, DispatchPlanner, makePathProvider, PHASE_CODE, unitsFromVehicles, type Assignment, type UnitTrack } from '@/domain/dispatchPlanner';
import { sampleWeatherAt } from '@/domain/weather';
import { useAppStore } from '@/store/appStore';
import { useDemoStore } from '@/store/demoStore';
import { useResourcesStore } from '@/store/resourcesStore';

/**
 * The dispatch rehearsal, end to end, through the API:
 *  1. `planOperation` — decide who goes where (planner), validate it (`POST /dispatches/validate`), publish it as a plan
 *                       (`POST /plans`) and ask the engine what it does to the fire (`POST /plans/{id}/simulate`).
 *  2. `executePlan`   — select + activate the plan: the backend creates one dispatch per vehicle.
 *  3. `createWriter`  — while the replay plays, report each unit's progress (`PATCH /dispatches/{id}`, `PATCH /vehicles/{id}/state`).
 *  4. `closePlan`     — complete the plan: the backend cancels what is still active and frees the vehicles.
 */

const POLL_MS = 1500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface PlanOptions {
  alarmMinute: number;
  respectAirLimits: boolean;
}

const dispatchInput = (a: Assignment): DispatchInput => ({
  resourceType: 'vehicle',
  resourceId: a.unit.id,
  personnel: a.crew,
  responsibility: a.responsibility,
  target: { label: a.target.label, position: { lat: a.target.lat, lon: a.target.lon } },
  fromStationId: a.unit.stationId,
  expectedDurationMinutes: Math.max(1, Math.round(a.endAt - (a.arriveAt ?? a.orderedAt))),
});

export async function planOperation(opts: PlanOptions, show: (sim: Simulation) => Promise<void>): Promise<void> {
  const demo = useDemoStore.getState();
  const { data } = useAppStore.getState();
  const first = useAppStore.getState().run;
  if (!useResourcesStore.getState().loaded) await useResourcesStore.getState().load();
  const { vehicles, stations, organizations } = useResourcesStore.getState();
  const fail = (message: string) => demo.patch({ stage: 'idle', error: message, status: '' });
  if (!data || !first) return fail('Escolha um cenário e espere pelo resultado do fogo.');
  let run = first;
  if (run.simulation.kind === 'what_if') return fail('O mapa mostra uma simulação com plano. Volte à simulação de base (escolha o cenário outra vez).');

  demo.reset();
  demo.patch({ stage: 'planning', status: 'A preparar os meios…', baselineSim: run.simulation });
  try {
    // A cached baseline may predate the current engine/data, and a plan can only be judged against the same engine: re-run the baseline first.
    const previous = run.simulation;
    const request = previous.scenarioId ? { scenarioId: previous.scenarioId } : { scenario: previous.scenarioSnapshot };
    const fresh = await simulationsApi.run(
      { ...request, label: 'Base do ensaio de despacho' },
      { onProgress: (s) => demo.patch({ status: `A recalcular o fogo de base com o motor atual… ${Math.round(s.progress?.percent ?? 0)}%` }) },
    );
    await show(fresh);
    const next = useAppStore.getState().run;
    if (!next || next.id !== fresh.id) return fail('Não foi possível carregar a simulação de base.');
    run = next;
    demo.patch({ baselineSim: fresh, status: 'A preparar os meios…' });
    const rules = await metaApi.rules();
    const orgName = (id: string) => organizations.find((o) => o.id === id)?.shortName ?? organizations.find((o) => o.id === id)?.name ?? id;
    const stationOf = (id: string | null | undefined) => {
      const s = stations.find((x) => x.id === id);
      return s ? { pos: s.position, name: s.name } : null;
    };
    const b = data.location.bounds;
    const ready = unitsFromVehicles(vehicles, orgName, stationOf, data.location.center);
    const units = ready.filter((u) => u.base.lat >= b.south && u.base.lat <= b.north && u.base.lon >= b.west && u.base.lon <= b.east);
    if (!units.length) {
      const busy = vehicles.filter((v) => v.inService !== false && (v.state?.status ?? 'available') !== 'available').length;
      return fail(
        ready.length
          ? `Há ${ready.length} meios disponíveis, mas nenhum tem o quartel dentro do mapa «${data.location.name}». Escolha o local onde estão as estações.`
          : `Nenhum veículo está disponível: ${vehicles.length} registados, ${busy} ocupados (despachados ou noutro plano ativo), os restantes fora de serviço ou sem função de combate, socorro ou controlo. Encerre o plano ativo ou registe veículos no separador «Recursos».`,
      );
    }

    const routeStats = { api: 0, unroutable: 0 };
    const startMs = run.startMs;
    const planner = new DispatchPlanner({
      geo: data.geo,
      ign: run.ign,
      burnMinutes: data.burnMinutes,
      width: run.gridWidth,
      height: run.gridHeight,
      cellM: data.geo.cellM,
      durationMinutes: run.durationMinutes,
      places: data.places,
      waterPoints: data.waterPoints,
      units,
      rules,
      provider: makePathProvider(data.location.id as string, run.simulation.id as string, startMs, routeStats),
      alarmMinute: opts.alarmMinute,
      windAt: (t) => sampleWeatherAt(run.weather, startMs, t)?.windKmh ?? null,
      daylight: (t) => {
        const h = new Date(startMs + t * 60000).getHours();
        return h >= 6 && h < 20;
      },
      respectAirLimits: opts.respectAirLimits,
    });
    await planner.plan((t) => demo.patch({ status: `A planear o despacho… T+${t} min` }));

    // keep only assignments the unit actually reached, then let the API validate them
    let assignments = planner.assignments.filter((a) => a.arriveAt != null);
    if (!assignments.length) return fail('Nenhum meio chegou ao incêndio no período simulado.');
    demo.patch({ status: 'A validar os despachos na API…' });
    const check = await dispatchesApi.validate({ dispatches: assignments.map(dispatchInput) });
    const rejected = new Set<number>();
    for (const issue of check.issues) {
      if (issue.severity !== 'error') continue;
      const m = /^\/dispatches\/(\d+)/.exec(issue.pointer ?? '');
      if (!m) throw new Error(issue.message);
      rejected.add(Number(m[1]));
      planner.log.push({ t: 0, text: `A API recusou ${assignments[Number(m[1])].unit.callsign}: ${issue.message}`, kind: 'warn' });
    }
    const etas = new Map((check.etas ?? []).map((e) => [e.resourceId, e.etaMinutes ?? null]));
    assignments = assignments.filter((_, i) => !rejected.has(i));
    if (!assignments.length) return fail('A API recusou todos os despachos.');

    const maxEff = rules.suppression?.maxEffectiveness ?? 0.85;
    const actions: ActionDispatchUnits[] = assignments.map((a, i) => {
      const effects: InterventionAerialDrop[] = a.drops.map((d) => ({
        type: 'aerial_drop',
        start: { offsetMinutes: Math.round(d.t) },
        geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
        agent: 'water',
        // payload-proportional share of the rules' maximum suppression effectiveness (6 000 L or more = maximum)
        effectiveness: Math.min(maxEff, (d.litres / 6000) * maxEff),
        effectDurationMinutes: 30,
      }));
      return {
        id: `a-${i + 1}`,
        type: 'dispatch_units',
        title: `${a.unit.callsign} → ${a.target.label}`,
        organizationId: a.unit.orgId,
        trigger: { kind: 'at_time', at: { offsetMinutes: Math.round(a.orderedAt) } },
        expectedDurationMinutes: dispatchInput(a).expectedDurationMinutes,
        resources: [
          {
            resourceType: 'vehicle',
            resourceId: a.unit.id,
            personnel: a.crew,
            responsibility: a.responsibility,
            fromStationId: a.unit.stationId ?? undefined,
            etaMinutes: etas.get(a.unit.id) ?? a.etaMin,
          },
        ],
        target: { label: a.target.label, position: { lat: a.target.lat, lon: a.target.lon } },
        mission: a.mission,
        rationale: `Ensaio de despacho: ${a.unit.callsign} (${a.unit.orgName}) parte da base aos T+${Math.round(a.orderedAt)} min.`,
        ...(effects.length ? { simulationEffects: effects } : {}),
      };
    });

    const baseline = run.simulation;
    const start = baseline.scenarioSnapshot.start;
    const input: PlanInput = {
      locationId: data.location.id as string,
      title: `Ensaio de despacho · ${baseline.scenarioSnapshot.name ?? baseline.label ?? 'cenário'}`,
      strategy: 'Despacho automático dos meios disponíveis para as frentes de fogo, por proximidade.',
      summary: `${actions.length} meios de ${new Set(assignments.map((a) => a.unit.orgId)).size} corporações, gerado pelo separador «Simulação».`,
      // only the simulation (not the scenario id): the engine then re-runs the baseline's own snapshot, so the comparison is like for like
      basis: { simulationId: baseline.id as string },
      horizon: { start, end: new Date(+new Date(start) + run.durationMinutes * 60000).toISOString() },
      actions,
      tags: ['demo'],
    };
    demo.patch({ status: 'A publicar o plano…' });
    const plan = await plansApi.create(input);
    const bad = plan.validation?.issues?.find((i) => i.severity === 'error');
    if (bad) throw new Error(`Plano inválido: ${bad.message}`);

    demo.patch({ status: 'A pedir ao motor o fogo com o plano…', plan });
    let sim = await plansApi.simulate(plan.id as string, { baselineSimulationId: baseline.id as string, label: 'Ensaio de despacho' });
    while (sim.status === 'queued' || sim.status === 'running') {
      demo.patch({ status: `Motor a simular o plano… ${Math.round(sim.progress?.percent ?? 0)}%` });
      await sleep(POLL_MS);
      sim = await simulationsApi.get(sim.id as string);
    }
    if (sim.status !== 'succeeded') throw new Error(sim.error?.detail ?? sim.error?.title ?? `Simulação ${sim.status}`);

    const summary = await simulationsApi.summary(sim.id as string, 60);
    const tracks = planner.tracks.filter((k) => assignments.some((a) => a.unit.id === k.unit.id));
    planner.log.push({ t: 0, text: `Trajetos: ${routeStats.api} percursos pela API de routing; ${routeStats.unroutable} sem caminho por estrada (ordens anuladas).`, kind: 'info' });
    demo.patch({
      stage: 'planned',
      status: '',
      plan,
      planSim: sim,
      tracks,
      assignments,
      log: planner.log,
      result: { areaHa: summary.final?.areaHa ?? 0, buildings: summary.final?.buildingsAffected ?? 0, casualties: sim.stats?.crewCasualties ?? 0 },
      exposures: sim.crewExposures ?? [],
      warnings: (plan.validation?.issues ?? []).filter((i) => i.code === 'crew_in_fire').map((i) => i.message),
    });
    await show(sim);
  } catch (e) {
    demo.patch({ stage: 'idle', status: '', error: (e as Error).message });
  }
}

/** Select + activate the plan (the backend creates the dispatches) and remember which dispatch belongs to which vehicle. */
export async function executePlan(): Promise<void> {
  const demo = useDemoStore.getState();
  if (!demo.plan) return;
  try {
    demo.patch({ status: 'A ativar o plano…', error: null });
    await plansApi.select(demo.plan.id as string);
    const plan = await plansApi.activate(demo.plan.id as string);
    const dispatches = await dispatchesApi.all({ planId: plan.id as string });
    const ids: Record<string, string> = {};
    dispatches.forEach((d) => (ids[d.resourceId as string] = d.id as string));
    demo.patch({ stage: 'executing', status: '', plan, dispatchIds: ids });
    await useResourcesStore.getState().load();
  } catch (e) {
    demo.patch({ error: (e as Error).message, status: '' });
  }
}

/** Completes the plan: the backend cancels active dispatches and puts the vehicles back at their stations. */
export async function closePlan(): Promise<void> {
  const demo = useDemoStore.getState();
  if (!demo.plan) return;
  try {
    await plansApi.patch(demo.plan.id as string, { status: 'completed' });
    demo.patch({ stage: 'closed', status: '' });
    await useResourcesStore.getState().load();
  } catch (e) {
    demo.patch({ error: (e as Error).message });
  }
}

// ------------------------------------------------------------------ progress reporting
const DISPATCH_STATUS: Record<string, DispatchStatus | null> = {
  base: null,
  ordered: null,
  en_route: 'en_route',
  working: 'working',
  to_water: 'refilling',
  filling: 'refilling',
  returning: 'returning',
  refueling: 'returning',
};

/**
 * Reports each unit's progress to the API as the replay advances. It is state-based (compares the unit's phase at the
 * current minute with what was last written), so scrubbing or skipping ahead simply writes the current state.
 */
export function createWriter() {
  const last = new Map<string, string>();
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (job: () => Promise<unknown>) => {
    chain = chain.then(job).then(() => undefined).catch((e) => console.warn('relatório de despacho:', (e as Error).message));
  };

  /** Position, water, fuel and people of the vehicle at minute `i` (the people already net of casualties). */
  const state = (k: UnitTrack, i: number, casualties: number) =>
    vehiclesApi.patchState(k.unit.id, {
      position: { lat: k.lat[i], lon: k.lon[i] },
      fuelPct: k.fuelPct[i],
      crewOnboard: Math.max(0, k.unit.crew - casualties),
      ...(casualties ? { crew: { casualties } } : {}),
      ...(k.unit.waterL || k.unit.bucketL ? { water: { levelL: k.waterL[i], capacityL: k.unit.air ? k.unit.bucketL : k.unit.waterL } } : {}),
    });

  return (minute: number, tracks: UnitTrack[], dispatchIds: Record<string, string>, exposures: CrewExposure[] = []) => {
    for (const k of tracks) {
      const id = dispatchIds[k.unit.id];
      const i = Math.min(k.phase.length - 1, Math.max(0, Math.floor(minute)));
      if (!id || i < k.from) continue;
      const { casualties } = crewAt(k, exposures.find((e) => e.vehicleId === k.unit.id), minute);
      const phase = PHASE_CODE[k.phase[i]];
      // 'base' after having left means the unit is back and done
      const status: DispatchStatus | null = phase === 'base' ? (i > k.from + 1 ? 'completed' : null) : DISPATCH_STATUS[phase];
      if (!status) continue;
      const key = `${status}|${casualties}`;
      if (last.get(k.unit.id) === key) continue;
      const statusChanged = last.get(k.unit.id)?.split('|')[0] !== status;
      last.set(k.unit.id, key);
      enqueue(async () => {
        if (statusChanged) await dispatchesApi.patch(id, { status });
        if (status !== 'completed') await state(k, i, casualties); // when completed the backend already puts the vehicle back, keeping its casualties
      });
    }
  };
}
