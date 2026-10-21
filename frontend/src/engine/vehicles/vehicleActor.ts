import * as THREE from 'three';

import { StatusTag } from './statusTag';
import { buildVehicle, isAircraft, liveryOf, type ModelClass, type VehicleModel } from './vehicleModels';

/** Below this distance (world units) a vehicle is drawn at its real size; farther away it grows so it stays a readable shape on screen. */
const TRUE_SIZE_DISTANCE = 40;
const MAX_ENLARGE = 22;

/**
 * One vehicle on the map: its 3D model (real size close up, enlarged far away so it never shrinks to a speck), its status tag, emergency lights that flash while it
 * responds, a spinning rotor for helicopters, and a hover tooltip.
 */
export class VehicleActor {
  readonly group = new THREE.Group();
  readonly model: VehicleModel;
  readonly tag: StatusTag;
  readonly air: boolean;
  /** How much the model is enlarged right now (1 = real size). */
  enlarge = 1;
  heading = 0;
  private readonly inner = new THREE.Group();
  private tip = '';

  constructor(
    readonly cls: ModelClass,
    orgType: string,
    callsign: string,
    unit: number,
    tagAlwaysOnTop: boolean,
  ) {
    this.model = buildVehicle(cls, liveryOf(orgType, cls), callsign);
    this.inner.scale.setScalar(1 / unit); // model metres → scene units
    this.inner.add(this.model.root);
    this.group.add(this.inner);
    this.tag = new StatusTag(tagAlwaysOnTop);
    this.air = isAircraft(cls);
    if (this.model.bucket) this.model.bucket.visible = false;
  }

  /** Puts the vehicle at `pos` facing `heading` (radians, 0 = east, counter-clockwise seen from above), sized for the camera distance. */
  place(pos: THREE.Vector3, heading: number, camera: THREE.Camera, maxEnlarge = MAX_ENLARGE): void {
    this.heading = heading;
    const distance = camera.position.distanceTo(pos);
    this.enlarge = Math.min(maxEnlarge, Math.max(1, distance / TRUE_SIZE_DISTANCE));
    this.group.position.copy(pos);
    this.group.rotation.y = heading;
    this.group.scale.setScalar(this.enlarge);
  }

  /** World height (scene units) of the top of the model, where the tag sits. */
  topY(unit: number): number {
    return this.group.position.y + ((this.model.heightM + 1.2) * this.enlarge) / unit;
  }

  /** Emergency lights: alternate left/right while responding, dim otherwise. */
  flash(timeS: number, on: boolean): void {
    const phase = Math.floor(timeS * 6) % 2;
    this.model.lights.forEach((light, i) => {
      (light.material as THREE.MeshStandardMaterial).emissiveIntensity = on ? (i % 2 === phase ? 4 : 0.2) : 0.15;
    });
  }

  spin(timeS: number): void {
    if (this.model.rotor) this.model.rotor.rotation.y = timeS * 28;
  }

  showBucket(on: boolean): void {
    if (this.model.bucket) this.model.bucket.visible = on;
  }

  /** World position of the water outlet (hose/monitor, bucket, tank). */
  nozzleWorld(target = new THREE.Vector3()): THREE.Vector3 {
    this.group.updateMatrixWorld(true);
    return this.model.root.localToWorld(target.copy(this.model.nozzle));
  }

  setTip(text: string): void {
    if (text === this.tip) return;
    this.tip = text;
    this.group.traverse((o) => ((o.userData as { tip?: string }).tip = text));
  }

  dispose(): void {
    this.tag.dispose();
    for (const m of this.model.own) {
      (m as THREE.MeshBasicMaterial).map?.dispose();
      m.dispose();
    }
  }
}

/** Heading (radians, as `VehicleActor.place` wants) of the movement from a to b on the ground plane; null when they are the same point. */
export function headingBetween(a: THREE.Vector3, b: THREE.Vector3): number | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (dx * dx + dz * dz < 1e-8) return null;
  return Math.atan2(-dz, dx);
}
