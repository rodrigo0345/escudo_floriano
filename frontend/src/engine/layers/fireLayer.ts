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
    const shape = new THREE.Shape();
    shape.moveTo(0, -2.4);
    shape.lineTo(0.75, -0.7);
    shape.lineTo(0.22, -0.55);
    shape.lineTo(0.22, 1.8);
    shape.lineTo(-0.22, 1.8);
    shape.lineTo(-0.22, -0.55);
    shape.lineTo(-0.75, -0.7);
    shape.closePath();
    this.arrowGeometry = new THREE.ShapeGeometry(shape);
    this.arrowGeometry.rotateX(Math.PI / 2); // tip (y = -2.4) ends up at -z, i.e. pointing north
    this.arrowMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthTest: false,
      transparent: true,
      opacity: 0.68,
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
    const geometry = collection?.features?.[0]?.geometry;
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
      const k = 2.4 * Math.min(Math.max(speedMmin / 30, 0.65), 1.6);
      quaternion.setFromAxisAngle(up, (-bearingDeg * Math.PI) / 180);
      position.set(...this.geo.world(lat, lon, 3.5));
      scale.set(k, 1, k);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      const intensity = props?.intensityKwm;
      const color = intensity == null ? 0xffa040 : intensity <= 1700 ? 0xf5c542 : intensity <= 4000 ? 0xff8a1f : 0xe5484d;
      mesh.setColorAt(i, new THREE.Color(color));
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.renderOrder = 9;
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
    this.track.renderOrder = 10;
    this.group.add(this.track);
    for (const m of list) {
      const sprite = textSprite(m.label, { size: 24, bg: 'rgba(30,20,10,.8)', color: '#ffd27a' });
      sprite.position.set(...this.geo.world(m.lat, m.lon, 7));
      this.group.add(sprite);
      this.milestoneSprites.push(sprite);
    }
  }
}
