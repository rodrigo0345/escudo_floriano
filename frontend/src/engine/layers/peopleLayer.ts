import * as THREE from 'three';

import type { Plan, PlanAction } from '@/api';
import { lineStringCoordinates, polygonRings, type LonLat } from '@/domain/geojson';
import type { Georef } from '@/domain/georef';
import { actionWindows, type ActionWindow } from '@/domain/actionTiming';

export interface House {
  lat: number;
  lon: number;
  /** Index of the grid cell the house is in (to know when the fire reaches it). */
  cell: number;
}

const BURNING_MIN = 18;
const HOUSE_LIFT = 1.1;
const WALKER_COLOR = new THREE.Color('#ffd166');
const CAR_COLOR = new THREE.Color('#ffffff');
const SHELTER_COLOR = new THREE.Color('#3dff7a');
const WATER_COLOR = new THREE.Color('#7cc4ff');
const INTACT = new THREE.Color('#d9c7a0');
const FLAME = new THREE.Color('#ff7a1a');
const BURNED = new THREE.Color('#2a1c18');
const MAX_WALKERS_PER_EVACUATION = 70;
const DROPS_PER_ZONE = 36;
const RING_POINTS = 40;
const DROP_FALL_M = 28;
const DEFENCE_RADIUS_M = 140;

/** A moving crowd: the points leave the area along the route to the shelter while the evacuation is on. */
interface Crowd {
  window: ActionWindow;
  path: THREE.Vector3[];
  cumulative: number[];
  total: number;
  walkers: number;
  cars: number;
  /** minutes one walker takes to cover the route */
  period: number;
}

interface Zone {
  window: ActionWindow;
  base: THREE.Vector3[]; // where each droplet column / ring point stands on the terrain
  kind: 'defence' | 'shelter';
}

/**
 * The people and the buildings of the scene, alive with the plan:
 * - **evacuations**: walkers and cars leave the evacuated area along the plan's route to the shelter, while the evacuation is on;
 * - **shelter in place**: a green ring pulses over the houses where people stay in;
 * - **house defence**: a blue ring and falling water over the houses the engines are wetting;
 * - **every house** is a dot: tan while intact, flickering orange while the fire burns it, dark once it has burned.
 * It only draws what the plan says is happening at the playback minute.
 */
export class PeopleLayer {
  readonly group = new THREE.Group();
  private houses: House[] = [];
  private housePoints: THREE.Points | null = null;
  private houseState: Int8Array = new Int8Array(0);
  private ign: Int16Array | null = null;
  private crowds: Crowd[] = [];
  private zones: Zone[] = [];
  private walkerPoints: THREE.Points | null = null;
  private carPoints: THREE.Points | null = null;
  private zonePoints: THREE.Points | null = null;
  private lastMinute = Number.NaN;

  constructor(private readonly geo: Georef) {
    this.group.renderOrder = 7;
  }

  setHouses(houses: House[]): void {
    this.houses = houses;
    if (this.housePoints) {
      this.group.remove(this.housePoints);
      this.housePoints.geometry.dispose();
      (this.housePoints.material as THREE.Material).dispose();
      this.housePoints = null;
    }
    if (!houses.length) return;
    const positions = new Float32Array(houses.length * 3);
    const colors = new Float32Array(houses.length * 3);
    houses.forEach((h, i) => {
      const [x, y, z] = this.geo.world(h.lat, h.lon, HOUSE_LIFT);
      positions.set([x, y, z], i * 3);
      colors.set([INTACT.r, INTACT.g, INTACT.b], i * 3);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.housePoints = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 3.2, sizeAttenuation: false, vertexColors: true, depthWrite: false }));
    this.housePoints.renderOrder = 7;
    this.housePoints.frustumCulled = false;
    this.group.add(this.housePoints);
    this.houseState = new Int8Array(houses.length).fill(-1);
    this.lastMinute = Number.NaN;
  }

  /** The fire's arrival minute per grid cell (`-1`: never): houses change as it reaches them. */
  setFire(ign: Int16Array | null): void {
    this.ign = ign;
    this.houseState.fill(-1);
    this.lastMinute = Number.NaN;
  }

  setPlan(plan: Plan | null): void {
    this.clearActions();
    if (!plan) return;
    const windows = actionWindows(plan);
    const world = (ring: LonLat[]) => ring.map(([lon, lat]) => new THREE.Vector3(...this.geo.world(lat, lon, 1.6)));
    const centre = (ring: LonLat[]): LonLat => [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
    const zones: Zone[] = [];
    for (const action of plan.actions as PlanAction[]) {
      const w = windows.get(action.id as string);
      if (!w) continue;
      const a = action as unknown as Record<string, unknown>;
      if (action.type === 'evacuation') {
        const route = (a.routes as { geometry?: Parameters<typeof lineStringCoordinates>[0] }[] | undefined)?.[0]?.geometry;
        const area = polygonRings(a.area as Parameters<typeof polygonRings>[0])[0];
        const shelter = (a.shelters as { position?: { lat: number; lon: number } }[] | undefined)?.[0]?.position;
        let line: LonLat[] = route ? lineStringCoordinates(route) : [];
        if (line.length < 2 && area && shelter) line = [centre(area), [shelter.lon, shelter.lat]];
        if (line.length < 2) continue;
        const path = world(line);
        const cumulative = [0];
        for (let i = 1; i < path.length; i++) cumulative.push(cumulative[i - 1] + path[i].distanceTo(path[i - 1]));
        const people = Number(a.estimatedPeople ?? 0);
        const walkers = Math.max(10, Math.min(MAX_WALKERS_PER_EVACUATION, Math.round(people / 3)));
        this.crowds.push({ window: w, path, cumulative, total: cumulative[cumulative.length - 1] || 1, walkers, cars: Math.max(3, Math.round(walkers / 4)), period: Math.max(5, Math.min(30, (w.end - w.start) / 3 || 12)) });
      } else if (action.type === 'shelter_in_place' || action.type === 'structure_protection') {
        const effect = (a.simulationEffects as { geometry?: Parameters<typeof polygonRings>[0] }[] | undefined)?.[0];
        const ring = polygonRings((a.area as Parameters<typeof polygonRings>[0]) ?? effect?.geometry)[0];
        const point = (a.anchorPoint ?? a.position ?? (a.location as { position?: unknown } | undefined)?.position) as { lat: number; lon: number } | undefined;
        const at: LonLat | null = ring && ring.length ? centre(ring) : point ? [point.lon, point.lat] : null;
        if (!at) continue;
        const kind = action.type === 'shelter_in_place' ? 'shelter' : 'defence';
        const base: THREE.Vector3[] = [];
        const dLat = DEFENCE_RADIUS_M / 111_320;
        const dLon = dLat / Math.cos((at[1] * Math.PI) / 180);
        const count = kind === 'defence' ? DROPS_PER_ZONE : RING_POINTS;
        for (let i = 0; i < count; i++) {
          const angle = (i / count) * Math.PI * 2;
          const r = kind === 'defence' ? Math.sqrt(((i * 0.618) % 1) + 0.05) : 1; // droplets fill the disc, the shelter is a ring
          base.push(new THREE.Vector3(...this.geo.world(at[1] + Math.sin(angle) * dLat * r, at[0] + Math.cos(angle) * dLon * r, 0.5)));
        }
        zones.push({ window: w, base, kind });
      }
    }
    this.zones = zones;

    const make = (count: number, size: number, color: THREE.Color): THREE.Points => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3).fill(-1e5), 3));
      const points = new THREE.Points(geometry, new THREE.PointsMaterial({ size, sizeAttenuation: false, color, depthTest: false, transparent: true }));
      points.renderOrder = 9;
      points.frustumCulled = false;
      this.group.add(points);
      return points;
    };
    const walkers = this.crowds.reduce((s, c) => s + c.walkers, 0);
    const cars = this.crowds.reduce((s, c) => s + c.cars, 0);
    if (walkers) this.walkerPoints = make(walkers, 3, WALKER_COLOR);
    if (cars) this.carPoints = make(cars, 4, CAR_COLOR);
    const zonePoints = zones.reduce((s, z) => s + z.base.length, 0);
    if (zonePoints) {
      this.zonePoints = make(zonePoints, 2.6, WATER_COLOR);
      const colors = new Float32Array(zonePoints * 3);
      let k = 0;
      for (const z of zones) for (let i = 0; i < z.base.length; i++, k++) colors.set(z.kind === 'shelter' ? [SHELTER_COLOR.r, SHELTER_COLOR.g, SHELTER_COLOR.b] : [WATER_COLOR.r, WATER_COLOR.g, WATER_COLOR.b], k * 3);
      this.zonePoints.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      (this.zonePoints.material as THREE.PointsMaterial).vertexColors = true;
    }
  }

  /** Every frame: the crowds walk, the water falls, the rings pulse; the houses change when the minute does. */
  update(tf: number, timeS: number): void {
    this.updateHouses(tf);
    const along = (c: Crowd, p: number, out: THREE.Vector3, lateral: number): void => {
      const d = p * c.total;
      let i = 1;
      while (i < c.cumulative.length - 1 && c.cumulative[i] < d) i++;
      const span = c.cumulative[i] - c.cumulative[i - 1] || 1;
      const f = Math.min(1, Math.max(0, (d - c.cumulative[i - 1]) / span));
      out.lerpVectors(c.path[i - 1], c.path[i], f);
      out.x += lateral;
      out.z += lateral * 0.6;
      out.y += 0.6;
    };
    const tmp = new THREE.Vector3();
    for (const [points, cars] of [[this.walkerPoints, false], [this.carPoints, true]] as const) {
      if (!points) continue;
      const attr = points.geometry.getAttribute('position') as THREE.BufferAttribute;
      let k = 0;
      for (const c of this.crowds) {
        const count = cars ? c.cars : c.walkers;
        const on = tf >= c.window.start && tf < c.window.end;
        const period = cars ? c.period / 2.6 : c.period;
        for (let i = 0; i < count; i++, k++) {
          if (!on) {
            attr.setXYZ(k, 0, -1e5, 0);
            continue;
          }
          const p = (((tf - c.window.start) / period + i / count) % 1 + 1) % 1;
          along(c, p, tmp, ((i * 7919) % 11 - 5) * (cars ? 0.15 : 0.35));
          attr.setXYZ(k, tmp.x, tmp.y, tmp.z);
        }
      }
      attr.needsUpdate = true;
    }
    if (this.zonePoints) {
      const attr = this.zonePoints.geometry.getAttribute('position') as THREE.BufferAttribute;
      let k = 0;
      for (const z of this.zones) {
        const on = tf >= z.window.start && tf < z.window.end;
        for (let i = 0; i < z.base.length; i++, k++) {
          if (!on) {
            attr.setXYZ(k, 0, -1e5, 0);
            continue;
          }
          const b = z.base[i];
          if (z.kind === 'defence') {
            const fall = ((timeS * 0.9 + i * 0.37) % 1 + 1) % 1; // each droplet falls from 28 m to the roof and starts over
            attr.setXYZ(k, b.x, b.y + (1 - fall) * (DROP_FALL_M / this.geo.unit), b.z);
          } else {
            const pulse = 1 + 0.18 * Math.sin(timeS * 2.2);
            const base = z.base[0];
            attr.setXYZ(k, base.x + (b.x - base.x) * pulse, b.y + 0.8, base.z + (b.z - base.z) * pulse);
          }
        }
      }
      attr.needsUpdate = true;
    }
  }

  private updateHouses(tf: number): void {
    const minute = Math.floor(tf);
    if (!this.housePoints || !this.ign || minute === this.lastMinute) return;
    this.lastMinute = minute;
    const attr = this.housePoints.geometry.getAttribute('color') as THREE.BufferAttribute;
    let changed = false;
    for (let i = 0; i < this.houses.length; i++) {
      const arrival = this.houses[i].cell >= 0 ? this.ign[this.houses[i].cell] : -1;
      const state = arrival < 0 || arrival > minute ? 0 : minute - arrival < BURNING_MIN ? 1 : 2;
      if (state === this.houseState[i]) continue;
      this.houseState[i] = state;
      const c = state === 0 ? INTACT : state === 1 ? FLAME : BURNED;
      attr.setXYZ(i, c.r, c.g, c.b);
      changed = true;
    }
    if (changed) attr.needsUpdate = true;
  }

  private clearActions(): void {
    for (const points of [this.walkerPoints, this.carPoints, this.zonePoints]) {
      if (!points) continue;
      this.group.remove(points);
      points.geometry.dispose();
      (points.material as THREE.Material).dispose();
    }
    this.walkerPoints = this.carPoints = this.zonePoints = null;
    this.crowds = [];
    this.zones = [];
  }

  dispose(): void {
    this.clearActions();
    this.setHouses([]);
  }
}
