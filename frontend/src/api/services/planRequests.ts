import { http } from '../httpClient';
import type { Page, PlanRequest, PlanRequestInput, PlanRequestStatus } from '../types';

export interface PlanRequestQueryParams {
  simulationId?: string;
  /** Comma list, e.g. `queued,planning`. */
  status?: PlanRequestStatus | string;
  limit?: number;
  cursor?: string;
}

/** Asking the agents for a new plan (A and B) for a baseline, and following the request while the agents work on it. */
export const planRequestsApi = {
  /** `POST /simulations/{id}/plan-requests`: a new request, or the one already open for this simulation. */
  create: async (simulationId: string, body: PlanRequestInput = {}): Promise<PlanRequest> => {
    const { data } = await http.post<PlanRequest>(`/simulations/${simulationId}/plan-requests`, body);
    return data;
  },

  get: async (id: string): Promise<PlanRequest> => {
    const { data } = await http.get<PlanRequest>(`/plan-requests/${id}`);
    return data;
  },

  /** Newest first. */
  list: async (params: PlanRequestQueryParams = {}): Promise<Page<PlanRequest>> => {
    const { data } = await http.get<Page<PlanRequest>>('/plan-requests', { params });
    return data;
  },
};
