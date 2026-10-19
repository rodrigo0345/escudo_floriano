import { http } from '../httpClient';
import type { Page, Scenario } from '../types';

export const scenariosApi = {
  listForLocation: async (locationId: string): Promise<Scenario[]> => {
    const { data } = await http.get<Page<Scenario>>('/scenarios', { params: { locationId, limit: 200 } });
    return data.items;
  },

  get: async (scenarioId: string): Promise<Scenario> => {
    const { data } = await http.get<Scenario>(`/scenarios/${scenarioId}`);
    return data;
  },
};
