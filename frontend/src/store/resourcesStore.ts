import { create } from 'zustand';

import {
  ApiError,
  equipmentApi,
  organizationsApi,
  personnelApi,
  stationsApi,
  vehiclesApi,
  type Equipment,
  type Organization,
  type PersonnelPool,
  type Station,
  type Vehicle,
} from '@/api';
import { templateForVehicle, templateToInput } from '@/domain/vehicleCatalog';

/** Every organization's registered resources (what the "Recursos" tab edits and the "Simulação" tab dispatches). */
interface ResourcesState {
  organizations: Organization[];
  stations: Station[];
  vehicles: Vehicle[];
  pools: PersonnelPool[];
  equipment: Equipment[];
  loading: boolean;
  error: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  /** Runs one API mutation, then reloads so the lists always mirror the server. */
  mutate: (fn: () => Promise<unknown>) => Promise<boolean>;
  completeFromCatalog: () => Promise<number>;
}

const describe = (e: unknown): string => {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`;
  return (e as Error).message ?? String(e);
};

export const useResourcesStore = create<ResourcesState>((set, get) => ({
  organizations: [],
  stations: [],
  vehicles: [],
  pools: [],
  equipment: [],
  loading: false,
  error: null,
  loaded: false,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [organizations, stations, vehicles, pools, equipment] = await Promise.all([
        organizationsApi.all(),
        stationsApi.all(),
        vehiclesApi.all(),
        personnelApi.all(),
        equipmentApi.all(),
      ]);
      set({ organizations, stations, vehicles, pools, equipment, loading: false, loaded: true });
    } catch (e) {
      set({ loading: false, error: describe(e) });
    }
  },

  mutate: async (fn) => {
    try {
      await fn();
      await get().load();
      return true;
    } catch (e) {
      set({ error: describe(e) });
      return false;
    }
  },

  /** Patches every vehicle with the catalogue's real specs for its type (only the spec fields; callsign, station and state stay). */
  completeFromCatalog: async () => {
    let n = 0;
    try {
      for (const v of get().vehicles) {
        const tpl = templateForVehicle(v);
        if (!tpl) continue;
        const { type: _type, ...specs } = templateToInput(tpl);
        void _type;
        // the generated patch type (wrongly) requires inService: keep the vehicle's current value
        await vehiclesApi.patch(v.id as string, { ...specs, inService: v.inService ?? true, metadata: { ...(v.metadata ?? {}), ...specs.metadata } });
        n += 1;
      }
      await get().load();
    } catch (e) {
      set({ error: describe(e) });
    }
    return n;
  },
}));
