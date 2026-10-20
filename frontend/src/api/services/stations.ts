import { http } from '../httpClient';
import { fetchAllPages } from '../pagination';
import type { Page, Station, StationInput, StationPatch } from '../types';

export const stationsApi = {
  list: async (params: { locationId?: string; organizationId?: string; limit?: number; cursor?: string } = {}): Promise<Page<Station>> => {
    const { data } = await http.get<Page<Station>>('/stations', { params });
    return data;
  },

  all: (params: { locationId?: string; organizationId?: string } = {}): Promise<Station[]> =>
    fetchAllPages<Station>('/stations', params as Record<string, string>),

  get: async (id: string): Promise<Station> => {
    const { data } = await http.get<Station>(`/stations/${id}`);
    return data;
  },

  create: async (body: StationInput): Promise<Station> => {
    const { data } = await http.post<Station>('/stations', body);
    return data;
  },

  patch: async (id: string, patch: StationPatch): Promise<Station> => {
    const { data } = await http.patch<Station>(`/stations/${id}`, patch, {
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });
    return data;
  },

  delete: async (id: string): Promise<void> => {
    await http.delete(`/stations/${id}`);
  },
};
