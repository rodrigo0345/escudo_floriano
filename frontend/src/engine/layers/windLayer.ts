import * as THREE from 'three';

import type { WeatherSample } from '@/api';
import { windColor } from '@/domain/colors';
import type { Georef } from '@/domain/georef';
import { sampleWeatherAt } from '@/domain/weather';

const MAX_TOTAL_INSTANCES = 500;
const ACTIVE_WINDOW_MIN = 25;
const MIN_INTENSITY_KWM = 350;
const INFLOW_DECAY_M = 900;
const INFLOW_REACH_M = 2800;
const INFLOW_EFFICIENCY = 1.55; // Convective indraft velocity scaling (~20-28 km/h for active wildfire)
const GRAVITY = 9.81;
const HEAT_CAPACITY = 360_000;
const MAX_INDUCED_KMH = 34;
const MAX_INDUCED_FRACTION = 0.85;
const WIND_LIFT = 4.8; // 48 m above local terrain height

export interface WindRun {
  ign: Int16Array;
  inten: Uint16Array;
  gridWidth: number;
  gridHeight: number;
  weather: WeatherSample[];
  startMs: number;
}

interface ActiveCluster {
  x: number;
  z: number;
  intensity: number;
  count: number;
}

interface PlacedArrow {
  wx: number;
  wz: number;
  heading: number;
  speedKmh: number;
  isFireZone: boolean;
}

const inflowSpeed = (intensityKwm: number): number =>
  INFLOW_EFFICIENCY * Math.cbrt((GRAVITY * intensityKwm * 1000) / HEAT_CAPACITY);



/**
 * 3D wind vector field with spatial redundancy pruning:
 * - Candidate points are evaluated and checked against neighboring arrows.
 * - If two arrows are close and pointing in a similar direction (redundant), only one representative arrow is kept.
 * - The 'Densidade' slider directly controls the separation radius, letting the user dial between
 *   sparse/minimalist and fine-grained resolution with zero duplicate or colliding arrows.
 */
export class WindLayer {
  readonly group = new THREE.Group();
  private readonly arrowGeometry: THREE.ShapeGeometry;
  private readonly arrowMaterial: THREE.MeshBasicMaterial;
  private readonly arrows: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private run: WindRun | null = null;
  private lastMinute = -1;
  private density = 0.5; // 0.2 to 1.0 (default 50%)

  constructor(private geo: Georef) {
    // Aerodynamic, crisp vector arrow: solid shaft and clear swept arrowhead
    const shape = new THREE.Shape();
    shape.moveTo(0, -2.8);       // Sharp tip pointing north (-z)
    shape.lineTo(1.25, -0.6);    // Swept-back head barb
    shape.lineTo(0.44, -0.5);    // Inner notch
    shape.lineTo(0.44, 1.9);     // Shaft
    shape.lineTo(-0.44, 1.9);    // Shaft
    shape.lineTo(-0.44, -0.5);   // Inner notch
    shape.lineTo(-1.25, -0.6);   // Swept-back head barb
    shape.closePath();
    this.arrowGeometry = new THREE.ShapeGeometry(shape);
    this.arrowGeometry.rotateX(Math.PI / 2); // tip (y = -2.8) rotates to -z (North)

    this.arrowMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      depthTest: false,
    });

    this.arrows = new THREE.InstancedMesh(this.arrowGeometry, this.arrowMaterial, MAX_TOTAL_INSTANCES);
    this.arrows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.arrows.frustumCulled = false;
    this.arrows.renderOrder = 12; // Render above terrain and surface roads
    this.arrows.visible = false;
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < MAX_TOTAL_INSTANCES; i++) this.arrows.setColorAt(i, white);
    this.group.add(this.arrows);
  }

  setEnabled(enabled: boolean): void {
    this.group.visible = enabled;
    this.arrows.visible = enabled && !!this.run && this.lastMinute >= 0;
  }

  setRun(run: WindRun | null): void {
    this.run = run;
    this.lastMinute = -1;
    this.arrows.visible = false;
  }

  setDensity(pct: number): void {
    const d = Math.max(0.2, Math.min(1.0, pct / 100));
    if (Math.abs(this.density - d) < 0.01) return;
    this.density = d;
    if (this.run && this.lastMinute >= 0) {
      this.apply(this.lastMinute);
    }
  }

  /** Subtle breathing opacity oscillation so the wind field feels dynamic without jerky movement. */
  updateFlow(minute: number): void {
    if (!this.run || !this.group.visible) return;
    this.arrowMaterial.opacity = 0.82 + 0.1 * ((Math.sin(minute * 1.6) + 1) / 2);
  }

  /** Recomputes the wind field at a whole playback minute. */
  setTime(minute: number): void {
    if (!this.run) {
      this.arrows.visible = false;
      return;
    }
    const m = Math.max(0, Math.round(minute));
    if (m === this.lastMinute) return;
    this.lastMinute = m;
    this.apply(m);
    this.arrows.visible = this.group.visible;
  }

  private apply(minute: number): void {
    const run = this.run!;
    const ambient = sampleWeatherAt(run.weather, run.startMs, minute);
    const ambToDeg = ambient ? (ambient.windFromDeg + 180) % 360 : 0;
    const ambSpeedKmh = ambient?.windKmh ?? 16;
    const ambSpeedMs = ambSpeedKmh / 3.6;
    const ambRad = (ambToDeg * Math.PI) / 180;
    const ambVx = Math.sin(ambRad) * ambSpeedMs;
    const ambVz = -Math.cos(ambRad) * ambSpeedMs; // +z is South in Three.js coordinates

    // 1. Gather active burning cells into spatial clusters
    const clusters = new Map<number, ActiveCluster>();
    const clusterCellSize = 6;
    const clusterCols = Math.ceil(run.gridWidth / clusterCellSize);

    for (let row = 0; row < run.gridHeight; row++) {
      for (let col = 0; col < run.gridWidth; col++) {
        const c = row * run.gridWidth + col;
        const at = run.ign[c];
        if (at < 0 || at > minute || at < minute - ACTIVE_WINDOW_MIN) continue;
        const inten = run.inten[c];
        if (inten < MIN_INTENSITY_KWM) continue;

        const cx = Math.floor(col / clusterCellSize);
        const cy = Math.floor(row / clusterCellSize);
        const key = cy * clusterCols + cx;
        const u = (col + 0.5) / run.gridWidth;
        const v = (row + 0.5) / run.gridHeight;
        const wx = this.geo.x(u);
        const wz = this.geo.z(v);

        const existing = clusters.get(key);
        if (existing) {
          existing.x = (existing.x * existing.count + wx) / (existing.count + 1);
          existing.z = (existing.z * existing.count + wz) / (existing.count + 1);
          existing.intensity = Math.max(existing.intensity, inten);
          existing.count++;
        } else {
          clusters.set(key, { x: wx, z: wz, intensity: inten, count: 1 });
        }
      }
    }

    const activeList = Array.from(clusters.values());

    // Helper: computes the convective wind vector at world position (wx, wz)
    const computeVectorAt = (wx: number, wz: number) => {
      let indVx = 0;
      let indVz = 0;
      let maxHeat = 0;

      for (const cl of activeList) {
        const dx = cl.x - wx;
        const dz = cl.z - wz;
        const distM = Math.hypot(dx, dz) * this.geo.unit;
        if (distM > INFLOW_REACH_M) continue;
        const effDist = Math.max(30, distM);
        const countWeight = Math.min(2.0, Math.sqrt(cl.count) * 0.7 + 0.3);
        const pull = inflowSpeed(cl.intensity) * countWeight * Math.exp(-effDist / INFLOW_DECAY_M);
        indVx += (pull * dx * this.geo.unit) / effDist;
        indVz += (pull * dz * this.geo.unit) / effDist;
        const heat = Math.exp(-effDist / 550);
        if (heat > maxHeat) maxHeat = heat;
      }

      const indSpeed = Math.hypot(indVx, indVz);
      const capMs = Math.max(4.0, Math.min(MAX_INDUCED_KMH / 3.6, MAX_INDUCED_FRACTION * ambSpeedMs + 3.0));
      if (indSpeed > capMs) {
        indVx *= capMs / indSpeed;
        indVz *= capMs / indSpeed;
      }

      const netVx = ambVx + indVx;
      const netVz = ambVz + indVz;
      const netSpeedKmh = Math.hypot(netVx, netVz) * 3.6;
      const heading = Math.atan2(netVx, -netVz);

      return { heading, speedKmh: netSpeedKmh, isFireZone: maxHeat > 0.12 };
    };

    // --- SPATIAL REDUNDANCY FILTER ---
    // Driven by the user's density slider:
    // R_hard: absolute minimum physical distance (prevents overlapping/colliding arrows)
    // R_soft: redundancy distance for arrows pointing in similar directions (< 35°)
    const densityExp = Math.pow(this.density, 0.65);
    const R_hard = 180 / densityExp; // e.g. ~280m at 50% density
    const R_soft = 420 / densityExp; // e.g. ~660m at 50% density

    const cellSizeUnits = Math.max(15, R_soft / this.geo.unit);
    const buckets = new Map<string, PlacedArrow[]>();
    const placed: PlacedArrow[] = [];

    const tryPlaceCandidate = (wx: number, wz: number): boolean => {
      if (placed.length >= MAX_TOTAL_INSTANCES) return false;
      if (Math.abs(wx) >= this.geo.W * 0.48 || Math.abs(wz) >= this.geo.H * 0.48) return false;

      const { heading, speedKmh, isFireZone } = computeVectorAt(wx, wz);

      const bx = Math.floor(wx / cellSizeUnits);
      const bz = Math.floor(wz / cellSizeUnits);

      // Check neighboring buckets for collisions or directional redundancy
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = buckets.get(`${bx + dx},${bz + dz}`);
          if (!list) continue;
          for (const p of list) {
            const distM = Math.hypot(p.wx - wx, p.wz - wz) * this.geo.unit;
            // 1. Collision check: arrows physically too close
            if (distM < R_hard) return false;
            // 2. Redundancy check: arrows close and pointing in similar direction (< 35°)
            if (distM < R_soft) {
              const diffAngle = Math.abs(((((heading - p.heading + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI);
              if (diffAngle < 0.6) {
                // Prune redundant parallel arrow
                return false;
              }
            }
          }
        }
      }

      const arrow: PlacedArrow = { wx, wz, heading, speedKmh, isFireZone };
      placed.push(arrow);
      const key = `${bx},${bz}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(arrow);
      else buckets.set(key, [arrow]);

      return true;
    };

    // --- STEP A: Fire zone candidates (evaluated first so the fire inflow gets primary representation) ---
    if (activeList.length > 0) {
      // Concentrated probe rings from 140m to 1600m
      const ringsM = [140, 280, 500, 850, 1300, 1750];
      const angles = [0, 45, 90, 135, 180, 225, 270, 315];

      for (const cl of activeList) {
        if (placed.length >= MAX_TOTAL_INSTANCES) break;
        for (const distM of ringsM) {
          const distUnits = distM / this.geo.unit;
          for (const aDeg of angles) {
            const rad = (aDeg * Math.PI) / 180;
            const wx = cl.x + Math.sin(rad) * distUnits;
            const wz = cl.z + Math.cos(rad) * distUnits;
            tryPlaceCandidate(wx, wz);
          }
        }
      }
    }

    // --- STEP B: Regional ambient grid across the territory ---
    const ambStepM = 520 / densityExp;
    const ambStepUnits = ambStepM / this.geo.unit;
    const xMin = -this.geo.W * 0.46;
    const xMax = this.geo.W * 0.46;
    const zMin = -this.geo.H * 0.46;
    const zMax = this.geo.H * 0.46;

    for (let wz = zMin; wz <= zMax; wz += ambStepUnits) {
      for (let wx = xMin; wx <= xMax; wx += ambStepUnits) {
        if (placed.length >= MAX_TOTAL_INSTANCES) break;
        tryPlaceCandidate(wx, wz);
      }
    }

    // --- RENDER ALL PLACED NON-REDUNDANT ARROWS ---
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      const [lat, lon] = this.geo.toLatLon(p.wx, p.wz);
      const [x, y, z] = this.geo.world(lat, lon, WIND_LIFT);

      this.quat.setFromAxisAngle(this.up, p.heading);

      // Clean scale: balanced and legible without overcrowding
      const k = (2.2 + 0.5 * this.density) + Math.min(p.speedKmh, 60) / 24;
      this.pos.set(x, y, z);
      this.scale.set(k, 1, k);
      this.matrix.compose(this.pos, this.quat, this.scale);
      this.arrows.setMatrixAt(i, this.matrix);

      // Color strictly based on net wind speed (matching the HUD and LayersPanel legend)
      const [r, g, b] = windColor(p.speedKmh);
      this.color.setRGB(r / 255, g / 255, b / 255);
      this.arrows.setColorAt(i, this.color);
    }

    this.arrows.count = placed.length;
    this.arrows.instanceMatrix.needsUpdate = true;
    if (this.arrows.instanceColor) this.arrows.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.arrowGeometry.dispose();
    this.arrowMaterial.dispose();
    this.arrows.dispose();
  }
}
