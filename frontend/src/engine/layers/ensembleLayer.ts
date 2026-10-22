import * as THREE from 'three';

import type { PerimeterCollection } from '@/api';
import { polygonParts, polygonRings } from '@/domain/geojson';
import type { Georef } from '@/domain/georef';

/** Height above terrain to draw the cone (sits just above the main fire outline, which is at 2.2). */
const LIFT = 2.6;
/** P90 fill: warm ember tone, kept very translucent so the cone reads as "could be", not "is". */
const P90_FILL = 0xff7733;
const P90_ALPHA = 0.15;
/** P10 (inner, optimistic) outline: a thin, high-contrast dashed ring. */
const P10_OUTLINE = 0xffd27a;
const P10_ALPHA = 0.55;

/**
 * The ensemble's "cone of futures": the p10–p90 uncertainty band around the median fire footprint.
 * Drawn as a translucent filled polygon for the p90 (pessimistic) perimeter with a dashed outline,
 * and a second dashed outline for the p10 (optimistic) one. If the run has no ensemble members the
 * backend returns three identical footprints — the layer then collapses to nothing instead of
 * faking a band around a single line of spread.
 */
export class EnsembleLayer {
  readonly group = new THREE.Group();
  /** True once the current perimeters carry a real p10–p90 spread (false = degenerate single-rep run). */
  hasSpread = false;
  /** The operator's LayersPanel switch. Kept here (not only on `group.visible`) so an in-flight fetch
   *  that resolves after the switch went off cannot turn the band back on. */
  private enabled = true;
  private p90Mesh: THREE.Mesh | null = null;
  private outlines: THREE.Line[] = [];

  constructor(private readonly geo: Georef) {
    this.group.visible = false;
  }

  /** The operator's LayersPanel switch: off means nothing is drawn even if data is present. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.group.visible = enabled && this.hasSpread;
  }

  /** Replaces the band with one built from the current minute's perimeters (one collection holding p10/p50/p90 features). */
  setCollections(collection: PerimeterCollection | null): void {
    this.clear();
    const features = collection?.features ?? [];
    const p90 = features.find((f) => f.properties?.percentile === 'p90');
    const p10 = features.find((f) => f.properties?.percentile === 'p10');
    if (!p90 || !p10) return;

    const p90Parts = polygonParts(p90.geometry);
    const p90Rings = p90Parts.flat();
    const p10Rings = polygonRings(p10.geometry);
    if (!p90Rings.length || !p10Rings.length) return;

    // Degenerate case: the run has no ensemble members, so every percentile is the same footprint.
    if (areSimilar(p90Rings, p10Rings)) {
      this.hasSpread = false;
      this.group.visible = false;
      return;
    }
    this.hasSpread = true;

    const fillMaterial = new THREE.MeshBasicMaterial({
      color: P90_FILL,
      transparent: true,
      opacity: P90_ALPHA,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    // One Shape per polygon (outer ring + its holes): a fire perimeter is a MultiPolygon, so the second
    // front's outer ring must not be swallowed as a hole of the first.
    const p90Shapes = p90Parts.map((rings) => ringsToShape(rings, this.geo)).filter((s): s is THREE.Shape => s !== null);
    if (p90Shapes.length) {
      const geometry = new THREE.ShapeGeometry(p90Shapes);
      geometry.rotateX(Math.PI / 2); // lay the shape flat: shape.y (world +z, south) rotates into world z
      // Drape the flat triangulation over the terrain: sample the height at each vertex's world x/z,
      // so the band follows hills instead of sinking under them.
      const position = geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i);
        const z = position.getZ(i);
        const [lat, lon] = this.geo.toLatLon(x, z);
        position.setY(i, this.geo.world(lat, lon, LIFT)[1]);
      }
      position.needsUpdate = true;
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, fillMaterial);
      mesh.renderOrder = 8.5; // above the fire outline (8), below the plan lines (9)
      this.p90Mesh = mesh;
      this.group.add(mesh);
    } else {
      // nothing to fill (every ring degenerate): don't leak the material created above
      fillMaterial.dispose();
    }

    const dashMaterial = new THREE.LineDashedMaterial({
      color: P10_OUTLINE,
      dashSize: 3,
      gapSize: 2,
      transparent: true,
      opacity: P10_ALPHA,
      depthTest: false,
      depthWrite: false,
    });
    for (const ring of [...p90Rings, ...p10Rings]) {
      const points = ring.map(([lon, lat]) => new THREE.Vector3(...this.geo.world(lat, lon, LIFT)));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), dashMaterial);
      line.computeLineDistances();
      line.renderOrder = 8.6;
      this.outlines.push(line);
      this.group.add(line);
    }
    // respect the operator's switch: a fetch that resolves after it went off must not show the band
    this.group.visible = this.enabled && this.hasSpread;
  }

  private clear(): void {
    for (const o of [...this.group.children]) {
      this.group.remove(o);
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of materials) if ('dispose' in m) m.dispose();
    }
    this.p90Mesh = null;
    this.outlines = [];
    this.hasSpread = false;
    this.group.visible = false;
  }

  /** Drops the band and hides it — used when the run changes so the next run never inherits the previous cone. */
  reset(): void {
    this.clear();
  }

  dispose(): void {
    this.clear();
  }
}

/** Rough "are these the same footprint" check: same ring count, similar sizes. */
function areSimilar(a: number[][][], b: number[][][]): boolean {
  if (a.length !== b.length) return false;
  const area = (rings: number[][][]): number =>
    rings.reduce((sum, ring) => {
      let s = 0;
      for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      return sum + Math.abs(s);
    }, 0);
  const aA = area(a);
  const bA = area(b);
  const big = Math.max(aA, bA);
  if (big === 0) return true;
  return Math.abs(aA - bA) / big < 0.02;
}

/** Builds a filled `THREE.Shape` from one polygon's rings (outer ring + holes), projected to world XZ coordinates. */
function ringsToShape(rings: number[][][], geo: Georef): THREE.Shape | null {
  if (!rings.length) return null;
  const [outer, ...holes] = rings;
  const toPoints = (ring: number[][]): THREE.Vector2[] =>
    ring.map(([lon, lat]) => {
      const [x, , z] = geo.world(lat, lon, 0);
      return new THREE.Vector2(x, z); // world +z (south) maps directly onto the shape's y axis
    });
  const shape = new THREE.Shape(toPoints(outer));
  for (const hole of holes) shape.holes.push(new THREE.Path(toPoints(hole)));
  return shape;
}
