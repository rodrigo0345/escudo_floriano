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

  simulate: async (id: string, request?: PlanSimulationRequest): Promise<Simulation> => {
    const { data } = await http.post<Simulation>(`/plans/${id}/simulate`, request ?? {});
    return data;
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
};
