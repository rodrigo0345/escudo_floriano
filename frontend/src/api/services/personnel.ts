import { http } from '../httpClient';
import { fetchAllPages } from '../pagination';
import type { Page, PersonnelPool, PersonnelPoolInput, PersonnelPoolPatch, PersonnelRole } from '../types';

export const personnelApi = {
  list: async (params: { organizationId?: string; role?: PersonnelRole; limit?: number; cursor?: string } = {}): Promise<Page<PersonnelPool>> => {
    const { data } = await http.get<Page<PersonnelPool>>('/personnel-pools', { params });
    return data;
  },

  all: (params: { organizationId?: string; role?: PersonnelRole } = {}): Promise<PersonnelPool[]> =>
    fetchAllPages<PersonnelPool>('/personnel-pools', params as Record<string, string>),

  get: async (id: string): Promise<PersonnelPool> => {
    const { data } = await http.get<PersonnelPool>(`/personnel-pools/${id}`);
    return data;
  },

  create: async (body: PersonnelPoolInput): Promise<PersonnelPool> => {
    const { data } = await http.post<PersonnelPool>('/personnel-pools', body);
    return data;
  },

  patch: async (id: string, patch: PersonnelPoolPatch): Promise<PersonnelPool> => {
    const { data } = await http.patch<PersonnelPool>(`/personnel-pools/${id}`, patch, {
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });
    return data;
  },

  delete: async (id: string): Promise<void> => {
    await http.delete(`/personnel-pools/${id}`);
  },
};
