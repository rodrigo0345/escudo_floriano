import * as THREE from 'three';

const DROP_COUNT = 1600;
// In FireTrace coordinates, 1 world unit = 10 meters.
// BOUNDS_XZ = 180 units => 1800 m across the camera focal area.
// CLOUD_BASE_Y = 72 units => 720m altitude, exactly matching the underside of the cloud deck.
// Rain strictly originates at or below CLOUD_BASE_Y and falls towards ground level (Y ~ 0).
const BOUNDS_XZ = 180;
const CLOUD_BASE_Y = 72;
const GROUND_Y = -6;
const RAIN_FALL_RANGE = CLOUD_BASE_Y - GROUND_Y;

/**
 * 3D Rain Particle Layer:
 * - Streaks fall and slant realistically along wind direction (north = -z, east = +x).
 * - 1 world unit = 10 meters.
 * - Dynamically visible and modulated in opacity when precipitationMmH > 0.
 * - Follows the camera focus area so rain particles remain centered in the viewport.
 */
export class RainLayer {
  readonly group = new THREE.Group();
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.LineBasicMaterial;
  private readonly lines: THREE.LineSegments;
  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly lengths: Float32Array;
  private active = false;

  constructor() {
    this.positions = new Float32Array(DROP_COUNT * 2 * 3);
    this.velocities = new Float32Array(DROP_COUNT);
    this.lengths = new Float32Array(DROP_COUNT);

    for (let i = 0; i < DROP_COUNT; i++) {
      const x = (Math.random() - 0.5) * BOUNDS_XZ;
      const y = GROUND_Y + Math.random() * RAIN_FALL_RANGE;
      const z = (Math.random() - 0.5) * BOUNDS_XZ;
      const streakLen = 1.6 + Math.random() * 1.8; // 16m to 34m world streak length
      this.lengths[i] = streakLen;

      // Top of streak (initial vertical)
      this.positions[i * 6] = x;
      this.positions[i * 6 + 1] = Math.min(CLOUD_BASE_Y, y + streakLen);
      this.positions[i * 6 + 2] = z;

      // Bottom of streak
      this.positions[i * 6 + 3] = x;
      this.positions[i * 6 + 4] = y;
      this.positions[i * 6 + 5] = z;

      // Fall speed: ~18 to 26 units/s (180 to 260 m/s visual fall rate for crisp streaks)
      this.velocities[i] = 18 + Math.random() * 8;
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));

    this.material = new THREE.LineBasicMaterial({
      color: 0x9bc2e6,
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

    // Rain intensity modulates opacity (0.28 to 0.75)
    this.material.opacity = Math.min(0.75, 0.28 + (precipRateMmH / 10) * 0.42);

    // Wind direction: wind blows FROM windFromDeg towards (windFromDeg + 180).
    // In FireTrace: North = -z, East = +x.
    // Direction vector of air movement:
    const fromRad = (windFromDeg * Math.PI) / 180;
    const dirX = -Math.sin(fromRad); // blowing toward East if from West (270°)
    const dirZ = Math.cos(fromRad);  // blowing toward South (+z) if from North (0°)

    // Drift ratio: under 40 km/h wind, drift is ~0.55 of fall velocity
    const driftRatio = Math.min(0.85, (Math.max(0, windKmh) / 45) * 0.6);

    if (cameraTarget) {
      // Anchored at ground level Y=0 so raindrop altitudes strictly map to world elevation.
      // Follows cameraTarget X and Z horizontally so precipitation stays in focus.
      this.group.position.set(cameraTarget.x, 0, cameraTarget.z);
    }

    const pos = this.positions;
    const halfX = BOUNDS_XZ / 2;

    for (let i = 0; i < DROP_COUNT; i++) {
      const vy = this.velocities[i];
      const dy = vy * dt;
      const driftDist = vy * driftRatio * dt;
      const dx = dirX * driftDist;
      const dz = dirZ * driftDist;

      const idx = i * 6;
      const len = this.lengths[i];
      const slantX = dirX * driftRatio * len;
      const slantZ = dirZ * driftRatio * len;

      // Bottom position advances
      pos[idx + 3] += dx;
      pos[idx + 4] -= dy;
      pos[idx + 5] += dz;

      // Top position stays slanted upwind from bottom, clamped to cloud base
      pos[idx] = pos[idx + 3] - slantX;
      pos[idx + 1] = Math.min(CLOUD_BASE_Y, pos[idx + 4] + len);
      pos[idx + 2] = pos[idx + 5] - slantZ;

      // Wrap boundaries horizontally around focus area
      if (pos[idx + 3] > halfX) {
        pos[idx + 3] -= BOUNDS_XZ;
        pos[idx] -= BOUNDS_XZ;
      } else if (pos[idx + 3] < -halfX) {
        pos[idx + 3] += BOUNDS_XZ;
        pos[idx] += BOUNDS_XZ;
      }
      if (pos[idx + 5] > halfX) {
        pos[idx + 5] -= BOUNDS_XZ;
        pos[idx + 2] -= BOUNDS_XZ;
      } else if (pos[idx + 5] < -halfX) {
        pos[idx + 5] += BOUNDS_XZ;
        pos[idx + 2] += BOUNDS_XZ;
      }

      // Reset when below ground level - respawn strictly inside the underside of the clouds
      if (pos[idx + 4] < GROUND_Y) {
        const x = (Math.random() - 0.5) * BOUNDS_XZ;
        const y = CLOUD_BASE_Y - Math.random() * 5;
        const z = (Math.random() - 0.5) * BOUNDS_XZ;

        pos[idx + 3] = x;
        pos[idx + 4] = y;
        pos[idx + 5] = z;

        pos[idx] = x - slantX;
        pos[idx + 1] = Math.min(CLOUD_BASE_Y, y + len);
        pos[idx + 2] = z - slantZ;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
  }
}
