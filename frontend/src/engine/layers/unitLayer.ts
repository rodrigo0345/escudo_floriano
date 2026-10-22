import * as THREE from 'three';

import type { DispatchStatus, LatLon, UnitState, UnitTrack, Vehicle } from '@/api';
import type { Georef } from '@/domain/georef';
import { DISPATCH_STATUS_LABEL } from '@/domain/resourceLabels';

import type { Pickable } from '../picking';
import { spreadPositions } from '../vehicles/declutter';
import { activityColor, type Activity } from '../vehicles/statusTag';
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
const AIR_CRUISE_M = 120;
const AIR_WORK_M = 45;
const AIR_FILL_M = 12;

type Sample = { status: DispatchStatus; waterLevelL?: number | null };

/** True while a refilling aircraft is at the water point (its tank is filling), false while it flies to or from it. */
const dipping = (a: Sample, b: Sample): boolean => a.status === 'refilling' && b.status === 'refilling' && (b.waterLevelL ?? 0) > (a.waterLevelL ?? 0);

/** Flying height of an aircraft between two samples: low over the target while it drops, lower still dipping its bucket, at cruise height in between. */
function airHeight(a: Sample, b: Sample, f: number): number {
  const at = (x: Sample, other: Sample): number =>
    x.status === 'working' || x.status === 'on_scene' ? AIR_WORK_M : dipping(x, other) || (x.status === 'refilling' && other.status === 'refilling' && (x.waterLevelL ?? 0) < (other.waterLevelL ?? 0)) ? AIR_FILL_M : x.status === 'grounded' ? 0 : AIR_CRUISE_M;
  return at(a, b) + (at(b, a) - at(a, b)) * f; // eased between the two, so it climbs and descends instead of jumping
}
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

/** A unit located for this frame: its track samples around now, its status, position (moved by the spreading) and heading. */
interface Placed {
  e: Entry;
  a: UnitTrack['points'][number];
  b: UnitTrack['points'][number];
  f: number;
  status: DispatchStatus;
  pos: THREE.Vector3;
  heading: number;
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
    // first where every unit is on its track, then spread the ones sharing a point, then draw them
    const placed: Placed[] = [];
    for (const e of this.entries) {
      const p = this.locate(e, tf);
      if (p) placed.push(p);
      else {
        e.actor.group.visible = false;
        e.actor.tag.sprite.visible = false;
      }
    }
    if (camera) {
      spreadPositions(
        placed.map((p) => ({ id: p.e.unit.state.unitId, pos: p.pos, footprint: p.e.actor.footprintAt(p.pos, camera, this.geo.unit), air: p.e.actor.air })),
        this.geo,
      );
    }
    for (const p of placed) this.draw(p, camera, timeS);
    if (camera) this.water.end(timeS, camera, viewportHeightPx);
  }

  /** Where a unit is at fractional minute `tf` on its track, and which way it is heading; null when it is not on the map. */
  private locate(e: Entry, tf: number): Placed | null {
    const { unit, actor } = e;
    const geo = this.geo;
    const sample = sampleAt(unit.track.points, tf);
    if (!sample) return null;
    const { a, b, f } = sample;
    const status = f >= 0.5 ? b.status : a.status;
    const here = pointAt(a.position, b.position, f);
    if (GONE.has(status) || !here) return null;

    const pos = new THREE.Vector3(...geo.world(here.lat, here.lon, 0));
    if (actor.air) {
      const alt = airHeight(a, b, f);
      pos.y += (alt + (alt ? 20 * actor.enlarge : 0)) / geo.unit;
    }
    // heading: where it is going (on scene it turns towards its target once spread out, in `draw`)
    let heading = actor.heading;
    const ahead = sampleAt(unit.track.points, tf + 0.25);
    const next = ahead ? pointAt(ahead.a.position, ahead.b.position, ahead.f) : null;
    if (next && status !== 'working' && status !== 'on_scene') {
      const aheadPos = this.tmpB.set(...geo.world(next.lat, next.lon, 0));
      aheadPos.y = pos.y;
      heading = headingBetween(pos, aheadPos) ?? heading;
    }
    return { e, a, b, f, status, pos, heading };
  }

  private draw(p: Placed, camera: THREE.PerspectiveCamera | undefined, timeS: number): void {
    const { e, a, b, f, status, pos } = p;
    const { unit, actor } = e;
    const geo = this.geo;
    const groundY = geo.y(geo.elevAtUV(pos.x / geo.W + 0.5, pos.z / geo.H + 0.5), pos.x, pos.z);
    let heading = p.heading;
    if ((status === 'working' || status === 'on_scene') && e.target) {
      const t = geo.world(e.target.lat, e.target.lon, 0);
      heading = headingBetween(pos, this.tmpA.set(t[0], pos.y, t[2])) ?? heading;
    }
    if (camera) actor.place(pos, heading, camera);
    else actor.group.position.copy(pos);
    actor.group.visible = true;

    actor.flash(timeS, RESPONDING.has(status) && !actor.air);
    actor.spin(timeS);
    actor.showBucket(actor.air && (status === 'working' || status === 'on_scene' || dipping(a, b)));  // the bucket hangs while it dips and drops, not on every flight

    const water = a.waterLevelL != null && b.waterLevelL != null ? lerp(a.waterLevelL, b.waterLevelL, f) : (a.waterLevelL ?? b.waterLevelL);
    const capacity = unit.state.water?.capacityL;
    const fatigue = a.fatiguePct != null && b.fatiguePct != null ? lerp(a.fatiguePct, b.fatiguePct, f) : (a.fatiguePct ?? b.fatiguePct);
    const fuel = a.fuelPct != null && b.fuelPct != null ? lerp(a.fuelPct, b.fuelPct, f) : (a.fuelPct ?? b.fuelPct);
    // a refill trip is for water or for fuel: the last refill/refuel event says which; on a water trip, the tank filling up means it is at the water point
    const trip = status === 'refilling' ? tripKind(unit.track.events, a.tMin + f) : null;
    const activity: Activity =
      trip === 'fuel' ? 'refueling' : trip === 'water' ? ((b.waterLevelL ?? 0) > (a.waterLevelL ?? 0) ? 'filling' : 'to_water') : activityOf(status, e.role);
    actor.marker.setActivityColor(activityColor(activity)); // the badge's dot shows what it is doing

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
    // the status tag only while the cursor is on the vehicle
    actor.tag.sprite.visible = actor.hovered;
    if (actor.hovered) {
      actor.tag.set({
        callsign,
        org: e.org,
        orgColor: e.orgColor,
        vehicleType: actor.cls,
        activity,
        detail: e.targetLabel && (status === 'en_route' || status === 'on_scene' || status === 'working' || status === 'ordered') ? e.targetLabel : undefined,
        water: capacity && water != null ? water / capacity : undefined,
        fuel: fuel != null ? fuel / 100 : undefined,
        people: `${people} p${fatigue != null && fatigue >= 1 ? ` · cansaço ${Math.round(fatigue)}%` : ''}`,
        casualties: unit.state.crew?.casualties || undefined,
      });
      actor.tag.sprite.position.set(pos.x, actor.topY(geo.unit), pos.z);
    }
    actor.setTip(
      `${callsign} · ${e.org} · ${DISPATCH_STATUS_LABEL[status] ?? status} · ${people} pessoas` +
        (water != null ? ` · água ${Math.round(water)}${capacity ? `/${Math.round(capacity)}` : ''} L` : '') +
        (fuel != null ? ` · combustível ${Math.round(fuel)}%` : '') +
        (fatigue != null ? ` · cansaço ${Math.round(fatigue)}%` : ''),
    );
  }

  /** The vehicles, plus the tag of a hovered one so the cursor can rest on the tag without it disappearing. */
  get pickables(): Pickable[] {
    return this.entries.flatMap((e) => (e.actor.tag.sprite.visible ? [e.actor.group, e.actor.tag.sprite] : [e.actor.group]) as Pickable[]);
  }

  /** Where every vehicle on the map is now, for the minimap. */
  snapshot(): { id: string; lat: number; lon: number; color: string; air: boolean }[] {
    return this.entries
      .filter((e) => e.actor.group.visible)
      .map((e) => {
        const p = e.actor.group.position;
        const [lat, lon] = this.geo.toLatLon(p.x, p.z);
        return { id: e.unit.state.unitId, lat, lon, color: e.orgColor, air: e.actor.air };
      });
  }

  /** The unit a vehicle on the map is (a click on it selects it). */
  unitIdOf(actor: VehicleActor): string | null {
    return this.entries.find((x) => x.actor === actor)?.unit.state.unitId ?? null;
  }

  /** Current world position of a unit (for focusing the camera on it), or null if it is not on the map. */
  positionOf(unitId: string): THREE.Vector3 | null {
    const e = this.entries.find((x) => x.unit.state.unitId === unitId);
    return e?.actor.group.visible ? e.actor.group.position.clone() : null;
  }
}

/** Whether the refill a unit is on at minute `t` is for water or for fuel (the last `refill_*` / `refuel_*` event at or before it). */
function tripKind(events: ReadonlyArray<{ tMin: number; type: string }> | undefined, t: number): 'water' | 'fuel' | null {
  let kind: 'water' | 'fuel' | null = null;
  for (const ev of events ?? []) {
    if (ev.tMin > t) break;
    if (ev.type === 'refuel_started') kind = 'fuel';
    else if (ev.type === 'refill_started') kind = 'water';
  }
  return kind;
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
