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
import {
  createDefaultAnepcVehicles,
  createDefaultEquipment,
  createDefaultHelicopters,
  createDefaultPools,
} from '@/domain/defaultHelicopters';

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
      const allVehicles = [...vehicles];
      const existingHelis = allVehicles.filter((v) => v.type === 'helicopter');
      if (existingHelis.length < 2) {
        const defaults = createDefaultHelicopters(stations, organizations);
        for (const def of defaults) {
          if (!allVehicles.some((v) => v.callsign === def.callsign || v.id === def.id)) {
            allVehicles.push(def);
          }
        }
      }

      // Default ANEPC vehicles (PCO, VCOT, VETA, Drones, VTTP, Autocarros, ABEV, Bulldozer, Tanque, Apoio Logístico)
      const anepcOrg = organizations.find((o) => o.type === 'civil_protection');
      const defAnepc = createDefaultAnepcVehicles(stations, organizations);
      for (const def of defAnepc) {
        if (!allVehicles.some((v) => v.callsign === def.callsign || v.id === def.id)) {
          allVehicles.push(def);
        }
      }

      // Personnel pools: Ensure 300 operationals are available for ANEPC
      let allPools = [...pools];
      const procivPool = allPools.find((p) => p.organizationId === anepcOrg?.id);
      if (!procivPool) {
        const defPools = createDefaultPools(organizations);
        for (const dp of defPools) {
          if (!allPools.some((p) => p.organizationId === dp.organizationId)) {
            allPools.push(dp);
          }
        }
      } else if (procivPool.available < 300) {
        allPools = allPools.map((p) =>
          p.organizationId === anepcOrg?.id
            ? { ...p, total: Math.max(p.total, 300), available: 300 }
            : p,
        );
      }

      // Evacuation and emergency equipment for ANEPC and response forces
      const allEquipment = [...equipment];
      const anepcEq = allEquipment.filter((e) => e.organizationId === anepcOrg?.id);
      if (anepcEq.length === 0) {
        const defEq = createDefaultEquipment(stations, organizations);
        for (const de of defEq) {
          if (!allEquipment.some((e) => e.id === de.id || e.label === de.label)) {
            allEquipment.push(de);
          }
        }
      }

      set({ organizations, stations, vehicles: allVehicles, pools: allPools, equipment: allEquipment, loading: false, loaded: true });
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
