import type { Location } from '@/api';

export type WorldPoint = [x: number, y: number, z: number];

const EARTH_RADIUS_M = 6371000;
const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'] as const;

/** The 8-point compass label (Portuguese) for a bearing in degrees. */
export function compass(deg: number): string {
  return COMPASS_POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/**
 * Local lat/lon → 3D world projection (1 world unit = 10 m; north = -z, east = +x), with
 * elevation from bilinear sampling of the heightmap. This is the one place that owns that
 * mapping — the GPU engine layer, the picking/raycasting code and every overlay all go
 * through a single `Georef` instance instead of re-deriving the projection.
 */
export class Georef {
  readonly north: number;
  readonly west: number;
  readonly dLat: number;
  readonly dLon: number;
  readonly widthM: number;
  readonly heightM: number;
  readonly unit = 10;
  readonly W: number;
  readonly H: number;
  readonly rw: number;
  readonly rh: number;
  readonly elev: Float32Array;
  /** Real scale: the photoreal 3D city (true heights) has to sit on the terrain, so no vertical exaggeration. */
  readonly exag = 1;
  readonly base: number;
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly cellM: number;

  constructor(location: Location, elevations: Float32Array) {
    const grid = location.grid;
    const renderGrid = location.renderGrid ?? grid;
    if (grid.latNorth == null || grid.lonWest == null || grid.dLat == null || grid.dLon == null) {
      throw new Error(`Location ${location.id} is missing grid georeferencing (latNorth/lonWest/dLat/dLon).`);
    }
    this.north = grid.latNorth;
    this.west = grid.lonWest;
    this.dLat = grid.dLat;
    this.dLon = grid.dLon;
    this.gridWidth = grid.width;
    this.gridHeight = grid.height;
    this.cellM = grid.cellM;
    this.widthM = grid.width * grid.cellM;
    this.heightM = grid.height * grid.cellM;
    this.W = this.widthM / this.unit;
    this.H = this.heightM / this.unit;
    this.rw = renderGrid.width;
    this.rh = renderGrid.height;
    this.elev = elevations;
    this.base = location.elevationM?.min ?? 0;
  }

  /** Normalized coordinates 0..1 (u = west→east, v = north→south). */
  uv(lat: number, lon: number): [number, number] {
    return [(lon - this.west) / (this.dLon * this.gridWidth), (this.north - lat) / (this.dLat * this.gridHeight)];
  }

  x(u: number): number {
    return (u - 0.5) * this.W;
  }

  z(v: number): number {
    return (v - 0.5) * this.H;
  }

  elevAtUV(u: number, v: number): number {
    const fx = Math.min(Math.max(u * this.rw - 0.5, 0), this.rw - 1.001);
    const fy = Math.min(Math.max(v * this.rh - 0.5, 0), this.rh - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const w = this.rw;
    const E = this.elev;
    return (
      (E[j * w + i] * (1 - tx) + E[j * w + i + 1] * tx) * (1 - ty) +
      (E[(j + 1) * w + i] * (1 - tx) + E[(j + 1) * w + i + 1] * tx) * ty
    );
  }

  /**
   * World height of a point `elev` metres above sea level at world position (`x`, `z`). The map is a flat sheet, but the earth is not: a point `d` metres from
   * the centre lies `d²/2R` below the tangent plane (12 m at 12 km). Bending the sheet the same way keeps it together with the 3D city tiles, which are projected
   * on that tangent plane (`PhotorealLayer`).
   */
  y(elev: number, x = 0, z = 0): number {
    const dropM = ((x * x + z * z) * this.unit * this.unit) / (2 * EARTH_RADIUS_M);
    return ((elev - dropM - this.base) / this.unit) * this.exag;
  }

  /** lat/lon → world position. */
  world(lat: number, lon: number, lift = 0): WorldPoint {
    const [u, v] = this.uv(lat, lon);
    const e = this.elevAtUV(u, v);
    const x = this.x(u);
    const z = this.z(v);
    return [x, this.y(e, x, z) + lift, z];
  }

  /** world x/z (ground plane) → lat/lon. */
  toLatLon(x: number, z: number): [number, number] {
    const u = x / this.W + 0.5;
    const v = z / this.H + 0.5;
    return [this.north - v * this.dLat * this.gridHeight, this.west + u * this.dLon * this.gridWidth];
  }

  /** @returns `[slopeDeg, aspectDeg]` — aspect is the compass direction the slope descends toward. */
  slopeAspect(u: number, v: number): [number, number] {
    const d = 1 / this.rw;
    const ex = (this.elevAtUV(u + d, v) - this.elevAtUV(u - d, v)) / (2 * this.cellM);
    const ey = (this.elevAtUV(u, v + d) - this.elevAtUV(u, v - d)) / (2 * this.cellM);
    const slope = (Math.atan(Math.hypot(ex, ey)) * 180) / Math.PI;
    const aspect = ((Math.atan2(-ex, ey) * 180) / Math.PI + 360) % 360;
    return [slope, aspect];
  }

  /** Grid cell column/row a lat/lon falls in, clamped to the grid. */
  cellAt(lat: number, lon: number): [col: number, row: number] {
    const [u, v] = this.uv(lat, lon);
    const col = Math.min(Math.max(Math.floor(u * this.gridWidth), 0), this.gridWidth - 1);
    const row = Math.min(Math.max(Math.floor(v * this.gridHeight), 0), this.gridHeight - 1);
    return [col, row];
  }
}
