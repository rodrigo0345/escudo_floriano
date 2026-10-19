import { http } from '../httpClient';
import type { Capabilities, Health, Rules } from '../types';

export const metaApi = {
  capabilities: async (): Promise<Capabilities> => {
    const { data } = await http.get<Capabilities>('/capabilities');
    return data;
  },

  rules: async (): Promise<Rules> => {
    const { data } = await http.get<Rules>('/rules');
    return data;
  },

  health: async (): Promise<Health> => {
    const { data } = await http.get<Health>('/health');
    return data;
  },
};
