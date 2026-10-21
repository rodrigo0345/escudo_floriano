import * as THREE from 'three';

const MAX_CLOUDS = 240;
// Full territory coverage (1 unit = 10m; 2400 units = 24 km spanning the entire Guimarães concelho)
const TERRITORY_BOUNDS = 2400;

// High atmospheric altitude (~1450m to 2100m above baseline elevation),
// comfortably hovering high above all mountain peaks (which top out at ~550m).
// Rain strictly originates at the cloud base CLOUD_BASE_Y = 140 (1400m).
const ALTITUDE_MIN = 145; // 1450m
const ALTITUDE_MAX = 210; // 2100m
export const CLOUD_BASE_Y = 140;

export interface CloudSpatialSpot {
  x: number;
  z: number;
  radiusUnits: number; // in world units (e.g. 400 = 4 km)
}

function createCloudTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    const dummyCanvas = document.createElement('canvas');
    dummyCanvas.width = 16;
    dummyCanvas.height = 16;
    return new THREE.CanvasTexture(dummyCanvas);
  }

  ctx.clearRect(0, 0, 256, 256);

  // Soft organic multi-lobe cumulus puff with volumetric 3D shading
  const drawPuff = (cx: number, cy: number, r: number, alpha: number, lightBias = 0) => {
    const grad = ctx.createRadialGradient(cx, cy - r * 0.15, r * 0.1, cx, cy, r);
    // Upper crests catch skylight, bottom underside is slightly shaded
    const topLuma = Math.min(255, 245 + lightBias);
    const botLuma = Math.max(220, 235 - lightBias * 0.5);
    grad.addColorStop(0, `rgba(${topLuma}, ${topLuma}, 255, ${alpha})`);
    grad.addColorStop(0.45, `rgba(${botLuma}, ${botLuma}, 250, ${alpha * 0.82})`);
    grad.addColorStop(0.78, `rgba(225, 230, 242, ${alpha * 0.35})`);
    grad.addColorStop(1, 'rgba(215, 225, 240, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };

  // Base tier - flatter foundation
  drawPuff(128, 148, 86, 0.72, -10);
  drawPuff(84, 152, 64, 0.65, -12);
  drawPuff(172, 152, 66, 0.65, -12);

  // Mid cumulus body
  drawPuff(128, 120, 78, 0.85, 5);
  drawPuff(88, 124, 62, 0.78, 0);
  drawPuff(168, 124, 64, 0.78, 0);

  // Towering upper cumulus domes (bright, voluminous crowns)
  drawPuff(128, 92, 58, 0.92, 15);
  drawPuff(104, 102, 48, 0.85, 10);
  drawPuff(152, 102, 50, 0.85, 10);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 3D Volumetric Cloud Layer:
 * - Camera-aligned 3D billboard cumulus puffs with realistic vertical volume (not flat pancakes).
 * - Floats in the altitude band (740m to 1080m) strictly above the rain origin.
 * - Coverage scales with `cloudCoverPct` from the weather timeline.
 * - Drifts horizontally along wind direction (windFromDeg) at real speed.
 * - Dynamically darkens to charcoal cumulonimbus when raining/stormy.
 */
export class CloudLayer {
  readonly group = new THREE.Group();
  private readonly geometry: THREE.PlaneGeometry;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly mesh: THREE.InstancedMesh;

  private readonly cloudX: Float32Array;
  private readonly cloudY: Float32Array;
  private readonly cloudZ: Float32Array;
  private readonly scaleX: Float32Array;
  private readonly scaleY: Float32Array;
  private readonly driftMult: Float32Array;
  private readonly rotZ: Float32Array;

  private readonly dummy = new THREE.Object3D();
  private active = false;
  private enabled = true;
  private renderedCloudCover = 0;
  private renderedOpacity = 0;

  constructor() {
    this.texture = createCloudTexture();
    this.geometry = new THREE.PlaneGeometry(1, 1);

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, MAX_CLOUDS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 24;

    this.cloudX = new Float32Array(MAX_CLOUDS);
    this.cloudY = new Float32Array(MAX_CLOUDS);
    this.cloudZ = new Float32Array(MAX_CLOUDS);
    this.scaleX = new Float32Array(MAX_CLOUDS);
    this.scaleY = new Float32Array(MAX_CLOUDS);
    this.driftMult = new Float32Array(MAX_CLOUDS);
    this.rotZ = new Float32Array(MAX_CLOUDS);

    // Initial 3D volumetric distribution spanning the entire territory
    for (let i = 0; i < MAX_CLOUDS; i++) {
      this.cloudX[i] = (Math.random() - 0.5) * TERRITORY_BOUNDS;
      // Staggered altitude in high sky troposphere band (1450m to 2100m)
      const altProgress = Math.pow(Math.random(), 1.3);
      this.cloudY[i] = ALTITUDE_MIN + altProgress * (ALTITUDE_MAX - ALTITUDE_MIN);
      this.cloudZ[i] = (Math.random() - 0.5) * TERRITORY_BOUNDS;

      // Volumetric cumulus dimensions: wide and tall (1100m-2050m wide, 700m-1400m tall)
      const baseWidth = 100 + Math.random() * 90;
      const baseHeight = baseWidth * (0.65 + Math.random() * 0.25);
      this.scaleX[i] = baseWidth;
      this.scaleY[i] = baseHeight;
      this.driftMult[i] = 0.85 + Math.random() * 0.3; // Parallax differential
      this.rotZ[i] = (Math.random() - 0.5) * 0.3;     // Organic variance
    }

    this.group.add(this.mesh);
    this.group.visible = false;
  }

  setVisible(visible: boolean): void {
    this.enabled = visible;
    if (!visible) {
      this.group.visible = false;
      this.active = false;
    }
  }

  update(
    dt: number,
    cloudCoverPct: number,
    windKmh: number,
    windFromDeg: number,
    precipMmH = 0,
    isNight = false,
    spot?: CloudSpatialSpot | null,
    camera?: THREE.Camera,
  ): void {
    if (!this.enabled) {
      if (this.active) {
        this.group.visible = false;
        this.active = false;
        this.renderedCloudCover = 0;
        this.renderedOpacity = 0;
      }
      return;
    }

    // Continuous smooth interpolation between frames (avoids any pop visual on rapid scrubbing)
    const lerpRate = Math.min(1, dt * 10);
    this.renderedCloudCover = THREE.MathUtils.lerp(this.renderedCloudCover, cloudCoverPct, lerpRate);

    if (this.renderedCloudCover <= 0.5 && cloudCoverPct <= 0.5) {
      if (this.active) {
        this.group.visible = false;
        this.active = false;
      }
      return;
    }

    if (!this.active) {
      this.group.visible = true;
      this.active = true;
    }

    const effectiveCover = Math.max(0, this.renderedCloudCover);
    const activeCount = Math.max(1, Math.min(MAX_CLOUDS, Math.round((effectiveCover / 100) * MAX_CLOUDS)));
    this.mesh.count = activeCount;

    // Atmospheric soft opacity (0.0 to 0.65) smoothly scaling with effectiveCover
    const targetOpacity = effectiveCover > 1 ? 0.38 + (effectiveCover / 100) * 0.26 : 0;
    this.renderedOpacity = THREE.MathUtils.lerp(this.renderedOpacity, targetOpacity, lerpRate);
    this.material.opacity = Math.min(0.65, Math.max(0.01, this.renderedOpacity));

    // Weather-dependent cloud tinting:
    if (precipMmH >= 3.0) {
      // Atmospheric stormy slate-gray with soft light transmission
      const stormDarkness = Math.min(1, (precipMmH - 3) / 12);
      this.material.color.setHex(0x526072).lerp(new THREE.Color(0x384452), stormDarkness);
    } else if (isNight) {
      this.material.color.setHex(0x283240);
    } else {
      this.material.color.setHex(0xf5f8fb);
    }

    // Wind drift direction
    const fromRad = (windFromDeg * Math.PI) / 180;
    const dirX = -Math.sin(fromRad);
    const dirZ = Math.cos(fromRad);

    // Wind speed: 1 unit/s = 36 km/h
    const baseSpeed = (Math.max(2, windKmh) / 36) * 1.2;

    // World anchoring:
    // If a localized spot is provided, clouds cluster around that spot with radius.
    // Otherwise, clouds span across the entire territory (cx=0, cz=0).
    // NEVER follow cameraTarget so clouds remain stationary in world sky when camera moves!
    for (let i = 0; i < activeCount; i++) {
      if (spot) {
        // Distribute within localized radius around (spot.x, spot.z)
        const angle = (i / activeCount) * Math.PI * 2 + this.rotZ[i] * 2;
        const normDist = ((i * 1.618033) % 1); // golden ratio distribution
        const dist = Math.sqrt(normDist) * spot.radiusUnits;
        const puffX = spot.x + Math.cos(angle) * dist;
        const puffZ = spot.z + Math.sin(angle) * dist;
        this.dummy.position.set(puffX, this.cloudY[i], puffZ);
      } else {
        const speed = baseSpeed * this.driftMult[i];
        this.cloudX[i] += dirX * speed * dt;
        this.cloudZ[i] += dirZ * speed * dt;

        if (this.cloudX[i] > TERRITORY_BOUNDS / 2) this.cloudX[i] -= TERRITORY_BOUNDS;
        else if (this.cloudX[i] < -TERRITORY_BOUNDS / 2) this.cloudX[i] += TERRITORY_BOUNDS;

        if (this.cloudZ[i] > TERRITORY_BOUNDS / 2) this.cloudZ[i] -= TERRITORY_BOUNDS;
        else if (this.cloudZ[i] < -TERRITORY_BOUNDS / 2) this.cloudZ[i] += TERRITORY_BOUNDS;

        this.dummy.position.set(this.cloudX[i], this.cloudY[i], this.cloudZ[i]);
      }

      if (camera) {
        this.dummy.lookAt(camera.position);
        if (this.rotZ[i] !== 0) {
          this.dummy.rotateZ(this.rotZ[i]);
        }
      } else {
        this.dummy.rotation.set(-Math.PI / 3, 0, this.rotZ[i]);
      }

      // If localized spot, scale puff size appropriately
      const sizeMult = spot ? Math.min(1.0, Math.max(0.4, spot.radiusUnits / 320)) : 1.0;
      const fadeFactor = activeCount > 6 && i >= activeCount - 6 ? (activeCount - i) / 6 : 1.0;
      this.dummy.scale.set(this.scaleX[i] * sizeMult * fadeFactor, this.scaleY[i] * sizeMult * fadeFactor, 1);
      this.dummy.updateMatrix();

      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
  }

  get isMeshActive(): boolean {
    return this.active;
  }

  get instanceCount(): number {
    return this.mesh.count;
  }

  dispose(): void {
    this.geometry.dispose();
    this.texture.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
