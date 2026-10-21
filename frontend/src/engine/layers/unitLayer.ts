import * as THREE from 'three';

import type { Georef } from '@/domain/georef';
import type { CrewExposure } from '@/api';
import { crewAt, PHASE_CODE, pointAtDistance, type UnitPhase, type UnitTrack } from '@/domain/dispatchPlanner';
import { UNIT_PHASE_LABEL } from '@/domain/resourceLabels';

import type { Pickable } from '../picking';
import type { Activity } from '../vehicles/statusTag';
import { headingBetween, VehicleActor } from '../vehicles/vehicleActor';
import { modelClassOf } from '../vehicles/vehicleModels';
import { WaterEffects } from '../vehicles/waterEffects';

/** Where a unit was sent (the plan action's target), for its tag and to aim its water. */
export interface UnitTarget {
  lat: number;
  lon: number;
  label: string;
}

export interface UnitStyle {
  colorOf: (orgId: string) => string;
  orgName: (orgId: string) => string;
  orgType: (orgId: string) => string;
  exposures?: CrewExposure[];
  targets?: Map<string, UnitTarget>;
}

/** Real flying heights (m): cruising, working over the fire with the bucket out, and dipping the bucket at a water source. */
const AIR_CRUISE_M = 220;
const AIR_WORK_M = 45;
const AIR_FILL_M = 20;
/** Reach (m) of a hose/monitor jet at real scale. */
const JET_REACH_M = 30;
const RESPONDING: ReadonlySet<UnitPhase> = new Set(['ordered', 'en_route', 'working', 'to_water']);

interface Entry {
  track: UnitTrack;
  actor: VehicleActor;
  org: string;
  orgColor: string;
  exposure: CrewExposure | undefined;
  target: UnitTarget | undefined;
}

/**
 * The dispatched vehicles of the operation, as 3D vehicles of their own class and livery, moving along the roads minute by minute from the planner's tracks. Each one
 * says what it is doing (tag + lights + effects): driving with lights flashing, spraying water at the fire, controlling traffic, assisting, filling at a water point,
 * helicopters cruising, hovering with the bucket out and dropping water, then returning.
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

  setTracks(tracks: UnitTrack[], style: UnitStyle): void {
    this.clear();
    this.entries = tracks.map((track) => {
      const orgType = style.orgType(track.unit.orgId);
      const actor = new VehicleActor(modelClassOf(track.unit.profile.vehicleType), orgType, track.unit.callsign, this.geo.unit, true);
      actor.group.visible = false;
      actor.tag.sprite.visible = false;
      this.group.add(actor.group, actor.tag.sprite);
      return {
        track,
        actor,
        org: style.orgName(track.unit.orgId),
        orgColor: style.colorOf(track.unit.orgId),
        exposure: style.exposures?.find((e) => e.vehicleId === track.unit.id),
        target: style.targets?.get(track.unit.id),
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
    return new Set(this.entries.map((e) => e.track.unit.id));
  }

  /** Places, animates and labels every unit at fractional minute `tf`. */
  update(tf: number, camera?: THREE.PerspectiveCamera, timeS = 0, viewportHeightPx = 1000): void {
    this.water.begin();
    for (const e of this.entries) this.updateOne(e, tf, camera, timeS);
    if (camera) this.water.end(timeS, camera, viewportHeightPx);
  }

  private positionAt(k: UnitTrack, tf: number): { lat: number; lon: number } {
    const last = k.lat.length - 1;
    const i = Math.min(last, Math.max(0, Math.floor(tf)));
    const j = Math.min(last, i + 1);
    const f = Math.min(1, Math.max(0, tf - i));
    let lat = k.lat[i] + (k.lat[j] - k.lat[i]) * f;
    let lon = k.lon[i] + (k.lon[j] - k.lon[i]) * f;
    // while travelling, follow the road between the minute samples instead of cutting straight across the terrain
    if (k.pathIdx[i] >= 0) {
      const path = k.paths[k.pathIdx[i]];
      const end = k.pathIdx[j] === k.pathIdx[i] ? k.dist[j] : path.cum[path.cum.length - 1];
      ({ lat, lon } = pointAtDistance(path, k.dist[i] + (end - k.dist[i]) * f));
    }
    return { lat, lon };
  }

  private updateOne(e: Entry, tf: number, camera: THREE.PerspectiveCamera | undefined, timeS: number): void {
    const { track: k, actor } = e;
    const last = k.lat.length - 1;
    const i = Math.min(last, Math.max(0, Math.floor(tf)));
    const phase: UnitPhase = i < k.from ? 'base' : PHASE_CODE[k.phase[i]];
    const geo = this.geo;
    const role = k.unit.role;
    const activity = activityOf(phase, role, actor.air);

    const here = this.positionAt(k, tf);
    const pos = this.tmpA.set(...geo.world(here.lat, here.lon, 0));
    const groundY = pos.y;
    if (actor.air) {
      const alt = phase === 'working' ? AIR_WORK_M : phase === 'filling' ? AIR_FILL_M : phase === 'base' || phase === 'refueling' ? 0 : AIR_CRUISE_M;
      pos.y += (alt + (alt ? 20 * actor.enlarge : 0)) / geo.unit;
    }
    // heading: where it is going; when working, towards its target
    let heading = actor.heading;
    const ahead = this.positionAt(k, Math.min(last, tf + 0.25));
    const aheadPos = this.tmpB.set(...geo.world(ahead.lat, ahead.lon, 0));
    aheadPos.y = pos.y;
    const moving = headingBetween(pos, aheadPos);
    if (moving !== null && phase !== 'working') heading = moving;
    if (phase === 'working' && e.target) {
      const t = geo.world(e.target.lat, e.target.lon, 0);
      heading = headingBetween(pos, new THREE.Vector3(t[0], pos.y, t[2])) ?? heading;
    }
    if (camera) actor.place(pos, heading, camera);
    else actor.group.position.copy(pos);
    actor.group.visible = true;

    actor.flash(timeS, RESPONDING.has(phase) && !actor.air);
    actor.spin(timeS);
    actor.showBucket(actor.air && (phase === 'working' || phase === 'filling' || phase === 'to_water'));

    // water: trucks spray at the fire while they have water; aircraft drop over it, in passes
    const cap = k.unit.air ? k.unit.bucketL : k.unit.waterL;
    const hasWater = cap > 0 && k.waterL[i] > 0;
    if (phase === 'working' && hasWater && (role === 'attack' || role === 'air')) {
      const nozzle = actor.nozzleWorld(new THREE.Vector3());
      if (actor.air) {
        if (Math.sin(timeS * 0.9 + k.unit.callsign.length) > -0.2) this.water.drop(nozzle, Math.max(0.5, nozzle.y - groundY));
      } else {
        const dir = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
        this.water.jet(nozzle, dir, (JET_REACH_M * actor.enlarge) / geo.unit);
      }
    }

    const crew = crewAt(k, e.exposure, tf);
    actor.tag.set({
      callsign: k.unit.callsign,
      org: e.org,
      orgColor: e.orgColor,
      activity,
      detail: e.target && (phase === 'en_route' || phase === 'working' || phase === 'ordered') ? e.target.label : undefined,
      water: cap ? k.waterL[i] / cap : undefined,
      fuel: k.fuelPct[i] / 100,
      people: `${crew.people}/${k.unit.crew}`,
      casualties: crew.casualties || undefined,
    });
    actor.tag.sprite.position.set(pos.x, actor.topY(geo.unit), pos.z);
    actor.tag.sprite.visible = true;
    actor.setTip(
      `${k.unit.callsign} · ${e.org} · ${UNIT_PHASE_LABEL[phase]} · ${crew.people}/${k.unit.crew} pessoas${crew.casualties ? ` (${crew.casualties} baixas)` : ''}` +
        (cap ? ` · água ${Math.round(k.waterL[i])}/${Math.round(cap)} L` : '') +
        ` · combustível ${Math.round(k.fuelPct[i])}%`,
    );
  }

  get pickables(): Pickable[] {
    return this.entries.map((e) => e.actor.group as Pickable);
  }

  /** Current world position of a unit (for focusing the camera on it), or null if it is not on the map. */
  positionOf(unitId: string): THREE.Vector3 | null {
    const e = this.entries.find((x) => x.track.unit.id === unitId);
    return e?.actor.group.visible ? e.actor.group.position.clone() : null;
  }
}

/** What the tag says, from the planner's phase and the unit's role. */
function activityOf(phase: UnitPhase, role: UnitTrack['unit']['role'], air: boolean): Activity {
  switch (phase) {
    case 'base':
      return 'parked';
    case 'ordered':
      return 'ordered';
    case 'en_route':
      return 'en_route';
    case 'to_water':
      return 'to_water';
    case 'filling':
      return 'filling';
    case 'returning':
      return 'returning';
    case 'refueling':
      return 'refueling';
    case 'working':
      if (air || role === 'air') return 'air_drop';
      if (role === 'traffic') return 'traffic';
      if (role === 'medical') return 'medical';
      if (role === 'command') return 'command';
      return 'attacking';
  }
}
