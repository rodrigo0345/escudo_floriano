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

  private readonly sunColorScratch = new THREE.Color();
  private readonly skyColorScratch = new THREE.Color();
  private readonly hemiSkyScratch = new THREE.Color();
  private readonly hemiGroundScratch = new THREE.Color();
  private readonly tmpColorA = new THREE.Color();
  private readonly tmpColorB = new THREE.Color();
  private lastAtmosphereKey = '';

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
   * according to real solar elevation at the current terrain coordinates (defaulting to Guimarães: 41.44°N, 8.29°W),
   * cloud cover, and smoke/weather ground visibility.
   */
  updateAtmosphere(
    timestampMs: number,
    cloudCoverPct = 0,
    latDeg = 41.442,
    lonDeg = -8.295,
    visibilityM?: number | null,
  ): void {
    const LAT_RAD = (latDeg * Math.PI) / 180;
    const LON_DEG = lonDeg;
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
    const thetaRad = Math.acos(Math.max(-1, Math.min(1, cosTheta)));
    // In northern hemisphere: at noon, theta = 0 (sun is South, +z).
    // Morning (hourAngleRad < 0): sun is in the East (+x).
    // Afternoon (hourAngleRad > 0): sun is in the West (-x).
    const sxSign = hourAngleRad > 0 ? -1 : 1;

    const cosElev = Math.cos(elevationRad);
    const sunDist = 1400;

    const sx = sxSign * Math.sin(thetaRad) * cosElev * sunDist;
    const sy = Math.max(Math.sin(elevationRad), 0.08) * sunDist;
    const sz = Math.cos(thetaRad) * cosElev * sunDist;

    if (elevationDeg > 0) {
      this.sunLight.position.set(sx, sy, sz);
    } else {
      const mx = -sx * 0.6;
      const my = Math.max(Math.sin(-elevationRad * 0.8), 0.25) * sunDist;
      const mz = -sz * 0.6;
      this.sunLight.position.set(mx, my, mz);
    }

    const cloudFactor = Math.min(1, Math.max(0, cloudCoverPct / 100));

    // Cache to prevent redundant color operations and DOM updates
    const visKey = visibilityM != null ? Math.round(visibilityM / 200) : 'none';
    const cacheKey = `${Math.floor(timestampMs / 10000)}_${Math.round(cloudCoverPct)}_${Math.round(latDeg * 100)}_${Math.round(lonDeg * 100)}_${visKey}`;
    if (cacheKey === this.lastAtmosphereKey) return;
    this.lastAtmosphereKey = cacheKey;

    if (elevationDeg > 18) {
      const t = Math.min(1, (elevationDeg - 18) / 30);
      this.sunColorScratch.setHex(0xfff8ee);
      this.skyColorScratch.setHex(0x8fa4b8).lerp(this.tmpColorA.setHex(0x6a7786), cloudFactor * 0.7);
      this.hemiSkyScratch.setHex(0xeaf0ff);
      this.hemiGroundScratch.setHex(0x35352c);

      this.sunLight.color.copy(this.sunColorScratch);
      this.sunLight.intensity = (2.1 - cloudFactor * 0.7) * (0.8 + 0.2 * t);
      this.hemiLight.color.copy(this.hemiSkyScratch);
      this.hemiLight.groundColor.copy(this.hemiGroundScratch);
      this.hemiLight.intensity = 0.95 + cloudFactor * 0.3;

      (this.scene.background as THREE.Color).copy(this.skyColorScratch);
      if (this.scene.fog instanceof THREE.Fog) {
        this.scene.fog.color.copy(this.skyColorScratch);
        this.scene.fog.near = 1500 - cloudFactor * 500;
        this.scene.fog.far = 7200 - cloudFactor * 2200;
      }
    } else if (elevationDeg > 0) {
      const t = elevationDeg / 18;
      this.sunColorScratch.setHex(0xff7722).lerp(this.tmpColorA.setHex(0xffe099), t);
      this.skyColorScratch.setHex(0x7a5250).lerp(this.tmpColorA.setHex(0x8fa4b8), t).lerp(this.tmpColorB.setHex(0x5a5560), cloudFactor * 0.6);
      this.hemiSkyScratch.setHex(0xffaa77).lerp(this.tmpColorA.setHex(0xeaf0ff), t);
      this.hemiGroundScratch.setHex(0x281812).lerp(this.tmpColorA.setHex(0x35352c), t);

      this.sunLight.color.copy(this.sunColorScratch);
      this.sunLight.intensity = (1.4 - cloudFactor * 0.5) * (0.6 + 0.4 * t);
      this.hemiLight.color.copy(this.hemiSkyScratch);
      this.hemiLight.groundColor.copy(this.hemiGroundScratch);
      this.hemiLight.intensity = 0.75;

      (this.scene.background as THREE.Color).copy(this.skyColorScratch);
      if (this.scene.fog instanceof THREE.Fog) {
        this.scene.fog.color.copy(this.skyColorScratch);
        this.scene.fog.near = 1200;
        this.scene.fog.far = 6000;
      }
    } else if (elevationDeg > -10) {
      const t = (elevationDeg + 10) / 10;
      this.sunColorScratch.setHex(0x98b8e0).lerp(this.tmpColorA.setHex(0xcc5522), t);
      this.skyColorScratch.setHex(0x0f1524).lerp(this.tmpColorA.setHex(0x604044), t);
      this.hemiSkyScratch.setHex(0x384a68).lerp(this.tmpColorA.setHex(0x884844), t);
      this.hemiGroundScratch.setHex(0x1e2a3c).lerp(this.tmpColorA.setHex(0x281812), t);

      this.sunLight.color.copy(this.sunColorScratch);
      this.sunLight.intensity = 0.85 - 0.01 * t; // Smooth transition: 0.84 at sunset, 0.85 at night
      this.hemiLight.color.copy(this.hemiSkyScratch);
      this.hemiLight.groundColor.copy(this.hemiGroundScratch);
      this.hemiLight.intensity = 0.72 + 0.03 * t; // 0.75 at sunset, 0.72 at night

      (this.scene.background as THREE.Color).copy(this.skyColorScratch);
      if (this.scene.fog instanceof THREE.Fog) {
        this.scene.fog.color.copy(this.skyColorScratch);
        this.scene.fog.near = 1200 + 200 * (1 - t);
        this.scene.fog.far = 6000 + 1200 * (1 - t);
      }
    } else {
      // Tactical moonlit night: clear terrain relief and orthophoto visibility without pitch-black gloom
      this.sunColorScratch.setHex(0x98b8e0);
      this.skyColorScratch.setHex(0x0f1524);
      this.hemiSkyScratch.setHex(0x384a68);
      this.hemiGroundScratch.setHex(0x1e2a3c);

      this.sunLight.color.copy(this.sunColorScratch);
      this.sunLight.intensity = 0.85;
      this.hemiLight.color.copy(this.hemiSkyScratch);
      this.hemiLight.groundColor.copy(this.hemiGroundScratch);
      this.hemiLight.intensity = 0.72;

      (this.scene.background as THREE.Color).copy(this.skyColorScratch);
      if (this.scene.fog instanceof THREE.Fog) {
        this.scene.fog.color.copy(this.skyColorScratch);
        this.scene.fog.near = 1400;
        this.scene.fog.far = 7200;
      }
    }

    // Atmospheric smoke haze tint on distant horizon (never blinding the tactical camera or occluding terrain)
    if (this.scene.fog instanceof THREE.Fog && visibilityM != null && visibilityM > 0 && visibilityM < 3000) {
      const smokeFactor = Math.min(0.3, (3000 - visibilityM) / 3000);
      this.skyColorScratch.lerp(this.tmpColorB.setHex(0x5a5048), smokeFactor);
      this.scene.fog.color.copy(this.skyColorScratch);
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
