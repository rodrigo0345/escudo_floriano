import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin, GoogleCloudAuthPlugin } from '3d-tiles-renderer/plugins';
import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

import type { Georef } from '@/domain/georef';

import { BURN_GLSL, type BurnUniforms } from '../burnShader';

/** What `tools/fetch_tiles3d.py` writes next to the tiles: where they came from, when, and the credit the provider requires on screen. */
export interface CityManifest {
  source: string;
  fetchedAt: string;
  location: string;
  tiles: number;
  bytes: number;
  maxGeometricErrorM: number;
  attribution: string[];
}

/** Where the city's tiles come from: the operator's own saved copy, or streamed from Google while in use. */
export type CitySource = 'live' | 'local';

const WGS84_A = 6378137;
const WGS84_E2 = 0.00669437999014;
/** Height of the WGS84 ellipsoid above the sea-level geoid in Portugal (EGM96, ~52 m). The tiles are ellipsoidal, the terrain model is above sea level. */
const GEOID_UNDULATION_M = 52;
/** Screen-space error (pixels) a tile may have before it is refined: lower = sharper, more tiles. Live tiles go all the way down to photographic detail near the camera. */
const ERROR_TARGET_PX = { live: 18, local: 18 }; // Google's own recommendation is ~20: sharper (6) fetched several times more tiles for detail nobody could see
const TILE_CACHE = { min: 200, max: 500, maxBytes: 400 * 2 ** 20 };
/** Only tiles within this many metres of where the camera looks are fetched (a multiple of the camera's distance to its target, between the two limits): the rest of the map stays terrain. */
const LOAD_RADIUS = { perCameraMetre: 1.6, minM: 1500, maxM: 5000 };
/** Starting a live session is the one request Google bills (~$0.006). A browser may start this many a day: a runaway toggle cannot run up the bill. */
export const LIVE_STARTS_PER_DAY = 40;
const LIVE_STARTS_KEY = 'firetrace.city3d.starts';

/** How many live sessions this browser has started today and how many it may still start (a count in localStorage; the API key is never stored). */
export function liveBudget(): { used: number; limit: number } {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const saved = JSON.parse(localStorage.getItem(LIVE_STARTS_KEY) ?? 'null') as { day: string; n: number } | null;
    return { used: saved?.day === today ? saved.n : 0, limit: LIVE_STARTS_PER_DAY };
  } catch {
    return { used: 0, limit: LIVE_STARTS_PER_DAY };
  }
}

function countLiveStart(): void {
  const today = new Date().toISOString().slice(0, 10);
  try {
    localStorage.setItem(LIVE_STARTS_KEY, JSON.stringify({ day: today, n: liveBudget().used + 1 }));
  } catch {
    // no storage (private window): the session still works, only the daily count is lost
  }
}
/** Spacing (metres) of the ground samples used to check the tiles sit on the terrain model, and how often that check may run. */
const CALIBRATION_STEP_M = 120;
const CALIBRATION_TRIES = 6;
/** A correction larger than this, or samples spread wider than this, mean the rays hit something other than ground (coarse tiles, rooftops): do not trust them. */
const MAX_CALIBRATION_M = 25;
const MAX_SPREAD_M = 40;

/**
 * The 3D city: Google Photorealistic 3D Tiles, streamed from Google while in use ('live': the operator types a key, kept in memory only and dropped when the layer is
 * switched off; a session costs one billed request) or read from a copy saved earlier with `tools/fetch_tiles3d.py` ('local'). It is OFF by default. Level of detail and
 * frustum culling are the tiles renderer's: only tiles that are on screen and sharper than the error target are loaded, kept in a bounded cache and freed when they leave it,
 * so zooming in fetches finer tiles and zooming out lets them go.
 *
 * The tiles are in Earth-centred coordinates (ECEF); a single matrix puts them in the scene's frame (1 unit = 10 m, north = -z, east = +x, up = +y) with the origin at
 * the map centre. The scene bends the terrain down with the earth's curvature (`Georef.y`), exactly as a tangent plane does to the tiles, so the two stay together.
 */
export class PhotorealLayer {
  readonly group = new THREE.Group();
  attribution = '';
  /** Called once, when the first tiles are drawn (the basemap can then step aside), and with `false` when the layer is switched off. */
  onVisibleChange: (visible: boolean) => void = () => undefined;
  private tiles: TilesRenderer | null = null;
  private source: CitySource | null = null;
  private manifest: CityManifest | null = null;
  private heightOffsetM = 0;
  /** The operator's manual height adjustment (metres), on top of the automatic one. */
  private trimM = 0;
  private calibrations = 0;
  private enabled = false;
  private reportedVisible = false;
  private readonly base: string;
  /** Where the camera looks (set every frame): the height check samples the city around it. */
  private readonly target = new THREE.Vector3();
  /** The load region (tile frame, metres): the camera target and how far around it tiles are fetched. */
  private readonly loadCenter = new THREE.Vector3();
  private loadRadiusM = Infinity;
  private readonly toTileFrame = new THREE.Matrix4();

  constructor(
    private readonly geo: Georef,
    private readonly locationId: string,
    private readonly burn: BurnUniforms,
  ) {
    this.base = `/tiles3d/${locationId}`;
    this.group.visible = false;
  }

  /** Are there local tiles? `null` when not (the default: nothing is shown and nothing is requested from anywhere). */
  async probe(): Promise<CityManifest | null> {
    try {
      const response = await fetch(`${this.base}/manifest.json`, { cache: 'no-store' });
      if (!response.ok) return null;
      this.manifest = (await response.json()) as CityManifest;
      this.attribution = this.manifest.attribution?.length ? this.manifest.attribution.join(' Â· ') : 'Google';
      return this.manifest;
    } catch {
      return null;
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Switches the layer on (from `source`; live needs the key) or off. Turning a live session off drops it and the key with it: the next start is a new session.
   * @returns false when it could not start (no tiles, no key, or today's live sessions are used up).
   */
  setEnabled(on: boolean, camera: THREE.Camera, renderer: THREE.WebGLRenderer, source: CitySource = 'local', apiKey = ''): boolean {
    if (!on) {
      if (this.enabled || this.tiles) this.stop(source === 'live' || this.source === 'live');
      return true;
    }
    if (this.enabled && this.source === source && this.tiles) return true;
    if (this.tiles) this.stop(true); // another source: start over
    if (source === 'local' && !this.manifest) return false;
    if (source === 'live' && (!apiKey || liveBudget().used >= LIVE_STARTS_PER_DAY)) return false;
    this.enabled = true;
    this.source = source;
    this.group.visible = true;
    this.tiles = this.createTiles(camera, renderer, source, apiKey);
    if (source === 'live') countLiveStart();
    return true;
  }

  private stop(dropTiles: boolean): void {
    this.enabled = false;
    this.group.visible = false;
    this.reportedVisible = false;
    this.onVisibleChange(false);
    if (dropTiles) {
      this.tiles?.dispose();
      this.tiles = null;
      this.group.clear();
      this.source = null;
    }
  }

  /** The operator's own height adjustment (metres, +up): the automatic check cannot see every error, so it can be nudged by eye. */
  setHeightTrim(metres: number): void {
    this.trimM = metres;
    if (this.tiles) this.applyAlignment(this.tiles);
  }

  /** Per frame, before drawing: lets the renderer pick, load and drop tiles for the current camera. */
  update(camera: THREE.Camera, renderer: THREE.WebGLRenderer, target: THREE.Vector3): void {
    const tiles = this.tiles;
    if (!tiles || !this.enabled) return;
    this.target.copy(target);
    camera.updateMatrixWorld();
    this.toTileFrame.copy(tiles.group.matrixWorld).invert();
    this.loadCenter.copy(target).applyMatrix4(this.toTileFrame);
    this.loadRadiusM = Math.min(LOAD_RADIUS.maxM, Math.max(LOAD_RADIUS.minM, camera.position.distanceTo(target) * this.geo.unit * LOAD_RADIUS.perCameraMetre));
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.update();
  }

  dispose(): void {
    this.tiles?.dispose();
    this.tiles = null;
    this.group.clear();
  }

  // ---------------------------------------------------------------------------------------------------------------- tiles
  private createTiles(camera: THREE.Camera, renderer: THREE.WebGLRenderer, source: CitySource, apiKey: string): TilesRenderer {
    const draco = new DRACOLoader().setDecoderPath('/draco/');
    const tiles = new TilesRenderer(source === 'local' ? `${this.base}/tileset.json` : undefined);
    // live: the plugin adds the key and Google's session token to every request and (no auto refresh) never opens a second, billed session on its own
    if (source === 'live') tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: false, useRecommendedSettings: false } as ConstructorParameters<typeof GoogleCloudAuthPlugin>[0]));
    tiles.registerPlugin(new GLTFExtensionsPlugin({ metadata: false, rtc: false, plugins: [], dracoLoader: draco, ktxLoader: null, autoDispose: true }));
    tiles.errorTarget = ERROR_TARGET_PX[source];
    tiles.downloadQueue.maxJobs = 24;
    tiles.parseQueue.maxJobs = 8;
    tiles.lruCache.minSize = TILE_CACHE.min;
    tiles.lruCache.maxSize = TILE_CACHE.max;
    (tiles.lruCache as unknown as { maxBytesSize: number }).maxBytesSize = TILE_CACHE.maxBytes;
    // a tile counts as in view only if it is also near where the camera looks: the tiles renderer then neither downloads nor refines the rest of the map
    const hook = tiles as unknown as { tileInView: (tile: unknown) => boolean };
    const inFrustum = hook.tileInView.bind(tiles);
    hook.tileInView = (tile) => {
      if (!inFrustum(tile)) return false;
      const volume = (tile as { cached?: { boundingVolume?: { distanceToPoint: (point: THREE.Vector3) => number } } }).cached?.boundingVolume;
      return !volume || volume.distanceToPoint(this.loadCenter) <= this.loadRadiusM;
    };
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.group.matrixAutoUpdate = false;
    this.applyAlignment(tiles);
    this.group.add(tiles.group);

    // photographic textures already carry their lighting: an unlit material shows them true and is cheaper than a lit one; it also chars where the fire burned
    tiles.addEventListener('load-model', (event) => this.makeBurnable((event as unknown as { scene: THREE.Object3D }).scene));
    tiles.forEachLoadedModel((scene: THREE.Object3D) => this.makeBurnable(scene));
    tiles.addEventListener('tiles-load-end', () => {
      if (source === 'live') this.updateLiveAttribution(tiles);
      if (!this.reportedVisible) {
        this.reportedVisible = true;
        this.onVisibleChange(true);
      }
      if (this.calibrations < CALIBRATION_TRIES) setTimeout(() => this.calibrate(tiles), 250);
    });
    draco.preload();
    return tiles;
  }

  /**
   * Swaps every textured material of a tile for the burnable one. Google's tiles are unlit (KHR_materials_unlit), so the loader gives MeshBasicMaterial, not Standard:
   * any material with a photo (Basic, Standard, Physical) is taken.
   */
  private makeBurnable(scene: THREE.Object3D): void {
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const material = mesh.material as THREE.MeshBasicMaterial | undefined;
      if (!mesh.isMesh || !material || Array.isArray(material) || !material.map || material.userData.burnable) return;
      mesh.material = this.burnableMaterial(material.map, material.color);
      material.dispose(); // the texture stays: the new material owns it now
    });
  }

  /**
   * The tile's photo, charred where the simulation burned (same shader and same uniforms as the terrain): trees, roofs and fields in the city turn to charcoal, soot or
   * ash by land-cover type as the fire passes, and the ground glows under the flames. The grid position comes from the fragment's world position.
   */
  private burnableMaterial(map: THREE.Texture, color: THREE.Color): THREE.MeshBasicMaterial {
    const material = new THREE.MeshBasicMaterial({ map, color, side: THREE.FrontSide });
    material.userData.burnable = true;
    material.customProgramCacheKey = () => 'burn-city'; // every tile shares one compiled program
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.burn);
      shader.vertexShader = `varying vec3 vBurnWorld;\n${shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n vBurnWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      )}`;
      shader.fragmentShader = `varying vec3 vBurnWorld;\n${BURN_GLSL}\n${shader.fragmentShader}`
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>\n diffuseColor.rgb = burnSurface(diffuseColor.rgb, vec2(vBurnWorld.x / burnSize.x + 0.5, vBurnWorld.z / burnSize.y + 0.5));`,
        )
        .replace('#include <opaque_fragment>', `outgoingLight += burnGlow * 0.9;\n#include <opaque_fragment>`);
    };
    return material;
  }

  /** Google's credit for the tiles in view (live): the providers named in the tiles themselves, which Google requires on screen. */
  private updateLiveAttribution(tiles: TilesRenderer): void {
    const credits: { type: string; value: string }[] = [];
    (tiles as unknown as { getAttributions: (target: unknown[]) => void }).getAttributions(credits);
    const text = credits.filter((c) => c.type === 'string').map((c) => c.value).join(' Â· ');
    this.attribution = text || 'Google';
  }

  /** ECEF -> scene: east/up/north axes at the map centre, metres to scene units, north flipped to -z. */
  private applyAlignment(tiles: TilesRenderer): void {
    const geo = this.geo;
    const [lat, lon] = geo.toLatLon(0, 0);
    const phi = (lat * Math.PI) / 180;
    const lambda = (lon * Math.PI) / 180;
    const h = geo.base + GEOID_UNDULATION_M;
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(phi) ** 2);
    const origin = new THREE.Vector3((n + h) * Math.cos(phi) * Math.cos(lambda), (n + h) * Math.cos(phi) * Math.sin(lambda), (n * (1 - WGS84_E2) + h) * Math.sin(phi));
    const east = new THREE.Vector3(-Math.sin(lambda), Math.cos(lambda), 0);
    const north = new THREE.Vector3(-Math.sin(phi) * Math.cos(lambda), -Math.sin(phi) * Math.sin(lambda), Math.cos(phi));
    const up = new THREE.Vector3(Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi));
    const k = 1 / geo.unit;
    const ky = (geo.exag / geo.unit);
    tiles.group.matrix.set(
      east.x * k, east.y * k, east.z * k, -origin.dot(east) * k,
      up.x * ky, up.y * ky, up.z * ky, -origin.dot(up) * ky + ((this.heightOffsetM + this.trimM) * ky),
      -north.x * k, -north.y * k, -north.z * k, origin.dot(north) * k,
      0, 0, 0, 1,
    );
    tiles.group.matrixWorldNeedsUpdate = true;
  }

  /**
   * The tiles' heights come from a different model than the terrain (ellipsoid vs sea level, different survey), so a few metres of error are normal. Cast rays down at a
   * grid of points around where the camera looks, only against the FINEST tiles drawn (a coarse parent is hundreds of metres off by construction and overlaps its children
   * while they load), and move the whole city by the low quartile of the differences to the terrain (low, because some rays land on roofs and treetops). A correction beyond
   * `MAX_CALIBRATION_M`, or samples that disagree, mean something else is wrong: logged, not applied.
   */
  private calibrate(tiles: TilesRenderer): void {
    const geo = this.geo;
    let finest = Infinity;
    const loaded: { scene: THREE.Object3D; error: number }[] = [];
    tiles.forEachLoadedModel((scene: THREE.Object3D, tile: { geometricError: number }) => {
      if (!scene.visible) return;
      loaded.push({ scene, error: tile.geometricError });
      finest = Math.min(finest, tile.geometricError);
    });
    const fine = loaded.filter((l) => l.error <= finest * 1.01).map((l) => l.scene);
    if (!fine.length) return;
    const raycaster = new THREE.Raycaster();
    const differences: number[] = [];
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        const x = this.target.x + (i * CALIBRATION_STEP_M) / geo.unit;
        const z = this.target.z + (j * CALIBRATION_STEP_M) / geo.unit;
        raycaster.set(new THREE.Vector3(x, 4000, z), new THREE.Vector3(0, -1, 0));
        const hit = raycaster.intersectObjects(fine, true)[0];
        if (!hit) continue;
        const terrainY = geo.y(geo.elevAtUV(x / geo.W + 0.5, z / geo.H + 0.5), x, z);
        differences.push(((hit.point.y - terrainY) * geo.unit) / geo.exag);
      }
    }
    if (differences.length < 10) return; // too few fine tiles under the camera yet: try again after the next load
    this.calibrations += 1;
    differences.sort((a, b) => a - b);
    const ground = differences[Math.floor(differences.length * 0.25)];
    const spread = differences[Math.floor(differences.length * 0.75)] - differences[Math.floor(differences.length * 0.25)];
    console.info(`cidade 3D: ${differences.length} raios em tiles de erro ${finest.toFixed(1)} m: chÃ£o ${ground.toFixed(1)} m acima do terreno (dispersÃ£o ${spread.toFixed(1)} m)`);
    if (spread > MAX_SPREAD_M || Math.abs(ground) > MAX_CALIBRATION_M || Math.abs(ground) < 0.75) return;
    this.heightOffsetM -= ground;
    this.applyAlignment(tiles);
    console.info(`cidade 3D: altura ajustada ${(-ground).toFixed(1)} m (total ${this.heightOffsetM.toFixed(1)} m)`);
  }
}