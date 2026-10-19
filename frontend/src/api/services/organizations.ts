import { http } from '../httpClient';
import { fetchAllPages } from '../pagination';
import type { Organization, OrganizationInput, OrganizationPatch, Page } from '../types';

export const organizationsApi = {
  list: async (params: { active?: boolean; limit?: number; cursor?: string } = {}): Promise<Page<Organization>> => {
    const { data } = await http.get<Page<Organization>>('/organizations', { params });
    return data;
  },

  all: (params: { active?: boolean } = {}): Promise<Organization[]> =>
    fetchAllPages<Organization>('/organizations', params as Record<string, string>),

  get: async (id: string): Promise<Organization> => {
    const { data } = await http.get<Organization>(`/organizations/${id}`);
    return data;
  },

  create: async (body: OrganizationInput): Promise<Organization> => {
    const { data } = await http.post<Organization>('/organizations', body);
    return data;
  },

  patch: async (id: string, patch: OrganizationPatch): Promise<Organization> => {
    const { data } = await http.patch<Organization>(`/organizations/${id}`, patch, {
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });
    return data;
  },

  delete: async (id: string): Promise<void> => {
    await http.delete(`/organizations/${id}`);
  },
};
