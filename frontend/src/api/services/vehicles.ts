import { http } from '../httpClient';
import { fetchAllPages } from '../pagination';
import type {
  LatLon,
  Page,
  Responsibility,
  Vehicle,
  VehicleCapability,
  VehicleInput,
  VehiclePatch,
  VehicleState,
  VehicleStatePatch,
  VehicleStatus,
  VehicleType,
} from '../types';

export interface VehicleQueryParams {
  organizationId?: string;
  stationId?: string;
  type?: VehicleType;
  status?: VehicleStatus;
  responsibility?: Responsibility;
  capability?: VehicleCapability;
  offRoad?: boolean;
  inService?: boolean;
  near?: LatLon;
  radiusM?: number;
  availableAt?: string;
  limit?: number;
  cursor?: string;
}

export const vehiclesApi = {
  list: async (params: VehicleQueryParams = {}): Promise<Page<Vehicle>> => {
    const q: Record<string, unknown> = { ...params };
    if (params.near) {
      q.near = `${params.near.lat},${params.near.lon}`;
    }
    const { data } = await http.get<Page<Vehicle>>('/vehicles', { params: q });
    return data;
  },

  all: (params: Omit<VehicleQueryParams, 'limit' | 'cursor'> = {}): Promise<Vehicle[]> => {
    const q: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) {
        if (k === 'near' && typeof v === 'object') {
          q.near = `${(v as LatLon).lat},${(v as LatLon).lon}`;
        } else {
          q[k] = String(v);
        }
      }
    }
    return fetchAllPages<Vehicle>('/vehicles', q);
  },

  get: async (id: string): Promise<Vehicle> => {
    const { data } = await http.get<Vehicle>(`/vehicles/${id}`);
    return data;
  },

  create: async (body: VehicleInput): Promise<Vehicle> => {
    const { data } = await http.post<Vehicle>('/vehicles', body);
    return data;
  },

  patch: async (id: string, patch: VehiclePatch): Promise<Vehicle> => {
    const { data } = await http.patch<Vehicle>(`/vehicles/${id}`, patch, {
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });
    return data;
  },

  delete: async (id: string): Promise<void> => {
    await http.delete(`/vehicles/${id}`);
  },

  getState: async (id: string): Promise<VehicleState> => {
    const { data } = await http.get<VehicleState>(`/vehicles/${id}/state`);
    return data;
  },

  patchState: async (id: string, patch: VehicleStatePatch): Promise<VehicleState> => {
    const { data } = await http.patch<VehicleState>(`/vehicles/${id}/state`, patch, {
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });
    return data;
  },
};
