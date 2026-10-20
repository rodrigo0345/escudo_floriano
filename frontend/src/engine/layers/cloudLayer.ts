import * as THREE from 'three';

const MAX_CLOUDS = 200;
// Area covered by clouds in FireTrace coordinates (1 unit = 10m; 420 units = 4.2 km across)
const BOUNDS_XZ = 420;
// Clouds float in the altitude band ~740m to 1080m.
// Cloud base starts at Y ~ 74, matching rainLayer's CLOUD_BASE_Y = 72.
const ALTITUDE_MIN = 74;  // 740m (cloud base)
const ALTITUDE_MAX = 108; // 1080m (cumulus tower summits)

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

    // Initial 3D volumetric distribution
    for (let i = 0; i < MAX_CLOUDS; i++) {
      this.cloudX[i] = (Math.random() - 0.5) * BOUNDS_XZ;
      // Staggered altitude giving clouds vertical depth and towering profile
      const altProgress = Math.pow(Math.random(), 1.4); // slightly denser at base
      this.cloudY[i] = ALTITUDE_MIN + altProgress * (ALTITUDE_MAX - ALTITUDE_MIN);
      this.cloudZ[i] = (Math.random() - 0.5) * BOUNDS_XZ;

      // Puffy volumetric dimensions: wide and tall (450m-900m wide, 350m-700m tall)
      const baseWidth = 48 + Math.random() * 45;
      const baseHeight = baseWidth * (0.75 + Math.random() * 0.25);
      this.scaleX[i] = baseWidth;
      this.scaleY[i] = baseHeight;
      this.driftMult[i] = 0.85 + Math.random() * 0.3; // Parallax differential
      this.rotZ[i] = (Math.random() - 0.5) * 0.3; // Organic variance
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
    camera?: THREE.Camera,
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
    const baseOpacity = 0.42 + (cloudCoverPct / 100) * 0.38;
    this.material.opacity = Math.min(0.82, baseOpacity);

    // Weather-dependent cloud tinting:
    if (precipMmH >= 4.0) {
      // Dark stormy cumulonimbus coloring during rain
      const stormDarkness = Math.min(1, (precipMmH - 4) / 8);
      this.material.color.setHex(0x404b5c).lerp(new THREE.Color(0x202630), stormDarkness);
    } else if (isNight) {
      this.material.color.setHex(0x283240);
    } else {
      this.material.color.setHex(0xf4f7fa);
    }

    // Wind drift direction
    const fromRad = (windFromDeg * Math.PI) / 180;
    const dirX = -Math.sin(fromRad);
    const dirZ = Math.cos(fromRad);

    // Wind speed: 1 unit/s = 36 km/h
    const baseSpeed = (Math.max(2, windKmh) / 36) * 1.2;

    const cx = cameraTarget ? cameraTarget.x : 0;
    const cz = cameraTarget ? cameraTarget.z : 0;
    const halfBound = BOUNDS_XZ / 2;

    // If camera is available, billboard puffs face the camera to ensure true 3D volumetric puffiness from all angles
    const camQuat = camera ? camera.quaternion : null;

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

      if (camQuat) {
        // Volumetric billboard: faces the viewer so it stays round, tall, and puffy from any vantage point
        this.dummy.quaternion.copy(camQuat);
        if (this.rotZ[i] !== 0) {
          this.dummy.rotateZ(this.rotZ[i]);
        }
      } else {
        // Natural oblique angle if no camera reference
        this.dummy.rotation.set(-Math.PI / 3, 0, this.rotZ[i]);
      }

      this.dummy.scale.set(this.scaleX[i], this.scaleY[i], 1);
      this.dummy.updateMatrix();

      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.texture.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
