import type * as THREE from 'three';

import type { Georef } from '@/domain/georef';

/** One vehicle to keep apart from the others: its position this frame (moved in place) and its ground footprint (scene units, enlargement included). */
export interface SpreadItem {
  /** Stable id: fixes each vehicle's slot in its cluster, so a group does not reshuffle every frame. */
  id: string;
  pos: THREE.Vector3;
  footprint: number;
  air: boolean;
}

/** Gap between neighbours in a spread-out cluster, as a multiple of the largest footprint in it. */
const SPACING = 1.3;
/** Up to this many vehicles go on one ring; more are laid out on a spiral. */
const RING_MAX = 6;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Height step between aircraft of one cluster, as a multiple of the largest footprint, cycling over this many levels. */
const AIR_STAGGER = 0.6;
const AIR_LEVELS = 3;

/**
 * Keeps vehicles that share a point (several units sent to one target, a crew and its truck) from being drawn inside each other: vehicles closer than their
 * footprint are grouped, and each group is laid out around its centre on a ring (a spiral when crowded), ordered by id. Ground vehicles are put back on the terrain
 * at their new x/z; aircraft keep their height above the ground and are stacked in a few altitude levels as well. Positions are changed in place.
 */
export function spreadPositions(items: SpreadItem[], geo: Georef): void {
  spreadGroup(
    items.filter((i) => !i.air),
    geo,
    false,
  );
  spreadGroup(
    items.filter((i) => i.air),
    geo,
    true,
  );
}

function spreadGroup(items: SpreadItem[], geo: Georef, air: boolean): void {
  if (items.length < 2) return;
  for (const cluster of clustersOf(items)) {
    if (cluster.length < 2) continue;
    cluster.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let cx = 0;
    let cz = 0;
    let largest = 0;
    for (const i of cluster) {
      cx += i.pos.x;
      cz += i.pos.z;
      largest = Math.max(largest, i.footprint);
    }
    cx /= cluster.length;
    cz /= cluster.length;
    const spacing = largest * SPACING;
    const n = cluster.length;
    cluster.forEach((item, k) => {
      let r: number;
      let angle: number;
      if (n <= RING_MAX) {
        r = spacing / (2 * Math.sin(Math.PI / n)); // neighbours on the ring `spacing` apart
        angle = (2 * Math.PI * k) / n;
      } else {
        r = spacing * 0.62 * Math.sqrt(k + 0.5); // sunflower spiral: about `spacing` between neighbours
        angle = k * GOLDEN_ANGLE;
      }
      const x = cx + r * Math.cos(angle);
      const z = cz + r * Math.sin(angle);
      const lift = item.pos.y - groundY(geo, item.pos.x, item.pos.z);
      item.pos.x = x;
      item.pos.z = z;
      item.pos.y = groundY(geo, x, z) + (air ? lift + (k % AIR_LEVELS) * largest * AIR_STAGGER : 0);
    });
  }
}

/** Groups items closer (x/z) than the larger of their footprints, transitively, using a grid hash so it stays cheap for a big fleet. */
function clustersOf(items: SpreadItem[]): SpreadItem[][] {
  const cell = Math.max(1e-6, ...items.map((i) => i.footprint));
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const grid = new Map<string, number[]>();
  items.forEach((item, i) => {
    const gx = Math.floor(item.pos.x / cell);
    const gz = Math.floor(item.pos.z / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const j of grid.get(`${gx + dx},${gz + dz}`) ?? []) {
          const other = items[j];
          const reach = Math.max(item.footprint, other.footprint);
          if ((item.pos.x - other.pos.x) ** 2 + (item.pos.z - other.pos.z) ** 2 < reach * reach) parent[find(i)] = find(j);
        }
      }
    }
    const key = `${gx},${gz}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  });
  const clusters = new Map<number, SpreadItem[]>();
  items.forEach((item, i) => {
    const root = find(i);
    const list = clusters.get(root);
    if (list) list.push(item);
    else clusters.set(root, [item]);
  });
  return [...clusters.values()];
}

/** Terrain height (scene units) at world x/z. */
function groundY(geo: Georef, x: number, z: number): number {
  return geo.y(geo.elevAtUV(x / geo.W + 0.5, z / geo.H + 0.5), x, z);
}
