import * as THREE from 'three';

import type { VegetationClass } from '@/api';

/**
 * What the fire does to a SURFACE, on the GPU: the ground glows under the flames while a cell burns, then it is left charred, with a look that depends on what burned
 * there. The same GLSL is injected into the terrain material and into every photoreal city tile, so trees, roofs and fields in the 3D city char exactly where the
 * simulation burned them. The flames themselves are real 3D geometry (`FlameLayer`), not painted here.
 *
 * Inputs (shared uniforms, one upload per simulation, then one float per frame):
 *  - `fireData`  RGBA float per grid cell: minute of ignition (-1 = never), intensity kW/m, residence time (min), burned flag
 *  - `burnStyle` R8 per grid cell: how that ground chars (see `BurnStyle`), from the land-cover map
 *  - `fireTime`  minute shown (negative = no fire)
 * Grid uv: u west→east, v north→south (row 0 = north), the same convention as the terrain and the fire data.
 */

/** How a land-cover class looks once burned. */
export enum BurnStyle {
  None = 0, // water: nothing to burn
  Forest = 1, // canopy and trunks: black charcoal, grey ash in patches
  Shrub = 2, // heath, broom, gorse: dark grey-brown, black stems
  Grass = 3, // pasture, crops, vineyards: light grey-white ash with black streaks
  Urban = 4, // roofs, walls, gardens: soot over what is there, the shapes stay readable
  Bare = 5, // rock and bare soil: only scorched
}

/** Land-cover class key (from `/vegetation`) → burn look. Unknown classes char like shrubland. */
const STYLE_BY_CLASS: Record<string, BurnStyle> = {
  floresta: BurnStyle.Forest, eucalipto: BurnStyle.Forest, pinheiro: BurnStyle.Forest, folhosas: BurnStyle.Forest,
  mato: BurnStyle.Shrub,
  agricola: BurnStyle.Grass, pasto: BurnStyle.Grass,
  urbano: BurnStyle.Urban,
  rocha: BurnStyle.Bare,
  agua: BurnStyle.None,
};

/** Minutes the embers keep glowing after the flames pass. */
export const EMBER_MINUTES = 25;
/** Intensity (kW/m) above which the ground is fully consumed (deepest char). */
export const SEVERE_KWM = 3000;

/** Burn style per grid cell, from the land-cover grid (once per location). */
export function burnStyles(landcover: Uint8Array, classes: VegetationClass[]): Uint8Array {
  const byId: BurnStyle[] = [];
  for (const c of classes) byId[c.id] = STYLE_BY_CLASS[c.key as string] ?? BurnStyle.Shrub;
  return Uint8Array.from(landcover, (id) => byId[id] ?? BurnStyle.Shrub);
}

/** The same, as a texture the burn shader reads. */
export function burnStyleTexture(styles: Uint8Array, width: number, height: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(styles, width, height, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/** The uniforms every burned surface reads. One object, shared by reference: updating it updates the terrain and all city tiles at once. */
export interface BurnUniforms {
  fireData: { value: THREE.DataTexture };
  fireDim: { value: THREE.Vector2 };
  fireTime: { value: number };
  burnStyle: { value: THREE.Texture };
  /** World size (scene units) of the fire grid, to turn a world position into grid uv. */
  burnSize: { value: THREE.Vector2 };
}

export function createBurnUniforms(worldWidth: number, worldHeight: number): BurnUniforms {
  const empty = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  empty.needsUpdate = true;
  const noStyle = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  noStyle.needsUpdate = true;
  return {
    fireData: { value: empty },
    fireDim: { value: new THREE.Vector2(1, 1) },
    fireTime: { value: -1 },
    burnStyle: { value: noStyle },
    burnSize: { value: new THREE.Vector2(worldWidth, worldHeight) },
  };
}

/**
 * `vec3 burnSurface(vec3 base, vec2 uv)` returns the surface colour after the fire (linear colour in, linear colour out) and sets `burnGlow` (linear, to ADD as emitted
 * light: the glowing ground under flames and the embers after). The burned edge is bilinear between cells that burned, so it follows the fire's shape, not the grid.
 */
export const BURN_GLSL = /* glsl */ `
uniform sampler2D fireData; uniform vec2 fireDim; uniform float fireTime; uniform sampler2D burnStyle; uniform vec2 burnSize;
vec3 burnGlow;
vec4 bcell(vec2 c) { return texture2D(fireData, (clamp(c, vec2(0.0), fireDim - 1.0) + 0.5) / fireDim); }
float bhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float bnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(bhash(i), bhash(i + vec2(1.0, 0.0)), f.x), mix(bhash(i + vec2(0.0, 1.0)), bhash(i + vec2(1.0, 1.0)), f.x), f.y); }
float bfbm(vec2 p) { return bnoise(p) * 0.55 + bnoise(p * 2.07 + 13.1) * 0.28 + bnoise(p * 4.13 + 37.7) * 0.17; }
vec3 burnSurface(vec3 base, vec2 uv) {
  burnGlow = vec3(0.0);
  if (fireTime < 0.0 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return base;
  vec2 g = uv * fireDim - 0.5, f0 = floor(g), fr = g - f0;
  vec4 a = bcell(f0), b = bcell(f0 + vec2(1.0, 0.0)), c = bcell(f0 + vec2(0.0, 1.0)), d = bcell(f0 + vec2(1.0, 1.0));
  float wa = (1.0 - fr.x) * (1.0 - fr.y) * a.a, wb = fr.x * (1.0 - fr.y) * b.a, wc = (1.0 - fr.x) * fr.y * c.a, wd = fr.x * fr.y * d.a, w = wa + wb + wc + wd;
  if (w < 0.35) return base;
  float ti = (wa * a.r + wb * b.r + wc * c.r + wd * d.r) / w;
  float age = fireTime - ti;
  if (age < 0.0) return base;
  float dur = max((wa * a.b + wb * b.b + wc * c.b + wd * d.b) / w, 1.0);
  float sev = clamp(((wa * a.g + wb * b.g + wc * c.g + wd * d.g) / w) / ${SEVERE_KWM}.0, 0.15, 1.0);
  float style = floor(texture2D(burnStyle, uv).r * 255.0 + 0.5);
  if (style < 0.5) return base;
  // the edge of the burned area breaks up with noise instead of following the bilinear blend
  vec2 p = uv * fireDim;
  float wn = w + (bfbm(p * 1.7) - 0.5) * 0.35;
  float edge = smoothstep(0.35, 0.75, wn);
  float lum = dot(base, vec3(0.299, 0.587, 0.114));
  float n = bfbm(p * 6.0), fine = bnoise(p * 38.0), streak = bnoise(vec2(p.x * 22.0, p.y * 3.0 + p.x * 0.7));
  vec3 charred; float amount;
  if (style < 1.5) {        // forest: charcoal, a little grey ash where the litter burned out
    charred = mix(vec3(0.012, 0.010, 0.009), vec3(0.16, 0.15, 0.14), smoothstep(0.62, 0.9, n) * 0.7) * (0.7 + 0.6 * lum);
    amount = mix(0.82, 0.97, sev);
  } else if (style < 2.5) { // shrub: dark grey-brown with black stems
    charred = mix(vec3(0.045, 0.036, 0.028), vec3(0.11, 0.095, 0.08), n) * (0.75 + 0.5 * lum);
    charred *= mix(1.0, 0.35, smoothstep(0.7, 0.95, fine));
    amount = mix(0.75, 0.93, sev);
  } else if (style < 3.5) { // grass, crops: pale ash, black streaks where it burned hottest
    charred = mix(vec3(0.30, 0.29, 0.27), vec3(0.52, 0.50, 0.47), n);
    charred = mix(charred, vec3(0.03, 0.028, 0.025), smoothstep(0.55, 0.85, streak) * (0.5 + 0.5 * sev));
    amount = mix(0.65, 0.88, sev);
  } else if (style < 4.5) { // urban: greyed soot over roofs and walls, dark enough to read on a photo, the shapes stay readable
    charred = mix(vec3(lum), base, 0.35) * mix(0.2, 0.42, n);
    amount = mix(0.6, 0.85, sev);
  } else {                  // bare ground: only scorched
    charred = base * 0.55;
    amount = 0.45;
  }
  // while it burns the surface goes from untouched to charred; the flames themselves are 3D (FlameLayer)
  float k = smoothstep(0.0, 0.85, age / dur) * amount * edge;
  vec3 result = mix(base, charred, k);
  // a thin warm-grey ash line along the burned perimeter, so the edge reads on busy photo textures too
  float rim = smoothstep(0.4, 0.52, wn) * (1.0 - smoothstep(0.52, 0.66, wn));
  result = mix(result, vec3(0.46, 0.41, 0.36) * (0.85 + 0.3 * lum), rim * 0.6 * smoothstep(0.0, 0.85, age / dur));
  if (age < dur) {
    float life = age / dur;
    float flicker = 0.7 + 0.3 * bnoise(p * 3.0 + vec2(fireTime * 9.0, -fireTime * 7.0));
    // a narrow band just behind the front: the ground under the flames, not the whole area still smouldering
    float hot = smoothstep(0.0, 0.03, life) * (1.0 - smoothstep(0.06, 0.22, life));
    hot *= 0.25 + 0.75 * smoothstep(0.35, 0.75, bnoise(p * 9.0 + 3.7)); // patches under the separate small fires, not an even sheet
    burnGlow = vec3(1.0, 0.22, 0.03) * hot * flicker * (0.5 + 0.7 * sev) * edge;
  } else {
    float ember = max(0.0, 1.0 - (age - dur) / ${EMBER_MINUTES}.0);
    // round embers scattered over the burned ground (one possible ember per small jittered cell), each pulsing on its own
    vec2 q = p * 12.0, ci = floor(q);
    vec2 fq = fract(q) - 0.5 - (vec2(bhash(ci), bhash(ci + 7.1)) - 0.5) * 0.6;
    float spots = (1.0 - smoothstep(0.05, 0.13, length(fq))) * step(0.6, bhash(ci + 3.3)) * (0.55 + 0.45 * sin(fireTime * 4.0 + bhash(ci + 9.9) * 6.283));
    burnGlow = vec3(0.9, 0.22, 0.04) * ember * ember * spots * (0.5 + 0.8 * sev) * edge * (style < 3.5 ? 1.0 : 0.3);
  }
  return result;
}
`;
