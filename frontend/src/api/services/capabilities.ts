import { http } from '../httpClient';
import type { Capabilities } from '../types';

/**
 * `GET /capabilities` — what the backend actually implements right now. Per AGENTS.md: the
 * contract can describe more than the engine does, and a feature this UI assumes exists
 * should be checked here rather than discovered via a confusing 422 deep in a user flow.
 */
export const capabilitiesApi = {
  get: async (): Promise<Capabilities> => {
    const { data } = await http.get<Capabilities>('/capabilities');
    return data;
  },
};
