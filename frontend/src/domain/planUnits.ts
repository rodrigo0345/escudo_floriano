import type { LatLon, Organization, PersonnelPool, Plan, Station, Vehicle } from '@/api';

import type { Path, UnitRole, UnitSpec, UnitTrack } from './dispatchPlanner';
import { PHASE_CODE } from './dispatchPlanner';
import { lineStringCoordinates } from './geojson';

/**
 * The units of an agents' plan, as tracks the map can replay: each ground vehicle leaves its station when the action starts, follows the road the
 * backend computed for it (`resources[].route`) and is on the spot at the backend's `etaMinutes`, then works until its effect ends. Nothing is
 * simulated here: the route, the arrival and the working window all come from the plan the backend stored and simulated.
 * Units with no stored route (a helicopter, a crew on foot) fly or walk the straight line from their station.
 */

export interface PlanResources {
  vehicles: Vehicle[];
  stations: Station[];
  pools: PersonnelPool[];
  organizations: Organization[];
}

type Json = Record<string, unknown>;
const EARTH_M = 6_371_000;
const DEFAULT_WORK_MINUTES = 60;
const AIR_TYPES = new Set(['helicopter', 'airtanker', 'drone']);

const rad = (d: number) => (d * Math.PI) / 180;
function distanceM(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pathOf(points: LatLon[], speedKmh: number, viaApi: boolean): Path {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + distanceM(points[i - 1], points[i]));
  return { pts: points, cum, speedKmh, viaApi };
}

/** The middle of a GeoJSON Point, LineString or Polygon as a LatLon, or null. */
function centreOf(geometry: unknown): LatLon | null {
  const g = geometry as { type?: string; coordinates?: unknown } | null | undefined;
  if (!g?.coordinates) return null;
  let points: number[][] = [];
  if (g.type === 'Point') points = [g.coordinates as number[]];
  else if (g.type === 'LineString') points = g.coordinates as number[][];
  else if (g.type === 'Polygon') points = (g.coordinates as number[][][])[0] ?? [];
  if (!points.length) return null;
  return { lat: points.reduce((s, p) => s + p[1], 0) / points.length, lon: points.reduce((s, p) => s + p[0], 0) / points.length };
}

/** Where an action works: its effect's shape, else the point the action itself names. */
function targetOf(action: Json): LatLon | null {
  for (const effect of (action.simulationEffects as Json[] | undefined) ?? []) {
    const c = centreOf(effect.geometry);
    if (c) return c;
  }
  const position = (action.position ?? action.anchorPoint ?? (action.stagingArea as { position?: LatLon } | undefined)?.position) as LatLon | undefined;
  if (position?.lat !== undefined) return position;
  return centreOf(action.line) ?? centreOf(action.area) ?? centreOf(((action.targets as Json[] | undefined) ?? [])[0]?.geometry) ?? null;
}

function roleOf(type: string | undefined, responsibility: string | undefined): UnitRole {
  if (responsibility === 'traffic_control' || responsibility === 'perimeter_security') return 'traffic';
  if (responsibility === 'medical') return 'medical';
  if (responsibility === 'command') return 'command';
  if (type && AIR_TYPES.has(type)) return 'air';
  return 'attack';
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function tracksFromPlan(plan: Plan, run: { startMs: number; durationMinutes: number }, res: PlanResources): UnitTrack[] {
  const minutes = Math.max(1, Math.round(run.durationMinutes)) + 1;
  const asOf = Date.parse(String(plan.basis?.situationAsOf ?? plan.horizon?.start ?? ''));
  const decided = Number.isFinite(asOf) ? Math.max(0, Math.round((asOf - run.startMs) / 60_000)) : 0;
  const stationAt = new Map(res.stations.map((s) => [s.id as string, s]));
  const orgName = new Map(res.organizations.map((o) => [o.id as string, o.shortName ?? o.name]));
  const vehicleOf = new Map(res.vehicles.map((v) => [v.id as string, v]));
  const poolOf = new Map(res.pools.map((p) => [p.id as string, p]));
  const tracks: UnitTrack[] = [];
  const used = new Set<string>();

  for (const raw of plan.actions) {
    const action = raw as unknown as Json;
    const target = targetOf(action);
    if (!target) continue;
    const trigger = action.trigger as { kind?: string; at?: { offsetMinutes?: number } } | undefined;
    const leaves = decided + (trigger?.kind === 'at_time' ? num(trigger.at?.offsetMinutes) : 0);
    const effect = ((action.simulationEffects as Json[] | undefined) ?? [])[0];

    for (const r of (action.resources as Json[] | undefined) ?? []) {
      const id = String(r.resourceId);
      if (used.has(id)) continue;
      const vehicle = r.resourceType === 'vehicle' ? vehicleOf.get(id) : undefined;
      const pool = r.resourceType === 'personnel_pool' ? poolOf.get(id) : undefined;
      if (!vehicle && !pool) continue;
      const orgId = String((vehicle?.organizationId ?? pool?.organizationId) ?? '');
      const station = stationAt.get(String((vehicle?.stationId ?? pool?.stationId) ?? ''));
      const base = station?.position ?? (r.route ? { lat: lineStringCoordinates(r.route as never)[0]?.[1] ?? target.lat, lon: lineStringCoordinates(r.route as never)[0]?.[0] ?? target.lon } : null);
      if (!base) continue;
      used.add(id);

      const air = !!vehicle && AIR_TYPES.has(vehicle.type as string);
      const route = lineStringCoordinates(r.route as never).map(([lon, lat]) => ({ lat, lon }));
      const points = route.length > 1 ? route : [base, target];
      const speed = vehicle?.cruiseSpeedKmh ?? 50;
      const path = pathOf(points, speed, route.length > 1);
      const total = path.cum[path.cum.length - 1];
      const end = points[points.length - 1];

      // arrival: the backend's ETA from the order; a unit with none arrives when its effect starts, else after the straight line at its speed
      const startOffset = num((effect?.start as Json | undefined)?.offsetMinutes, Number.NaN);
      const eta = typeof r.etaMinutes === 'number' ? r.etaMinutes : Number.isFinite(startOffset) ? Math.max(0, startOffset - leaves) : total / 1000 / Math.max(speed, 1) * 60;
      const arrives = Math.min(minutes - 1, Math.round(leaves + eta));
      const window = num(effect?.durationMinutes, num(effect?.effectDurationMinutes, DEFAULT_WORK_MINUTES));
      const closes = (action.until as { offsetMinutes?: number } | undefined)?.offsetMinutes;
      const leavesAt = Math.min(minutes - 1, Math.round(leaves));
      const worksUntil = Math.min(minutes - 1, closes !== undefined ? decided + closes : arrives + window);

      const lat = new Float32Array(minutes);
      const lon = new Float32Array(minutes);
      const phase = new Uint8Array(minutes);
      const waterL = new Float32Array(minutes);
      const fuelPct = new Float32Array(minutes).fill(100);
      const pathIdx = new Int16Array(minutes).fill(-1);
      const dist = new Float32Array(minutes);
      const capacity = num(vehicle?.waterCapacityL) || 0;
      for (let t = 0; t < minutes; t++) {
        if (t < leavesAt) {
          lat[t] = base.lat;
          lon[t] = base.lon;
          phase[t] = PHASE_CODE.indexOf('base');
        } else if (t < arrives) {
          const f = arrives > leavesAt ? (t - leavesAt) / (arrives - leavesAt) : 1;
          dist[t] = total * f;
          pathIdx[t] = 0;
          lat[t] = base.lat + (end.lat - base.lat) * f; // the layer follows the path while pathIdx is set; this is only the fallback
          lon[t] = base.lon + (end.lon - base.lon) * f;
          phase[t] = PHASE_CODE.indexOf('en_route');
        } else if (t <= worksUntil) {
          lat[t] = end.lat;
          lon[t] = end.lon;
          phase[t] = PHASE_CODE.indexOf('working');
        } else {
          lat[t] = end.lat;
          lon[t] = end.lon;
          phase[t] = PHASE_CODE.indexOf('base'); // the effect is over: the unit leaves the map
        }
      }

      const spec: UnitSpec = {
        id,
        callsign: vehicle?.callsign ?? `Equipa ${id.slice(-4)}`,
        typeCode: vehicle?.typeCode ?? 'EQ',
        orgId,
        orgName: orgName.get(orgId) ?? orgId,
        stationId: (vehicle?.stationId ?? pool?.stationId ?? null) as string | null,
        role: roleOf(vehicle?.type as string | undefined, r.responsibility as string | undefined),
        air,
        base,
        baseName: station?.name ?? 'Posto',
        crew: num(r.personnel, num(vehicle?.crewCapacity)),
        minCrew: num(vehicle?.minimumCrew, 1),
        waterL: capacity,
        pumpLpm: num(vehicle?.pumpFlowLpm),
        speedKmh: speed,
        rangeKm: 0,
        fuelL: null, // the plan carries no fuel model: the tooltip leaves it out
        bucketL: num(vehicle?.aerial?.bucketCapacityL),
        loadMin: 0,
        maxWindKmh: 0,
        profile: { vehicleType: (vehicle?.type ?? 'forest_firefighting_vehicle') as UnitSpec['profile']['vehicleType'], offRoad: !!vehicle?.offRoad },
      };
      tracks.push({ unit: spec, lat, lon, phase, waterL, fuelPct, from: leavesAt, paths: [path], pathIdx, dist });
    }
  }
  return tracks;
}
