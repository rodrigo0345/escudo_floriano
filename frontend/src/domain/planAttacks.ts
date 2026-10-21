import type { LatLon, Organization, PersonnelPool, Plan, PlanAction, Station, Vehicle } from '@/api';

/**
 * The combat side of an agents' plan, one row per action that works on the fire (ground attack, air drops, fuel breaks, building defence):
 * who goes, from where, when they leave, arrive and work, how hard they hit (the effect's `effectiveness`) and why. Everything comes from
 * the plan the backend stored and simulated; times are minutes of the plan's run (the effects' `start.offsetMinutes`, as `planUnits` reads them).
 */

export type AttackKind = 'ground' | 'air' | 'fuel' | 'defence';

export const ATTACK_KINDS: Record<AttackKind, { label: string; color: string }> = {
  ground: { label: 'Ataque terrestre', color: '#33e06a' },
  air: { label: 'Meios aéreos', color: '#3b8cff' },
  fuel: { label: 'Faixas corta-fogo', color: '#c8873a' },
  defence: { label: 'Defesa de edifícios', color: '#c07bff' },
};

export interface AttackRow {
  id: string;
  kind: AttackKind;
  title: string;
  /** The effect label ("Ataque direto cabeça"), shorter than the title. */
  label: string;
  orgId: string;
  orgName: string;
  /** Callsigns of the vehicles, or the crew's name. */
  units: string;
  fromStation: string;
  reinforcement: boolean;
  personnel: number;
  vehicles: number;
  waterL: number;
  /** Minute the unit leaves its station (its trigger), arrives (leaves + ETA), starts and stops working on the fire. */
  leaves: number;
  arrives: number;
  start: number;
  end: number;
  /** 0–1: how much the effect slows the fire where it works (strength × water duty × fatigue, see agents `duty.py`). */
  effectiveness: number;
  /** Re-planning wave (`[T+90]` in the title), or null for the first plan. */
  wave: number | null;
  where: LatLon | null;
  rationale: string;
  safetyNotes: string;
  expectedEffect: string;
  dependsOnEvacuation: boolean;
}

export interface AttackResources {
  vehicles: Vehicle[];
  stations: Station[];
  pools: PersonnelPool[];
  organizations: Organization[];
}

type Json = Record<string, unknown>;
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const KIND_OF_EFFECT: Record<string, AttackKind> = {
  crew_deployment: 'ground',
  fire_line: 'ground',
  aerial_drop: 'air',
  fuel_removal: 'fuel',
  structure_protection: 'defence',
};

function centre(geometry: unknown): LatLon | null {
  const g = geometry as { type?: string; coordinates?: unknown } | null | undefined;
  let pts: number[][] = [];
  if (g?.type === 'Point') pts = [g.coordinates as number[]];
  else if (g?.type === 'LineString') pts = g.coordinates as number[][];
  else if (g?.type === 'Polygon') pts = (g.coordinates as number[][][])[0] ?? [];
  if (!pts.length) return null;
  return { lat: pts.reduce((s, p) => s + p[1], 0) / pts.length, lon: pts.reduce((s, p) => s + p[0], 0) / pts.length };
}

/** Minute the action's unit leaves: an `at_time` trigger, else at once (an `on_action_complete` waits for the evacuation, which the effect start already includes). */
function leavesOf(action: Json): number {
  const trigger = action.trigger as { kind?: string; at?: { offsetMinutes?: number } } | undefined;
  return trigger?.kind === 'at_time' ? num(trigger.at?.offsetMinutes) : 0;
}

export function attacksOf(plan: Plan, res: AttackResources, places?: ReadonlyMap<string, LatLon>): AttackRow[] {
  const vehicleOf = new Map(res.vehicles.map((v) => [v.id as string, v]));
  const poolOf = new Map(res.pools.map((p) => [p.id as string, p]));
  const stationOf = new Map(res.stations.map((s) => [s.id as string, s]));
  const orgOf = new Map(res.organizations.map((o) => [o.id as string, o]));
  const rows: AttackRow[] = [];

  for (const raw of plan.actions as PlanAction[]) {
    const action = raw as unknown as Json;
    const effects = ((action.simulationEffects as Json[] | undefined) ?? []).filter((e) => KIND_OF_EFFECT[String(e.type)]);
    if (!effects.length) continue;
    const first = effects[0];
    const kind = KIND_OF_EFFECT[String(first.type)];
    const resources = (action.resources as Json[] | undefined) ?? [];
    const starts = effects.map((e) => num((e.start as Json | undefined)?.offsetMinutes, Number.NaN)).filter(Number.isFinite);
    const stay = num(action.expectedDurationMinutes, 60);
    const ends = effects.map((e) => {
      const s = num((e.start as Json | undefined)?.offsetMinutes, Number.NaN);
      return s + num(e.durationMinutes, num(e.effectDurationMinutes, stay));
    });
    const leaves = leavesOf(action);
    const eta = Math.max(0, ...resources.map((r) => num(r.etaMinutes)));
    const start = starts.length ? Math.min(...starts) : leaves + eta;
    const end = Math.max(start, ...ends.filter(Number.isFinite));

    const names: string[] = [];
    let personnel = 0;
    let vehicles = 0;
    let station = '';
    let reinforcement = false;
    for (const r of resources) {
      const id = String(r.resourceId);
      const vehicle = r.resourceType === 'vehicle' ? vehicleOf.get(id) : undefined;
      const pool = r.resourceType === 'personnel_pool' ? poolOf.get(id) : undefined;
      const from = stationOf.get(String(r.fromStationId ?? vehicle?.stationId ?? pool?.stationId ?? ''))?.name ?? '';
      names.push(vehicle?.callsign ?? (pool ? `Equipa a pé (${num(r.personnel)})` : id));
      personnel += num(r.personnel);
      if (r.resourceType === 'vehicle') vehicles += 1;
      station ||= from;
      const org = orgOf.get(String(vehicle?.organizationId ?? pool?.organizationId ?? ''));
      if ((org?.tags ?? []).includes('reinforcement')) reinforcement = true;
    }
    const org = orgOf.get(String(action.organizationId));
    const wave = /^\[T\+(\d+)\]/.exec(String(action.title ?? ''));
    const placeAt = first.placeId ? places?.get(String(first.placeId)) : undefined;
    rows.push({
      id: String(action.id),
      kind,
      title: String(action.title ?? ''),
      label: String(first.label ?? action.title ?? ''),
      orgId: String(action.organizationId ?? ''),
      orgName: org?.shortName ?? org?.name ?? String(action.organizationId ?? ''),
      units: names.join(', ') || '—',
      fromStation: station,
      reinforcement,
      personnel,
      vehicles: Math.max(vehicles, num(first.vehicles)),
      waterL: effects.reduce((s, e) => Math.max(s, num(e.waterL)), 0),
      leaves,
      arrives: leaves + eta,
      start,
      end,
      effectiveness: Math.max(...effects.map((e) => num(e.effectiveness))),
      wave: wave ? Number(wave[1]) : null,
      where: centre(first.geometry) ?? placeAt ?? (action.anchorPoint as LatLon | undefined) ?? (action.position as LatLon | undefined) ?? null,
      rationale: String(action.rationale ?? ''),
      safetyNotes: String(action.safetyNotes ?? ''),
      expectedEffect: String(action.expectedEffect ?? ''),
      dependsOnEvacuation: ((action.dependsOn as string[] | undefined) ?? []).some((d) => d.startsWith('evap')),
    });
  }
  return rows.sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
}

/** Operatives working on the fire at each minute `0..minutes` (the curve the timeline draws). */
export function personnelByMinute(rows: AttackRow[], minutes: number): number[] {
  const out = new Array<number>(minutes + 1).fill(0);
  for (const r of rows) for (let t = Math.max(0, Math.floor(r.start)); t <= Math.min(minutes, Math.ceil(r.end) - 1); t++) out[t] += r.personnel;
  return out;
}
