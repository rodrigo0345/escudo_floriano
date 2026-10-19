import * as THREE from 'three';

/** An object that can carry a static tooltip (`tip`) or compute one per-instance (`tipFor`, for `Points`/`InstancedMesh`). */
export type Pickable = THREE.Object3D & {
  userData: { tip?: string; tipFor?: (index: number) => string };
};

/** Wraps `THREE.Raycaster` with the normalized-device-coordinate math every pointer handler needs. */
export class Picker {
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  constructor(private readonly camera: THREE.Camera) {}

  /** Sets the point-picking threshold (world units) from the camera distance, so hover targets stay a roughly constant pixel size. */
  setPointThreshold(worldUnits: number): void {
    this.raycaster.params.Points = { threshold: worldUnits };
  }

  pick(clientX: number, clientY: number, bounds: DOMRect, objects: THREE.Object3D[]): THREE.Intersection | undefined {
    this.ndc.set(((clientX - bounds.left) / bounds.width) * 2 - 1, -((clientY - bounds.top) / bounds.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster.intersectObjects(objects, false)[0];
  }

  /** The tooltip text for a pick result, using `tipFor(index)` when present (instanced/point layers) or the static `tip`. */
  static tooltipFor(hit: THREE.Intersection | undefined): string | null {
    if (!hit) return null;
    const data = hit.object.userData as Pickable['userData'];
    if (data.tipFor && hit.index != null) return data.tipFor(hit.index);
    return data.tip ?? null;
  }
}
