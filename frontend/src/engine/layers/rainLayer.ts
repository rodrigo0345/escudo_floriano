import * as THREE from 'three';

import type { CloudSpatialSpot } from './cloudLayer';

const DROP_COUNT = 6000;
// In FireTrace coordinates, 1 world unit = 10 meters.
// TERRITORY_BOUNDS = 2400 units => 24 km spanning the entire Guimarães concelho.
// CLOUD_BASE_Y = 140 units => 1400m altitude, exactly matching the underside of the high cloud deck.
// Rain strictly originates at or below CLOUD_BASE_Y and falls towards ground level (Y ~ 0).
const TERRITORY_BOUNDS = 2400;
const CLOUD_BASE_Y = 140;
const GROUND_Y = -6;
const RAIN_FALL_RANGE = CLOUD_BASE_Y - GROUND_Y;

/**
 * 3D Rain Particle Layer:
 * - Streaks fall and slant realistically along wind direction (north = -z, east = +x).
 * - 1 world unit = 10 meters.
 * - Dynamically visible and modulated in opacity when precipitationMmH > 0.
 * - Originates strictly at the high cloud base (Y = 140), falling towards terrain.
 * - World sky anchored: completely independent of camera movement (never follows camera view).
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
      const x = (Math.random() - 0.5) * TERRITORY_BOUNDS;
      const y = GROUND_Y + Math.random() * RAIN_FALL_RANGE;
      const z = (Math.random() - 0.5) * TERRITORY_BOUNDS;
      const streakLen = 3.6 + Math.random() * 4.4; // 36m to 80m world streak length
      this.lengths[i] = streakLen;

      // Top of streak (initial vertical)
      this.positions[i * 6] = x;
      this.positions[i * 6 + 1] = Math.min(CLOUD_BASE_Y, y + streakLen);
      this.positions[i * 6 + 2] = z;

      // Bottom of streak
      this.positions[i * 6 + 3] = x;
      this.positions[i * 6 + 4] = y;
      this.positions[i * 6 + 5] = z;

      // Fall speed: ~30 to 46 units/s (300 to 460 m/s visual fall rate for crisp streaks)
      this.velocities[i] = 30 + Math.random() * 16;
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

  update(
    dt: number,
    precipRateMmH: number,
    windKmh: number,
    windFromDeg: number,
    spot?: CloudSpatialSpot | null,
  ): void {
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

    // Rain intensity modulates opacity (0.28 to 0.72)
    this.material.opacity = Math.min(0.72, 0.28 + (precipRateMmH / 10) * 0.40);

    // Wind direction: wind blows FROM windFromDeg towards (windFromDeg + 180).
    const fromRad = (windFromDeg * Math.PI) / 180;
    const dirX = -Math.sin(fromRad);
    const dirZ = Math.cos(fromRad);

    const driftRatio = Math.min(0.85, (Math.max(0, windKmh) / 45) * 0.6);

    // World sky anchoring:
    // If localized spot is active, anchor rain strictly over that spot on the terrain.
    // If global (concelho-wide), anchor rain strictly at world origin (0, 0, 0) across TERRITORY_BOUNDS.
    // NEVER follow camera or cameraTarget, so rain remains stationary in world space!
    const effectiveRadius = spot ? Math.max(120, spot.radiusUnits) : TERRITORY_BOUNDS / 2;
    const spanXZ = effectiveRadius * 2;

    if (spot) {
      this.group.position.set(spot.x, 0, spot.z);
    } else {
      this.group.position.set(0, 0, 0);
    }

    const pos = this.positions;
    const halfX = effectiveRadius;

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

      // Wrap boundaries horizontally within effectiveRadius
      if (pos[idx + 3] > halfX || pos[idx + 3] < -halfX || pos[idx + 5] > halfX || pos[idx + 5] < -halfX) {
        const rx = (Math.random() - 0.5) * spanXZ;
        const rz = (Math.random() - 0.5) * spanXZ;
        pos[idx + 3] = rx;
        pos[idx] = rx - slantX;
        pos[idx + 5] = rz;
        pos[idx + 2] = rz - slantZ;
      }

      // Reset when below ground level - respawn strictly inside the underside of the clouds
      if (pos[idx + 4] < GROUND_Y) {
        const x = (Math.random() - 0.5) * spanXZ;
        const y = CLOUD_BASE_Y - Math.random() * 8;
        const z = (Math.random() - 0.5) * spanXZ;

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
