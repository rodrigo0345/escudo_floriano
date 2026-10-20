import * as THREE from 'three';

const MAX_CLOUDS = 150;
// Area covered by clouds in FireTrace coordinates (1 unit = 10m; 360 units = 3.6 km across)
const BOUNDS_XZ = 360;
const ALTITUDE_MIN = 85;  // 850m
const ALTITUDE_MAX = 120; // 1200m

function createCloudTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    const dummyCanvas = document.createElement('canvas');
    dummyCanvas.width = 16;
    dummyCanvas.height = 16;
    return new THREE.CanvasTexture(dummyCanvas);
  }

  // Soft organic multi-lobe cloud puff
  ctx.clearRect(0, 0, 128, 128);

  const drawPuff = (cx: number, cy: number, r: number, alpha: number) => {
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    grad.addColorStop(0.45, `rgba(248, 250, 255, ${alpha * 0.75})`);
    grad.addColorStop(0.8, `rgba(240, 244, 252, ${alpha * 0.25})`);
    grad.addColorStop(1, 'rgba(235, 240, 250, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };

  drawPuff(64, 64, 52, 0.78);
  drawPuff(48, 60, 40, 0.65);
  drawPuff(80, 60, 42, 0.65);
  drawPuff(64, 48, 38, 0.6);
  drawPuff(64, 76, 38, 0.55);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 3D Cloud Layer (Epic E4):
 * - Instanced billboard cloud puffs floating at altitude (~850m to 1200m).
 * - Coverage scales directly with `cloudCoverPct` from the weather timeline.
 * - Drifts horizontally along wind direction (windFromDeg) at real speed.
 * - Modulates color between silver-white (day), moonlight indigo-grey (night),
 *   and dark cumulonimbus charcoal (during storms / heavy rain).
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
  private readonly scaleZ: Float32Array;
  private readonly driftMult: Float32Array;
  private readonly tiltAngle: Float32Array;

  private readonly dummy = new THREE.Object3D();
  private active = false;
  private enabled = true;

  constructor() {
    this.texture = createCloudTexture();
    this.geometry = new THREE.PlaneGeometry(1, 1);

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0.55,
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
    this.scaleZ = new Float32Array(MAX_CLOUDS);
    this.driftMult = new Float32Array(MAX_CLOUDS);
    this.tiltAngle = new Float32Array(MAX_CLOUDS);

    // Initial pseudo-random distribution over the bounding area
    for (let i = 0; i < MAX_CLOUDS; i++) {
      this.cloudX[i] = (Math.random() - 0.5) * BOUNDS_XZ;
      this.cloudY[i] = ALTITUDE_MIN + Math.random() * (ALTITUDE_MAX - ALTITUDE_MIN);
      this.cloudZ[i] = (Math.random() - 0.5) * BOUNDS_XZ;
      // Cloud puff size: 50 to 105 units across (500m to 1050m)
      const baseScale = 50 + Math.random() * 55;
      this.scaleX[i] = baseScale * (0.85 + Math.random() * 0.3);
      this.scaleZ[i] = baseScale * (0.85 + Math.random() * 0.3);
      this.driftMult[i] = 0.85 + Math.random() * 0.3; // Gentle parallax differential
      this.tiltAngle[i] = (Math.random() - 0.5) * 0.25; // Slight natural pitch
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
    cameraTarget?: THREE.Vector3,
  ): void {
    if (!this.enabled || cloudCoverPct <= 1) {
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

    // Instance count proportional to cloud cover
    const activeCount = Math.max(1, Math.min(MAX_CLOUDS, Math.round((cloudCoverPct / 100) * MAX_CLOUDS)));
    this.mesh.count = activeCount;

    // Modulate opacity according to cloud cover
    const baseOpacity = 0.35 + (cloudCoverPct / 100) * 0.42;
    this.material.opacity = Math.min(0.78, baseOpacity);

    // Weather-dependent cloud tinting:
    if (precipMmH >= 6.0) {
      // Dark stormy cumulonimbus coloring
      const stormDarkness = Math.min(1, (precipMmH - 6) / 8);
      this.material.color.setHex(0x3a4454).lerp(new THREE.Color(0x222933), stormDarkness);
    } else if (isNight) {
      this.material.color.setHex(0x262f3d);
    } else {
      this.material.color.setHex(0xf4f7fa);
    }

    // Wind direction: wind blows FROM windFromDeg towards (windFromDeg + 180) % 360
    // North = -z, East = +x
    const fromRad = (windFromDeg * Math.PI) / 180;
    const dirX = -Math.sin(fromRad);
    const dirZ = Math.cos(fromRad);

    // Wind speed: 1 world unit = 10m. 36 km/h = 10 m/s = 1.0 unit/s.
    // Upper level clouds drift with 1.25x scaling
    const baseSpeed = (Math.max(2, windKmh) / 36) * 1.25;

    const cx = cameraTarget ? cameraTarget.x : 0;
    const cz = cameraTarget ? cameraTarget.z : 0;
    const halfBound = BOUNDS_XZ / 2;

    for (let i = 0; i < activeCount; i++) {
      const speed = baseSpeed * this.driftMult[i];
      this.cloudX[i] += dirX * speed * dt;
      this.cloudZ[i] += dirZ * speed * dt;

      // Wrap around camera target bounding box
      if (this.cloudX[i] - cx > halfBound) {
        this.cloudX[i] -= BOUNDS_XZ;
      } else if (this.cloudX[i] - cx < -halfBound) {
        this.cloudX[i] += BOUNDS_XZ;
      }

      if (this.cloudZ[i] - cz > halfBound) {
        this.cloudZ[i] -= BOUNDS_XZ;
      } else if (this.cloudZ[i] - cz < -halfBound) {
        this.cloudZ[i] += BOUNDS_XZ;
      }

      this.dummy.position.set(this.cloudX[i], this.cloudY[i], this.cloudZ[i]);
      // Horizontal disk with slight organic pitch
      this.dummy.rotation.set(-Math.PI / 2 + this.tiltAngle[i], 0, 0);
      this.dummy.scale.set(this.scaleX[i], this.scaleZ[i], 1);
      this.dummy.updateMatrix();

      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.texture.dispose();
    this.material.dispose();
  }
}
