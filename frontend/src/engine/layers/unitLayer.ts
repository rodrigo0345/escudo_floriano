import * as THREE from 'three';

import type { DispatchStatus, LatLon, UnitState, UnitTrack } from '@/api';
import type { Georef } from '@/domain/georef';
import { DISPATCH_STATUS_LABEL } from '@/domain/resourceLabels';

import type { Pickable } from '../picking';
import { badgeSprite } from '../sprites';

type UnitRole = 'attack' | 'air' | 'traffic' | 'medical' | 'command';

const ROLE_CODE: Record<UnitRole, string> = { attack: 'VC', air: 'AV', traffic: 'TR', medical: 'AM', command: 'CO' };
const SIZE = 12;

export interface MapUnit {
  /** Metadata (callsign, organization, responsibility) from `GET /units`. */
  state: UnitState;
  /** Per-minute positions and state from `GET /units/{id}/track`. */
  track: UnitTrack;
}

interface Entry {
  unit: MapUnit;
  sprite: THREE.Sprite;
  org: string;
}

const roleOf = (state: UnitState): UnitRole => {
  if (state.aerial) return 'air';
  switch (state.responsibility) {
    case 'traffic_control':
    case 'perimeter_security':
      return 'traffic';
    case 'medical':
    case 'rescue':
      return 'medical';
    case 'command':
    case 'reconnaissance':
    case 'logistics':
    case 'standby':
      return 'command';
    default:
      return 'attack';
  }
};

const visibleStatus = (status: DispatchStatus): boolean =>
  status !== 'ordered' && status !== 'completed' && status !== 'cancelled' && status !== 'failed';

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;

const pointAt = (a: LatLon | null | undefined, b: LatLon | null | undefined, f: number): LatLon | null => {
  if (a && b) return { lat: lerp(a.lat, b.lat, f), lon: lerp(a.lon, b.lon, f) };
  return a ?? b ?? null;
};

/** Finds the pair of track samples around `minute` and the fraction between them. */
const sampleAt = (points: UnitTrack['points'], minute: number) => {
  if (points.length === 0) return null;
  let i = 0;
  while (i < points.length - 1 && points[i + 1].tMin <= minute) i++;
  const a = points[i];
  const b = points[Math.min(points.length - 1, i + 1)];
  const span = b.tMin - a.tMin;
  return { a, b, f: span <= 0 ? 0 : Math.min(1, Math.max(0, (minute - a.tMin) / span)) };
};

/** The plan's units, drawn from the backend's `/units` and `/units/{unitId}/track` answers. */
export class UnitLayer {
  readonly group = new THREE.Group();
  private entries: Entry[] = [];

  constructor(private readonly geo: Georef) {}

  setUnits(units: MapUnit[], colorOf: (orgId: string) => string, orgName: (orgId: string) => string): void {
    this.clear();
    this.entries = units.map((unit) => {
      const sprite = badgeSprite(ROLE_CODE[roleOf(unit.state)], colorOf(unit.state.organizationId ?? ''));
      sprite.scale.set(SIZE, SIZE, 1);
      sprite.visible = false;
      this.group.add(sprite);
      return { unit, sprite, org: orgName(unit.state.organizationId ?? '') };
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

  /** Positions every unit at fractional minute `tf`, interpolating between the backend's one-minute samples. */
  update(tf: number): void {
    for (const { unit, sprite, org } of this.entries) {
      const sample = sampleAt(unit.track.points, tf);
      if (!sample) {
        sprite.visible = false;
        continue;
      }
      const { a, b, f } = sample;
      const status = f >= 0.5 ? b.status : a.status;
      const position = pointAt(a.position, b.position, f);
      sprite.visible = visibleStatus(status) && position !== null;
      if (!sprite.visible || !position) continue;

      sprite.position.set(...this.geo.world(position.lat, position.lon, 6));
      const water = a.waterLevelL != null && b.waterLevelL != null ? lerp(a.waterLevelL, b.waterLevelL, f) : (a.waterLevelL ?? b.waterLevelL);
      const fatigue = a.fatiguePct != null && b.fatiguePct != null ? lerp(a.fatiguePct, b.fatiguePct, f) : (a.fatiguePct ?? b.fatiguePct);
      const capacity = unit.state.water?.capacityL;
      const people = unit.state.personnel ?? 0;
      (sprite.userData as { tip?: string }).tip =
        `${unit.state.callsign ?? unit.state.unitId} · ${org} · ${DISPATCH_STATUS_LABEL[status] ?? status} · ${people} pessoas` +
        (water != null ? ` · água ${Math.round(water)}${capacity ? `/${Math.round(capacity)}` : ''} L` : '') +
        (fatigue != null ? ` · cansaço ${Math.round(fatigue)}%` : '');
    }
  }

  get pickables(): Pickable[] {
    return this.entries.map((e) => e.sprite as Pickable);
  }

  /** Current world position of a unit's sprite (for focusing the camera on it), or null if it is not on the map. */
  positionOf(unitId: string): THREE.Vector3 | null {
    const e = this.entries.find((x) => x.unit.state.unitId === unitId);
    return e?.sprite.visible ? e.sprite.position.clone() : null;
  }
}
