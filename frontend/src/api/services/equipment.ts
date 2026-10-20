import { http } from '../httpClient';
import { fetchAllPages } from '../pagination';
import type { Equipment, EquipmentInput, EquipmentKind, EquipmentPatch, Page } from '../types';

export const equipmentApi = {
  list: async (params: { organizationId?: string; kind?: EquipmentKind; limit?: number; cursor?: string } = {}): Promise<Page<Equipment>> => {
    const { data } = await http.get<Page<Equipment>>('/equipment', { params });
    return data;
  },

  all: (params: { organizationId?: string; kind?: EquipmentKind } = {}): Promise<Equipment[]> =>
    fetchAllPages<Equipment>('/equipment', params as Record<string, string>),

  get: async (id: string): Promise<Equipment> => {
    const { data } = await http.get<Equipment>(`/equipment/${id}`);
    return data;
  },

  create: async (body: EquipmentInput): Promise<Equipment> => {
    const { data } = await http.post<Equipment>('/equipment', body);
    return data;
  },

  patch: async (id: string, patch: EquipmentPatch): Promise<Equipment> => {
    const { data } = await http.patch<Equipment>(`/equipment/${id}`, patch, {
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });
    return data;
  },

  delete: async (id: string): Promise<void> => {
    await http.delete(`/equipment/${id}`);
  },
};
