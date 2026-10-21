import * as THREE from 'three';

const PER_JET = 80;
const PER_DROP = 90;
const MAX = 12000;

const VERTEX = /* glsl */ `
attribute vec3 aOrigin;
attribute vec4 aDir;    // xyz direction (horizontal for a jet, down for a drop), w = reach (world units)
attribute vec2 aSeed;   // x = seed 0..1, y = 0 jet / 1 drop
uniform float uTime;
uniform float uScale;
varying float vT;
float h(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  float s = aSeed.x;
  float t = fract(uTime * (aSeed.y > 0.5 ? 0.55 : 1.1) + s);
  vT = t;
  float reach = aDir.w;
  vec3 side = normalize(cross(aDir.xyz + vec3(0.0001, 0.0, 0.0), vec3(0.0, 1.0, 0.0)));
  vec3 p;
  if (aSeed.y < 0.5) {
    // hose / monitor jet: a parabola out to the reach, fanning out as it breaks up
    float spread = (h(s * 3.7) - 0.5) * reach * 0.12 * t;
    p = aOrigin + aDir.xyz * reach * t + vec3(0.0, reach * 0.42 * 4.0 * t * (1.0 - t) - reach * 0.08 * t, 0.0) + side * spread;
  } else {
    // bucket or tank drop: a falling curtain that widens and drifts as it falls
    vec2 j = vec2(h(s * 5.1), h(s * 9.3)) - 0.5;
    p = aOrigin + vec3(j.x, 0.0, j.y) * reach * (0.08 + 0.5 * t) + vec3(0.0, -reach * t, 0.0);
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float size = reach * (aSeed.y < 0.5 ? (0.05 + 0.11 * t) : (0.06 + 0.14 * t));
  gl_PointSize = clamp(size * uScale / -mv.z, 1.0, 96.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT = /* glsl */ `
varying float vT;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  float a = exp(-d * 2.2) * (1.0 - vT * 0.85) * 0.95;
  gl_FragColor = vec4(mix(vec3(0.78, 0.9, 1.0), vec3(0.45, 0.68, 0.95), vT), a);
}
`;

/**
 * Water in the air: the jets from hoses and roof monitors of trucks fighting the fire, and the curtains dropped by helicopters and air tankers. Stateless GPU particles
 * (motion is a function of time and seed); the layer only lists, each frame, who is spraying from where and towards where.
 */
export class WaterEffects {
  readonly points: THREE.Points;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly origin = new Float32Array(MAX * 3);
  private readonly dir = new Float32Array(MAX * 4);
  private readonly seed = new Float32Array(MAX * 2);
  private readonly material: THREE.ShaderMaterial;
  private n = 0;

  constructor() {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    this.geometry.setAttribute('aOrigin', new THREE.BufferAttribute(this.origin, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aDir', new THREE.BufferAttribute(this.dir, 4).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 2).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uTime: { value: 0 }, uScale: { value: 1000 } },
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }

  begin(): void {
    this.n = 0;
  }

  /** A hose/monitor jet from `from` towards horizontal direction `dir`, `reach` world units long. */
  jet(from: THREE.Vector3, dir: THREE.Vector3, reach: number): void {
    this.add(from, dir, reach, 0, PER_JET);
  }

  /** A falling curtain of water from `from`, `height` world units down to the ground. */
  drop(from: THREE.Vector3, height: number): void {
    this.add(from, new THREE.Vector3(0, -1, 0), height, 1, PER_DROP);
  }

  private add(from: THREE.Vector3, dir: THREE.Vector3, reach: number, kind: number, count: number): void {
    for (let i = 0; i < count && this.n < MAX; i++, this.n++) {
      this.origin.set([from.x, from.y, from.z], this.n * 3);
      this.dir.set([dir.x, dir.y, dir.z, reach], this.n * 4);
      this.seed.set([(i + 0.5) / count, kind], this.n * 2);
    }
  }

  end(timeS: number, camera: THREE.PerspectiveCamera, viewportHeightPx: number): void {
    this.material.uniforms.uTime.value = timeS;
    this.material.uniforms.uScale.value = viewportHeightPx / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.geometry.setDrawRange(0, this.n);
    if (this.n) {
      for (const name of ['aOrigin', 'aDir', 'aSeed']) (this.geometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
