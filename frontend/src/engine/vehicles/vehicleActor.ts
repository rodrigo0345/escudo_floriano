import * as THREE from 'three';

import { StatusTag } from './statusTag';
import { VehicleMarker } from './vehicleMarker';
import { buildVehicle, isAircraft, liveryOf, type ModelClass, type VehicleModel } from './vehicleModels';

/** Map-only view (H): every vehicle keeps working on the map, without its overhead badge or status tag. */
export const actorDisplay = { bare: false };

/**
 * With the 3D city on: how far its ground is from our terrain at a point (world units), so ground vehicles stand on the tiles instead of sinking into them
 * (`PhotorealLayer.groundOffset`; null where it has no answer). Null while the city is off.
 */
export const groundSnap: { offsetAt: ((x: number, z: number) => number | null) | null } = { offsetAt: null };
/** A vehicle asks for the ground again after moving this far (world units, 1 = 10 m), or after `SNAP_REFRESH_MS` (tiles keep loading). */
const SNAP_MOVE = 0.4;
const SNAP_REFRESH_MS = 1500;
/** Share of the gap closed per frame: a new ground height eases in, so nothing jumps. */
const SNAP_EASE = 0.15;

/** Base scale factor so vehicles are comfortably visible on the regional wildfire terrain map. */
export const BASE_VEHICLE_SCALE = 1.4;

/**
 * Draw order of a vehicle's model: above the ground annotations (roads, closures, fire lines and fuel breaks, 5–9) so a car is never
 * buried under a translucent line, but below the smoke/rain/clouds (15+), which should still pass in front of it. The model stays on the
 * terrain and is depth-tested against it, so raising the draw order only wins over the lines — it never makes a vehicle float.
 */
const VEHICLE_RENDER_ORDER = 10;

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
  /** Lift onto the 3D city's ground: the eased value drawn, the value asked for, and where/when it was last asked. */
  private snapY = 0;
  private snapTarget = 0;
  private readonly snapAt = new THREE.Vector3(Infinity, 0, Infinity);
  private snapTime = 0;

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
    this.raiseAboveAnnotations();

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

  /**
   * Moves the model into the transparent queue, after the ground annotations, without changing its position or size.
   * `transparent` only changes the render queue here (every part is fully opaque); `depthWrite` keeps the parts occluding each
   * other and the terrain occluding the whole vehicle, which is what stops it from looking like it floats over a hill or a line.
   */
  private raiseAboveAnnotations(): void {
    this.model.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      // the livery markings are already translucent and do not write depth: they must draw just after the body they sit on,
      // or the body can cover them (both are in the transparent queue now, so depth sorting alone is not enough)
      const overBody = materials.some((material) => material.depthWrite === false);
      mesh.renderOrder = VEHICLE_RENDER_ORDER + (overBody ? 0.5 : 0);
      for (const material of materials) {
        if (material.transparent) continue; // the side markings are already translucent (and do not write depth)
        material.transparent = true;
        material.depthWrite = true;
        material.needsUpdate = true; // shared paints: only the first vehicle flips them
      }
    });
  }

  /** Puts the vehicle at `pos` facing `heading` (radians, 0 = east), keeping constant dimensions. */
  place(pos: THREE.Vector3, heading: number, _camera?: THREE.Camera, _maxEnlarge?: number): void {
    this.heading = heading;
    this.enlarge = 1;
    this.group.position.copy(pos);
    if (!this.air) this.group.position.y += this.groundLift(pos);
    this.group.rotation.y = heading;
    this.group.scale.setScalar(1);
    this.marker.sprite.visible = !actorDisplay.bare;
    if (actorDisplay.bare) this.tag.sprite.visible = false;
    else this.marker.draw(this.hovered);
  }

  /** How far to raise (or lower) a ground vehicle at `pos` to stand on the 3D city's ground; eases back to 0 when the city is off. */
  private groundLift(pos: THREE.Vector3): number {
    const offsetAt = groundSnap.offsetAt;
    if (!offsetAt) {
      this.snapTarget = 0;
      this.snapAt.set(Infinity, 0, Infinity);
    } else {
      const now = performance.now();
      const dx = pos.x - this.snapAt.x;
      const dz = pos.z - this.snapAt.z;
      if (dx * dx + dz * dz > SNAP_MOVE * SNAP_MOVE || now - this.snapTime > SNAP_REFRESH_MS) {
        this.snapAt.copy(pos);
        this.snapTime = now + Math.random() * 300; // spread the refreshes of a whole fleet over several frames
        // up only: the overlay pass depth-tests vehicles against our terrain, so one lowered below it would vanish (a few metres of float is the lesser evil)
        this.snapTarget = Math.max(0, offsetAt(pos.x, pos.z) ?? 0);
      }
    }
    this.snapY += (this.snapTarget - this.snapY) * SNAP_EASE;
    if (Math.abs(this.snapY) < 1e-3 && this.snapTarget === 0) this.snapY = 0;
    return this.snapY;
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
