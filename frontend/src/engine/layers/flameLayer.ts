import * as THREE from 'three';

import type { Georef } from '@/domain/georef';

import { BurnStyle } from '../burnShader';

/** One simulation's fire, per grid cell (same layout as the terrain's fire data). */
export interface FlameRun {
  ign: Int16Array; // minute of ignition, -1 = never burns
  inten: Uint16Array; // fireline intensity, kW/m
  flags: Uint8Array; // bit 0 = crown fire
  dur: Uint8Array; // minutes the cell keeps burning (residence time from the vegetation)
  width: number;
  height: number;
}

/**
 * How each fuel burns, as separate small fires inside a 60 m cell: how many, how tall (m), how long each one lasts as a share of the cell's burning time, and how
 * wide the fire column is relative to its height. Trees torch one by one and tall; shrubs flare at head height; grass makes many low, short-lived flames; a building
 * is one big, long fire.
 */
const FUEL: Record<number, { spots: number; heightM: [number, number]; life: [number, number]; width: number }> = {
  [BurnStyle.Forest]: { spots: 7, heightM: [9, 22], life: [0.25, 0.55], width: 0.42 },
  [BurnStyle.Shrub]: { spots: 9, heightM: [3, 7], life: [0.2, 0.45], width: 0.55 },
  [BurnStyle.Grass]: { spots: 14, heightM: [1.2, 3], life: [0.1, 0.3], width: 0.7 },
  [BurnStyle.Urban]: { spots: 2, heightM: [7, 14], life: [0.5, 0.9], width: 0.6 },
  [BurnStyle.Bare]: { spots: 2, heightM: [1, 2], life: [0.1, 0.2], width: 0.7 },
};
/** Crown fire: the flames stand on the canopy and reach well above it. */
const CROWN_EXTRA_M = 14;
/** Fires are drawn larger than life so they still read from a few hundred metres up. */
const VISUAL_SCALE = 2.2;
/** Glowing particles per small fire: enough to look like a solid, rounded column of flame from any side. */
const PARTICLES_PER_SPOT = 20;
const MAX_PARTICLES = 120000;
const REPICK_MIN = 0.1;

const VERTEX = /* glsl */ `
attribute vec4 aBase;      // xyz = foot of the small fire, w = its height (world units)
attribute vec4 aParams;    // x = particle seed, y = strength 0..1, z = column width / height, w = fire seed
uniform float uTime;
uniform float uScale;      // pixels per world unit at distance 1
uniform vec2 uWind;        // lean of the flames: sideways drift per unit of height
varying float vAge;
varying float vStrength;
float h(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  float seed = aParams.x;
  float strength = aParams.y;
  float tall = aBase.w;
  // each particle loops: born at the fuel, rises, swells, cools and fades
  float speed = 0.55 + 0.6 * h(seed * 3.1);
  float age = fract(uTime * speed / max(0.6, sqrt(tall)) * 1.6 + h(seed * 7.7));
  vAge = age;
  vStrength = strength;
  float radius = aParams.z * tall * 0.5;
  float ang = h(seed * 1.3) * 6.2831 + uTime * (0.6 + h(seed) * 0.8);
  float r = radius * sqrt(h(seed * 5.9)) * (1.0 - age * 0.55);
  vec3 p = aBase.xyz;
  float rise = tall * (0.15 + 0.95 * age) * strength;
  p.y += rise;
  p.x += cos(ang) * r + uWind.x * rise;
  p.z += sin(ang) * r + uWind.y * rise;
  // flicker: the whole little fire pulses
  float pulse = 0.85 + 0.25 * sin(uTime * (7.0 + h(aParams.w) * 5.0) + aParams.w * 40.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float sizeWorld = tall * aParams.z * 1.6 * (0.9 - 0.45 * age) * pulse * (0.55 + 0.6 * strength);
  gl_PointSize = clamp(sizeWorld * uScale / -mv.z, 1.0, 220.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT = /* glsl */ `
varying float vAge;
varying float vStrength;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  // a soft ball, hotter in the middle: stacked, they read as a volume, not a sheet
  float core = exp(-d * 3.2);
  // young particles at the fuel are white-yellow, then orange, then a fading deep red at the top
  vec3 hot = vec3(1.0, 0.86, 0.52), mid = vec3(1.0, 0.42, 0.06), cool = vec3(0.55, 0.07, 0.01);
  vec3 col = mix(hot, mid, smoothstep(0.05, 0.4, vAge));
  col = mix(col, cool, smoothstep(0.45, 0.9, vAge));
  float alpha = core * (1.0 - smoothstep(0.55, 1.0, vAge)) * smoothstep(0.0, 0.06, vAge) * (0.45 + 0.55 * vStrength);
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

/**
 * The fire in 3D, as what it really is: many small fires. Every burning cell holds several separate fires (trees torching, shrubs flaring, grass flames, a building),
 * scattered over the cell, each lighting up at its own moment within the cell's burning time and dying on its own, so the front is patchy — some fuel aflame, some
 * already burned out, some not yet caught — instead of one sheet of fire. Each small fire is a column of glowing particles that rises, swells and cools, which looks
 * round from every side. Height follows the fuel and the intensity; crown fires stand on the canopy; the flames lean with the wind.
 *
 * Particles are stateless (their motion is a function of time and seed, computed on the GPU), so the CPU only rebuilds the list of burning small fires when the shown
 * minute moves, through cells sorted by ignition time (a binary search, not a scan of the map).
 */
export class FlameLayer {
  readonly mesh: THREE.Points;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly base = new Float32Array(MAX_PARTICLES * 4);
  private readonly params = new Float32Array(MAX_PARTICLES * 4);
  private readonly material: THREE.ShaderMaterial;
  private run: FlameRun | null = null;
  private styles: Uint8Array | null = null;
  private order: Int32Array = new Int32Array(0);
  private orderIgn: Float32Array = new Float32Array(0);
  private maxDur = 0;
  private lastPick = -1e9;

  constructor(private readonly geo: Georef) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3)); // unused (positions come from aBase), but three needs it
    this.geometry.setAttribute('aBase', new THREE.BufferAttribute(this.base, 4).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aParams', new THREE.BufferAttribute(this.params, 4).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uTime: { value: 0 }, uScale: { value: 500 }, uWind: { value: new THREE.Vector2() } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Points(this.geometry, this.material);
    this.mesh.frustumCulled = false; // the fires are spread over the whole map
    this.mesh.renderOrder = 11; // after the vehicles (10): flames in front of a car show, flames behind it stay behind (depth-tested)
  }

  /** Burn style per grid cell (from the land cover), which decides how each cell's small fires look. */
  setStyles(styles: Uint8Array): void {
    this.styles = styles;
    this.lastPick = -1e9;
  }

  setRun(run: FlameRun | null): void {
    this.run = run;
    this.lastPick = -1e9;
    this.geometry.setDrawRange(0, 0);
    if (!run) return;
    const cells: number[] = [];
    let maxDur = 0;
    for (let i = 0; i < run.ign.length; i++) {
      if (run.ign[i] < 0) continue;
      cells.push(i);
      maxDur = Math.max(maxDur, run.dur[i] || 10);
    }
    cells.sort((a, b) => run.ign[a] - run.ign[b]);
    this.order = Int32Array.from(cells);
    this.orderIgn = Float32Array.from(cells, (c) => run.ign[c]);
    this.maxDur = maxDur;
  }

  /**
   * Per frame: animate, keep particle sizes right for the camera, lean with the wind, and re-pick the burning small fires when the minute has moved.
   * `windFromDeg` is where the wind blows FROM.
   */
  update(tf: number, realTimeS: number, camera: THREE.PerspectiveCamera, viewportHeightPx: number, windKmh = 0, windFromDeg = 0): void {
    const u = this.material.uniforms;
    u.uTime.value = realTimeS;
    u.uScale.value = viewportHeightPx / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const lean = Math.min(0.9, windKmh / 40);
    const to = ((windFromDeg + 180) * Math.PI) / 180;
    (u.uWind.value as THREE.Vector2).set(Math.sin(to) * lean, -Math.cos(to) * lean); // east = +x, north = -z
    if (!this.run || Math.abs(tf - this.lastPick) < REPICK_MIN) return;
    this.lastPick = tf;
    this.pick(tf);
  }

  private pick(tf: number): void {
    const run = this.run!;
    const geo = this.geo;
    let lo = 0;
    let hi = this.orderIgn.length;
    const from = tf - this.maxDur;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.orderIgn[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    let n = 0;
    for (let k = lo; k < this.order.length && this.orderIgn[k] <= tf && n + PARTICLES_PER_SPOT <= MAX_PARTICLES; k++) {
      const cell = this.order[k];
      const dur = run.dur[cell] || 10;
      const age = tf - run.ign[cell];
      if (age < 0 || age >= dur) continue;
      const style = this.styles?.[cell] ?? BurnStyle.Shrub;
      const fuel = FUEL[style];
      if (!fuel) continue; // water: nothing to burn
      const kwm = run.inten[cell];
      const crown = (run.flags[cell] & 1) === 1 && style === BurnStyle.Forest;
      const intensity = Math.min(1, kwm / 3500);
      const col = cell % run.width;
      const row = (cell - col) / run.width;
      // stronger fire: more of the cell's fuel is alight at once
      const spots = Math.max(1, Math.round(fuel.spots * (0.6 + 0.6 * intensity)));
      for (let s = 0; s < spots && n + PARTICLES_PER_SPOT <= MAX_PARTICLES; s++) {
        const seed = cell * 31 + s * 7;
        // each small fire catches at its own moment in the cell's burning time and lasts its own while
        const start = hash(seed + 1) * dur * 0.6;
        const life = dur * (fuel.life[0] + (fuel.life[1] - fuel.life[0]) * hash(seed + 2));
        const t = (age - start) / life;
        if (t < 0 || t > 1) continue;
        const envelope = Math.min(1, t / 0.15) * (1 - Math.pow(Math.max(0, (t - 0.4) / 0.6), 1.5));
        if (envelope < 0.05) continue;
        const u = (col + hash(seed + 3)) / run.width;
        const v = (row + hash(seed + 4)) / run.height;
        const x = geo.x(u);
        const z = geo.z(v);
        const heightM = (fuel.heightM[0] + (fuel.heightM[1] - fuel.heightM[0]) * hash(seed + 5)) * (0.7 + 0.6 * intensity) + (crown ? CROWN_EXTRA_M : 0);
        const tall = (heightM * VISUAL_SCALE * (0.5 + 0.5 * envelope)) / geo.unit;
        const ground = geo.y(geo.elevAtUV(u, v), x, z) + (crown ? 8 / geo.unit : 0);
        // seeds stay in 0..1: the GPU hashes them in 32-bit floats, where large numbers collapse and every particle of a fire would land on the same spot
        const fireSeed = hash(seed + 6);
        for (let p = 0; p < PARTICLES_PER_SPOT; p++) {
          this.base.set([x, ground, z, tall], n * 4);
          this.params.set([(p + hash(seed * 1.7 + p * 13.1)) / PARTICLES_PER_SPOT, envelope * (0.6 + 0.4 * intensity), fuel.width, fireSeed], n * 4);
          n++;
        }
      }
    }
    this.geometry.setDrawRange(0, n);
    (this.geometry.getAttribute('aBase') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aParams') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

function hash(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}
