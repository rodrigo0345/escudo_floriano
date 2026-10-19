/**
 * The fire GLSL injected into the terrain material (see `TerrainMesh.makeMaterial`). Runs
 * entirely on the GPU, once per fragment, every frame — this is the "use the GPU whenever
 * possible" part of the renderer: the CPU only ever uploads a small ignition-time/intensity
 * texture once per simulation (`setFireData`) and a single `fireTime` uniform per frame
 * (`setFireTime`); all of the per-pixel flame shape, flicker and color grading below runs on
 * the GPU without the CPU touching a single pixel.
 *
 * Bilinear-interpolates between the 4 nearest fire-data texels so the burned/unburned edge
 * isn't blocky, but only blends between cells that actually burn (`a` channel), so the edge
 * doesn't bleed color into untouched terrain. Ported as-is from the original project, where
 * the flame look (small flickering tongues, not a smooth lava-like fill) was tuned against a
 * live simulation — see the session notes in the FireTrace memory file for the exact
 * before/after reasoning on the turbulence thresholds below.
 */
export const EMBER_MIN = 25; // minutes embers take to cool after the front passes
export const SEVERITY_KWM = 3000; // intensity above which the ground reads as scorched/char

export const FIRE_GLSL = `
uniform sampler2D fireData; uniform vec2 fireDim; uniform float fireTime;
varying vec2 vGUv;
float vGlow; // 0..~1, how much this fire cell should glow (fresh flame > ember > cold char); read right after, in the emissive boost
vec4 fcell(vec2 c) { return texture2D(fireData, (clamp(c, vec2(0.0), fireDim - 1.0) + 0.5) / fireDim); }
float fhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fhash(i), fhash(i + vec2(1.0, 0.0)), f.x), mix(fhash(i + vec2(0.0, 1.0)), fhash(i + vec2(1.0, 1.0)), f.x), f.y); }
// turbulence (3 octaves, stretched upward and drifting slowly sideways): the silhouette of many small flame tongues, not a smooth blob
float flameTurbulence(vec2 p, float t) {
  vec2 rise = vec2(t * 0.4, -t * 2.6);
  float n1 = fnoise(p * vec2(1.0, 0.45) + rise);
  float n2 = fnoise(p * vec2(2.3, 1.1) + rise * 1.7 + 11.0);
  float n3 = fnoise(p * vec2(5.0, 2.4) - rise * 2.3 + 37.0);
  return n1 * 0.55 + n2 * 0.3 + n3 * 0.15;
}
vec4 fireColor(vec2 uv) {
  vGlow = 0.0;
  if (fireTime < 0.0) return vec4(0.0);
  vec2 g = uv * fireDim - 0.5, f0 = floor(g), fr = g - f0;
  vec4 a = fcell(f0), b = fcell(f0 + vec2(1.0, 0.0)), c = fcell(f0 + vec2(0.0, 1.0)), d = fcell(f0 + vec2(1.0, 1.0));
  float wa = (1.0 - fr.x) * (1.0 - fr.y) * a.a, wb = fr.x * (1.0 - fr.y) * b.a, wc = (1.0 - fr.x) * fr.y * c.a, wd = fr.x * fr.y * d.a, w = wa + wb + wc + wd;
  if (w < 0.5) return vec4(0.0);
  float ti = (wa * a.r + wb * b.r + wc * c.r + wd * d.r) / w, age = fireTime - ti;
  if (age < 0.0) return vec4(0.0);
  float dur = (wa * a.b + wb * b.b + wc * c.b + wd * d.b) / w, inten = (wa * a.g + wb * b.g + wc * c.g + wd * d.g) / w;
  float edge = smoothstep(0.5, 0.65, w), flame = min(2.0 + dur * 0.3, dur), sev = min(inten / ${SEVERITY_KWM}.0, 1.0);
  vec3 col; float al; vGlow = 0.0;
  if (age < dur) {
    float hot = sev;
    float flicker = fnoise(g * 3.1 + vec2(fireTime * 2.3, fireTime * 1.7)) * 0.7 + fnoise(g * 9.0 + vec2(-fireTime * 4.1, fireTime * 3.3)) * 0.3;
    if (age < flame) {
      float turb = flameTurbulence(uv * fireDim * 6.0, fireTime);
      float tongue = smoothstep(0.46, 0.80, turb), tip = smoothstep(0.76, 0.95, turb);
      vec3 base = vec3(70.0, 20.0, 8.0) / 255.0 * (0.55 + 0.45 * hot);
      vec3 flame_ = vec3(255.0, 150.0 - 40.0 * (1.0 - hot), 60.0 + 70.0 * hot) / 255.0;
      vec3 tipCol = vec3(255.0, 235.0, 180.0) / 255.0;
      col = mix(base, flame_, tongue); col = mix(col, tipCol, tip * 0.8);
      al = mix(0.32, 1.0, tongue) * (0.9 + 0.2 * flicker);
      vGlow = mix(0.12, 1.0, tongue) + tip * 0.6;
    }
    else { float k = (age - flame) / max(dur - flame, 1.0); col = vec3(240.0 - 120.0 * k, 90.0 - 60.0 * k, 20.0) / 255.0 * (0.9 + 0.2 * flicker); al = (245.0 - 50.0 * k) / 255.0; vGlow = (1.0 - k) * 0.5; }
  } else {
    float ember = max(0.0, 1.0 - (age - dur) / ${EMBER_MIN}.0);
    float sh = 1.0 + (fnoise(g) - 0.5) * 0.4 + (fhash(floor(uv * fireDim * 8.0)) - 0.5) * 0.12;
    float glint = ember > 0.0 ? (fnoise(g * 4.0 + vec2(fireTime * 1.1, -fireTime * 0.9)) * 0.5 + 0.5) : 0.0;
    col = vec3((34.0 + 34.0 * (1.0 - sev)) * sh + 130.0 * ember * (0.7 + 0.5 * glint), (30.0 + 26.0 * (1.0 - sev)) * sh + 38.0 * ember * (0.7 + 0.5 * glint), (28.0 + 20.0 * (1.0 - sev)) * sh) / 255.0;
    al = (150.0 + 75.0 * sev) / 255.0;
    vGlow = ember * ember * 0.55 * (0.6 + 0.6 * glint);
  }
  return vec4(pow(col, vec3(2.2)), al * edge);
}
`;
