import * as THREE from 'three';

import type { DispatchStatus, LatLon, UnitState, UnitTrack, Vehicle } from '@/api';
import type { Georef } from '@/domain/georef';
import { DISPATCH_STATUS_LABEL } from '@/domain/resourceLabels';

import type { Pickable } from '../picking';
import type { Activity } from '../vehicles/statusTag';
import { headingBetween, VehicleActor } from '../vehicles/vehicleActor';
import { modelClassOf } from '../vehicles/vehicleModels';
import { WaterEffects } from '../vehicles/waterEffects';

export interface MapUnit {
  /** Metadata (callsign, organization, responsibility, target, water) from `GET /units`. */
  state: UnitState;
  /** Per-minute positions and state from `GET /units/{id}/track`. */
  track: UnitTrack;
}

export interface UnitStyle {
  colorOf: (orgId: string) => string;
  orgName: (orgId: string) => string;
  orgType: (orgId: string) => string;
  /** The registered vehicle behind a unit (for its class and look); undefined for a personnel group. */
  vehicleOf: (unitId: string) => Vehicle | undefined;
}

type UnitRole = 'attack' | 'air' | 'traffic' | 'medical' | 'command';

/** Real flying heights (m): cruising, working over the fire with the bucket out, and refilling the bucket at a water source. */
const AIR_CRUISE_M = 220;
const AIR_WORK_M = 45;
const AIR_FILL_M = 20;
/** Reach (m) of a hose/monitor jet at real scale. */
const JET_REACH_M = 30;
const RESPONDING: ReadonlySet<DispatchStatus> = new Set(['ordered', 'en_route', 'on_scene', 'working']);
const GONE: ReadonlySet<DispatchStatus> = new Set(['completed', 'cancelled', 'failed']);

interface Entry {
  unit: MapUnit;
  actor: VehicleActor;
  role: UnitRole;
  org: string;
  orgColor: string;
  target: LatLon | null;
  targetLabel: string | undefined;
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

/**
 * The plan's units from the backend (`/units` + `/units/{unitId}/track`), as 3D vehicles of their own class and livery moving along their one-minute track. Each one
 * says what it is doing (tag + lights + effects): driving with lights flashing, spraying water at the fire, controlling traffic, assisting, refilling, resting,
 * helicopters cruising, hovering with the bucket out and dropping water, grounded, then returning.
 */
export class UnitLayer {
  readonly group = new THREE.Group();
  readonly water = new WaterEffects();
  private entries: Entry[] = [];
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

  constructor(private readonly geo: Georef) {
    this.group.add(this.water.points);
  }

  setUnits(units: MapUnit[], style: UnitStyle): void {
    this.clear();
    this.entries = units.map((unit) => {
      const orgId = unit.state.organizationId ?? '';
      const vehicle = style.vehicleOf(unit.state.unitId);
      const vehicleType = vehicle?.type ?? (unit.state.aerial ? 'helicopter' : 'personnel_transport');
      const callsign = unit.state.callsign ?? vehicle?.callsign ?? unit.state.unitId;
      const actor = new VehicleActor(modelClassOf(vehicleType), style.orgType(orgId), callsign, this.geo.unit, true);
      actor.group.visible = false;
      actor.tag.sprite.visible = false;
      this.group.add(actor.group, actor.tag.sprite);
      return {
        unit,
        actor,
        role: roleOf(unit.state),
        org: style.orgName(orgId),
        orgColor: style.colorOf(orgId),
        target: unit.state.target?.position ?? null,
        targetLabel: unit.state.target?.label ?? undefined,
      };
    });
  }

  clear(): void {
    for (const e of this.entries) {
      this.group.remove(e.actor.group, e.actor.tag.sprite);
      e.actor.dispose();
    }
    this.entries = [];
  }

  /** Ids of the units this layer draws (the fleet layer leaves them out). */
  get unitIds(): Set<string> {
    return new Set(this.entries.map((e) => e.unit.state.unitId));
  }

  /** Places, animates and labels every unit at fractional minute `tf`, interpolating between the backend's one-minute samples. */
  update(tf: number, camera?: THREE.PerspectiveCamera, timeS = 0, viewportHeightPx = 1000): void {
    this.water.begin();
    for (const e of this.entries) this.updateOne(e, tf, camera, timeS);
    if (camera) this.water.end(timeS, camera, viewportHeightPx);
  }

  private updateOne(e: Entry, tf: number, camera: THREE.PerspectiveCamera | undefined, timeS: number): void {
    const { unit, actor } = e;
    const geo = this.geo;
    const sample = sampleAt(unit.track.points, tf);
    const hide = () => {
      actor.group.visible = false;
      actor.tag.sprite.visible = false;
    };
    if (!sample) return hide();
    const { a, b, f } = sample;
    const status = f >= 0.5 ? b.status : a.status;
    const here = pointAt(a.position, b.position, f);
    if (GONE.has(status) || !here) return hide();

    const pos = this.tmpA.set(...geo.world(here.lat, here.lon, 0));
    const groundY = pos.y;
    if (actor.air) {
      const alt = status === 'working' || status === 'on_scene' ? AIR_WORK_M : status === 'refilling' ? AIR_FILL_M : status === 'grounded' ? 0 : AIR_CRUISE_M;
      pos.y += (alt + (alt ? 20 * actor.enlarge : 0)) / geo.unit;
    }
    // heading: where it is going; on scene, towards its target
    let heading = actor.heading;
    const ahead = sampleAt(unit.track.points, tf + 0.25);
    const next = ahead ? pointAt(ahead.a.position, ahead.b.position, ahead.f) : null;
    if (next && status !== 'working' && status !== 'on_scene') {
      const aheadPos = this.tmpB.set(...geo.world(next.lat, next.lon, 0));
      aheadPos.y = pos.y;
      heading = headingBetween(pos, aheadPos) ?? heading;
    }
    if ((status === 'working' || status === 'on_scene') && e.target) {
      const t = geo.world(e.target.lat, e.target.lon, 0);
      heading = headingBetween(pos, new THREE.Vector3(t[0], pos.y, t[2])) ?? heading;
    }
    if (camera) actor.place(pos, heading, camera);
    else actor.group.position.copy(pos);
    actor.group.visible = true;

    actor.flash(timeS, RESPONDING.has(status) && !actor.air);
    actor.spin(timeS);
    actor.showBucket(actor.air && (status === 'working' || status === 'on_scene' || status === 'refilling'));

    const water = a.waterLevelL != null && b.waterLevelL != null ? lerp(a.waterLevelL, b.waterLevelL, f) : (a.waterLevelL ?? b.waterLevelL);
    const capacity = unit.state.water?.capacityL;
    const fatigue = a.fatiguePct != null && b.fatiguePct != null ? lerp(a.fatiguePct, b.fatiguePct, f) : (a.fatiguePct ?? b.fatiguePct);

    // water: trucks spray at the fire while they have water; aircraft drop over it, in passes
    if (status === 'working' && (water ?? 1) > 0 && (e.role === 'attack' || e.role === 'air')) {
      const nozzle = actor.nozzleWorld(new THREE.Vector3());
      if (actor.air) {
        if (Math.sin(timeS * 0.9 + e.actor.cls.length) > -0.2) this.water.drop(nozzle, Math.max(0.5, nozzle.y - groundY));
      } else {
        const dir = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
        this.water.jet(nozzle, dir, (JET_REACH_M * actor.enlarge) / geo.unit);
      }
    }

    const people = unit.state.personnel ?? 0;
    const callsign = unit.state.callsign ?? unit.state.unitId;
    actor.tag.set({
      callsign,
      org: e.org,
      orgColor: e.orgColor,
      activity: activityOf(status, e.role),
      detail: e.targetLabel && (status === 'en_route' || status === 'on_scene' || status === 'working' || status === 'ordered') ? e.targetLabel : undefined,
      water: capacity && water != null ? water / capacity : undefined,
      people: `${people} p${fatigue != null && fatigue >= 1 ? ` · cansaço ${Math.round(fatigue)}%` : ''}`,
      casualties: unit.state.crew?.casualties || undefined,
    });
    actor.tag.sprite.position.set(pos.x, actor.topY(geo.unit), pos.z);
    actor.tag.sprite.visible = true;
    actor.setTip(
      `${callsign} · ${e.org} · ${DISPATCH_STATUS_LABEL[status] ?? status} · ${people} pessoas` +
        (water != null ? ` · água ${Math.round(water)}${capacity ? `/${Math.round(capacity)}` : ''} L` : '') +
        (fatigue != null ? ` · cansaço ${Math.round(fatigue)}%` : ''),
    );
  }

  get pickables(): Pickable[] {
    return this.entries.map((e) => e.actor.group as Pickable);
  }

  /** Current world position of a unit (for focusing the camera on it), or null if it is not on the map. */
  positionOf(unitId: string): THREE.Vector3 | null {
    const e = this.entries.find((x) => x.unit.state.unitId === unitId);
    return e?.actor.group.visible ? e.actor.group.position.clone() : null;
  }
}

/** What the tag says, from the backend's dispatch status and the unit's role. */
function activityOf(status: DispatchStatus, role: UnitRole): Activity {
  switch (status) {
    case 'ordered':
      return 'ordered';
    case 'en_route':
      return 'en_route';
    case 'refilling':
      return 'filling';
    case 'resting':
      return 'resting';
    case 'grounded':
      return 'grounded';
    case 'returning':
      return 'returning';
    case 'on_scene':
    case 'working':
      if (role === 'air') return 'air_drop';
      if (role === 'traffic') return 'traffic';
      if (role === 'medical') return 'medical';
      if (role === 'command') return 'command';
      return 'attacking';
    default:
      return 'parked';
  }
}
