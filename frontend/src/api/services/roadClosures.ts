import { http } from '../httpClient';
import { fetchAllPages } from '../pagination';
import type { ClosureStatus, Page, RoadClosure, RoadClosureInput, RoadClosurePatch } from '../types';

export interface RoadClosureQueryParams {
  locationId?: string;
  status?: ClosureStatus;
  source?: string;
  organizationId?: string;
  activeAt?: string;
  limit?: number;
  cursor?: string;
}

export const roadClosuresApi = {
  list: async (params: RoadClosureQueryParams = {}): Promise<Page<RoadClosure>> => {
    const { data } = await http.get<Page<RoadClosure>>('/road-closures', { params });
    return data;
  },

  all: (params: Omit<RoadClosureQueryParams, 'limit' | 'cursor'> = {}): Promise<RoadClosure[]> =>
    fetchAllPages<RoadClosure>('/road-closures', params as Record<string, string>),

  get: async (id: string): Promise<RoadClosure> => {
    const { data } = await http.get<RoadClosure>(`/road-closures/${id}`);
    return data;
  },

  create: async (body: RoadClosureInput): Promise<RoadClosure> => {
    const { data } = await http.post<RoadClosure>('/road-closures', body);
    return data;
  },

  patch: async (id: string, patch: RoadClosurePatch): Promise<RoadClosure> => {
    const { data } = await http.patch<RoadClosure>(`/road-closures/${id}`, patch, {
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });
    return data;
  },
};
