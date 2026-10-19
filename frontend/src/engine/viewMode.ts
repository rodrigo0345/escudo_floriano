import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ViewModeName = '3d' | '2d';

const PAN_FRACTION = 0.12; // how far each key press pans, as a fraction of camera distance
const ZOOM_FRACTION = 0.2;

const PAN_KEYS: Record<string, [number, number]> = {
  arrowup: [0, -1],
  w: [0, -1],
  arrowdown: [0, 1],
  s: [0, 1],
  arrowleft: [-1, 0],
  a: [-1, 0],
  arrowright: [1, 0],
  d: [1, 0],
};

/**
 * Navigation mode: "3D" (free orbit) or "2D" (top-down, north up; drag pans and the wheel zooms,
 * easier to scan). Switching back to 3D restores the camera that was there before.
 */
export class ViewMode {
  mode: ViewModeName = '3d';
  private saved: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private readonly listeners = new Set<(mode: ViewModeName) => void>();
  private readonly defaults: {
    maxPolar: number;
    mouse: typeof OrbitControls.prototype.mouseButtons;
    touches: typeof OrbitControls.prototype.touches;
    fog: THREE.FogBase | null;
  };
  private readonly onKeyDown = (e: KeyboardEvent) => this.onKey(e);

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls,
    private readonly scene: THREE.Scene,
  ) {
    this.defaults = {
      maxPolar: controls.maxPolarAngle,
      mouse: { ...controls.mouseButtons },
      touches: { ...controls.touches },
      fog: scene.fog,
    };
    window.addEventListener('keydown', this.onKeyDown);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.listeners.clear();
  }

  onChange(fn: (mode: ViewModeName) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(mode: ViewModeName): void {
    if (mode === this.mode) return;
    const { camera, controls } = this;
    if (mode === '2d') {
      this.saved = { position: camera.position.clone(), target: controls.target.clone() };
      const distance = Math.max(camera.position.distanceTo(controls.target), 200);
      controls.target.y = 0;
      camera.position.set(controls.target.x, distance, controls.target.z);
      controls.minPolarAngle = controls.maxPolarAngle = 0;
      controls.enableRotate = false;
      controls.zoomToCursor = true;
      controls.screenSpacePanning = true;
      controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
      this.scene.fog = null; // top-down: no distance fog
    } else {
      controls.minPolarAngle = 0;
      controls.maxPolarAngle = this.defaults.maxPolar;
      controls.enableRotate = true;
      controls.zoomToCursor = false;
      controls.screenSpacePanning = false;
      controls.mouseButtons = this.defaults.mouse;
      controls.touches = this.defaults.touches;
      this.scene.fog = this.defaults.fog;
      if (this.saved) {
        camera.position.copy(this.saved.position);
        controls.target.copy(this.saved.target);
      }
    }
    this.mode = mode;
    controls.update();
    this.listeners.forEach((fn) => fn(mode));
  }

  /** Rotates the camera around its target until north is up, keeping tilt and distance. */
  resetNorth(): void {
    const { camera, controls } = this;
    const offset = camera.position.clone().sub(controls.target);
    const radius = Math.hypot(offset.x, offset.z);
    camera.position.set(controls.target.x, camera.position.y, controls.target.z + radius);
    controls.update();
  }

  /** Arrows/WASD pan, +/- zoom (both modes), so navigation doesn't depend on a mouse. */
  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if ((target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) || e.ctrlKey || e.metaKey || e.altKey) return;
    const { camera, controls } = this;
    const distance = camera.position.distanceTo(controls.target);
    const pan = PAN_KEYS[e.key.toLowerCase()];
    if (pan) {
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0).setY(0).normalize();
      const forward = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), right);
      const move = right.multiplyScalar(pan[0] * distance * PAN_FRACTION).add(forward.multiplyScalar(-pan[1] * distance * PAN_FRACTION));
      camera.position.add(move);
      controls.target.add(move);
      controls.update();
      e.preventDefault();
    } else if (['+', '=', '-', '_'].includes(e.key)) {
      const k = e.key === '+' || e.key === '=' ? 1 - ZOOM_FRACTION : 1 + ZOOM_FRACTION;
      const next = Math.min(Math.max(distance * k, controls.minDistance), controls.maxDistance);
      camera.position.copy(controls.target).add(camera.position.clone().sub(controls.target).setLength(next));
      controls.update();
      e.preventDefault();
    }
  }
}
