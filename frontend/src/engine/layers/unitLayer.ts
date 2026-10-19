import * as THREE from 'three';

import type { Georef } from '@/domain/georef';
import type { CrewExposure } from '@/api';
import { crewAt, PHASE_CODE, pointAtDistance, type UnitRole, type UnitTrack } from '@/domain/dispatchPlanner';
import { UNIT_PHASE_LABEL } from '@/domain/resourceLabels';

import type { Pickable } from '../picking';
import { badgeSprite } from '../sprites';

const ROLE_CODE: Record<UnitRole, string> = { attack: 'VC', air: 'AV', traffic: 'TR', medical: 'AM', command: 'CO' };
const SIZE = 12;

interface Entry {
  track: UnitTrack;
  sprite: THREE.Sprite;
  org: string;
  exposure: CrewExposure | undefined;
}

/** The dispatched vehicles of the operation replay, drawn on the same terrain as everything else and positioned from the planner's per-minute tracks. */
export class UnitLayer {
  readonly group = new THREE.Group();
  private entries: Entry[] = [];

  constructor(private readonly geo: Georef) {}

  setTracks(tracks: UnitTrack[], colorOf: (orgId: string) => string, orgName: (orgId: string) => string, exposures: CrewExposure[] = []): void {
    this.clear();
    this.entries = tracks.map((track) => {
      const sprite = badgeSprite(ROLE_CODE[track.unit.role], colorOf(track.unit.orgId));
      sprite.scale.set(SIZE, SIZE, 1);
      sprite.visible = false;
      this.group.add(sprite);
      return { track, sprite, org: orgName(track.unit.orgId), exposure: exposures.find((e) => e.vehicleId === track.unit.id) };
    });
  }

  clear(): void {
    this.entries.forEach((e) => {
      this.group.remove(e.sprite);
      (e.sprite.material as THREE.SpriteMaterial).map?.dispose();
      e.sprite.material.dispose();
    });
    this.entries = [];
  }

  /** Positions every unit at fractional minute `tf` (linear interpolation between the per-minute samples). */
  update(tf: number): void {
    for (const { track: k, sprite, org, exposure } of this.entries) {
      const last = k.lat.length - 1;
      const i = Math.min(last, Math.max(0, Math.floor(tf)));
      const j = Math.min(last, i + 1);
      const f = Math.min(1, Math.max(0, tf - i));
      const phase = PHASE_CODE[k.phase[i]];
      const out = i < k.from || phase === 'base' || phase === 'refueling';
      sprite.visible = !out;
      if (out) continue;
      // while travelling, follow the road between the minute samples instead of cutting straight across the terrain
      let lat = k.lat[i] + (k.lat[j] - k.lat[i]) * f;
      let lon = k.lon[i] + (k.lon[j] - k.lon[i]) * f;
      if (k.pathIdx[i] >= 0) {
        const path = k.paths[k.pathIdx[i]];
        const end = k.pathIdx[j] === k.pathIdx[i] ? k.dist[j] : path.cum[path.cum.length - 1];
        ({ lat, lon } = pointAtDistance(path, k.dist[i] + (end - k.dist[i]) * f));
      }
      sprite.position.set(...this.geo.world(lat, lon, 6));
      const crew = crewAt(k, exposure, tf);
      const cap = k.unit.air ? k.unit.bucketL : k.unit.waterL;
      (sprite.userData as { tip?: string }).tip =
        `${k.unit.callsign} · ${org} · ${UNIT_PHASE_LABEL[phase]} · ${crew.people}/${k.unit.crew} pessoas${crew.casualties ? ` (${crew.casualties} baixas)` : ''}` +
        (cap ? ` · água ${Math.round(k.waterL[i])}/${Math.round(cap)} L` : '') +
        ` · combustível ${Math.round(k.fuelPct[i])}%`;
    }
  }

  get pickables(): Pickable[] {
    return this.entries.map((e) => e.sprite as Pickable);
  }

  /** Current world position of a unit's sprite (for focusing the camera on it), or null if it is not on the map. */
  positionOf(unitId: string): THREE.Vector3 | null {
    const e = this.entries.find((x) => x.track.unit.id === unitId);
    return e?.sprite.visible ? e.sprite.position.clone() : null;
  }
}
