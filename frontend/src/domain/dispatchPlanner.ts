import { routingApi, type LatLon, type Place, type Responsibility, type Rules, type Vehicle, type VehicleCapability, type VehicleType, type WaterPoint } from '@/api';

import type { Georef } from './georef';

/**
 * The dispatch planner: given a finished baseline fire run and the registered, available vehicles, it decides who goes
 * where and when, and records how each unit would move (routes from `POST /routing/route`, water and fuel cycles using the
 * API's published `/rules`). Its output is turned into a real plan + dispatches by `usecases/dispatchDemo.ts`; the effect on
 * the fire is computed by the backend (`POST /plans/{id}/simulate`), never here.
 *
 * Each unit is used for exactly one assignment (one plan action → one dispatch).
 */

export type UnitPhase = 'base' | 'ordered' | 'en_route' | 'working' | 'to_water' | 'filling' | 'returning' | 'refueling';
export type UnitRole = 'attack' | 'air' | 'traffic' | 'medical' | 'command';

export const PHASE_CODE: UnitPhase[] = ['base', 'ordered', 'en_route', 'working', 'to_water', 'filling', 'returning', 'refueling'];

export interface UnitSpec {
  id: string;
  callsign: string;
  typeCode: string;
  orgId: string;
  orgName: string;
  stationId: string | null;
  role: UnitRole;
  air: boolean;
  base: LatLon;
  baseName: string;
  crew: number;
  minCrew: number;
  waterL: number;
  pumpLpm: number;
  speedKmh: number;
  rangeKm: number;
  fuelL: number | null;
  bucketL: number;
  loadMin: number;
  maxWindKmh: number;
  /** What the routing service needs to decide which roads this vehicle can use. */
  profile: { vehicleType: VehicleType; heightM?: number; widthM?: number; weightT?: number; offRoad: boolean; maxSlopePercent?: number };
}

export interface Target {
  id: string;
  label: string;
  lat: number;
  lon: number;
  kind: 'front' | 'place' | 'command';
  /** Grid cell of the front this standoff point serves, and how many times the road approach had to be retried farther away. */
  anchor?: { col: number; row: number };
  tries?: number;
}

export interface Path {
  pts: LatLon[];
  cum: number[];
  speedKmh: number;
  viaApi: boolean;
}

export interface Assignment {
  unit: UnitSpec;
  target: Target;
  orderedAt: number;
  arriveAt: number | null;
  endAt: number;
  crew: number;
  route: LatLon[];
  etaMin: number | null;
  drops: { t: number; lat: number; lon: number; litres: number }[];
  responsibility: Responsibility;
  mission: 'direct_attack' | 'traffic_control' | 'medical_response' | 'logistics';
}

/** Per-minute positions and states of every used unit, so the 3D map can replay the operation at any minute. */
export interface UnitTrack {
  unit: UnitSpec;
  lat: Float32Array;
  lon: Float32Array;
  phase: Uint8Array;
  waterL: Float32Array;
  fuelPct: Float32Array;
  /** First minute the unit leaves its base. */
  from: number;
  /** While driving (or flying) at a minute: which of `paths` it is on (-1 = not travelling) and how far along it is (m). The map follows the road between the minute samples. */
  paths: Path[];
  pathIdx: Int16Array;
  dist: Float32Array;
}

/** The point `d` metres along a path (clamped to its ends). */
export function pointAtDistance(path: Path, d: number): LatLon {
  const total = path.cum[path.cum.length - 1];
  const x = Math.min(Math.max(d, 0), total);
  let i = 1;
  while (i < path.cum.length - 1 && path.cum[i] < x) i++;
  const a = path.pts[i - 1];
  const b = path.pts[i];
  const f = Math.min(1, Math.max(0, (x - path.cum[i - 1]) / (path.cum[i] - path.cum[i - 1] || 1)));
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

/** How many people the unit has at a minute: its crew once dispatched, minus the casualties the engine's what-if says it suffers from `firstMinute` on. */
export function crewAt(track: UnitTrack, exposure: { firstMinute: number; casualties: number } | undefined, minute: number): { people: number; casualties: number } {
  const casualties = exposure && minute >= exposure.firstMinute ? exposure.casualties : 0;
  return { people: Math.max(0, track.unit.crew - casualties), casualties };
}

export interface LogEntry {
  t: number;
  text: string;
  kind: 'info' | 'ok' | 'warn' | 'bad';
}

interface Unit {
  spec: UnitSpec;
  used: boolean;
  phase: UnitPhase;
  lat: number;
  lon: number;
  waterL: number;
  fuelPct: number;
  crew: number;
  target: Target | null;
  path: Path | null;
  dist: number;
  timer: number;
  pending: boolean;
  token: number;
  assignment: Assignment | null;
  track: UnitTrack | null;
}

/** Resolves the way from A to B at scenario minute `atMinute`; `null` when the vehicle has no road path (the backend decides, we never draw a straight line for a ground vehicle). */
export type PathProvider = (from: LatLon, to: LatLon, spec: UnitSpec, atMinute: number) => Promise<Path | null>;

const R_EARTH = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;
const nearest = (from: LatLon, targets: LatLon[]): number => targets.reduce((best, p) => Math.min(best, haversineM(from, p)), Infinity);

export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

function buildPath(pts: LatLon[], speedKmh: number, viaApi: boolean): Path {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineM(pts[i - 1], pts[i]));
  return { pts, cum, speedKmh, viaApi };
}

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/**
 * Ground vehicles get their path from `POST /routing/route`, which owns the movement rules (closures, predicted fire with clearance, slope, width, off-road).
 * No path means the vehicle cannot go there: there is no straight-line fallback. Aircraft fly straight at their cruise speed.
 */
export function makePathProvider(locationId: string, simulationId: string, startMs: number, stats: { api: number; unroutable: number }): PathProvider {
  const cache = new Map<string, Path | null>();
  return async (from, to, spec, atMinute) => {
    if (spec.air) return buildPath([from, to], spec.speedKmh, false);
    const key = `${spec.id}|${from.lat.toFixed(3)},${from.lon.toFixed(3)}>${to.lat.toFixed(3)},${to.lon.toFixed(3)}|${Math.floor(atMinute / 10)}`;
    if (!cache.has(key)) {
      try {
        const r = await withTimeout(
          routingApi.route({
            locationId,
            from,
            to,
            at: new Date(startMs + atMinute * 60000).toISOString(),
            simulationId,
            vehicle: { ...spec.profile, speedKmh: spec.speedKmh },
            avoid: { activeClosures: true, predictedFire: true },
          }),
          8000,
        );
        if (r.found && r.geometry && r.distanceM && r.durationMin && r.geometry.coordinates.length >= 2) {
          const speed = Math.max(5, r.distanceM / 1000 / (r.durationMin / 60));
          cache.set(key, buildPath(r.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })), speed, true));
        } else cache.set(key, null);
      } catch {
        cache.set(key, null);
      }
    }
    const hit = cache.get(key) ?? null;
    if (hit) stats.api += 1;
    else stats.unroutable += 1;
    return hit;
  };
}

export interface PlannerInit {
  geo: Georef;
  ign: Int16Array;
  burnMinutes: Uint8Array;
  width: number;
  height: number;
  cellM: number;
  durationMinutes: number;
  places: Place[];
  waterPoints: WaterPoint[];
  units: UnitSpec[];
  rules: Rules;
  provider: PathProvider;
  alarmMinute: number;
  windAt: (t: number) => number | null;
  daylight: (t: number) => boolean;
  respectAirLimits: boolean;
}

const GROUND_PER_FRONT = 2;
const AIR_PER_FRONT = 1;
const TICK_MIN = 5;
const FUEL_RETREAT_PCT = 12;

export class DispatchPlanner {
  readonly units: Unit[];
  readonly log: LogEntry[] = [];
  readonly assignments: Assignment[] = [];
  private t = 0;
  private lastTick = -999;
  private readonly total: number;
  private readonly duty: number;
  private readonly refillMin: number;
  private readonly retreatPct: number;
  private readonly maxWorkMin: number;
  private readonly waterKinds: Set<string>;
  /** Crews stand at least this far from burning cells (the routing service keeps routes this far from the predicted fire as well). */
  private readonly clearanceM: number;
  /** Every path any unit has driven, shared by the tracks so the replay can follow the roads. */
  private readonly paths: Path[] = [];

  constructor(private readonly init: PlannerInit) {
    const r = init.rules;
    this.duty = r.water?.dutyCycle ?? 0.5;
    this.refillMin = r.water?.refill?.setupMinutes ?? 4;
    this.retreatPct = r.water?.refill?.retreatBelowPct ?? 15;
    this.maxWorkMin = r.crews?.maxContinuousWorkMinutes ?? 240;
    this.clearanceM = Math.max(r.movement?.fireClearanceM ?? 150, r.safety?.minSafeDistanceM ?? 100);
    this.waterKinds = new Set(r.water?.refill?.sources ?? ['hydrant', 'dry_hydrant', 'tank', 'reservoir', 'pond']);
    this.total = Math.ceil(init.durationMinutes) + 1;
    this.units = init.units.map((spec) => ({
      spec,
      used: false,
      phase: 'base',
      lat: spec.base.lat,
      lon: spec.base.lon,
      waterL: spec.waterL,
      fuelPct: 100,
      crew: 0,
      target: null,
      path: null,
      dist: 0,
      timer: 0,
      pending: false,
      token: 0,
      assignment: null,
      track: null,
    }));
  }

  private say(t: number, text: string, kind: LogEntry['kind'] = 'info') {
    this.log.push({ t, text, kind });
  }

  /** Plays the whole operation forward (1-minute steps), waiting for each route as needed. */
  async plan(onProgress?: (t: number) => void): Promise<void> {
    this.say(0, `${this.units.length} meios disponíveis. Alarme previsto aos T+${this.init.alarmMinute} min.`, 'info');
    for (let t = 0; t < this.total; t++) {
      this.t = t;
      if (t >= this.init.alarmMinute && (t - this.lastTick >= TICK_MIN || this.lastTick < 0)) {
        this.lastTick = t;
        this.dispatchTick(t);
      }
      await this.settle();
      for (const u of this.units) this.stepUnit(u, t, 1);
      for (const u of this.units) this.record(u, t);
      if (t % 10 === 0) {
        onProgress?.(t);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  /** Waits until no unit is waiting for a route. */
  private async settle(): Promise<void> {
    for (let i = 0; i < 400 && this.units.some((u) => u.pending); i++) await new Promise((r) => setTimeout(r, 15));
  }

  // ------------------------------------------------------------------ fire helpers (baseline run)
  private cellLatLon(col: number, row: number): LatLon {
    const g = this.init.geo;
    return { lat: g.north - (row + 0.5) * g.dLat, lon: g.west + (col + 0.5) * g.dLon };
  }
  private burning(i: number, t: number): boolean {
    const v = this.init.ign[i];
    return v >= 0 && t >= v && t < v + this.init.burnMinutes[i];
  }

  /** Burning cells with an unburned neighbour, grouped in ~8-cell blocks → ranked attack points. */
  private frontTargets(t: number): Target[] {
    const { width: W, height: H, ign } = this.init;
    const BIN = 8;
    const bins = new Map<number, { n: number; sc: number; sr: number }>();
    for (let r = 1; r < H - 1; r++) {
      for (let c = 1; c < W - 1; c++) {
        const i = r * W + c;
        if (!this.burning(i, t)) continue;
        if (![ign[i - 1], ign[i + 1], ign[i - W], ign[i + W]].some((v) => v < 0 || v > t)) continue;
        const key = Math.floor(r / BIN) * 10000 + Math.floor(c / BIN);
        const b = bins.get(key) ?? { n: 0, sc: 0, sr: 0 };
        b.n += 1;
        b.sc += c;
        b.sr += r;
        bins.set(key, b);
      }
    }
    const ranked = [...bins.values()]
      .filter((b) => b.n >= 2)
      .map((b) => ({ col: Math.round(b.sc / b.n), row: Math.round(b.sr / b.n), n: b.n }))
      .map((a) => ({ ...this.standoff(a.col, a.row, t), anchor: { col: a.col, row: a.row }, n: a.n }))
      .sort((a, b) => b.n - a.n);
    const picked: Target[] = [];
    for (const cand of ranked) {
      if (picked.every((p) => haversineM(p, cand) > 700)) {
        const near = this.nearestPlace(cand);
        picked.push({ id: `f${t}-${picked.length}`, label: `Frente de fogo${near ? ` perto de ${near.name}` : ''}`, lat: cand.lat, lon: cand.lon, kind: 'front', anchor: cand.anchor });
      }
      if (picked.length >= 6) break;
    }
    return picked;
  }

  /**
   * Where a crew may stand to work a front: the nearest cell with no burning cell within the safety clearance, preferring ground that has already burnt out
   * (firefighters anchor in the black). Standing on a burning cell would be a casualty, and the routing service would refuse the approach anyway.
   */
  private standoff(col: number, row: number, t: number, extraM = 0): LatLon {
    const { width: W, height: H, cellM } = this.init;
    const clearM = this.clearanceM + extraM;
    const reach = Math.ceil((clearM + 450) / cellM);
    const clear = Math.ceil(clearM / cellM);
    const safe = (c: number, r: number) => {
      for (let dr = -clear; dr <= clear; dr++)
        for (let dc = -clear; dc <= clear; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && cc >= 0 && rr < H && cc < W && Math.hypot(dr, dc) * cellM <= clearM && this.burning(rr * W + cc, t)) return false;
        }
      return true;
    };
    let best: { c: number; r: number; score: number } | null = null;
    for (let dr = -reach; dr <= reach; dr++)
      for (let dc = -reach; dc <= reach; dc++) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || r < 0 || c >= W || r >= H) continue;
        const v = this.init.ign[r * W + c];
        const burnt = v >= 0 && t >= v + this.init.burnMinutes[r * W + c];
        const score = Math.hypot(dr, dc) + (burnt ? 0 : 6); // prefer burnt-out ground; otherwise the nearest safe cell
        if ((!best || score < best.score) && safe(c, r)) best = { c, r, score };
      }
    return this.cellLatLon(best?.c ?? col, best?.r ?? row);
  }

  private fireNear(p: LatLon, radiusM: number, t: number): boolean {
    const [c0, r0] = this.init.geo.cellAt(p.lat, p.lon);
    const rc = Math.ceil(radiusM / this.init.cellM);
    for (let dr = -rc; dr <= rc; dr++)
      for (let dc = -rc; dc <= rc; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || c < 0 || r >= this.init.height || c >= this.init.width) continue;
        if (this.burning(r * this.init.width + c, t)) return true;
      }
    return false;
  }

  private fireCentroid(t: number): LatLon | null {
    const { width: W, height: H } = this.init;
    let n = 0;
    let sc = 0;
    let sr = 0;
    for (let r = 0; r < H; r += 2)
      for (let c = 0; c < W; c += 2)
        if (this.burning(r * W + c, t)) {
          n++;
          sc += c;
          sr += r;
        }
    return n ? this.cellLatLon(sc / n, sr / n) : null;
  }

  private nearestPlace(p: LatLon): Place | null {
    let best: Place | null = null;
    let bd = 2500;
    for (const pl of this.init.places) {
      const d = haversineM(p, pl.position);
      if (d < bd) {
        bd = d;
        best = pl;
      }
    }
    return best;
  }

  private nearestWater(from: LatLon, air: boolean, bucket: number): WaterPoint | null {
    let best: WaterPoint | null = null;
    let bd = Infinity;
    for (const w of this.init.waterPoints) {
      if (w.available === false) continue;
      if (air) {
        if (!w.helicopterAccessible) continue;
        if (bucket > 3500 && (w.areaM2 ?? 0) < 40000) continue; // scooping aeroplanes need a real lake or reservoir
      } else if (!w.truckAccessible || !this.waterKinds.has(w.kind)) continue;
      const d = haversineM(from, w.position);
      if (d < bd) {
        bd = d;
        best = w;
      }
    }
    return best;
  }

  private airAllowed(t: number, s: UnitSpec): boolean {
    if (!this.init.respectAirLimits) return true;
    const lim = this.init.rules.aerial?.limits;
    const maxWind = Math.min(s.maxWindKmh, lim?.maxWindKmh ?? 999);
    return (!lim?.dayOnly || this.init.daylight(t)) && (this.init.windAt(t) ?? 0) <= maxWind;
  }

  // ------------------------------------------------------------------- dispatching
  private travel(u: Unit, to: LatLon, via: UnitPhase) {
    u.pending = true;
    u.token += 1;
    const token = u.token;
    void this.init.provider({ lat: u.lat, lon: u.lon }, to, u.spec, this.t).then((path) => {
      if (u.token !== token) return;
      u.pending = false;
      if (!path) return this.noRoad(u, via);
      u.path = path;
      u.dist = 0;
      u.phase = via;
    });
  }

  /** The routing service found no road path (slope, width, closures or predicted fire): the order is void, or the unit just gets home some other way. */
  private noRoad(u: Unit, via: UnitPhase) {
    const t = this.t;
    const tg = u.target;
    if (via === 'en_route' && u.assignment && u.assignment.arriveAt == null && tg?.kind === 'front' && tg.anchor && (tg.tries ?? 0) < 3) {
      // the road to that standoff point passes the predicted fire: work the front from farther along a road that stays clear of it
      const tries = (tg.tries ?? 0) + 1;
      const p = this.standoff(tg.anchor.col, tg.anchor.row, t, tries * 350);
      const next: Target = { ...tg, lat: p.lat, lon: p.lon, tries };
      u.target = next;
      u.assignment.target = next;
      this.travel(u, next, 'en_route');
      return;
    }
    if (via === 'en_route' && u.assignment && u.assignment.arriveAt == null) {
      this.say(t, `${u.spec.callsign} não tem caminho por estrada até ${u.target?.label ?? 'ao destino'} (declive, largura, cortes ou fogo previsto; ${u.target ? `${u.target.lat.toFixed(4)}, ${u.target.lon.toFixed(4)}` : ''}, ${(u.target?.tries ?? 0) + 1} tentativas): ordem anulada.`, 'warn');
      this.assignments.splice(this.assignments.indexOf(u.assignment), 1);
      u.assignment = null;
      u.target = null;
      u.crew = 0;
      u.phase = 'base';
    } else if (via === 'returning') {
      u.lat = u.spec.base.lat;
      u.lon = u.spec.base.lon;
      u.phase = 'refueling';
      u.timer = 6;
    } else {
      this.finish(u, t, 'sem caminho por estrada');
    }
  }

  private order(u: Unit, target: Target, t: number, responsibility: Responsibility, mission: Assignment['mission']) {
    u.used = true;
    u.crew = u.spec.crew;
    u.target = target;
    u.phase = 'ordered';
    u.waterL = u.spec.waterL;
    u.assignment = { unit: u.spec, target, orderedAt: t, arriveAt: null, endAt: t, crew: u.crew, route: [], etaMin: null, drops: [], responsibility, mission };
    this.assignments.push(u.assignment);
    this.say(t, `${u.spec.callsign} (${u.spec.orgName}) despachado para ${target.label} com ${u.crew} operadores.`, 'info');
    this.travel(u, target, 'en_route');
  }

  private sendHome(u: Unit, t: number, why: string) {
    this.say(t, `${u.spec.callsign} regressa à base (${why}).`, 'info');
    u.token += 1;
    u.pending = false;
    if (u.assignment) u.assignment.endAt = t;
    this.travel(u, u.spec.base, 'returning');
  }

  private dispatchTick(t: number) {
    const front = this.frontTargets(t);
    if (t === this.init.alarmMinute) this.say(t, 'ALARME: incêndio detetado. O centro de operações ativa os meios registados.', 'bad');
    const idle = (role: UnitRole) => this.units.filter((u) => u.spec.role === role && !u.used);
    const covering = (tg: Target, role: UnitRole) =>
      this.units.filter((u) => u.spec.role === role && u.used && u.target && u.phase !== 'returning' && u.phase !== 'refueling' && u.phase !== 'base' && haversineM(u.target, tg) < 900).length;
    const airOk = (u: Unit) => u.spec.air && this.airAllowed(t, u.spec) && u.fuelPct > 30;
    // A crew arrives long after it is ordered: it must work the front where the fire will be when it gets there, not where it is now.
    const ahead = new Map<number, Target[]>();
    const frontsAt = (minute: number) => {
      const key = Math.min(Math.floor(minute / 10) * 10, Math.floor(this.init.durationMinutes));
      if (!ahead.has(key)) ahead.set(key, this.frontTargets(key));
      return ahead.get(key) as Target[];
    };
    for (const [role, want] of [['attack', GROUND_PER_FRONT], ['air', AIR_PER_FRONT]] as const) {
      let budget = Math.max(1, front.length) * want;
      for (const u of idle(role).filter((x) => role !== 'air' || airOk(x)).sort((a, b) => nearest(a.spec.base, front) - nearest(b.spec.base, front))) {
        if (budget <= 0 || !front.length) break;
        const lead = Math.min(120, nearest(u.spec.base, front) / (u.spec.speedKmh * (u.spec.air ? 1000 : 550) / 60)); // minutes to get there (ground units at ~55% of cruise)
        const tg = [...frontsAt(t + lead)].sort((a, b) => haversineM(u.spec.base, a) - haversineM(u.spec.base, b))[0];
        if (!tg || covering(tg, role) >= want) continue;
        this.order(u, tg, t, 'firefighting', 'direct_attack');
        budget -= 1;
      }
    }
    // support units go once, to the places nearest the fire
    const support = this.units.filter((u) => ['traffic', 'medical', 'command'].includes(u.spec.role) && !u.used);
    const centre = support.length ? this.fireCentroid(t) : null;
    if (centre) {
      const places = [...this.init.places].sort((a, b) => haversineM(a.position, centre) - haversineM(b.position, centre)).slice(0, 8);
      let k = 0;
      for (const u of support) {
        const pl = places[k % Math.max(1, places.length)];
        if (!pl || haversineM(pl.position, centre) > 6000) continue;
        const tg: Target = { id: `p-${pl.id}`, label: pl.name, lat: pl.position.lat, lon: pl.position.lon, kind: u.spec.role === 'command' ? 'command' : 'place' };
        if (u.spec.role === 'command') this.order(u, tg, t, 'command', 'logistics');
        else if (u.spec.role === 'medical') this.order(u, tg, t, 'medical', 'medical_response');
        else this.order(u, tg, t, 'traffic_control', 'traffic_control');
        k += 1;
      }
    }
  }

  // -------------------------------------------------------------------- unit state machine
  private stepUnit(u: Unit, t: number, dt: number) {
    const s = u.spec;
    if (u.pending) return;
    switch (u.phase) {
      case 'en_route':
      case 'to_water':
      case 'returning': {
        if (!u.path) return;
        const km = (u.path.speedKmh * dt) / 60;
        u.dist += km * 1000;
        u.fuelPct = Math.max(0, u.fuelPct - (km / Math.max(50, s.rangeKm)) * 100);
        const total = u.path.cum[u.path.cum.length - 1];
        const d = Math.min(u.dist, total);
        let i = 1;
        while (i < u.path.cum.length - 1 && u.path.cum[i] < d) i++;
        const a = u.path.pts[i - 1];
        const b = u.path.pts[i];
        const f = Math.min(1, Math.max(0, (d - u.path.cum[i - 1]) / (u.path.cum[i] - u.path.cum[i - 1] || 1)));
        u.lat = a.lat + (b.lat - a.lat) * f;
        u.lon = a.lon + (b.lon - a.lon) * f;
        if (u.dist >= total) this.arrive(u, t);
        return;
      }
      case 'working': {
        const worked = t - (u.assignment?.arriveAt ?? t);
        const over = worked >= this.maxWorkMin;
        const supportRole = s.role === 'traffic' || s.role === 'medical' || s.role === 'command';
        if (supportRole) return; // they stay until the end of the operation
        u.fuelPct = Math.max(0, u.fuelPct - 0.12 * dt);
        if (s.role === 'attack') {
          u.waterL = Math.max(0, u.waterL - s.pumpLpm * this.duty * dt);
          if (t % TICK_MIN === 0 && u.target && !this.fireNear(u.target, 900, t)) return this.finish(u, t, 'frente extinta ou sem fogo na zona');
          if (over || u.fuelPct < FUEL_RETREAT_PCT) return this.finish(u, t, over ? 'limite de trabalho contínuo' : 'combustível');
          if (s.waterL > 0 && u.waterL <= (this.retreatPct / 100) * s.waterL) {
            // with no mapped water point for trucks, the station's own supply is the fallback
            const wp = this.nearestWater(u, false, 0);
            this.say(t, `${s.callsign} sem água — reabastece ${wp ? `em ${wp.name ?? wp.kind}` : 'no quartel (sem pontos de água mapeados)'}.`, 'warn');
            this.travel(u, wp?.position ?? s.base, 'to_water');
          }
        } else if (s.role === 'air') {
          if (u.assignment) u.assignment.drops.push({ t, lat: u.lat, lon: u.lon, litres: s.bucketL });
          this.say(t, `${s.callsign} larga ${Math.round(s.bucketL)} L sobre ${u.target?.label ?? 'a frente'}.`, 'ok');
          u.waterL = 0;
          const wp = this.nearestWater(u, true, s.bucketL);
          if (wp && u.fuelPct > 22 && u.target && this.fireNear(u.target, 1100, t) && !over) this.travel(u, wp.position, 'to_water');
          else this.finish(u, t, !wp ? 'sem água acessível' : 'fim da missão aérea');
        }
        return;
      }
      case 'filling': {
        u.timer -= dt;
        if (u.timer > 0) return;
        u.waterL = s.air ? s.bucketL : s.waterL;
        if (u.target && this.fireNear(u.target, 1100, t) && (!s.air || (u.fuelPct > 22 && this.airAllowed(t, s)))) this.travel(u, u.target, 'en_route');
        else this.finish(u, t, 'fim da missão');
        return;
      }
      case 'refueling': {
        u.timer -= dt;
        if (u.timer <= 0) {
          u.fuelPct = 100;
          u.waterL = s.waterL;
          u.phase = 'base';
          u.lat = s.base.lat;
          u.lon = s.base.lon;
          this.say(t, `${s.callsign} reabastecido e de volta ao quartel.`, 'ok');
        }
        return;
      }
      default:
        return;
    }
  }

  private finish(u: Unit, t: number, why: string) {
    u.crew = 0;
    this.sendHome(u, t, why);
  }

  private arrive(u: Unit, t: number) {
    const s = u.spec;
    if (u.phase === 'en_route') {
      u.phase = 'working';
      const a = u.assignment;
      if (a && a.arriveAt == null) {
        a.arriveAt = t;
        a.route = u.path?.pts ?? [];
        a.etaMin = t - a.orderedAt;
      }
      this.say(t, `${s.callsign} chegou a ${u.target?.label ?? 'destino'}${u.path?.viaApi || s.air ? '' : ' (trajeto estimado)'}.`, 'ok');
    } else if (u.phase === 'to_water') {
      u.phase = 'filling';
      u.timer = s.air ? s.loadMin : this.refillMin;
    } else if (u.phase === 'returning') {
      u.phase = 'refueling';
      u.timer = 6;
      u.lat = s.base.lat;
      u.lon = s.base.lon;
    }
  }

  // ------------------------------------------------------------------------- recording
  private record(u: Unit, t: number) {
    if (!u.used) return;
    if (!u.track) {
      u.track = {
        unit: u.spec,
        lat: new Float32Array(this.total).fill(u.spec.base.lat),
        lon: new Float32Array(this.total).fill(u.spec.base.lon),
        phase: new Uint8Array(this.total),
        waterL: new Float32Array(this.total).fill(u.spec.waterL),
        fuelPct: new Float32Array(this.total).fill(100),
        from: t,
        paths: this.paths,
        pathIdx: new Int16Array(this.total).fill(-1),
        dist: new Float32Array(this.total),
      };
    }
    const k = u.track;
    if (u.path && (u.phase === 'en_route' || u.phase === 'to_water' || u.phase === 'returning')) {
      let idx = this.paths.indexOf(u.path);
      if (idx < 0) idx = this.paths.push(u.path) - 1;
      k.pathIdx[t] = idx;
      k.dist[t] = u.dist;
    }
    k.lat[t] = u.lat;
    k.lon[t] = u.lon;
    k.phase[t] = PHASE_CODE.indexOf(u.phase);
    k.waterL[t] = u.waterL;
    k.fuelPct[t] = u.fuelPct;
    if (u.assignment && u.phase !== 'base' && u.phase !== 'refueling') u.assignment.endAt = t;
  }

  get tracks(): UnitTrack[] {
    return this.units.map((u) => u.track).filter((k): k is UnitTrack => !!k);
  }
}

// ----------------------------------------------------------------- building units from the registry
const ATTACK_TYPES = new Set(['forest_firefighting_vehicle', 'light_firefighting_vehicle', 'urban_firefighting_vehicle', 'tanker_forest', 'tanker_urban', 'tanker_large']);
const hasCap = (v: Vehicle, c: VehicleCapability) => v.capabilities?.includes(c) ?? false;

export function roleOf(v: Vehicle): UnitRole | null {
  if (v.type === 'helicopter' || v.type === 'airtanker') return v.aerial?.bucketCapacityL ? 'air' : null;
  if (ATTACK_TYPES.has(v.type) && (v.waterCapacityL ?? 0) > 0) return 'attack';
  if (v.type === 'ambulance' || v.type === 'advanced_medical_vehicle' || v.type === 'immediate_life_support_vehicle') return 'medical';
  if (v.type === 'command_vehicle' || v.type === 'command_comms_vehicle' || v.type === 'operations_vehicle') return 'command';
  if (hasCap(v, 'traffic_control') || hasCap(v, 'perimeter_security')) return 'traffic';
  return null;
}

const DEFAULT_SPEED: Record<UnitRole, number> = { attack: 75, air: 250, traffic: 95, medical: 100, command: 85 };

/** Registered, in-service, available vehicles → planner units (stations give the base position). */
export function unitsFromVehicles(
  vehicles: Vehicle[],
  orgName: (id: string) => string,
  station: (id: string | null | undefined) => { pos: LatLon; name: string } | null,
  fallbackBase: LatLon,
): UnitSpec[] {
  const out: UnitSpec[] = [];
  for (const v of vehicles) {
    const role = roleOf(v);
    if (!role || v.inService === false || (v.state?.status ?? 'available') !== 'available') continue;
    const st = station(v.stationId);
    const air = role === 'air';
    out.push({
      id: v.id as string,
      callsign: v.callsign,
      typeCode: v.typeCode ?? v.type,
      orgId: v.organizationId as string,
      orgName: orgName(v.organizationId as string),
      stationId: v.stationId ?? null,
      role,
      air,
      base: st?.pos ?? v.state?.position ?? fallbackBase,
      baseName: st?.name ?? 'base',
      crew: v.crewCapacity,
      minCrew: v.minimumCrew ?? Math.min(v.crewCapacity, 1),
      waterL: v.waterCapacityL ?? 0,
      pumpLpm: v.pumpFlowLpm ?? 500,
      speedKmh: v.aerial?.cruiseSpeedKmh ?? v.cruiseSpeedKmh ?? DEFAULT_SPEED[role],
      rangeKm: v.rangeKm ?? (air ? 600 : 500),
      fuelL: v.fuelCapacityL ?? null,
      bucketL: v.aerial?.bucketCapacityL ?? 0,
      loadMin: v.aerial?.loadMinutes ?? 1,
      maxWindKmh: v.aerial?.maxWindKmh ?? 50,
      profile: { vehicleType: v.type, heightM: v.heightM, widthM: v.widthM, weightT: v.weightT, offRoad: v.offRoad ?? false, maxSlopePercent: v.maxSlopePercent },
    });
  }
  return out;
}
