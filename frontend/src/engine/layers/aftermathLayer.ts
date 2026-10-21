import * as THREE from 'three';

import type { Georef } from '@/domain/georef';

import { BurnStyle } from '../burnShader';

/** One simulation's fire, per grid cell (same layout as the terrain's fire data). */
export interface AftermathRun {
  ign: Int16Array; // minute of ignition, -1 = never burns
  dur: Uint8Array; // minutes the cell keeps burning
  width: number;
  height: number;
}

/** Burned cells sampled per simulation (spread over the land-cover types), and particles per sampled cell. */
const MAX_CELLS = 5000;
const PER_CELL = 3;
/** Drawn larger than life so the effects still read from a few hundred metres up (as the flames are). */
const VISUAL_SCALE = 2;
/** Only these leave something behind: water and bare rock do not smoulder. */
const STYLES = [BurnStyle.Forest, BurnStyle.Shrub, BurnStyle.Grass, BurnStyle.Urban];

/**
 * Per particle: `aInfo` x = minute the flames left the cell, y = burn style, z = seed, w = phase in its loop. Each particle loops on the wall clock (so the wisps keep
 * moving while playback is paused); the fire clock only decides how strong the effect still is, so scrubbing the timeline fades it in and out with no CPU work.
 * Windows (minutes after the flames): forest 60, shrub 30, grass 20, urban 90.
 */
const VERTEX = /* glsl */ `
attribute vec4 aInfo;
uniform float uFireTime;
uniform float uClock;
uniform float uScale;   // pixels per world unit at distance 1
uniform float uUnit;    // world units per metre
uniform vec2 uWind;     // downwind direction (x east, y = +z south), scaled by wind strength
varying vec4 vColor;
varying float vEmber;
float h(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  float style = aInfo.y, seed = aInfo.z;
  float age = uFireTime - aInfo.x;
  float win = style < 1.5 ? 60.0 : style < 2.5 ? 30.0 : style < 3.5 ? 20.0 : 90.0;
  vColor = vec4(0.0);
  vEmber = 0.0;
  if (uFireTime < 0.0 || age < 0.0 || age > win) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  // full strength just after the flames, then dying away over the window
  float fade = smoothstep(0.0, 1.5, age) * (1.0 - smoothstep(0.15 * win, win, age));
  vec3 p = position;
  vec2 sway = vec2(sin(uClock * 0.7 + seed * 40.0), cos(uClock * 0.53 + seed * 23.0));
  float sizeM, a;
  vec3 col;
  if (style < 1.5) {
    // forest: thin grey wisps rising from the charred stumps
    float ph = fract(uClock / (7.0 + 4.0 * h(seed * 3.1)) + aInfo.w);
    float rise = ph * (35.0 + 30.0 * h(seed * 5.3));
    p.y += rise * uUnit;
    p.xz += (uWind * rise * 0.6 + sway * ph * 4.0) * uUnit;
    sizeM = 4.0 + 14.0 * ph;
    col = vec3(0.62, 0.61, 0.6);
    a = 0.5 * smoothstep(0.0, 0.15, ph) * (1.0 - ph);
  } else if (style < 2.5) {
    // shrub: embers flickering at the ground first, then a light smoke
    float embers = 1.0 - smoothstep(8.0, 14.0, age);
    if (h(seed * 7.7 + aInfo.w * 3.3) < embers) {
      float ph = fract(uClock / (2.0 + 2.0 * h(seed * 2.3)) + aInfo.w);
      float flicker = 0.55 + 0.45 * sin(uClock * (6.0 + 5.0 * h(seed * 9.1)) + seed * 60.0);
      p.y += (0.4 + 1.5 * h(seed * 4.1) + ph * 2.5) * uUnit;
      p.xz += sway * 1.5 * uUnit;
      sizeM = 1.6;
      col = mix(vec3(1.0, 0.32, 0.04), vec3(1.0, 0.62, 0.18), flicker);
      a = 0.95 * flicker * (1.0 - ph * 0.6);
      vEmber = 1.0;
    } else {
      float ph = fract(uClock / (6.0 + 3.0 * h(seed * 3.7)) + aInfo.w);
      float rise = ph * (20.0 + 15.0 * h(seed * 5.9));
      p.y += rise * uUnit;
      p.xz += (uWind * rise * 0.7 + sway * ph * 3.0) * uUnit;
      sizeM = 3.0 + 9.0 * ph;
      col = vec3(0.72, 0.71, 0.69);
      a = 0.38 * smoothstep(0.0, 0.15, ph) * (1.0 - ph);
    }
  } else if (style < 3.5) {
    // grass, crops: pale ash flecks lifted and carried downwind
    float ph = fract(uClock / (8.0 + 4.0 * h(seed * 6.1)) + aInfo.w);
    vec2 dir = length(uWind) > 0.05 ? uWind : vec2(0.25);
    p.xz += (dir * ph * 45.0 + sway * 2.0) * uUnit;
    p.y += (1.0 + 7.0 * sin(ph * 3.1416) * (0.5 + h(seed * 8.3)) + sin(uClock * 2.0 + seed * 30.0) * 0.6) * uUnit;
    sizeM = 1.3;
    col = vec3(0.86, 0.85, 0.81);
    a = 0.9 * smoothstep(0.0, 0.1, ph) * (1.0 - ph * 0.7);
  } else {
    // urban: darker, denser smoke columns from the burned-out buildings
    float ph = fract(uClock / (9.0 + 4.0 * h(seed * 4.9)) + aInfo.w);
    float rise = ph * (80.0 + 60.0 * h(seed * 6.7));
    p.y += rise * uUnit;
    p.xz += (uWind * rise * 0.8 + sway * ph * 6.0) * uUnit;
    sizeM = 7.0 + 28.0 * ph;
    col = mix(vec3(0.17, 0.16, 0.155), vec3(0.32, 0.31, 0.3), ph);
    a = 0.65 * smoothstep(0.0, 0.12, ph) * (1.0 - ph);
  }
  vColor = vec4(col, a * fade);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(sizeM * ${VISUAL_SCALE.toFixed(1)} * uUnit * uScale / -mv.z, vEmber > 0.5 ? 2.0 : 1.0, 160.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT = /* glsl */ `
varying vec4 vColor;
varying float vEmber;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  // soft round puffs; embers are a tighter, hotter dot
  float soft = mix((1.0 - d) * (0.55 + 0.45 * exp(-d * 3.0)), exp(-d * 4.0), vEmber);
  float a = vColor.a * soft;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * (1.0 + vEmber * 0.5), a);
}
`;

/**
 * What the ground does after the flames have passed, by what burned there: forests smoke in thin wisps for about an hour, shrubland leaves embers and then a light smoke,
 * grass and crops shed pale ash flecks that drift downwind, buildings keep sending up dark columns for an hour and a half. Water and bare ground leave nothing.
 *
 * One `THREE.Points` cloud, built once per simulation from a sample of the burned cells (stratified per land-cover type, so a small burned village still smokes next to a
 * large burned forest). Everything else happens in the shader from the fire clock and the wind: the CPU sets a few uniforms per frame.
 */
export class AftermathLayer {
  readonly points: THREE.Points;
  /** The simulation the cloud was built for (`null` = none yet). */
  runId: string | null = null;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private styles: Uint8Array | null = null;

  constructor(private readonly geo: Georef) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    this.geometry.setAttribute('aInfo', new THREE.BufferAttribute(new Float32Array(0), 4));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uFireTime: { value: -1 },
        uClock: { value: 0 },
        uScale: { value: 500 },
        uUnit: { value: 1 / geo.unit },
        uWind: { value: new THREE.Vector2() },
      },
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false; // spread over the whole map
    this.points.renderOrder = 14; // under the main smoke plume
  }

  /** Burn style per grid cell (from the land cover): which effect each burned cell gets. */
  setStyles(styles: Uint8Array): void {
    this.styles = styles;
    this.runId = null;
  }

  /** Builds the particle cloud for one simulation. */
  setRun(id: string, run: AftermathRun): void {
    this.runId = id;
    const styles = this.styles;
    const byStyle = new Map<number, number[]>(STYLES.map((s) => [s, []]));
    if (styles) {
      for (let c = 0; c < run.ign.length; c++) {
        if (run.ign[c] >= 0) byStyle.get(styles[c])?.push(c);
      }
    }
    // stratified: each type gets a share by the square root of its burned area, the smallest first so what they leave goes to the others
    const groups = [...byStyle.entries()].filter(([, cells]) => cells.length).sort((a, b) => a[1].length - b[1].length);
    let remaining = MAX_CELLS;
    let weight = groups.reduce((sum, [, cells]) => sum + Math.sqrt(cells.length), 0);
    const picked: number[] = [];
    let rng = 1;
    for (const [, cells] of groups) {
      const quota = Math.min(cells.length, Math.floor((remaining * Math.sqrt(cells.length)) / weight));
      weight -= Math.sqrt(cells.length);
      remaining -= quota;
      // partial Fisher-Yates: a uniform sample, the same every time for the same simulation
      for (let k = 0; k < quota; k++) {
        const j = k + Math.floor(hash(rng++) * (cells.length - k));
        [cells[k], cells[j]] = [cells[j], cells[k]];
        picked.push(cells[k]);
      }
    }

    const geo = this.geo;
    const n = picked.length * PER_CELL;
    const position = new Float32Array(n * 3);
    const info = new Float32Array(n * 4);
    let i = 0;
    for (const cell of picked) {
      const col = cell % run.width;
      const row = (cell - col) / run.width;
      const out = run.ign[cell] + (run.dur[cell] || 10);
      const style = styles![cell];
      const seed = hash(cell * 0.37 + 11);
      for (let k = 0; k < PER_CELL; k++) {
        const u = (col + hash(cell * 1.3 + k * 7.1 + 1)) / run.width;
        const v = (row + hash(cell * 2.9 + k * 3.7 + 2)) / run.height;
        const x = geo.x(u);
        const z = geo.z(v);
        position.set([x, geo.y(geo.elevAtUV(u, v), x, z), z], i * 3);
        info.set([out, style, hash(seed * 97.3 + k), (k + hash(seed * 13.1 + k)) / PER_CELL], i * 4);
        i++;
      }
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    this.geometry.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
    this.geometry.setDrawRange(0, n);
  }

  /** Per frame: the fire clock, the wall clock, particle size for the camera, and the wind (`windFromDeg` is where it blows FROM). */
  update(fireTime: number, realTimeS: number, camera: THREE.PerspectiveCamera, viewportHeightPx: number, windKmh = 0, windFromDeg = 0): void {
    const u = this.material.uniforms;
    u.uFireTime.value = fireTime;
    u.uClock.value = realTimeS;
    u.uScale.value = viewportHeightPx / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const strength = Math.min(1.5, windKmh / 25);
    const to = ((windFromDeg + 180) * Math.PI) / 180;
    (u.uWind.value as THREE.Vector2).set(Math.sin(to) * strength, -Math.cos(to) * strength); // east = +x, north = -z
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
