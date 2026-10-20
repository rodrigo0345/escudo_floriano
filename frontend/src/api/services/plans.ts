import { http } from '../httpClient';
import { fetchAllPages } from '../pagination';
import type { Plan, PlanSummary, Simulation } from '../types';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The plans the agents published for a baseline simulation (`GET /plans?simulationId=`), and their what-if runs. */
export const plansApi = {
  /** Plans whose basis is this baseline simulation. */
  listForSimulation: (simulationId: string): Promise<PlanSummary[]> => fetchAllPages<PlanSummary>('/plans', { simulationId }),

  get: async (planId: string): Promise<Plan> => {
    const { data } = await http.get<Plan>(`/plans/${planId}`);
    return data;
  },

  /**
   * The latest finished what-if run of each plan, keyed by plan id. The API has no "simulations of this plan" filter,
   * so every finished what-if is listed and matched on its `planId` here.
   */
  whatIfRuns: async (planIds: string[]): Promise<Map<string, Simulation>> => {
    const wanted = new Set(planIds);
    const latest = new Map<string, Simulation>();
    for (const sim of await fetchAllPages<Simulation>('/simulations', { kind: 'what_if', status: 'succeeded' })) {
      const planId = sim.planId as string | null | undefined;
      if (!planId || !wanted.has(planId)) continue;
      const known = latest.get(planId);
      if (!known || String(sim.finishedAt ?? '') > String(known.finishedAt ?? '')) latest.set(planId, sim);
    }
    return latest;
  },

  /** "What happens if we apply this plan?": runs the what-if and waits for it (a failed run is reported, never thrown away silently). */
  simulate: async (planId: string, baselineSimulationId: string): Promise<Simulation> => {
    const { data } = await http.post<Simulation>(
      `/plans/${planId}/simulate`,
      { baselineSimulationId, label: `what-if ${planId}` },
      { headers: { Prefer: 'wait=60' } },
    );
    let sim = data;
    while (sim.status === 'queued' || sim.status === 'running') {
      await sleep(1500);
      sim = (await http.get<Simulation>(`/simulations/${sim.id}`)).data;
    }
    if (sim.status !== 'succeeded') throw new Error(sim.error?.detail ?? sim.error?.title ?? `Simulação ${sim.status}`);
    return sim;
  },
};
