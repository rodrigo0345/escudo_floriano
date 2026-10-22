import type { Action, LatLon, Responsibility, ResourceAssignment, Trigger, Vehicle } from '@/api';
import type { LocationData, RunData } from '@/store/types';

/**
 * The operator's edit of an agent plan (Epic A6): pure functions over the `Action` JSON, so the plan editor does not have to know
 * which of the fifteen action types carries its target in `target`, `area`, `line` or `anchorPoint`. Nothing here invents a field:
 * every change is one the backend already accepts in `PATCH /plans/{id}` (the action is sent whole).
 */

type Json = Record<string, unknown>;

const object = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null);
const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
export const cloneAction = (action: Action): Action => JSON.parse(JSON.stringify(action)) as Action;

/** The minute an `at_time` trigger starts, or null for a conditional/manual trigger (which the engine does not time yet — J3). */
export function timeSpecMinute(value: unknown, startMs?: number): number | null {
  const at = object(value);
  const offset = number(at?.offsetMinutes);
  if (offset != null) return offset;
  if (typeof at?.time !== 'string' || startMs == null) return null;
  const absolute = Date.parse(at.time);
  return Number.isFinite(absolute) ? (absolute - startMs) / 60_000 : null;
}

export function triggerStartMinute(action: Action, startMs?: number): number | null {
  const trigger = object((action as Json).trigger);
  if (!trigger || trigger.kind !== 'at_time') return null;
  return timeSpecMinute(trigger.at, startMs);
}

/** Alert timing on the displayed run: immediate, clock-scheduled, or forecast arrival at its target. */
export function alertStartMinute(action: Action, run: RunData, data: LocationData): number | null {
  const trigger = action.trigger as Trigger | undefined;
  if (!trigger) return 0;
  if (trigger.kind === 'at_time') return triggerStartMinute(action, run.startMs);
  if (trigger.kind !== 'on_fire_arrival') return null;
  const target = trigger.target;
  const points: LatLon[] = [];
  collectLatLons(target.position ?? target.geometry ??
    data.places.find((p) => p.id === target.placeId)?.position ??
    data.facilities.find((p) => p.id === target.facilityId)?.position ??
    data.waterPoints.find((p) => p.id === target.waterPointId)?.position, points);
  if (!points.length) return null;
  const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const lon = points.reduce((sum, p) => sum + p.lon, 0) / points.length;
  const [u, v] = data.geo.uv(lat, lon);
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
  const arrival = run.ign[Math.floor(v * run.gridHeight) * run.gridWidth + Math.floor(u * run.gridWidth)];
  return arrival >= 0 ? Math.max(0, arrival - (trigger.leadTimeMinutes ?? 0)) : null;
}

export function triggerKind(action: Action): string {
  return String(object((action as Json).trigger)?.kind ?? 'imediato');
}

/**
 * Fix the action to a clock minute. If it already had an `at_time` trigger, the what-if windows move with it by the same delta;
 * if it was conditional (fire arrival / another action), the windows start at the chosen minute, so re-simulating the plan actually
 * reflects the change instead of silently keeping the old window.
 */
export function setTriggerMinute(action: Action, minute: number, startMs?: number): Action {
  const previous = action.trigger ? triggerStartMinute(action, startMs) : 0;
  const next = cloneAction(action) as Json;
  next.trigger = { kind: 'at_time', at: { offsetMinutes: Math.max(0, Math.round(minute)) } };
  const delta = previous == null ? null : Math.round(minute) - previous;
  const effects = next.simulationEffects;
  if (Array.isArray(effects)) {
    for (const raw of effects) {
      const effect = object(raw);
      if (!effect) continue;
      const s = timeSpecMinute(effect.start, startMs);
      const e = timeSpecMinute(effect.end, startMs);
      if (s != null) effect.start = { offsetMinutes: delta == null ? Math.max(0, Math.round(minute)) : Math.round(s + delta) };
      if (e != null) effect.end = { offsetMinutes: delta == null ? Math.max(1, Math.round(minute) + Math.max(1, e - (s ?? e))) : Math.round(e + delta) };
    }
  }
  if (number(object(next.startBy)?.offsetMinutes) != null) (next.startBy as Json).offsetMinutes = Math.max(0, Math.round(minute));
  return next as Action;
}

/**
 * The target fields each action type carries, mirroring the geometry fields of the corresponding
 * `Action*` schemas in `api-spec/openapi.json` (e.g., `ActionEvacuation.area`, `ActionFireAttack.line`).
 * Anything not listed here is treated as having "no place on the map"; if a new action type is added
 * to the contract, its geometry field(s) MUST be registered here, or the editor/map will silently
 * fall back to the generic search in `actionCentre` (which may miss nested or non-standard targets).
 */
const TARGET_KEYS: Record<string, string[]> = {
  dispatch_units: ['target'],
  stage_resources: ['stagingArea'],
  establish_command_post: ['location'],
  structure_protection: ['targets'],
  fire_attack: ['anchorPoint', 'line'],
  fuel_break: ['line'],
  evacuation: ['area'],
  shelter_in_place: ['area'],
  reconnaissance: ['area'],
  medical_standby: ['positions', 'casualtyCollectionPoint'],
  air_support_request: ['targetArea'],
  road_closure: ['geometry'],
  traffic_control_point: ['position'],
  public_alert: ['area'],
  request_reinforcements: ['stagingArea'],
  custom: ['target', 'geometry', 'area'],
};

const collectLatLons = (node: unknown, out: LatLon[]): void => {
  if (Array.isArray(node)) {
    // GeoJSON position: [lon, lat]
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      out.push({ lat: node[1], lon: node[0] });
      return;
    }
    for (const item of node) collectLatLons(item, out);
    return;
  }
  const obj = object(node);
  if (!obj) return;
  const lat = number(obj.lat);
  const lon = number(obj.lon);
  if (lat != null && lon != null) {
    out.push({ lat, lon });
    return;
  }
  if (Array.isArray(obj.coordinates)) {
    collectLatLons(obj.coordinates, out);
    return;
  }
  for (const value of Object.values(obj)) collectLatLons(value, out);
};

/** Centre of the action's target, or null when it has no place on the map (a public alert, a request for reinforcements without an area…). */
export function actionCentre(action: Action): LatLon | null {
  const raw = action as Json;
  const keys = TARGET_KEYS[String(raw.type)] ?? ['target', 'geometry', 'area', 'position', 'line', 'anchorPoint'];
  const points: LatLon[] = [];
  for (const key of keys) collectLatLons(raw[key], points);
  if (!points.length) return null;
  return {
    lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
    lon: points.reduce((sum, p) => sum + p.lon, 0) / points.length,
  };
}

const shiftGeo = (node: unknown, dLat: number, dLon: number, inCoordinates = false): unknown => {
  if (Array.isArray(node)) {
    if (inCoordinates && node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      return [node[0] + dLon, node[1] + dLat, ...node.slice(2)];
    }
    return node.map((item) => shiftGeo(item, dLat, dLon, inCoordinates));
  }
  const obj = object(node);
  if (!obj) return node;
  const lat = number(obj.lat);
  const lon = number(obj.lon);
  if (lat != null && lon != null) return { ...obj, lat: lat + dLat, lon: lon + dLon };
  const result: Json = {};
  for (const [key, value] of Object.entries(obj)) result[key] = shiftGeo(value, dLat, dLon, key === 'coordinates');
  return result;
};

/**
 * Translate the whole action by (dLat, dLon): its target, its geometry, its escape routes/safety zones and the what-if interventions
 * (the line held, the area evacuated…). Moving only the label while the engine kept the old line is exactly the kind of silent
 * disagreement A6 is meant to remove.
 */
export function shiftAction(action: Action, dLat: number, dLon: number): Action {
  return shiftGeo(action, dLat, dLon) as Action;
}

/** `T+15–45` for the action's what-if interventions, so the operator sees what changing the trigger moved. */
export function effectWindows(action: Action, startMs?: number): { start: number; end: number }[] {
  const effects = (action as Json).simulationEffects;
  if (!Array.isArray(effects)) return [];
  const windows: { start: number; end: number }[] = [];
  for (const raw of effects) {
    const effect = object(raw);
    const start = timeSpecMinute(effect?.start, startMs);
    const end = timeSpecMinute(effect?.end, startMs);
    if (start != null) windows.push({ start, end: end ?? start });
  }
  return windows;
}

export const assignmentKey = (assignment: ResourceAssignment): string => `${assignment.resourceType}:${assignment.resourceId}`;

/**
 * Which vehicle capability serves each action type, and with what `responsibility` (mirrors the backend's
 * `PlanService.DefaultResponsibility`, so the validator does not warn `responsibility_not_supported`). Used by the editor's
 * "Sugerir meios": agent and demo plans often publish actions with no `resources` at all — the operator should not have to
 * scroll a 60-vehicle dropdown to fix that.
 */
const CAPABILITY_BY_TYPE: Record<string, { capabilities: string[]; responsibility?: Responsibility }> = {
  fire_attack: { capabilities: ['wildfire_attack'], responsibility: 'firefighting' },
  fuel_break: { capabilities: ['wildfire_attack'], responsibility: 'firefighting' },
  dispatch_units: { capabilities: ['wildfire_attack'], responsibility: 'firefighting' },
  air_support_request: { capabilities: ['aerial_water_drop', 'aerial_recon'], responsibility: 'firefighting' },
  structure_protection: { capabilities: ['structure_protection', 'wildfire_attack'], responsibility: 'structure_protection' },
  evacuation: { capabilities: ['evacuation_transport'], responsibility: 'evacuation' },
  shelter_in_place: { capabilities: ['evacuation_transport'], responsibility: 'evacuation' },
  medical_standby: { capabilities: ['medical_transport', 'advanced_life_support'], responsibility: 'medical' },
  road_closure: { capabilities: ['traffic_control'], responsibility: 'traffic_control' },
  traffic_control_point: { capabilities: ['traffic_control'], responsibility: 'traffic_control' },
  establish_command_post: { capabilities: ['command_and_control', 'communications'], responsibility: 'command' },
  reconnaissance: { capabilities: ['reconnaissance', 'aerial_recon'], responsibility: 'reconnaissance' },
  stage_resources: { capabilities: ['wildfire_attack'], responsibility: 'standby' },
  request_reinforcements: { capabilities: ['wildfire_attack'], responsibility: 'standby' },
  public_alert: { capabilities: [], responsibility: undefined },
  custom: { capabilities: [], responsibility: undefined },
};

/**
 * Up to `limit` vehicles that can do this action's job, not yet used anywhere else in the plan (two actions with the same
 * vehicle raise `resource_conflict`). Ground actions never suggest aircraft. Falls back to any unused vehicle of the action's
 * organization, then to any unused vehicle, so the button always offers something on a small fleet.
 */
export function suggestVehicles(action: Action, vehicles: Vehicle[], usedIds: Set<string>, limit = 3): Vehicle[] {
  const type = String((action as Json).type ?? '');
  const wanted = CAPABILITY_BY_TYPE[type]?.capabilities ?? [];
  const organizationId = String((action as Json).organizationId ?? '');
  const isAerialAction = type === 'air_support_request';
  const free = vehicles.filter((v) => !usedIds.has(`vehicle:${v.id}`));
  const ground = (list: Vehicle[]) => list.filter((v) => isAerialAction || !v.aerial);
  const matching = ground(free.filter((v) => (v.capabilities ?? []).some((c) => wanted.includes(String(c)))));
  const sameOrg = ground(free.filter((v) => String(v.organizationId) === organizationId));
  const pool = matching.length >= 2 ? matching : [...matching, ...sameOrg.filter((v) => !matching.includes(v)), ...free.filter((v) => !matching.includes(v) && !sameOrg.includes(v))];
  return pool.slice(0, limit);
}

/** The `responsibility` the backend expects for this action type (undefined = let the server default it). */
export function responsibilityFor(action: Action): Responsibility | undefined {
  return CAPABILITY_BY_TYPE[String((action as Json).type ?? '')]?.responsibility;
}

/** Whether this action carries no means at all — the editor explains why instead of showing a bare empty list. */
export function hasNoResources(action: Action): boolean {
  return !Array.isArray((action as Json).resources) || ((action as Json).resources as unknown[]).length === 0;
}

export function addVehicleAssignment(action: Action, vehicle: Vehicle, responsibility?: Responsibility): Action {
  const next = cloneAction(action) as Json;
  const resources = Array.isArray(next.resources) ? (next.resources as ResourceAssignment[]) : [];
  if (resources.some((r) => r.resourceType === 'vehicle' && r.resourceId === vehicle.id)) return next as Action;
  const assignment: ResourceAssignment = {
    resourceType: 'vehicle',
    resourceId: vehicle.id as string,
    personnel: Math.max(1, vehicle.minimumCrew ?? 1),
    ...(responsibility ? { responsibility } : {}),
  };
  next.resources = [...resources, assignment];
  return next as Action;
}

/** Adds a whole suggestion batch ("Sugerir meios"), skipping vehicles the action already carries. */
export function addVehicleSuggestions(action: Action, vehicles: Vehicle[], responsibility?: Responsibility): Action {
  let next = action;
  for (const vehicle of vehicles) next = addVehicleAssignment(next, vehicle, responsibility);
  return next;
}

export function removeAssignment(action: Action, index: number): Action {
  const next = cloneAction(action) as Json;
  const resources = Array.isArray(next.resources) ? (next.resources as ResourceAssignment[]) : [];
  next.resources = resources.filter((_, i) => i !== index);
  return next as Action;
}

export function updateAssignment(action: Action, index: number, patch: Partial<ResourceAssignment>): Action {
  const next = cloneAction(action) as Json;
  const resources = Array.isArray(next.resources) ? (next.resources as ResourceAssignment[]) : [];
  next.resources = resources.map((r, i) => (i === index ? { ...r, ...patch } : r));
  return next as Action;
}

/** Drop an action and any `dependsOn` pointer that would now dangle (the validator reports unknown dependencies as errors). */
export function removeAction(actions: Action[], index: number): Action[] {
  const removed = actions[index]?.id;
  return actions.filter((_, i) => i !== index).map((action) => {
    const next = cloneAction(action) as Json;
    if (removed && Array.isArray(next.dependsOn)) next.dependsOn = (next.dependsOn as string[]).filter((id) => id !== removed);
    return next as Action;
  });
}
