import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { Picker } from './picking';
import { ViewMode } from './viewMode';

export type FrameCallback = (timestampMs: number, azimuthRad: number) => void;

const SKY = 0x8fa4b8;

/**
 * Owns the WebGL renderer, camera, orbit controls, lights and the animation loop — nothing
 * about FireTrace's domain. React mounts it into a div and everything domain-specific (terrain,
 * layers, smoke) is added to `scene` by `World`. The renderer asks the OS for the
 * high-performance GPU (`powerPreference`) so hybrid-GPU laptops don't fall back to the iGPU.
 */
export class SceneEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 1, 14000);
  readonly controls: OrbitControls;
  readonly viewMode: ViewMode;
  readonly picker: Picker;
  private readonly frameCallbacks = new Set<FrameCallback>();
  private readonly resizeObserver: ResizeObserver;
  private rafId = 0;
  private disposed = false;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.prepend(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 1200, 7000);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x242424, 1.0));
    const sun = new THREE.DirectionalLight(0xffffff, 2.1);
    sun.position.set(-500, 600, 300);
    this.scene.add(sun);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.minDistance = 30;
    this.controls.maxDistance = 4200;
    this.controls.enableDamping = true;

    this.viewMode = new ViewMode(this.camera, this.controls, this.scene);
    this.picker = new Picker(this.camera);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** Subscribes to every animation frame; returns an unsubscribe function. */
  onFrame(callback: FrameCallback): () => void {
    this.frameCallbacks.add(callback);
    return () => this.frameCallbacks.delete(callback);
  }

  start(): void {
    const loop = (ts: number) => {
      if (this.disposed) return;
      this.rafId = requestAnimationFrame(loop);
      const azimuth = this.controls.getAzimuthalAngle();
      this.frameCallbacks.forEach((cb) => cb(ts, azimuth));
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /** Frames a world point from the south-southwest, the default viewing angle for an ignition. */
  focusOn(x: number, y: number, z: number): void {
    this.controls.target.set(x, y, z);
    this.camera.position.set(x - 120, y + 300, z + 400);
    this.controls.update();
  }

  /** Ground meters per CSS pixel at the controls target, in the scene's world units. */
  worldUnitsPerPixel(): number {
    const heightPx = this.renderer.domElement.height / this.renderer.getPixelRatio();
    const distance = this.camera.position.distanceTo(this.controls.target);
    return (2 * distance * Math.tan((this.camera.fov * Math.PI) / 360)) / heightPx;
  }

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.viewMode.dispose();
    this.controls.dispose();
    this.frameCallbacks.clear();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
