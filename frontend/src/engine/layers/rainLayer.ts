import * as THREE from 'three';

import type { CloudSpatialSpot } from './cloudLayer';

const DROP_COUNT = 1800;
// In FireTrace coordinates, 1 world unit = 10 meters.
// BOUNDS_XZ = 240 units => 2400 m across camera viewport.
// CLOUD_BASE_Y = 140 units => 1400m altitude, exactly matching the underside of the high cloud deck.
// Rain strictly originates at or below CLOUD_BASE_Y and falls towards ground level (Y ~ 0).
const BOUNDS_XZ = 240;
const CLOUD_BASE_Y = 140;
const GROUND_Y = -6;
const RAIN_FALL_RANGE = CLOUD_BASE_Y - GROUND_Y;

/**
 * 3D Rain Particle Layer:
 * - Streaks fall and slant realistically along wind direction (north = -z, east = +x).
 * - 1 world unit = 10 meters.
 * - Dynamically visible and modulated in opacity when precipitationMmH > 0.
 * - Originates strictly at the high cloud base (Y = 140), falling towards terrain.
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
      const streakLen = 2.4 + Math.random() * 2.6; // 24m to 50m world streak length
      this.lengths[i] = streakLen;

      // Top of streak (initial vertical)
      this.positions[i * 6] = x;
      this.positions[i * 6 + 1] = Math.min(CLOUD_BASE_Y, y + streakLen);
      this.positions[i * 6 + 2] = z;

      // Bottom of streak
      this.positions[i * 6 + 3] = x;
      this.positions[i * 6 + 4] = y;
      this.positions[i * 6 + 5] = z;

      // Fall speed: ~22 to 32 units/s (220 to 320 m/s visual fall rate for crisp streaks)
      this.velocities[i] = 22 + Math.random() * 10;
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
    cameraTarget?: THREE.Vector3,
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

    // If localized spot is active, anchor rain strictly over that spot on the terrain.
    // If global, center rain horizontally around camera focus area so the user sees rain wherever they look.
    const effectiveRadius = spot ? Math.max(120, spot.radiusUnits) : BOUNDS_XZ / 2;
    const spanXZ = effectiveRadius * 2;

    if (spot) {
      this.group.position.set(spot.x, 0, spot.z);
    } else if (cameraTarget) {
      this.group.position.set(cameraTarget.x, 0, cameraTarget.z);
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

      // Wrap boundaries horizontally
      if (pos[idx + 3] > halfX) {
        pos[idx + 3] -= spanXZ;
        pos[idx] -= spanXZ;
      } else if (pos[idx + 3] < -halfX) {
        pos[idx + 3] += spanXZ;
        pos[idx] += spanXZ;
      }
      if (pos[idx + 5] > halfX) {
        pos[idx + 5] -= spanXZ;
        pos[idx + 2] -= spanXZ;
      } else if (pos[idx + 5] < -halfX) {
        pos[idx + 5] += spanXZ;
        pos[idx + 2] += spanXZ;
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
