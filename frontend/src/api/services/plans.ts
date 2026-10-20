import { http } from '../httpClient';
import { fetchAllPages } from '../pagination';
import type {
  Action,
  ActionPatch,
  Page,
  Plan,
  PlanInput,
  PlanPatch,
  PlanSimulationRequest,
  PlanStatus,
  PlanSummary,
  PlanValidation,
  Simulation,
} from '../types';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface PlanQueryParams {
  locationId?: string;
  simulationId?: string;
  variant?: string;
  status?: PlanStatus;
  organizationId?: string;
  limit?: number;
  cursor?: string;
}

export const plansApi = {
  list: async (params: PlanQueryParams = {}): Promise<Page<PlanSummary>> => {
    const { data } = await http.get<Page<PlanSummary>>('/plans', { params });
    return data;
  },

  all: (params: Omit<PlanQueryParams, 'limit' | 'cursor'> = {}): Promise<PlanSummary[]> =>
    fetchAllPages<PlanSummary>('/plans', params as Record<string, string>),

  /** Plans whose basis is this baseline simulation. */
  listForSimulation: (simulationId: string): Promise<PlanSummary[]> => fetchAllPages<PlanSummary>('/plans', { simulationId }),

  get: async (id: string): Promise<Plan> => {
    const { data } = await http.get<Plan>(`/plans/${id}`);
    return data;
  },

  create: async (body: PlanInput): Promise<Plan> => {
    const { data } = await http.post<Plan>('/plans', body);
    return data;
  },

  validate: async (body: PlanInput): Promise<PlanValidation> => {
    const { data } = await http.post<PlanValidation>('/plans/validate', body);
    return data;
  },

  patch: async (id: string, patch: PlanPatch): Promise<Plan> => {
    const { data } = await http.patch<Plan>(`/plans/${id}`, patch, {
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });
    return data;
  },

  delete: async (id: string): Promise<void> => {
    await http.delete(`/plans/${id}`);
  },

  select: async (id: string): Promise<Plan> => {
    const { data } = await http.post<Plan>(`/plans/${id}/select`, {});
    return data;
  },

  activate: async (id: string): Promise<Plan> => {
    const { data } = await http.post<Plan>(`/plans/${id}/activate`, {});
    return data;
  },

  /**
   * Starts the plan's what-if. A baseline id waits for the run (the plans panel compares the two fires);
   * an explicit request returns the queued simulation, leaving polling to the caller.
   */
  simulate: async (id: string, request?: PlanSimulationRequest | string): Promise<Simulation> => {
    const wait = typeof request === 'string';
    const body: PlanSimulationRequest = typeof request === 'string'
      ? { baselineSimulationId: request, label: `what-if ${id}` }
      : request ?? {};
    const { data } = await http.post<Simulation>(`/plans/${id}/simulate`, body, wait ? { headers: { Prefer: 'wait=60' } } : undefined);
    if (!wait) return data;
    let sim = data;
    while (sim.status === 'queued' || sim.status === 'running') {
      await sleep(1500);
      sim = (await http.get<Simulation>(`/simulations/${sim.id}`)).data;
    }
    if (sim.status !== 'succeeded') throw new Error(sim.error?.detail ?? sim.error?.title ?? `Simulação ${sim.status}`);
    return sim;
  },

  actions: async (id: string): Promise<Action[]> => fetchAllPages<Action>(`/plans/${id}/actions`),

  getAction: async (id: string, actionId: string): Promise<Action> => {
    const { data } = await http.get<Action>(`/plans/${id}/actions/${actionId}`);
    return data;
  },

  patchAction: async (id: string, actionId: string, patch: ActionPatch): Promise<Action> => {
    const { data } = await http.patch<Action>(`/plans/${id}/actions/${actionId}`, patch, {
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });
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
};
