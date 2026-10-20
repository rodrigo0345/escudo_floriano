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
  readonly hemiLight: THREE.HemisphereLight;
  readonly sunLight: THREE.DirectionalLight;
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
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x242424, 1.0);
    this.scene.add(this.hemiLight);
    this.sunLight = new THREE.DirectionalLight(0xffffff, 2.1);
    this.sunLight.position.set(-500, 600, 300);
    this.scene.add(this.sunLight);

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

  /**
   * Updates sun angle, directional light, ambient sky/ground light, sky color, and fog
   * according to real solar elevation in Guimarães (41.44°N, 8.29°W) and cloud cover.
   */
  updateAtmosphere(timestampMs: number, cloudCoverPct = 0): void {
    const LAT_RAD = (41.442 * Math.PI) / 180;
    const LON_DEG = -8.295;
    const date = new Date(timestampMs);

    const startOfYear = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const dayOfYear = Math.floor((timestampMs - +startOfYear) / 86400000) + 1;

    const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    const solarTimeHours = (utcHours + LON_DEG / 15 + 24) % 24;

    const declinationRad = ((23.45 * Math.sin(((360 / 365) * (dayOfYear - 81) * Math.PI) / 180)) * Math.PI) / 180;
    const hourAngleRad = ((solarTimeHours - 12) * 15 * Math.PI) / 180;

    const sinAlpha = Math.sin(LAT_RAD) * Math.sin(declinationRad) + Math.cos(LAT_RAD) * Math.cos(declinationRad) * Math.cos(hourAngleRad);
    const elevationRad = Math.asin(Math.max(-1, Math.min(1, sinAlpha)));
    const elevationDeg = (elevationRad * 180) / Math.PI;

    const cosTheta = (Math.sin(declinationRad) - Math.sin(LAT_RAD) * sinAlpha) / (Math.cos(LAT_RAD) * Math.cos(elevationRad) || 0.0001);
    const azimuthRad = Math.acos(Math.max(-1, Math.min(1, cosTheta))) * (hourAngleRad > 0 ? 1 : -1);

    const cosElev = Math.cos(elevationRad);
    const sunDist = 1400;

    if (elevationDeg > 0) {
      const sx = Math.sin(azimuthRad) * cosElev * sunDist;
      const sy = Math.max(Math.sin(elevationRad), 0.08) * sunDist;
      const sz = -Math.cos(azimuthRad) * cosElev * sunDist;
      this.sunLight.position.set(sx, sy, sz);
    } else {
      const mx = -Math.sin(azimuthRad) * 0.6 * sunDist;
      const my = Math.max(Math.sin(-elevationRad * 0.8), 0.25) * sunDist;
      const mz = Math.cos(azimuthRad) * 0.6 * sunDist;
      this.sunLight.position.set(mx, my, mz);
    }

    const cloudFactor = Math.min(1, Math.max(0, cloudCoverPct / 100));

    if (elevationDeg > 18) {
      const t = Math.min(1, (elevationDeg - 18) / 30);
      const sunColor = new THREE.Color(0xfff8ee);
      const skyColor = new THREE.Color(0x8fa4b8).lerp(new THREE.Color(0x6a7786), cloudFactor * 0.7);
      const hemiSky = new THREE.Color(0xeaf0ff);
      const hemiGround = new THREE.Color(0x35352c);

      this.sunLight.color.copy(sunColor);
      this.sunLight.intensity = (2.1 - cloudFactor * 0.7) * (0.8 + 0.2 * t);
      this.hemiLight.color.copy(hemiSky);
      this.hemiLight.groundColor.copy(hemiGround);
      this.hemiLight.intensity = 0.95 + cloudFactor * 0.3;

      (this.scene.background as THREE.Color).copy(skyColor);
      if (this.scene.fog instanceof THREE.Fog) {
        this.scene.fog.color.copy(skyColor);
        this.scene.fog.near = 1500 - cloudFactor * 500;
        this.scene.fog.far = 7200 - cloudFactor * 2200;
      }
    } else if (elevationDeg > 0) {
      const t = elevationDeg / 18;
      const sunColor = new THREE.Color(0xff7722).lerp(new THREE.Color(0xffe099), t);
      const skyColor = new THREE.Color(0x7a5250).lerp(new THREE.Color(0x8fa4b8), t).lerp(new THREE.Color(0x5a5560), cloudFactor * 0.6);
      const hemiSky = new THREE.Color(0xffaa77).lerp(new THREE.Color(0xeaf0ff), t);
      const hemiGround = new THREE.Color(0x281812).lerp(new THREE.Color(0x35352c), t);

      this.sunLight.color.copy(sunColor);
      this.sunLight.intensity = (1.4 - cloudFactor * 0.5) * (0.6 + 0.4 * t);
      this.hemiLight.color.copy(hemiSky);
      this.hemiLight.groundColor.copy(hemiGround);
      this.hemiLight.intensity = 0.75;

      (this.scene.background as THREE.Color).copy(skyColor);
      if (this.scene.fog instanceof THREE.Fog) {
        this.scene.fog.color.copy(skyColor);
        this.scene.fog.near = 1200;
        this.scene.fog.far = 6000;
      }
    } else if (elevationDeg > -10) {
      const t = (elevationDeg + 10) / 10;
      const sunColor = new THREE.Color(0x384260).lerp(new THREE.Color(0xcc5522), t);
      const skyColor = new THREE.Color(0x182030).lerp(new THREE.Color(0x604044), t);
      const hemiSky = new THREE.Color(0x1c2438).lerp(new THREE.Color(0x884844), t);
      const hemiGround = new THREE.Color(0x0e121a);

      this.sunLight.color.copy(sunColor);
      this.sunLight.intensity = 0.45 * t + 0.2;
      this.hemiLight.color.copy(hemiSky);
      this.hemiLight.groundColor.copy(hemiGround);
      this.hemiLight.intensity = 0.45 * t + 0.3;

      (this.scene.background as THREE.Color).copy(skyColor);
      if (this.scene.fog instanceof THREE.Fog) {
        this.scene.fog.color.copy(skyColor);
        this.scene.fog.near = 900;
        this.scene.fog.far = 4800;
      }
    } else {
      const moonColor = new THREE.Color(0x5c759e);
      const nightSky = new THREE.Color(0x0a0f18);
      const nightGround = new THREE.Color(0x05080e);

      this.sunLight.color.copy(moonColor);
      this.sunLight.intensity = 0.28;
      this.hemiLight.color.copy(new THREE.Color(0x151c2a));
      this.hemiLight.groundColor.copy(nightGround);
      this.hemiLight.intensity = 0.25;

      (this.scene.background as THREE.Color).copy(nightSky);
      if (this.scene.fog instanceof THREE.Fog) {
        this.scene.fog.color.copy(nightSky);
        this.scene.fog.near = 700;
        this.scene.fog.far = 3800;
      }
    }
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
