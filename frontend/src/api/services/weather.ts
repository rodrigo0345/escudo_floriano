import { http } from '../httpClient';
import type { WeatherResolveRequest, WeatherResolveResponse } from '../types';

export const weatherApi = {
  /** `POST /weather/resolve` — what a weather recipe resolves to for a period, without running the engine. */
  resolve: async (request: WeatherResolveRequest): Promise<WeatherResolveResponse> => {
    const { data } = await http.post<WeatherResolveResponse>('/weather/resolve', request);
    return data;
  },
};
