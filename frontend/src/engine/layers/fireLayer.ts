import * as THREE from 'three';

import type { PerimeterCollection, SpreadVectorCollection } from '@/api';
import { pointCoordinates, polygonRings } from '@/domain/geojson';
import type { Georef } from '@/domain/georef';
import type { IgnitionPoint } from '@/store/types';

import { textSprite } from '../sprites';

export interface Milestone {
  label: string;
  lat: number;
  lon: number;
}

/** Ignition marker, current fire perimeter outline, direction-of-spread arrows and the timeline of milestones since ignition. */
export class FireLayer {
  readonly group = new THREE.Group();
  private readonly ignitionMarkers = new THREE.Group();
  private ignitionRings: THREE.Mesh[] = [];
  private perimeter: THREE.Group | null = null;
  private arrows: THREE.InstancedMesh | null = null;
  private track: THREE.Line | null = null;
  private milestoneSprites: THREE.Sprite[] = [];
  private readonly arrowGeometry: THREE.ShapeGeometry;
  private readonly arrowMaterial: THREE.MeshBasicMaterial;

  constructor(private geo: Georef) {
    this.group.add(this.ignitionMarkers);
    // Segmented / striped chevron vector: visually unmistakable from solid wind arrows
    const head = new THREE.Shape();
    head.moveTo(0, -3.0);
    head.lineTo(1.35, -1.3);
    head.lineTo(0.5, -1.1);
    head.lineTo(0, -1.65);
    head.lineTo(-0.5, -1.1);
    head.lineTo(-1.35, -1.3);
    head.closePath();

    const c1 = new THREE.Shape();
    c1.moveTo(0, -1.25);
    c1.lineTo(1.15, -0.35);
    c1.lineTo(0.5, -0.15);
    c1.lineTo(0, -0.7);
    c1.lineTo(-0.5, -0.15);
    c1.lineTo(-1.15, -0.35);
    c1.closePath();

    const c2 = new THREE.Shape();
    c2.moveTo(0, -0.3);
    c2.lineTo(1.0, 0.6);
    c2.lineTo(0.48, 0.8);
    c2.lineTo(0, 0.25);
    c2.lineTo(-0.48, 0.8);
    c2.lineTo(-1.0, 0.6);
    c2.closePath();

    const c3 = new THREE.Shape();
    c3.moveTo(0, 0.65);
    c3.lineTo(0.85, 1.55);
    c3.lineTo(0.45, 1.75);
    c3.lineTo(0, 1.2);
    c3.lineTo(-0.45, 1.75);
    c3.lineTo(-0.85, 1.55);
    c3.closePath();

    this.arrowGeometry = new THREE.ShapeGeometry([head, c1, c2, c3]);
    this.arrowGeometry.rotateX(Math.PI / 2); // tip (y = -3.0) ends up at -z, i.e. pointing north
    this.arrowMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.92,
    });
  }

  /** Replacement for the single-ignition API; kept for call sites that draw one marker. */
  setIgnition(lat: number, lon: number, label?: string): void {
    this.setIgnitions([{ position: { lat, lon }, label }]);
  }

  setIgnitions(points: IgnitionPoint[]): void {
    this.ignitionMarkers.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      } else if (object instanceof THREE.Sprite) {
        object.material.map?.dispose();
        object.material.dispose();
      }
    });
    this.ignitionMarkers.clear();
    this.ignitionRings = [];
    for (const [i, point] of points.entries()) {
      const marker = new THREE.Group();
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(2.2, 3, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xff3b30, side: THREE.DoubleSide, depthTest: false, transparent: true }),
      );
      const dot = new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff3b30, depthTest: false }));
      ring.renderOrder = dot.renderOrder = 25;
      ring.userData.phase = i;
      marker.add(ring, dot);
      const label = point.label ?? `Foco ${i + 1}`;
      const sprite = textSprite(label, { size: 26 });
      sprite.position.set(0, 7, 0);
      marker.add(sprite);
      marker.position.set(...this.geo.world(point.position.lat, point.position.lon, 1));
      this.ignitionMarkers.add(marker);
      this.ignitionRings.push(ring);
    }
  }

  /** Pulsing rings, so several ignition markers stay visually distinct. */
  updatePulse(minute: number): void {
    for (const ring of this.ignitionRings) {
      const phase = Number(ring.userData.phase ?? 0);
      const scale = 1 + 0.12 * Math.sin(minute * 0.7 + phase * 1.7);
      ring.scale.set(scale, 1, scale);
    }
  }

  setPerimeter(collection: PerimeterCollection | null): void {
    if (this.perimeter) {
      this.group.remove(this.perimeter);
      this.perimeter.traverse((o) => (o as THREE.Line).geometry?.dispose());
      this.perimeter = null;
    }
    const features = collection?.features ?? [];
    // Com o ensemble, a coleção traz p10/p50/p90: o contorno principal é sempre o p50 (a mediana),
    // não o primeiro feature da coleção.
    const geometry = (features.find((f) => f.properties?.percentile === 'p50') ?? features[0])?.geometry;
    const rings = polygonRings(geometry);
    if (!rings.length) return;
    const group = new THREE.Group();
    const material = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 3, gapSize: 1.6, depthTest: false, transparent: true, opacity: 0.95 });
    for (const ring of rings) {
      const points = ring.map(([lon, lat]) => new THREE.Vector3(...this.geo.world(lat, lon, 2.2)));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material);
      line.computeLineDistances();
      line.renderOrder = 8;
      group.add(line);
    }
    this.perimeter = group;
    this.group.add(group);
  }

  setArrows(collection: SpreadVectorCollection | null): void {
    if (this.arrows) {
      this.group.remove(this.arrows);
      this.arrows.dispose();
      this.arrows = null;
    }
    const features = collection?.features ?? [];
    if (!features.length) return;
    const mesh = new THREE.InstancedMesh(this.arrowGeometry, this.arrowMaterial, features.length);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    features.forEach((feature, i) => {
      const point = pointCoordinates(feature.geometry);
      if (!point) return;
      const [lon, lat] = point;
      const props = feature.properties as { bearingDeg?: number; speedMmin?: number; intensityKwm?: number } | undefined;
      const bearingDeg = props?.bearingDeg ?? 0;
      const speedMmin = props?.speedMmin ?? 0;
      const k = 3.8 * Math.min(Math.max(speedMmin / 25, 0.75), 1.9);
      quaternion.setFromAxisAngle(up, (-bearingDeg * Math.PI) / 180);
      position.set(...this.geo.world(lat, lon, 4.5));
      scale.set(k, 1, k);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      const intensity = props?.intensityKwm;
      const color = intensity == null ? 0xff9933 : intensity <= 1700 ? 0xffd000 : intensity <= 4000 ? 0xff7700 : 0xff3333;
      mesh.setColorAt(i, new THREE.Color(color));
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.renderOrder = 15;
    this.arrows = mesh;
    this.group.add(mesh);
  }

  /** A line from ignition through each milestone, with a floating label, tracing the fire's progress so far. */
  setMilestones(list: Milestone[], ignition: [lat: number, lon: number]): void {
    this.milestoneSprites.forEach((s) => this.group.remove(s));
    this.milestoneSprites = [];
    if (this.track) {
      this.group.remove(this.track);
      this.track = null;
    }
    if (!list.length) return;
    const points = [{ lat: ignition[0], lon: ignition[1] }, ...list].map((m) => new THREE.Vector3(...this.geo.world(m.lat, m.lon, 4)));
    this.track = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xffc247, depthTest: false, transparent: true }));
    this.track.renderOrder = 9.5; // above the plan lines (6–9), below the vehicles (10), so a car is never hidden by it
    this.group.add(this.track);
    for (const m of list) {
      const sprite = textSprite(m.label, { size: 24, bg: 'rgba(30,20,10,.8)', color: '#ffd27a' });
      sprite.position.set(...this.geo.world(m.lat, m.lon, 7));
      this.group.add(sprite);
      this.milestoneSprites.push(sprite);
    }
  }
}
