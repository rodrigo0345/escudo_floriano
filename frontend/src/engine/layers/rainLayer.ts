import * as THREE from 'three';

const DROP_COUNT = 1600;
const BOUNDS_XZ = 380; // 380m radius around camera target
const BOUNDS_Y = 220;  // 220m fall height

/**
 * 3D Rain Particle Layer:
 * - Streaks fall at realistic velocity with wind-induced horizontal drift.
 * - Dynamically visible when precipitationMmH > 0.
 * - Follows the camera focus area so rain particles are always centered around current view.
 */
export class RainLayer {
  readonly group = new THREE.Group();
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.LineBasicMaterial;
  private readonly lines: THREE.LineSegments;
  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private active = false;

  constructor() {
    this.positions = new Float32Array(DROP_COUNT * 2 * 3);
    this.velocities = new Float32Array(DROP_COUNT);

    for (let i = 0; i < DROP_COUNT; i++) {
      const x = (Math.random() - 0.5) * BOUNDS_XZ;
      const y = Math.random() * BOUNDS_Y;
      const z = (Math.random() - 0.5) * BOUNDS_XZ;
      const streakLen = 2.2 + Math.random() * 3.0;

      // Top of streak
      this.positions[i * 6] = x;
      this.positions[i * 6 + 1] = y + streakLen;
      this.positions[i * 6 + 2] = z;

      // Bottom of streak
      this.positions[i * 6 + 3] = x;
      this.positions[i * 6 + 4] = y;
      this.positions[i * 6 + 5] = z;

      this.velocities[i] = 130 + Math.random() * 60; // fall speed units/s
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));

    this.material = new THREE.LineBasicMaterial({
      color: 0x98b8dc,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });

    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.renderOrder = 22;
    this.group.add(this.lines);
    this.group.visible = false;
  }

  update(dt: number, precipRateMmH: number, windKmh: number, windFromDeg: number, cameraTarget?: THREE.Vector3): void {
    if (precipRateMmH <= 0.05) {
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

    // Rain intensity modulates opacity
    this.material.opacity = Math.min(0.72, 0.22 + (precipRateMmH / 12) * 0.45);

    // Wind drift vector: wind blows FROM windFromDeg, so drift is toward (from + 180)
    const windRad = ((windFromDeg + 180) * Math.PI) / 180;
    const windSpeedUnits = (windKmh / 3.6) * 0.35;
    const driftX = Math.sin(windRad) * windSpeedUnits * dt;
    const driftZ = Math.cos(windRad) * windSpeedUnits * dt;

    if (cameraTarget) {
      this.group.position.set(cameraTarget.x, cameraTarget.y, cameraTarget.z);
    }

    const pos = this.positions;
    for (let i = 0; i < DROP_COUNT; i++) {
      const dy = this.velocities[i] * dt;
      const idx = i * 6;

      pos[idx + 1] -= dy;
      pos[idx + 4] -= dy;
      pos[idx] += driftX;
      pos[idx + 3] += driftX;
      pos[idx + 2] += driftZ;
      pos[idx + 5] += driftZ;

      // Reset when below ground relative to camera focus
      if (pos[idx + 4] < -40) {
        const x = (Math.random() - 0.5) * BOUNDS_XZ;
        const y = BOUNDS_Y - Math.random() * 25;
        const z = (Math.random() - 0.5) * BOUNDS_XZ;
        const streakLen = 2.2 + Math.random() * 3.0;

        pos[idx] = x;
        pos[idx + 1] = y + streakLen;
        pos[idx + 2] = z;
        pos[idx + 3] = x;
        pos[idx + 4] = y;
        pos[idx + 5] = z;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
  }
}
