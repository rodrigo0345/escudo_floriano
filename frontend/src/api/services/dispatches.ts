import { http } from '../httpClient';
import { fetchAllPages } from '../pagination';
import type {
  Dispatch,
  DispatchBatchInput,
  DispatchPatch,
  DispatchRecall,
  DispatchResult,
  DispatchStatus,
  DispatchValidation,
  Page,
  Responsibility,
} from '../types';

export interface DispatchQueryParams {
  status?: DispatchStatus;
  responsibility?: Responsibility;
  resourceId?: string;
  planId?: string;
  organizationId?: string;
  stationId?: string;
  includeFinished?: boolean;
  limit?: number;
  cursor?: string;
}

export const dispatchesApi = {
  list: async (params: DispatchQueryParams = {}): Promise<Page<Dispatch>> => {
    const { data } = await http.get<Page<Dispatch>>('/dispatches', { params });
    return data;
  },

  all: (params: Omit<DispatchQueryParams, 'limit' | 'cursor'> = {}): Promise<Dispatch[]> =>
    fetchAllPages<Dispatch>('/dispatches', params as Record<string, string>),

  get: async (id: string): Promise<Dispatch> => {
    const { data } = await http.get<Dispatch>(`/dispatches/${id}`);
    return data;
  },

  create: async (batch: DispatchBatchInput): Promise<DispatchResult> => {
    const { data } = await http.post<DispatchResult>('/dispatches', batch);
    return data;
  },

  validate: async (batch: DispatchBatchInput): Promise<DispatchValidation> => {
    const { data } = await http.post<DispatchValidation>('/dispatches/validate', batch);
    return data;
  },

  patch: async (id: string, patch: DispatchPatch): Promise<Dispatch> => {
    const { data } = await http.patch<Dispatch>(`/dispatches/${id}`, patch, {
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });
    return data;
  },

  recall: async (id: string, recall?: DispatchRecall): Promise<Dispatch> => {
    const { data } = await http.post<Dispatch>(`/dispatches/${id}/recall`, recall ?? {});
    return data;
  },
};
