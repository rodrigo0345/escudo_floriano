import * as THREE from 'three';

import { StatusTag } from './statusTag';
import { VehicleMarker } from './vehicleMarker';
import { buildVehicle, isAircraft, liveryOf, type ModelClass, type VehicleModel } from './vehicleModels';

/** Base scale factor so vehicles are comfortably visible on the regional wildfire terrain map. */
export const BASE_VEHICLE_SCALE = 2.4;

/**
 * One vehicle on the map: its 3D model at constant dimension (comfortably visible, never enlarged when zooming out or in),
 * an overhead identifier marker showing organization crest + vehicle type icon, its status tag, emergency lights that flash while it
 * responds, a spinning rotor for helicopters, and a hover tooltip.
 */
export class VehicleActor {
  readonly group = new THREE.Group();
  readonly model: VehicleModel;
  readonly marker: VehicleMarker;
  readonly tag: StatusTag;
  readonly air: boolean;
  /** Constant dimension: 1 = real size at any camera zoom. */
  enlarge = 1;
  heading = 0;
  /** Set by the map pointer while the cursor is over this vehicle (or its tag): the layers only show the status tag then. */
  hovered = false;
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
    // Scale vehicle to comfortable readable size at constant dimension
    this.inner.scale.setScalar(BASE_VEHICLE_SCALE / unit);
    this.inner.add(this.model.root);
    this.group.add(this.inner);

    // Overhead dual-identifier marker: Organization Logo/Color + Vector Vehicle Type Icon
    this.marker = new VehicleMarker(cls, orgType, callsign, this.model.heightM, unit, BASE_VEHICLE_SCALE);
    this.marker.setOwnerActor(this);
    this.marker.sprite.position.set(0, ((this.model.heightM * BASE_VEHICLE_SCALE) + 1.8) / unit, 0);
    this.group.add(this.marker.sprite);

    this.tag = new StatusTag(tagAlwaysOnTop);
    this.air = isAircraft(cls);
    // lets a raycast hit (any mesh of the model, marker, or the tag) find its vehicle
    this.group.userData.actor = this;
    this.tag.sprite.userData.actor = this;
    if (this.model.bucket) this.model.bucket.visible = false;
  }

  /** Puts the vehicle at `pos` facing `heading` (radians, 0 = east), keeping constant dimensions. */
  place(pos: THREE.Vector3, heading: number, _camera?: THREE.Camera, _maxEnlarge?: number): void {
    this.heading = heading;
    this.enlarge = 1;
    this.group.position.copy(pos);
    this.group.rotation.y = heading;
    this.group.scale.setScalar(1);
    this.marker.draw(this.hovered);
  }

  /** Constant dimensions: vehicle never gets bigger when zooming out or in. */
  enlargeAt(_pos?: THREE.Vector3, _camera?: THREE.Camera, _maxEnlarge?: number): number {
    return 1;
  }

  /** Ground footprint (scene units) of the model at `pos`: constant real size. */
  footprintAt(_pos: THREE.Vector3, _camera: THREE.Camera, unit: number, _maxEnlarge?: number): number {
    return (this.model.lengthM * BASE_VEHICLE_SCALE) / unit;
  }

  /** World height (scene units) of the top of the vehicle marker, where the status tag sits. */
  topY(unit: number): number {
    return this.group.position.y + ((this.model.heightM * BASE_VEHICLE_SCALE) + 6.0) / unit;
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
    this.marker.dispose();
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
