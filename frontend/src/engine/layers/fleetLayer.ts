import * as THREE from 'three';

import type { Organization, Station, Vehicle } from '@/api';
import type { Georef } from '@/domain/georef';
import { ORG_COLOR, VEHICLE_STATUS_LABEL } from '@/domain/resourceLabels';

import type { Pickable } from '../picking';
import type { Activity } from '../vehicles/statusTag';
import { VehicleActor } from '../vehicles/vehicleActor';
import { modelClassOf } from '../vehicles/vehicleModels';

/** Parked vehicles are drawn only within this distance of the camera (world units, 1 = 10 m), and their tags closer still: a station's fleet when you look at it. */
const PARKED_VISIBLE = 160;
const PARKED_TAG_VISIBLE = 70;
/** Gap between parked vehicles (m) in the station's yard. */
const BAY_M = 9;
/** Parked vehicles may grow less than moving ones, so a full yard does not merge into one blob. */
const PARKED_MAX_ENLARGE = 5;

interface Entry {
  vehicle: Vehicle;
  actor: VehicleActor;
  base: THREE.Vector3;
  heading: number;
  activity: Activity;
  org: string;
  orgColor: string;
  parked: boolean;
}

/**
 * Every registered vehicle that is not part of a replayed operation, where the API says it is: parked in its station's yard (in rows, nose out) or, once dispatched,
 * at its reported position, with its status (available, en route, on scene, refilling, returning…) on its tag. Parked fleets only appear when the camera is near.
 */
export class FleetLayer {
  readonly group = new THREE.Group();
  private entries: Entry[] = [];
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly geo: Georef) {}

  setVehicles(vehicles: Vehicle[], stations: Station[], organizations: Organization[], exclude: Set<string>): void {
    this.clear();
    const geo = this.geo;
    const bays = new Map<string, number>();
    const orgOf = (id: string) => organizations.find((o) => o.id === id);
    for (const v of vehicles) {
      if (exclude.has(v.id as string)) continue;
      const station = stations.find((s) => s.id === v.stationId);
      const status = v.state?.status ?? 'available';
      const parked = (status === 'available' || status === 'out_of_service' || status === 'maintenance' || status === 'unavailable') && !!station;
      const at = parked ? station!.position : (v.state?.position ?? station?.position);
      if (!at) continue;
      const [u, v2] = geo.uv(at.lat, at.lon);
      if (u < 0 || u > 1 || v2 < 0 || v2 > 1) continue; // outside this map
      const base = new THREE.Vector3(...geo.world(at.lat, at.lon, 0));
      let heading = 0;
      if (parked) {
        // rows of four in the yard, nose out
        const bay = bays.get(station!.id as string) ?? 0;
        bays.set(station!.id as string, bay + 1);
        const row = Math.floor(bay / 4);
        const col = (bay % 4) - 1.5;
        base.x += (col * BAY_M) / geo.unit;
        base.z += ((row + 1) * BAY_M * 1.6) / geo.unit;
        heading = Math.PI / 2; // facing north, out of the yard
      }
      const org = orgOf(v.organizationId as string);
      const actor = new VehicleActor(modelClassOf(v.type), org?.type ?? 'other', v.callsign, geo.unit, !parked);
      this.group.add(actor.group, actor.tag.sprite);
      const activity = activityOfStatus(status, v.state?.responsibility ?? undefined);
      this.entries.push({
        vehicle: v,
        actor,
        base,
        heading,
        activity,
        org: org?.shortName ?? org?.name ?? '',
        orgColor: ORG_COLOR[org?.type ?? ''] ?? '#9aa0a8',
        parked,
      });
      actor.setTip(`${v.callsign} · ${org?.shortName ?? ''} · ${VEHICLE_STATUS_LABEL[status]}${station ? ` · ${station.name}` : ''}`);
    }
  }

  clear(): void {
    for (const e of this.entries) {
      this.group.remove(e.actor.group, e.actor.tag.sprite);
      e.actor.dispose();
    }
    this.entries = [];
  }

  update(camera: THREE.PerspectiveCamera, timeS: number): void {
    const geo = this.geo;
    for (const e of this.entries) {
      const { actor } = e;
      const distance = camera.position.distanceTo(e.base);
      const show = !e.parked || distance < PARKED_VISIBLE;
      actor.group.visible = show;
      actor.tag.sprite.visible = show && (!e.parked || distance < PARKED_TAG_VISIBLE);
      actor.tag.setCompact(e.parked);
      if (!show) continue;
      const pos = this.tmp.copy(e.base);
      if (actor.air && !e.parked) pos.y += 200 / geo.unit;
      actor.place(pos, e.heading, camera, e.parked ? PARKED_MAX_ENLARGE : undefined);
      actor.flash(timeS, e.activity === 'en_route' || e.activity === 'attacking' || e.activity === 'traffic' || e.activity === 'medical' || e.activity === 'ordered');
      actor.spin(timeS);
      if (actor.tag.sprite.visible) {
        const water = e.vehicle.state?.water;
        actor.tag.set({
          callsign: e.vehicle.callsign,
          org: e.org,
          orgColor: e.orgColor,
          activity: e.activity,
          water: water?.capacityL ? (water.levelL ?? water.capacityL) / water.capacityL : undefined,
          fuel: e.vehicle.state?.fuelPct != null ? e.vehicle.state.fuelPct / 100 : undefined,
          people: e.vehicle.state?.crewOnboard != null ? `${e.vehicle.state.crewOnboard}/${e.vehicle.crewCapacity}` : undefined,
          casualties: e.vehicle.state?.crew?.casualties || undefined,
        });
        actor.tag.sprite.position.set(pos.x, actor.topY(geo.unit), pos.z);
      }
    }
  }

  get pickables(): Pickable[] {
    return this.entries.filter((e) => e.actor.group.visible).map((e) => e.actor.group as Pickable);
  }
}

function activityOfStatus(status: string, responsibility: string | undefined): Activity {
  switch (status) {
    case 'assigned':
    case 'dispatched':
      return 'ordered';
    case 'en_route':
      return 'en_route';
    case 'on_scene':
      if (responsibility === 'traffic_control') return 'traffic';
      if (responsibility === 'medical') return 'medical';
      if (responsibility === 'command') return 'command';
      return 'attacking';
    case 'returning':
      return 'returning';
    case 'refilling':
      return 'filling';
    case 'out_of_service':
    case 'maintenance':
    case 'unavailable':
      return 'out_of_service';
    default:
      return 'parked';
  }
}
