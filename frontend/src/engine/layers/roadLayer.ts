import * as THREE from 'three';

import type { RoadCollection, RoadFeature } from '@/api';
import { lineStringCoordinates } from '@/domain/geojson';
import type { Georef } from '@/domain/georef';

const MAJOR_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link']);

interface RoadRange {
  start: number;
  count: number;
  major: boolean;
}

/** `cut` by road index, `prob` 0..1 by road index (probability/ensemble mode) or `null`, `smoky` = visibility lost to smoke. */
export interface RoadPaintState {
  cut: ReadonlySet<number>;
  prob: ReadonlyMap<number, number> | null;
  smoky?: ReadonlySet<number>;
}

/** Roads draped on the terrain as a single mesh (per-vertex RGBA color: open, cut, probability, smoke-obscured). */
export class RoadLayer {
  readonly mesh: THREE.Mesh;
  readonly features: RoadFeature[];
  readonly indexById: Map<string, number>;
  private readonly ranges: RoadRange[] = [];
  private readonly color: Float32Array;

  constructor(
    private geo: Georef,
    collection: RoadCollection,
  ) {
    // Forest tracks (`requiresOffRoad`) only serve off-road vehicles — not drawn as a navigable road.
    this.features = ((collection.features ?? []) as RoadFeature[]).filter((f) => !f.properties?.requiresOffRoad);
    this.indexById = new Map<string, number>(this.features.map((f, i): [string, number] => [f.properties!.id as string, i]));

    const positions: number[] = [];
    const indices: number[] = [];
    let vertexCount = 0;
    for (const feature of this.features) {
      const major = MAJOR_CLASSES.has(feature.properties?.class ?? '');
      const halfWidth = major ? 1.3 : 0.7;
      const start = vertexCount;
      const points = lineStringCoordinates(feature.geometry).map(([lon, lat]) => geo.world(lat, lon, 0.9));
      points.forEach((p, i) => {
        const a = points[Math.max(0, i - 1)];
        const b = points[Math.min(points.length - 1, i + 1)];
        let dx = b[0] - a[0];
        let dz = b[2] - a[2];
        const len = Math.hypot(dx, dz) || 1;
        dx /= len;
        dz /= len;
        positions.push(p[0] - dz * halfWidth, p[1], p[2] + dx * halfWidth, p[0] + dz * halfWidth, p[1], p[2] - dx * halfWidth);
        vertexCount += 2;
        if (i < points.length - 1) {
          const k = start + i * 2;
          indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        }
      });
      this.ranges.push({ start, count: vertexCount - start, major });
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    this.color = new Float32Array(vertexCount * 4);
    geometry.setAttribute('color', new THREE.BufferAttribute(this.color, 4));

    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    );
    this.mesh.renderOrder = 5;
    this.update({ cut: new Set(), prob: null });
  }

  update({ cut, prob, smoky = new Set() }: RoadPaintState): void {
    const c = new THREE.Color();
    this.ranges.forEach(({ start, count, major }, i) => {
      let r: number, g: number, b: number, a: number;
      if (prob) {
        const p = prob.get(i) ?? 0;
        c.set(p <= 0 ? 0xdddddd : p < 0.5 ? 0xf5b301 : 0xff2020);
        r = c.r;
        g = c.g;
        b = c.b;
        a = p > 0 ? 0.95 : major ? 0.45 : 0.18;
      } else if (cut.has(i)) {
        r = 1;
        g = 0.14;
        b = 0.12;
        a = 1;
      } else if (smoky.has(i)) {
        r = 0.72;
        g = 0.5;
        b = 0.2;
        a = 0.95; // open, but obscured by smoke
      } else {
        r = 0.98;
        g = 0.95;
        b = 0.82;
        a = major ? 0.55 : 0.2;
      }
      for (let k = start; k < start + count; k++) this.color.set([r, g, b, a], k * 4);
    });
    (this.mesh.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Midpoint of a road's geometry (for labels). */
  midpoint(index: number): [number, number, number] {
    const coords = lineStringCoordinates(this.features[index].geometry);
    const [lon, lat] = coords[Math.floor(coords.length / 2)];
    return this.geo.world(lat, lon, 4);
  }
}
