import { simulationsApi, type LatLon, type UnitState, type UnitTrackResponse } from '@/api';

import { PHASE_CODE, type UnitPhase, type UnitRole, type UnitSpec, type UnitTrack } from './dispatchPlanner';
import type { PlanResources } from './planUnits';

/**
 * The units of a plan's what-if as the backend simulates them (`GET /simulations/{id}/units` and `/units/{unitId}/track`): where each one is every
 * minute, whether it is driving, working, refilling its tank, resting or going home, and how much water it has. The map only replays it.
 */

const AIR_TYPES = new Set(['helicopter', 'airtanker', 'drone']);
const CONCURRENCY = 8;

/** The backend's dispatch status in the vocabulary the unit layer draws. `completed` and anything cancelled leave the map. */
const PHASE: Record<string, UnitPhase> = {
  ordered: 'ordered',
  en_route: 'en_route',
  on_scene: 'working',
  working: 'working',
  refilling: 'filling',
  resting: 'working',
  grounded: 'ordered',
  returning: 'returning',
  completed: 'base',
  cancelled: 'base',
  failed: 'base',
};

function roleOf(state: UnitState, air: boolean): UnitRole {
  if (air) return 'air';
  if (state.responsibility === 'traffic_control' || state.responsibility === 'perimeter_security') return 'traffic';
  if (state.responsibility === 'medical') return 'medical';
  if (state.responsibility === 'command') return 'command';
  return 'attack';
}

function build(state: UnitState, track: UnitTrackResponse, minutes: number, res: PlanResources): UnitTrack {
  const vehicle = res.vehicles.find((v) => v.id === state.unitId);
  const air = !!vehicle && AIR_TYPES.has(vehicle.type as string);
  const station = res.stations.find((s) => s.id === vehicle?.stationId);
  const first = track.points.find((p) => p.position)?.position as LatLon | undefined;
  const base = station?.position ?? first ?? { lat: 0, lon: 0 };
  const capacity = state.water?.capacityL ?? 0;

  const lat = new Float32Array(minutes);
  const lon = new Float32Array(minutes);
  const phase = new Uint8Array(minutes);
  const waterL = new Float32Array(minutes);
  const fuelPct = new Float32Array(minutes).fill(100);
  const pathIdx = new Int16Array(minutes).fill(-1);
  const dist = new Float32Array(minutes);
  let at = base;
  let from = minutes;
  const byMinute = new Map(track.points.map((p) => [p.tMin, p]));
  for (let t = 0; t < minutes; t++) {
    const p = byMinute.get(t);
    if (p?.position) at = p.position as LatLon;
    lat[t] = at.lat;
    lon[t] = at.lon;
    const status = p?.status ?? 'completed';
    phase[t] = PHASE_CODE.indexOf(PHASE[status] ?? 'base');
    waterL[t] = p?.waterLevelL ?? 0;
    if (status !== 'ordered' && t < from) from = t;
  }

  const org = res.organizations.find((o) => o.id === state.organizationId);
  const spec: UnitSpec = {
    id: state.unitId,
    callsign: state.callsign ?? state.unitId,
    typeCode: vehicle?.typeCode ?? 'EQ',
    orgId: state.organizationId ?? '',
    orgName: org?.shortName ?? org?.name ?? state.organizationId ?? '',
    stationId: vehicle?.stationId ?? null,
    role: roleOf(state, air),
    air,
    base,
    baseName: station?.name ?? 'Posto',
    crew: state.personnel ?? 0,
    minCrew: 1,
    waterL: capacity,
    pumpLpm: state.water?.consumptionLpm ?? 0,
    speedKmh: vehicle?.cruiseSpeedKmh ?? 0,
    rangeKm: 0,
    fuelL: null, // the backend does not model fuel: the tooltip leaves it out
    bucketL: 0,
    loadMin: 0,
    maxWindKmh: 0,
    profile: { vehicleType: (vehicle?.type ?? 'forest_firefighting_vehicle') as UnitSpec['profile']['vehicleType'], offRoad: !!vehicle?.offRoad },
  };
  return { unit: spec, lat, lon, phase, waterL, fuelPct, from: Math.min(from, minutes - 1), paths: [], pathIdx, dist };
}

/** Runs `fn` over `items` a few at a time (a plan has dozens of units: one request each, but not all at once). */
async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** The backend's unit tracks for a simulation, or `[]` when it has none (a baseline, or a server without the unit simulator). */
export async function loadBackendTracks(simulationId: string, run: { durationMinutes: number }, res: PlanResources): Promise<UnitTrack[]> {
  const minutes = Math.max(1, Math.round(run.durationMinutes)) + 1;
  const list = await simulationsApi.units(simulationId, 0);
  if (!list.items.length) return [];
  return inBatches(list.items, CONCURRENCY, async (state) => build(state, await simulationsApi.unitTrack(simulationId, state.unitId, 1), minutes, res));
}
