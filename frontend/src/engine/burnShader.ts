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
  Forest = 1, // canopy and trunks: black charcoal
  Shrub = 2, // heath, broom, gorse: black charcoal with a hint of warm earth
  Grass = 3, // pasture, crops, vineyards: black, the thinnest fuel leaves the darkest, flattest char
  Urban = 4, // roofs, walls, gardens: near-black soot over what is there, the shapes stay readable
  Bare = 5, // rock and bare soil: scorched to a flat dark tone
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

/**
 * The same, as a texture the burn shader reads. Nearest filtering is deliberate: the ids are categorical, so the shader takes
 * four explicit taps around each fragment and averages their look (see burnSurface). Interpolating the ids would invent
 * classes that are not there — between forest (1) and grass (3) it would pass through shrub (2).
 */
export function burnStyleTexture(styles: Uint8Array, width: number, height: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(styles, width, height, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  // one byte per cell: do not let WebGL pad each row to 4 bytes, or the styles shear across the terrain
  tex.unpackAlignment = 1;
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

// What one land-cover style looks like after the fire. Flat, near-black colours with only a hint of variation per class:
// the black scar itself reads as burned ground, and no texture or pale ash is left for the photo to show through as grey
// soot. The amount is 1 in the interior, so the blend reaches pure char; only the flame front (age/dur) still fades in.
void burnStyleLook(float style, vec3 base, out vec3 charred, out float amount) {
  if (style < 0.5) {          // water: nothing to burn
    charred = base; amount = 0.0;
  } else if (style < 1.5) {   // forest: black charcoal
    charred = vec3(0.013, 0.012, 0.011); amount = 1.0;
  } else if (style < 2.5) {   // shrub: black with a hint of warm earth
    charred = vec3(0.024, 0.021, 0.018); amount = 1.0;
  } else if (style < 3.5) {   // grass, crops: flat black char
    charred = vec3(0.034, 0.031, 0.028); amount = 1.0;
  } else if (style < 4.5) {   // urban: flat near-black soot over the roofs
    charred = vec3(0.044, 0.042, 0.040); amount = 1.0;
  } else {                    // bare ground: scorched to a flat dark tone, no photo left
    charred = vec3(0.050, 0.047, 0.043); amount = 1.0;
  }
}
// The ids are categorical, so a tap resolves one style with nearest sampling, and burnSurface averages the look of four taps
// around the fragment: a soft one-cell edge without inventing a class (interpolating 1 and 3 would pass through 2).
float burnStyleAt(vec2 uv) { return floor(texture2D(burnStyle, uv).r * 255.0 + 0.5); }
vec4 burnTap(float style, vec3 base) {
  vec3 charred; float amount;
  burnStyleLook(style, base, charred, amount);
  return vec4(charred, amount);
}
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
  // the edge of the burned area breaks up with noise instead of following the bilinear blend
  vec2 p = uv * fireDim;
  float wn = w + (bfbm(p * 1.7) - 0.5) * 0.35;
  float edge = smoothstep(0.35, 0.75, wn);
  // Land cover is a 60 m categorical grid. Warp the lookup with noise and average the look of four taps around the fragment,
  // so a burned field, hamlet or block of houses fades into the char around it instead of ending in a hard, grid-aligned
  // edge. Each tap keeps its own style: the average is of the four looks, never of the ids.
  vec2 suv = clamp(uv + (vec2(bfbm(p * 0.9), bfbm(p * 0.9 + 31.7)) - 0.5) * (1.8 / fireDim), vec2(0.0), vec2(1.0));
  vec2 o = 0.6 / fireDim;
  vec4 look = burnTap(burnStyleAt(suv + vec2(-o.x, -o.y)), base)
            + burnTap(burnStyleAt(suv + vec2(o.x, -o.y)), base)
            + burnTap(burnStyleAt(suv + vec2(-o.x, o.y)), base)
            + burnTap(burnStyleAt(suv + vec2(o.x, o.y)), base);
  float amount = look.a * 0.25;
  if (amount < 0.01) return base;
  vec3 charred = look.rgb * 0.25;
  // Burnt ground is black, not flat: broad charcoal mottling, a fine grain and a few paler clinker patches. Procedural and kept in
  // the dark range, so the scar reads black from 8 km and still has detail when the camera comes down.
  float n1 = bfbm(p * 5.5);
  float n2 = bfbm(p * 13.0 + 21.7);
  float grain = bnoise(p * 29.0 + 7.3);
  charred *= 0.60 + 0.78 * n1;
  charred *= 0.88 + 0.24 * grain;
  charred += vec3(0.022, 0.012, 0.006) * smoothstep(0.55, 0.9, n2);
  charred += vec3(0.045, 0.037, 0.030) * smoothstep(0.60, 0.92, n1) * smoothstep(0.45, 0.8, n2);
  // while it burns the surface goes from untouched to charred; the flames themselves are 3D (FlameLayer)
  float k = smoothstep(0.0, 0.85, age / dur) * amount * edge;
  vec3 result = mix(base, charred, k);
  // A narrow scorched band just behind the front: darkened ground that still keeps a little of what was there, warm brown instead of
  // the grey ash wash. It is what makes a fresh scar read as a fire edge rather than a flat black card dropped on the photo.
  float fresh = smoothstep(0.0, 0.10, age / dur) * (1.0 - smoothstep(0.16, 0.75, age / dur));
  result = mix(result, mix(base * 0.22, vec3(0.095, 0.045, 0.017), 0.62), fresh * edge * 0.5 * amount);
  // Ash flecks, in two scales: sparse clumps that the wind has piled into drifts (elongated), and fine grains over the charcoal.
  // Both are pale grey-tan, never white: they give the black scar texture without turning it back into the grey soot the photo showed.
  float settle = smoothstep(0.0, 0.5, (age - dur) / 30.0);
  vec2 drift = p * 1.35 + vec2(-31.0, 5.0);
  vec2 dc = floor(drift);
  vec2 df = fract(drift) - 0.5 - (vec2(bhash(dc + 2.3), bhash(dc + 8.1)) - 0.5) * 0.85;
  df.x *= 0.55; // ash is carried downwind: the clumps are longer than they are wide
  float driftMask = smoothstep(0.35, 0.7, bfbm(p * 0.9 + 12.4));
  float clump = (1.0 - smoothstep(0.22, 0.52, length(df))) * step(0.86, bhash(dc + 4.4)) * driftMask;
  vec2 aq = p * 3.1 + vec2(17.0, 9.0);
  vec2 ac = floor(aq);
  vec2 af = fract(aq) - 0.5 - (vec2(bhash(ac + 3.1), bhash(ac + 9.7)) - 0.5) * 0.9;
  float ashPatch = smoothstep(0.28, 0.62, bfbm(p * 1.1 + 4.7)); // ash settles in patches, not an even sprinkle
  float fleck = (1.0 - smoothstep(0.06, 0.24, length(af))) * step(0.78, bhash(ac + 1.7)) * ashPatch;
  vec3 ash = mix(vec3(0.46, 0.445, 0.42), vec3(0.29, 0.275, 0.25), bhash(ac + 5.5));
  vec3 driftAsh = mix(vec3(0.38, 0.365, 0.34), vec3(0.25, 0.24, 0.22), bhash(dc + 6.6));
  result = mix(result, ash, fleck * settle * edge * 0.5 * amount);
  result = mix(result, driftAsh, clump * settle * edge * 0.34 * amount);
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
    burnGlow = vec3(0.9, 0.22, 0.04) * ember * ember * spots * (0.5 + 0.8 * sev) * edge * (burnStyleAt(suv) < 3.5 ? 1.0 : 0.3);
  }
  return result;
}
`;
