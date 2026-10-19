import * as THREE from 'three';

import type { WeatherSample } from '@/api';
import type { Georef } from '@/domain/georef';

function hash(n: number): number {
  n = (n ^ 61) ^ (n >>> 16);
  n = (n + (n << 3)) | 0;
  n ^= n >>> 4;
  n = Math.imul(n, 0x27d4eb2d);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}

const LIFE = 28; // minutes of sim time a smoke particle lives
const FLAME_MIN = 8; // only cells on fire for less than this many minutes emit
const PLUME_RISE_TAU = 4;

export interface SmokeRun {
  ign: Int16Array;
  inten: Uint16Array;
  flags: Uint8Array;
  width: number;
  height: number;
  dur: Uint8Array;
  weather: WeatherSample[];
  startMs: number;
  durationMinutes: number;
}

export interface SmokeSummary {
  bearingDeg: number;
  speedKmh: number;
  plumeHeightM: number;
}

/**
 * A GPU-rendered smoke column driven by wind and fire intensity. Every particle is a pure
 * function of time (emitting cell, emission minute, accumulated wind since then), so playback
 * can jump to any instant without replaying history — the CPU just repositions `N` particles
 * per frame (`update`); the actual soft, rotating, noise-textured look is computed per-pixel
 * in the fragment shader below, not drawn into a texture.
 */
export class SmokeSystem {
  readonly points: THREE.Points;
  enabled = true;
  private run: SmokeRun | null = null;
  private cells: Int32Array[] = [];
  private cdf: Float32Array[] = [];
  private cumEast = new Float64Array(0);
  private cumNorth = new Float64Array(0);
  private readonly material: THREE.ShaderMaterial;
  private readonly position: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly color: Float32Array;
  private readonly seed: Float32Array;

  constructor(
    private readonly geo: Georef,
    private readonly count = 7000,
  ) {
    const geometry = new THREE.BufferGeometry();
    this.position = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.color = new Float32Array(count * 3);
    this.seed = Float32Array.from({ length: count }, (_, j) => hash(j * 13 + 7));
    geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { scale: { value: 400 } },
      vertexShader: `attribute float aSize; attribute float aAlpha; attribute vec3 aColor; attribute float aSeed; varying float vA; varying vec3 vC; varying float vSeed; uniform float scale;
        void main(){ vA=aAlpha; vC=aColor; vSeed=aSeed; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=aSize*scale/max(-mv.z,1.0); gl_Position=projectionMatrix*mv; }`,
      // each puff is an irregular noise-rotated blob, not a disc: many overlapping puffs read as a textured smoke column
      fragmentShader: `varying float vA; varying vec3 vC; varying float vSeed;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h(i), h(i + vec2(1.0, 0.0)), f.x), mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), f.x), f.y); }
        void main(){ vec2 p = gl_PointCoord - 0.5; float ang = vSeed * 6.2832; vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * p;
          float d = length(p) * 2.0, noise = n(q * 5.0 + vSeed * 10.0) * 0.6 + n(q * 11.0 + vSeed * 3.0) * 0.4;
          float a = smoothstep(1.0, 0.1, d + (noise - 0.5) * 0.8) * vA; if (a < 0.004) discard;
          gl_FragColor = vec4(vC * (0.8 + 0.4 * noise), a); }`,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 15;
  }

  setRun(run: SmokeRun): void {
    this.run = run;
    const { ign, dur, durationMinutes } = run;
    const emitters: number[][] = Array.from({ length: durationMinutes + 1 }, () => []);
    for (let c = 0; c < ign.length; c++) {
      const ignitionMinute = ign[c];
      if (ignitionMinute < 0) continue;
      const end = Math.min(ignitionMinute + Math.min(dur[c] || 8, FLAME_MIN) - 1, durationMinutes);
      for (let m = ignitionMinute; m <= end; m++) emitters[m].push(c);
    }
    this.cells = emitters.map((l) => Int32Array.from(l));
    this.cdf = emitters.map((list) => {
      const arr = new Float32Array(list.length);
      let sum = 0;
      list.forEach((c, k) => {
        sum += Math.max(run.inten[c], 150);
        arr[k] = sum;
      });
      return arr;
    });

    const total = durationMinutes + LIFE + 2;
    this.cumEast = new Float64Array(total);
    this.cumNorth = new Float64Array(total);
    const samples = run.weather.map((x) => ({
      t: +new Date(x.time),
      vx: -Math.sin(((x.windFromDeg ?? 0) * Math.PI) / 180) * (x.windKmh ?? 0),
      vy: -Math.cos(((x.windFromDeg ?? 0) * Math.PI) / 180) * (x.windKmh ?? 0),
    }));
    const velocityAt = (ms: number) => {
      const i = samples.findIndex((x) => x.t >= ms);
      if (i < 0) return samples[samples.length - 1];
      if (i === 0) return samples[0];
      const a = samples[i - 1];
      const b = samples[i];
      const f = (ms - a.t) / (b.t - a.t);
      return { vx: a.vx + (b.vx - a.vx) * f, vy: a.vy + (b.vy - a.vy) * f };
    };
    for (let m = 1; m < total; m++) {
      const v = velocityAt(run.startMs + (m - 1) * 60000);
      this.cumEast[m] = this.cumEast[m - 1] + (v.vx * 1000) / 60; // km/h -> m/min
      this.cumNorth[m] = this.cumNorth[m - 1] + (v.vy * 1000) / 60;
    }
  }

  private cumAt(arr: Float64Array, t: number): number {
    const i = Math.min(Math.floor(t), arr.length - 2);
    const f = t - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  }

  update(t: number, camera: THREE.PerspectiveCamera, viewportHeight: number): void {
    if (!this.run || !this.enabled) {
      this.points.visible = false;
      return;
    }
    this.points.visible = true;
    const { geo, run } = this;
    const { width, height, durationMinutes } = run;
    this.material.uniforms.scale.value = viewportHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const activeFront = (this.cells[Math.min(Math.floor(t), this.cells.length - 1)] ?? []).length;
    const densityScale = Math.min(0.35 + activeFront / 120, 1);

    for (let j = 0; j < this.count; j++) {
      const phase = hash(j * 7 + 1) * LIFE;
      const cycle = Math.floor((t - phase) / LIFE);
      const emissionMinute = phase + cycle * LIFE;
      const age = t - emissionMinute;
      const m = Math.floor(emissionMinute);
      const o = j * 3;
      this.alpha[j] = 0;
      if (emissionMinute < 0 || m > durationMinutes || m < 0) continue;
      const cells = this.cells[m];
      const cdf = this.cdf[m];
      if (!cells || cells.length === 0) continue;
      const u = hash(j * 131 + cycle * 977 + 5) * cdf[cdf.length - 1];
      let lo = 0;
      let hi = cdf.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] < u) lo = mid + 1;
        else hi = mid;
      }
      const cell = cells[lo];
      const intensity = Math.max(run.inten[cell], 150);
      const crown = run.flags[cell] & 1 ? 1.5 : 1;
      const cx = cell % width;
      const cy = (cell / width) | 0;
      const plumeHeightM = (80 + 160 * Math.sqrt(intensity / 1000)) * crown * (0.7 + 0.6 * hash(j * 17 + cycle * 3 + 2));
      const rise = 1 - Math.exp(-age / PLUME_RISE_TAU);
      const zMeters = plumeHeightM * rise;
      const aloft = 1 + 0.3 * rise;
      const dEast = (this.cumAt(this.cumEast, t) - this.cumAt(this.cumEast, emissionMinute)) * aloft;
      const dNorth = (this.cumAt(this.cumNorth, t) - this.cumAt(this.cumNorth, emissionMinute)) * aloft;
      const sigma = 25 + 14 * Math.sqrt(Math.max(age, 0));
      const g1 = Math.sqrt(-2 * Math.log(1 - hash(j * 29 + cycle * 11 + 3) * 0.999)) * Math.cos(6.2831 * hash(j * 31 + cycle * 13 + 4));
      const g2 = Math.sqrt(-2 * Math.log(1 - hash(j * 37 + cycle * 17 + 6) * 0.999)) * Math.cos(6.2831 * hash(j * 41 + cycle * 19 + 8));
      const u0 = (cx + 0.5) / width;
      const v0 = (cy + 0.5) / height;
      const x = geo.x(u0) + (dEast + g1 * sigma) / geo.unit;
      const zw = geo.z(v0) - (dNorth + g2 * sigma) / geo.unit;
      const ground = geo.y(geo.elevAtUV(Math.min(Math.max(x / geo.W + 0.5, 0), 1), Math.min(Math.max(zw / geo.H + 0.5, 0), 1)));
      this.position[o] = x;
      this.position[o + 1] = ground + zMeters / geo.unit + 1;
      this.position[o + 2] = zw;
      const k = Math.min(age / LIFE, 1);
      this.size[j] = (34 + 5.5 * age) / geo.unit; // ~34 m at birth, ~190 m at end of life
      const fadeIn = Math.min(age / 1.5, 1);
      this.alpha[j] = 0.5 * Math.pow(1 - k, 0.7) * fadeIn * Math.min(0.5 + intensity / 3000, 1) * densityScale;
      const shade = 0.52 + 0.33 * Math.min(k * 1.4, 1);
      const warm = (1 - Math.min(k * 3, 1)) * 0.08;
      this.color[o] = shade + warm;
      this.color[o + 1] = shade;
      this.color[o + 2] = shade - warm * 0.5;
    }
    const geometry = this.points.geometry;
    (geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
  }

  /** For the HUD: where the smoke is heading and typical plume height at instant `t`. */
  describe(t: number): SmokeSummary | null {
    if (!this.run) return null;
    const m = Math.min(Math.floor(t), this.cells.length - 1);
    const cells = this.cells[m] ?? [];
    let maxIntensity = 0;
    for (const c of cells) maxIntensity = Math.max(maxIntensity, this.run.inten[c]);
    const dEast = this.cumAt(this.cumEast, Math.min(t + 5, this.cumEast.length - 2)) - this.cumAt(this.cumEast, t);
    const dNorth = this.cumAt(this.cumNorth, Math.min(t + 5, this.cumNorth.length - 2)) - this.cumAt(this.cumNorth, t);
    const bearingDeg = ((Math.atan2(dEast, dNorth) * 180) / Math.PI + 360) % 360;
    return {
      bearingDeg,
      speedKmh: ((Math.hypot(dEast, dNorth) / 5) * 60) / 1000,
      plumeHeightM: Math.round(80 + 160 * Math.sqrt(Math.max(maxIntensity, 150) / 1000)),
    };
  }
}
