import { http } from '../httpClient';
import type { AccessMatrix, AccessRequest, Route, RouteRequest } from '../types';

export const routingApi = {
  route: async (req: RouteRequest): Promise<Route> => {
    const { data } = await http.post<Route>('/routing/route', req);
    return data;
  },

  access: async (req: AccessRequest): Promise<AccessMatrix> => {
    const { data } = await http.post<AccessMatrix>('/routing/access', req);
    return data;
  },
};
