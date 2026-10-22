import * as THREE from 'three';

import type { LayerInfo, VegetationClass } from '@/api';
import { elevationColor, hexToRgb } from '@/domain/colors';
import type { Georef } from '@/domain/georef';

import { BURN_GLSL, createBurnUniforms, type BurnUniforms } from './burnShader';

const loadImageOnce = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`imagem: ${url}`));
    img.src = url;
  });

/**
 * One retry on top of the browser's own: a dev-server reload, a backend restart or a dropped connection must not leave a
 * base layer permanently unloaded (the failed request is not cached, so a fresh Image can succeed).
 */
const loadImage = async (url: string): Promise<HTMLImageElement> => {
  try {
    return await loadImageOnce(url);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return loadImageOnce(url);
  }
};

/** Decodes a Terrarium-encoded heightmap (R*256+G+B/256-32768) into meters. */
export async function loadHeightmap(url: string): Promise<Float32Array> {
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const out = new Float32Array(canvas.width * canvas.height);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
  return out;
}

type BaseLayerName = 'satellite' | 'topo' | 'species';

/** With the 3D city on, the terrain sinks this far (world units, 1 = 10 m) below it: it only shows where the city has no tiles (loading, or outside the copy), never fights it. */
const CITY_SINK = 2;

interface OrthoTile {
  x: number;
  y: number;
  url: string;
  attribution?: string;
}

interface ShadeField {
  n: number;
  shade: Float32Array;
  grad: Float32Array;
  elev: Float32Array;
}

/**
 * The terrain mesh: satellite (DGT orthophoto tiles, or Sentinel-2 as a fallback mosaic),
 * topographic (hillshade + hypsometric color + contour lines) and species base layers, with
 * the fire state blended on top in the GPU shader (see `burnShader.ts`). Switching base layer
 * only swaps which texture each tile material points at — the mesh itself never rebuilds.
 */
export class TerrainMesh {
  /** One child mesh per orthophoto tile: the renderer culls each against the camera, so only the visible part of the terrain is drawn. */
  readonly mesh: THREE.Group;
  readonly geometry: THREE.BufferGeometry;
  private readonly chunks: THREE.Mesh[] = [];
  private readonly chunkGeometries: THREE.BufferGeometry[] = [];
  /** The same terrain, writing only depth: overlays drawn over the 3D city are hidden by hills but not by buildings (see `SceneEngine.setOverlayPass`). */
  readonly depthProxy = new THREE.Group();
  /** What the fire did to the ground, shared with the city tiles (one upload, both surfaces char together). */
  readonly burn: BurnUniforms;
  readonly attribution: string;
  readonly sourceLabel: string;
  readonly ready: Promise<void>;
  private layer: BaseLayerName = 'satellite';
  private readonly layerTex: Partial<Record<BaseLayerName, THREE.Texture>> = {};
  private readonly layerPending: Partial<Record<BaseLayerName, Promise<THREE.Texture>>> = {};
  private readonly tileTex: THREE.Texture[] = [];
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly tilesPerSide: number;
  private readonly speciesUrl?: string;
  private shadeField: ShadeField | null = null;


  constructor(
    private readonly geo: Georef,
    layers: LayerInfo[],
    private readonly vegetationClasses: VegetationClass[],
  ) {
    this.burn = createBurnUniforms(geo.W, geo.H);

    const ortho: OrthoTile[] = layers
      .filter((l) => l.kind === 'orthophoto')
      .map((l) => {
        const match = /^ortho_(\d+)_(\d+)$/.exec(l.id);
        if (!match) throw new Error(`orthophoto layer id "${l.id}" doesn't match ortho_<x>_<y>`);
        return { x: Number(match[1]), y: Number(match[2]), url: l.url, attribution: l.attribution };
      });
    const satellite = layers.find((l) => l.kind === 'satellite');
    this.speciesUrl = layers.find((l) => l.kind === 'vegetation')?.url;
    this.tilesPerSide = ortho.length ? Math.max(...ortho.map((t) => Math.max(t.x, t.y))) + 1 : 1;
    const N = this.tilesPerSide;

    const { rw, rh } = geo;
    const pos = new Float32Array(rw * rh * 3);
    const uv = new Float32Array(rw * rh * 2);
    const tileGroups: number[][] = Array.from({ length: N * N }, () => []);
    for (let j = 0; j < rh; j++) {
      for (let i = 0; i < rw; i++) {
        const k = j * rw + i;
        const u = (i + 0.5) / rw;
        const v = (j + 0.5) / rh;
        pos.set([geo.x(u), geo.y(geo.elev[k], geo.x(u), geo.z(v)), geo.z(v)], k * 3);
        uv.set([u, 1 - v], k * 2);
      }
    }
    for (let j = 0; j < rh - 1; j++) {
      for (let i = 0; i < rw - 1; i++) {
        const a = j * rw + i;
        const tx = Math.min(N - 1, Math.floor(((i + 1) / rw) * N));
        const ty = Math.min(N - 1, Math.floor(((j + 1) / rh) * N));
        tileGroups[ty * N + tx].push(a, a + rw, a + 1, a + 1, a + rw, a + rw + 1);
      }
    }
    // the shared vertex data; normals need the whole mesh's triangles once, then each tile keeps only its own index
    const index: number[] = [];
    const geometry = new THREE.BufferGeometry();
    tileGroups.forEach((list) => {
      // a plain loop: `push(...list)` overflows the call stack for the hundreds of thousands of indices a tile holds
      for (let q = 0; q < list.length; q++) index.push(list[q]);
    });
    const position = new THREE.BufferAttribute(pos, 3);
    geometry.setAttribute('position', position);
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    geometry.setIndex(null);
    this.geometry = geometry;

    for (let t = 0; t < N * N; t++) {
      const tex = new THREE.Texture();
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      const tx = t % N;
      const ty = Math.floor(t / N);
      tex.repeat.set(N, N);
      tex.offset.set(-tx, ty - (N - 1)); // global uv -> this tile's local uv (row 0 = north)
      this.tileTex.push(tex);
      this.materials.push(this.makeMaterial(tex));
    }
    this.mesh = new THREE.Group();
    const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
    tileGroups.forEach((list, t) => {
      const chunk = new THREE.BufferGeometry();
      chunk.setAttribute('position', position);
      chunk.setAttribute('uv', geometry.getAttribute('uv'));
      chunk.setAttribute('normal', geometry.getAttribute('normal'));
      chunk.setIndex(new THREE.Uint32BufferAttribute(Uint32Array.from(list), 1));
      // the shared position buffer would give every chunk the bounding sphere of the whole terrain: measure only the vertices this chunk uses
      const box = new THREE.Box3();
      const corner = new THREE.Vector3();
      for (let q = 0; q < list.length; q++) box.expandByPoint(corner.fromBufferAttribute(position, list[q]));
      chunk.boundingBox = box;
      chunk.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      const mesh = new THREE.Mesh(chunk, this.materials[t]);
      this.chunkGeometries.push(chunk);
      this.chunks.push(mesh);
      this.mesh.add(mesh);
      this.depthProxy.add(new THREE.Mesh(chunk, depthOnly));
    });
    this.depthProxy.visible = false;

    const sources = ortho.length
      ? ortho.map((t) => ({ idx: t.y * N + t.x, url: t.url }))
      : satellite
        ? [{ idx: 0, url: satellite.url }]
        : [];
    this.attribution = (ortho.length ? ortho[0].attribution : satellite?.attribution) ?? '';
    this.sourceLabel = ortho.length ? 'Ortofoto DGT 2021' : 'Sentinel-2';
    this.ready = Promise.all(
      sources.map(async (s) => {
        const img = await loadImage(s.url);
        const tex = this.tileTex[s.idx];
        tex.image = img;
        tex.needsUpdate = true;
        this.materials[s.idx].needsUpdate = true;
      }),
    ).then(() => undefined);
  }

  private makeMaterial(map: THREE.Texture): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ map, roughness: 0.95, metalness: 0 });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.burn);
      shader.vertexShader = `varying vec2 vGUv;\n${shader.vertexShader.replace(
        '#include <uv_vertex>',
        '#include <uv_vertex>\n vGUv = uv;',
      )}`;
      // the ground chars where the fire passed and glows under the flames; the flames are 3D (FlameLayer)
      shader.fragmentShader = `varying vec2 vGUv;\n${BURN_GLSL}\n${shader.fragmentShader}`
        .replace('#include <map_fragment>', `#include <map_fragment>\n diffuseColor.rgb = burnSurface(diffuseColor.rgb, vec2(vGUv.x, 1.0 - vGUv.y));`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n totalEmissiveRadiance += burnGlow * 1.3;`);
    };
    return material;
  }

  private currentWetness = 0;

  /** Modulates roughness and metalness to give the terrain a wet sheen and darker tone during rain. */
  setWetness(wetFactor: number): void {
    const factor = Math.min(1, Math.max(0, wetFactor));
    if (Math.abs(this.currentWetness - factor) < 0.05) return;
    this.currentWetness = factor;
    const targetRoughness = 0.95 - factor * 0.45;
    const targetMetalness = factor * 0.12;
    for (const m of this.materials) {
      m.roughness = targetRoughness;
      m.metalness = targetMetalness;
    }
  }

  // ------------------------------------------------------------ base layers
  async setLayer(name: BaseLayerName): Promise<void> {
    if (name !== 'satellite' && !this.layerTex[name]) {
      const layer = name;
      // one build per layer: clicking again while the first is still decoding shares that promise instead of starting another
      if (!this.layerPending[layer]) {
        const build = layer === 'topo' ? Promise.resolve(this.buildTopo()) : this.buildSpecies();
        this.layerPending[layer] = build.then((tex) => {
          this.layerTex[layer] = tex;
          return tex;
        });
      }
      try {
        await this.layerPending[layer];
      } finally {
        // the texture is cached in layerTex on success; on failure nothing is cached, so the next click retries
        delete this.layerPending[layer];
      }
    }
    this.layer = name;
    this.materials.forEach((material, t) => {
      material.map = name === 'satellite' ? this.tileTex[t] : (this.layerTex[name] ?? null);
      material.needsUpdate = true;
    });
  }

  get currentLayer(): BaseLayerName {
    return this.layer;
  }

  /** Shared hillshade/gradient/elevation field (NW light, 40° altitude) for the topo and species layers. */
  private ensureShade(n = 2048): ShadeField {
    if (this.shadeField && this.shadeField.n === n) return this.shadeField;
    const g = this.geo;
    const eps = 1.5 / n;
    const az = (315 * Math.PI) / 180;
    const alt = (40 * Math.PI) / 180;
    const light: [number, number, number] = [Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt)];
    const shade = new Float32Array(n * n);
    const grad = new Float32Array(n * n);
    const elev = new Float32Array(n * n);
    for (let py = 0; py < n; py++) {
      for (let px = 0; px < n; px++) {
        const u = (px + 0.5) / n;
        const v = (py + 0.5) / n;
        const k = py * n + px;
        const dE = (g.elevAtUV(u + eps, v) - g.elevAtUV(u - eps, v)) / (2 * eps * g.widthM);
        const dS = (g.elevAtUV(u, v + eps) - g.elevAtUV(u, v - eps)) / (2 * eps * g.heightM);
        const sx = dE * 1.8;
        const sy = -dS * 1.8;
        const inv = 1 / Math.hypot(sx, sy, 1);
        shade[k] = Math.max(0, (-sx * light[0] - sy * light[1] + light[2]) * inv);
        grad[k] = Math.hypot(dE, dS);
        elev[k] = g.elevAtUV(u, v);
      }
    }
    this.shadeField = { n, shade, grad, elev };
    return this.shadeField;
  }

  private canvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  private buildTopo(): THREE.CanvasTexture {
    const { n, shade, grad, elev } = this.ensureShade();
    const pxM = this.geo.widthM / n;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = n;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(n, n);
    const d = img.data;
    for (let k = 0; k < n * n; k++) {
      const e = elev[k];
      const [cr, cg, cb] = elevationColor(e);
      const s = 0.55 + 0.65 * shade[k];
      let r = cr * s;
      let g = cg * s;
      let b = cb * s;
      const hw = Math.max(grad[k] * pxM * 0.6, 0.15);
      const f20 = Math.abs(e / 20 - Math.round(e / 20)) * 20;
      const f100 = Math.abs(e / 100 - Math.round(e / 100)) * 100;
      if (f100 < hw * 1.4) {
        r = r * 0.35 + 60 * 0.65;
        g = g * 0.35 + 38 * 0.65;
        b = b * 0.35 + 22 * 0.65;
      } else if (f20 < hw) {
        r = r * 0.55 + 120 * 0.45;
        g = g * 0.55 + 80 * 0.45;
        b = b * 0.55 + 55 * 0.45;
      }
      d[k * 4] = r;
      d[k * 4 + 1] = g;
      d[k * 4 + 2] = b;
      d[k * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return this.canvasTexture(canvas);
  }

  private async buildSpecies(): Promise<THREE.CanvasTexture> {
    if (!this.speciesUrl) throw new Error('sem mapa de espécies (corra o ingest)');
    const source = await loadImage(this.speciesUrl);
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = source.width;
    srcCanvas.height = source.height;
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true })!;
    srcCtx.drawImage(source, 0, 0);
    const src = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height).data;

    const { n, shade } = this.ensureShade();
    const palette: Record<number, [number, number, number]> = {};
    this.vegetationClasses.forEach((k) => {
      if (k.color) palette[k.id] = hexToRgb(k.color);
    });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = n;
    const ctx = canvas.getContext('2d')!;
    const out = ctx.createImageData(n, n);
    const d = out.data;
    for (let py = 0; py < n; py++) {
      const sy = Math.min(Math.floor(((py + 0.5) / n) * srcCanvas.height), srcCanvas.height - 1);
      for (let px = 0; px < n; px++) {
        const sx = Math.min(Math.floor(((px + 0.5) / n) * srcCanvas.width), srcCanvas.width - 1);
        const id = src[(sy * srcCanvas.width + sx) * 4];
        const [cr, cg, cb] = palette[id] ?? [80, 80, 80];
        const s = 0.62 + 0.5 * shade[py * n + px];
        const o = (py * n + px) * 4;
        d[o] = Math.min(cr * s, 255);
        d[o + 1] = Math.min(cg * s, 255);
        d[o + 2] = Math.min(cb * s, 255);
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
    return this.canvasTexture(canvas);
  }

  // ------------------------------------------------------------ fire
  /**
   * Uploads a simulation result to the GPU, once per run: `ign` (minute of ignition per cell,
   * -1 = never burned), `inten` (kW/m), `dur` (residency time per cell, from vegetation).
   * After this, the fire only depends on `fireTime` (`setFireTime`) — playback is continuous
   * and free (no CPU work per frame beyond setting one float uniform).
   */
  setFireData(ign: Int16Array, width: number, height: number, dur: Uint8Array, inten: Uint16Array): void {
    const data = new Float32Array(width * height * 4);
    for (let i = 0; i < ign.length; i++) {
      data[i * 4] = ign[i];
      data[i * 4 + 1] = inten[i];
      data[i * 4 + 2] = dur[i] || 10;
      data[i * 4 + 3] = ign[i] >= 0 ? 1 : 0;
    }
    const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    tex.magFilter = tex.minFilter = THREE.NearestFilter; // interpolation happens in the shader, only between cells that burn
    tex.needsUpdate = true;
    this.burn.fireData.value.dispose();
    this.burn.fireData.value = tex;
    this.burn.fireDim.value.set(width, height);
  }

  /** How each cell chars (from the land-cover map; see `burnStyleTexture`). */
  setBurnStyle(tex: THREE.Texture): void {
    this.burn.burnStyle.value.dispose();
    this.burn.burnStyle.value = tex;
  }

  /** Instant (minutes, may be fractional) to show the fire at; negative = no fire. */
  setFireTime(minutes: number): void {
    this.burn.fireTime.value = minutes;
  }

  clearFire(): void {
    this.burn.fireTime.value = -1;
  }

  // ------------------------------------------------------------ under the 3D city
  /** With the photoreal city on, the terrain sinks just below it: it fills any gap in the tiles instead of leaving grey haze, and never z-fights with them. */
  setCityMode(on: boolean): void {
    this.mesh.position.y = on ? -CITY_SINK : 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.chunkGeometries.forEach((g) => g.dispose());
  }
}
