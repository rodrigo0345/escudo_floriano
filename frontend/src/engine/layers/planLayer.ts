import * as THREE from 'three';

import type { Plan, PlanAction } from '@/api';
import { actionWindows } from '@/domain/actionTiming';
import { lineStringCoordinates, polygonRings, type LonLat } from '@/domain/geojson';
import type { Georef, WorldPoint } from '@/domain/georef';
import { decisionKey, whereOf } from '@/domain/planDecisions';

import type { Pickable } from '../picking';
import { textSprite } from '../sprites';

export type PlanKind =
  | 'fire_line'
  | 'fuel_break'
  | 'aerial_drop'
  | 'crew_deployment'
  | 'structure_protection'
  | 'evacuation'
  | 'road_closure'
  | 'traffic_control'
  | 'support';

export const PLAN_KINDS: Record<PlanKind, { label: string; color: string }> = {
  fire_line: { label: 'Linhas de fogo', color: '#ffd400' },
  fuel_break: { label: 'Faixas corta-fogo', color: '#c8873a' },
  aerial_drop: { label: 'Largadas aéreas', color: '#3b8cff' },
  crew_deployment: { label: 'Zonas das equipas', color: '#33e06a' },
  structure_protection: { label: 'Defesa de edifícios', color: '#c07bff' },
  evacuation: { label: 'Evacuações, rotas e abrigos', color: '#ff7a1a' },
  road_closure: { label: 'Cortes de estrada (laranja: emergência passa)', color: '#ff3b3b' },
  traffic_control: { label: 'Controlo de trânsito', color: '#4da3ff' },
  support: { label: 'INEM e posto de comando', color: '#ff4fd8' },
};
const KIND_ORDER = Object.keys(PLAN_KINDS) as PlanKind[];

// Half-widths in world units (1 unit = 10 m): a fire line is ~50 m wide on screen so it reads from the whole-map view.
const LINE_HALF_WIDTH = 2.5;
const DROP_HALF_WIDTH = 4;
const OUTLINE_HALF_WIDTH = 1.1;
const ROUTE_HALF_WIDTH = 1;
const CLOSURE_HALF_WIDTH = 1.7; // a little wider than the road it covers
const EMERGENCY_PASSES = '#ff9f1a';
const PLACE_RING_M = 160;
const LIFT = 2.2;
const FOCUS_ROUTE = '#00e5ff';
// A picked decision's crew safety: the escape route as a dashed arrow ending at its safety zone, and the lookout, each labelled.
const SAFE_ZONE = '#3dff7a';
const LOOKOUT = '#ffe14d';
const DASH = 5; // world units (≈ 50 m)
const GAP = 3.5;
const ARROW_LENGTH = 9;
const ARROW_HALF_WIDTH = 4.5;
const LABEL_LIFT = 14;
const LABEL_MAX_CHARS = 48;
// The plan is an annotation over the map, not a wall over it: translucent at rest, so roads, places and the fire still read through it.
const LINE_ALPHA = 0.55;
const FILL_ALPHA = 0.14;
const OUTLINE_ALPHA = 0.6;
const ROUTE_ALPHA = 0.45;
const CLOSURE_ALPHA = 0.8; // a road closure stays stronger than a fire line: it is a safety order

const FIRE_LINE_COLORS: Record<string, string> = { handline: '#ffd400', wet_line: '#00e5ff', machine: '#ff9f1a' };
const DROP_COLORS: Record<string, string> = { water: '#3b8cff', retardant: '#ff4fa3', foam: '#f4f4f4' };

/** When an effect works (minutes of the run) and whose it is: the layer brightens it while it works and dims it before and after. */
interface Window {
  action: string;
  start: number;
  end: number;
}

/** A run of vertices `[from, to)` drawn at `alpha` for the effect of `action`. */
interface Span extends Window {
  from: number;
  to: number;
  alpha: number;
}

const UPCOMING = 0.22; // share of its alpha before it starts, when the whole plan is shown
const DONE = 0.07; // ...and once it is over, or when another action is focused
const WORKING = 1.35; // a working effect is drawn stronger than the plan at rest, without turning opaque

/** Alpha of a timed element at minute `t`: `onlyActive` hides what is not happening now (nothing faint left on the map), else it dims it. */
function alphaAt(s: Span, t: number | null, focus: ReadonlySet<string> | null, onlyActive: boolean): number {
  if (focus) return focus.has(s.action) ? Math.min(1, s.alpha * 2.2) : onlyActive && t !== null ? 0 : s.alpha * DONE;
  if (t === null) return s.alpha;
  const active = t >= s.start && t < s.end;
  if (active) return Math.min(1, s.alpha * WORKING);
  if (onlyActive) return 0;
  return t < s.start ? s.alpha * UPCOMING : s.alpha * DONE;
}

/** Triangles accumulated for one mesh; `tips[i]` is the tooltip of triangle `i` (what a hover on that face shows). */
class MeshAcc {
  readonly positions: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];
  readonly tips: string[] = [];
  private readonly spans: Span[] = [];
  private geometry: THREE.BufferGeometry | null = null;

  private span(from: number, alpha: number, win?: Window): void {
    if (win) this.spans.push({ ...win, from, to: this.positions.length / 3, alpha });
  }

  /** Re-weights each timed element's alpha for minute `t` (`null`: as drawn); a focused decision is drawn at full strength whatever the time. */
  retime(t: number | null, focus: ReadonlySet<string> | null, onlyActive: boolean): void {
    const attr = this.geometry?.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!attr || !this.spans.length) return;
    for (const s of this.spans) {
      const a = alphaAt(s, t, focus, onlyActive);
      for (let v = s.from; v < s.to; v++) attr.setW(v, a);
    }
    attr.needsUpdate = true;
  }

  /** A ribbon of constant half-width along `points` (like the road layer), `closed` joins the last point back to the first. */
  ribbon(points: WorldPoint[], halfWidth: number, color: THREE.Color, alpha: number, tip: string, closed = false, win?: Window): void {
    const pts = closed && points.length > 2 ? [...points, points[0]] : points;
    if (pts.length < 2) return;
    const start = this.positions.length / 3;
    pts.forEach((p, i) => {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      let dx = b[0] - a[0];
      let dz = b[2] - a[2];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      this.positions.push(p[0] - dz * halfWidth, p[1], p[2] + dx * halfWidth, p[0] + dz * halfWidth, p[1], p[2] - dx * halfWidth);
      this.colors.push(color.r, color.g, color.b, alpha, color.r, color.g, color.b, alpha);
      if (i < pts.length - 1) {
        const k = start + i * 2;
        this.indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        this.tips.push(tip, tip);
      }
    });
    this.span(start, alpha, win);
  }

  /** A translucent convex polygon as a fan from its centroid (every vertex follows the terrain, so it drapes over hills). */
  fan(ring: WorldPoint[], color: THREE.Color, alpha: number, tip: string, win?: Window): void {
    const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][2] === ring[ring.length - 1][2] ? ring.slice(0, -1) : ring;
    if (pts.length < 3) return;
    const start = this.positions.length / 3;
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p[2], 0) / pts.length;
    this.positions.push(cx, cy, cz);
    this.colors.push(color.r, color.g, color.b, alpha);
    pts.forEach((p) => {
      this.positions.push(p[0], p[1], p[2]);
      this.colors.push(color.r, color.g, color.b, alpha);
    });
    for (let i = 0; i < pts.length; i++) {
      this.indices.push(start, start + 1 + i, start + 1 + ((i + 1) % pts.length));
      this.tips.push(tip);
    }
    this.span(start, alpha, win);
  }

  build(renderOrder: number): THREE.Mesh | null {
    if (!this.indices.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 4));
    geometry.setIndex(this.indices);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -6,
        polygonOffsetUnits: -6,
      }),
    );
    mesh.renderOrder = renderOrder;
    mesh.userData.tipForFace = (face: number) => this.tips[face] ?? '';
    this.geometry = geometry;
    return mesh;
  }
}

/** Fixed-size points (patrols, shelters, lookouts...) with their time windows, faded like the meshes. */
class PointAcc {
  readonly positions: number[] = [];
  readonly colors: number[] = [];
  readonly tips: string[] = [];
  private readonly spans: Span[] = [];
  private geometry: THREE.BufferGeometry | null = null;

  add(p: WorldPoint, color: THREE.Color, tip: string, win?: Window): void {
    const index = this.tips.length;
    this.positions.push(p[0], p[1], p[2]);
    this.colors.push(color.r, color.g, color.b, 1);
    this.tips.push(tip);
    if (win) this.spans.push({ ...win, from: index, to: index + 1, alpha: 1 });
  }

  retime(t: number | null, focus: ReadonlySet<string> | null, onlyActive: boolean): void {
    const attr = this.geometry?.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!attr || !this.spans.length) return;
    for (const s of this.spans) attr.setW(s.from, alphaAt(s, t, focus, onlyActive));
    attr.needsUpdate = true;
  }

  build(): THREE.Points | null {
    if (!this.tips.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 4));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, vertexColors: true, transparent: true, depthTest: false }));
    points.renderOrder = 8;
    points.userData.tipFor = (i: number) => this.tips[i] ?? '';
    this.geometry = geometry;
    return points;
  }
}

interface Bucket {
  ribbons: MeshAcc;
  fills: MeshAcc;
  markers: PointAcc;
}

const tipOf = (action: PlanAction, win?: Window, facts = ''): string => {
  const why = (action.rationale ?? '').replace(/\s+/g, ' ').trim();
  const when = win ? ` · trabalha T+${Math.round(win.start)}→${Number.isFinite(win.end) ? `T+${Math.round(win.end)}` : 'fim'} min` : '';
  const head = `${action.title} · ${action.organizationId}${when}${facts}`;
  return why ? `${head} — ${why.length > 230 ? `${why.slice(0, 230)}…` : why}` : head;
};

type Effect = NonNullable<PlanAction['simulationEffects']>[number];
const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** When an effect works: from its `start` (minutes of the run) for its duration; a fire line or fuel break stays once made, a defence lasts the action's stay. */
function windowOf(action: PlanAction, effect: Effect): Window | undefined {
  const e = effect as unknown as Record<string, unknown>;
  const start = finite((e.start as { offsetMinutes?: number } | undefined)?.offsetMinutes);
  if (start === undefined) return undefined;
  const lasting = e.type === 'fire_line' || e.type === 'fuel_removal';
  const stay = finite(e.durationMinutes) ?? finite(e.effectDurationMinutes) ?? (lasting ? Infinity : finite(action.expectedDurationMinutes) ?? 60);
  return { action: action.id as string, start, end: start + stay };
}

/** ` · 35 op. · 1 veíc. · 3000 L · eficácia 83%` for an effect that has those numbers. */
function effectFacts(effect: Effect): string {
  const e = effect as unknown as Record<string, unknown>;
  const parts: string[] = [];
  if (finite(e.personnel)) parts.push(`${e.personnel} op.`);
  if (finite(e.vehicles)) parts.push(`${e.vehicles} veíc.`);
  if (finite(e.waterL)) parts.push(`${e.waterL} L`);
  const effectiveness = finite(e.effectiveness);
  if (effectiveness !== undefined) parts.push(`eficácia ${Math.round(effectiveness * 100)}%`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

/** A circle of `radiusM` around a point, as `[lon, lat]` (closed ring). */
function circleRing(lat: number, lon: number, radiusM: number, vertices = 20): LonLat[] {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring: LonLat[] = [];
  for (let i = 0; i < vertices; i++) {
    const a = (i / vertices) * Math.PI * 2;
    ring.push([lon + Math.cos(a) * dLon, lat + Math.sin(a) * dLat]);
  }
  ring.push(ring[0]);
  return ring;
}

/** `points` cut into dashes of `dash` world units with `gap` between them (measured on the ground plane). */
function dashes(points: WorldPoint[], dash: number, gap: number): WorldPoint[][] {
  const out: WorldPoint[][] = [];
  let current: WorldPoint[] = [];
  let drawing = true;
  let left = dash;
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
    let at = 0;
    if (drawing && !current.length) current.push(a);
    while (length - at > left) {
      at += left;
      const k = at / length;
      const p: WorldPoint = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
      if (drawing) {
        current.push(p);
        out.push(current);
        current = [];
      } else current = [p];
      drawing = !drawing;
      left = drawing ? dash : gap;
    }
    left -= length - at;
    if (drawing) current.push(b);
  }
  if (drawing && current.length > 1) out.push(current);
  return out;
}

/** A triangle pointing along the last segment of `points`, its tip at the last point. */
function arrowHead(points: WorldPoint[]): WorldPoint[] | null {
  if (points.length < 2) return null;
  const [a, tip] = [points[points.length - 2], points[points.length - 1]];
  const length = Math.hypot(tip[0] - a[0], tip[2] - a[2]);
  if (!length) return null;
  const [dx, dz] = [(tip[0] - a[0]) / length, (tip[2] - a[2]) / length];
  const base: WorldPoint = [tip[0] - dx * ARROW_LENGTH, tip[1], tip[2] - dz * ARROW_LENGTH];
  return [
    [base[0] - dz * ARROW_HALF_WIDTH, base[1], base[2] + dx * ARROW_HALF_WIDTH],
    tip,
    [base[0] + dz * ARROW_HALF_WIDTH, base[1], base[2] - dx * ARROW_HALF_WIDTH],
  ];
}

const shorten = (text: string): string => (text.length > LABEL_MAX_CHARS ? `${text.slice(0, LABEL_MAX_CHARS - 1)}…` : text);

/**
 * What the agents' plan does, drawn on the terrain: fire lines across the fire's path, aerial-drop curtains, crew zones,
 * building defence and evacuation areas. Hover shows the action and the agent's reason. The plan's `simulationEffects` are what
 * the backend simulated, so this is what was run. The timed effects follow the playback (`setTime`): bright while the crew works
 * there, faint before it arrives and after it leaves. A decision picked in the panel (`setFocus`: every action sharing its type and
 * title, i.e. all its units) is outlined with the roads its units take, labelled, and shows its crews' escape routes as dashed
 * arrows to their labelled safety zones and lookouts (drawn only then: forty attacks' escape routes at once read as noise).
 */
export class PlanLayer {
  readonly group = new THREE.Group();
  readonly pickables: Pickable[] = [];
  readonly counts: Record<PlanKind, number> = {
    fire_line: 0,
    fuel_break: 0,
    aerial_drop: 0,
    crew_deployment: 0,
    structure_protection: 0,
    evacuation: 0,
    road_closure: 0,
    traffic_control: 0,
    support: 0,
  };
  private readonly kindGroups = new Map<PlanKind, THREE.Group>();
  private readonly hidden = new Set<PlanKind>();
  private readonly listeners = new Set<() => void>();
  private readonly accs: (MeshAcc | PointAcc)[] = [];
  private onlyActive = true;
  private readonly focusGroup = new THREE.Group();
  private plan: Plan | null = null;
  private time: number | null = null;
  private focus: string | null = null;

  constructor(private readonly geo: Georef) {}

  /** Called after every `setPlan`, so the legend (React) can re-read `counts` once the layer is built. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /**
   * `places` maps a place/facility id to where it is (a `structure_protection` effect names the place, not a shape);
   * `roadGeometry` gives a road's `[lon, lat]` points by id (a `road_closure` action names roads, not a shape).
   */
  setPlan(plan: Plan | null, places: ReadonlyMap<string, { lat: number; lon: number }>, roadGeometry?: (id: string) => LonLat[]): void {
    this.clear();
    if (!plan) return;
    const buckets = new Map<PlanKind, Bucket>(KIND_ORDER.map((k) => [k, { ribbons: new MeshAcc(), fills: new MeshAcc(), markers: new PointAcc() }]));
    const world = (ring: LonLat[]): WorldPoint[] => ring.map(([lon, lat]) => this.geo.world(lat, lon, LIFT));
    // when each action happens (the backend's own timing): closures, patrols, escape routes and markers appear only while their action is under way
    const windows = actionWindows(plan);
    const whenOf = (action: PlanAction): Window | undefined => {
      const w = windows.get(action.id as string);
      return w ? { action: action.id as string, start: w.start, end: w.end } : undefined;
    };

    const shape = (kind: PlanKind, geometry: Parameters<typeof lineStringCoordinates>[0], color: THREE.Color, tip: string, width: number, win?: Window) => {
      const b = buckets.get(kind)!;
      if (geometry?.type === 'LineString') {
        b.ribbons.ribbon(world(lineStringCoordinates(geometry)), width, color, LINE_ALPHA, tip, false, win);
        this.counts[kind]++;
      } else {
        const rings = polygonRings(geometry);
        rings.forEach((ring) => {
          b.fills.fan(world(ring), color, FILL_ALPHA, tip, win);
          b.ribbons.ribbon(world(ring), OUTLINE_HALF_WIDTH, color, OUTLINE_ALPHA, tip, true, win);
        });
        if (rings.length) this.counts[kind]++;
      }
    };
    const marker = (lat: number, lon: number, color: THREE.Color, tip: string, kind: PlanKind, win?: Window) => {
      buckets.get(kind)!.markers.add(this.geo.world(lat, lon, 3), color, tip, win);
      this.counts[kind]++;
    };
    const placeRing = (id: string | undefined): LonLat[] | null => {
      const at = id ? places.get(id) : undefined;
      return at ? circleRing(at.lat, at.lon, PLACE_RING_M) : null;
    };

    for (const action of plan.actions) {
      const when = whenOf(action);
      const tip = tipOf(action, when);
      for (const effect of action.simulationEffects ?? []) {
        const win = windowOf(action, effect);
        const effectTip = win ? tipOf(action, win, effectFacts(effect)) : tip;
        switch (effect.type) {
          case 'fire_line':
            shape('fire_line', effect.geometry, new THREE.Color(FIRE_LINE_COLORS[effect.method ?? ''] ?? PLAN_KINDS.fire_line.color), effectTip, LINE_HALF_WIDTH, win);
            break;
          case 'aerial_drop':
            shape('aerial_drop', effect.geometry, new THREE.Color(DROP_COLORS[effect.agent ?? ''] ?? PLAN_KINDS.aerial_drop.color), effectTip, DROP_HALF_WIDTH, win);
            break;
          case 'crew_deployment':
            shape('crew_deployment', effect.geometry, new THREE.Color(PLAN_KINDS.crew_deployment.color), effectTip, LINE_HALF_WIDTH, win);
            break;
          case 'fuel_removal':
            shape('fuel_break', effect.geometry, new THREE.Color(PLAN_KINDS.fuel_break.color), effectTip, LINE_HALF_WIDTH, win);
            break;
          case 'structure_protection': {
            const color = new THREE.Color(PLAN_KINDS.structure_protection.color);
            const ring = placeRing(effect.placeId);
            if (effect.geometry) shape('structure_protection', effect.geometry, color, effectTip, LINE_HALF_WIDTH, win);
            else if (ring) {
              const b = buckets.get('structure_protection')!;
              b.fills.fan(world(ring), color, FILL_ALPHA, effectTip, win);
              b.ribbons.ribbon(world(ring), OUTLINE_HALF_WIDTH, color, OUTLINE_ALPHA, effectTip, true, win);
              this.counts.structure_protection++;
            }
            break;
          }
          case 'evacuation': {
            const color = new THREE.Color(PLAN_KINDS.evacuation.color);
            if (effect.geometry) shape('evacuation', effect.geometry, color, tip, LINE_HALF_WIDTH, when);
            else
              for (const id of effect.placeIds ?? []) {
                const ring = placeRing(id);
                if (!ring) continue;
                const b = buckets.get('evacuation')!;
                b.fills.fan(world(ring), color, FILL_ALPHA, tip, when);
                b.ribbons.ribbon(world(ring), OUTLINE_HALF_WIDTH, color, OUTLINE_ALPHA, tip, true, when);
                this.counts.evacuation++;
              }
            break;
          }
          default:
            break; // road closures, backfires...: nothing to draw yet
        }
      }
      if (action.type === 'road_closure') {
        // orange where emergency vehicles may still pass (the closure's exemption), red where nobody does
        const color = new THREE.Color((action.exemptions ?? []).includes('emergency_vehicles') ? EMERGENCY_PASSES : PLAN_KINDS.road_closure.color);
        let drawn = false;
        for (const id of action.roadIds ?? []) {
          const points = roadGeometry?.(id) ?? [];
          if (points.length < 2) continue;
          buckets.get('road_closure')!.ribbons.ribbon(world(points), CLOSURE_HALF_WIDTH, color, CLOSURE_ALPHA, tip, false, when);
          drawn = true;
        }
        if (drawn) this.counts.road_closure++;
      }
      if (action.type === 'traffic_control_point' && action.position) {
        marker(action.position.lat, action.position.lon, new THREE.Color(PLAN_KINDS.traffic_control.color), tip, 'traffic_control', when);
      }
      if (action.type === 'evacuation') {
        // Proteção Civil's part of an evacuation: the road to the shelter and the shelter itself
        const orange = new THREE.Color(PLAN_KINDS.evacuation.color);
        for (const route of action.routes ?? []) {
          buckets.get('evacuation')!.ribbons.ribbon(world(lineStringCoordinates(route.geometry)), ROUTE_HALF_WIDTH, orange, ROUTE_ALPHA, `Rota de evacuação · ${tip}`, false, when);
        }
        for (const shelter of action.shelters ?? []) marker(shelter.position.lat, shelter.position.lon, orange, `Abrigo: ${shelter.name ?? ''} · ${action.title}`, 'evacuation', when);
      }
      if (action.type === 'medical_standby') {
        const pink = new THREE.Color(PLAN_KINDS.support.color);
        for (const target of action.positions ?? []) if (target.position) marker(target.position.lat, target.position.lon, pink, tip, 'support', when);
      }
      if (action.type === 'establish_command_post' && action.location.position) {
        marker(action.location.position.lat, action.location.position.lon, new THREE.Color(PLAN_KINDS.support.color), tip, 'support', when);
      }
    }

    KIND_ORDER.forEach((kind) => {
      const b = buckets.get(kind)!;
      const kindGroup = new THREE.Group();
      for (const [acc, order] of [[b.fills, 6], [b.ribbons, 7]] as const) {
        const mesh = acc.build(order);
        if (!mesh) continue;
        this.accs.push(acc);
        kindGroup.add(mesh);
        this.pickables.push(mesh as unknown as Pickable);
      }
      const points = b.markers.build();
      if (points) {
        this.accs.push(b.markers);
        kindGroup.add(points);
        this.pickables.push(points as unknown as Pickable);
      }
      kindGroup.visible = !this.hidden.has(kind);
      this.kindGroups.set(kind, kindGroup);
      this.group.add(kindGroup);
    });
    this.plan = plan;
    this.retime();
    this.drawFocus();
    this.listeners.forEach((listener) => listener());
  }

  /** The playback minute: crews and drops are bright while they work, faint before they start and after they leave. */
  setTime(t: number | null): void {
    if (t === this.time) return;
    this.time = t;
    this.retime();
  }

  /** One action picked in the panel: its decision (every action of the same type and title) at full strength, the rest dimmed. */
  setFocus(actionId: string | null): void {
    if (actionId === this.focus) return;
    this.focus = actionId;
    this.retime();
    this.drawFocus();
  }

  /** The focused action and its siblings: the agents publish one action per unit, and the panel picks the decision, not the unit. */
  private focused(): PlanAction[] {
    const picked = this.focus ? this.plan?.actions.find((a) => a.id === this.focus) : undefined;
    if (!picked) return [];
    const key = decisionKey(picked);
    return (this.plan?.actions ?? []).filter((a) => decisionKey(a) === key);
  }

  private retime(): void {
    const actions = this.focused();
    const focus = actions.length ? new Set(actions.map((a) => a.id as string)) : null;
    for (const acc of this.accs) acc.retime(this.time, focus, this.onlyActive);
  }

  /** Only what is happening at the playback minute (the default), or the whole plan with what is not under way dimmed. */
  isOnlyActive(): boolean {
    return this.onlyActive;
  }

  setOnlyActive(on: boolean): void {
    if (on === this.onlyActive) return;
    this.onlyActive = on;
    this.retime();
    this.listeners.forEach((listener) => listener());
  }

  private clearFocus(): void {
    for (const child of this.focusGroup.children) {
      if (child instanceof THREE.Sprite) {
        // sprites share one geometry across the scene: free only this label's texture and material
        child.material.map?.dispose();
        child.material.dispose();
        continue;
      }
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose();
      const at = this.pickables.indexOf(mesh as unknown as Pickable);
      if (at >= 0) this.pickables.splice(at, 1);
    }
    this.focusGroup.clear();
    this.group.remove(this.focusGroup);
  }

  private label(text: string, lat: number, lon: number, color: string): void {
    const sprite = textSprite(text, { color, bg: 'rgba(8,12,16,.82)', size: 24 });
    sprite.position.copy(new THREE.Vector3(...this.geo.world(lat, lon, LABEL_LIFT)));
    this.focusGroup.add(sprite);
  }

  private drawFocus(): void {
    this.clearFocus();
    const actions = this.focused();
    if (!actions.length) return;
    const acc = new MeshAcc();
    const world = (ring: LonLat[]): WorldPoint[] => ring.map(([lon, lat]) => this.geo.world(lat, lon, LIFT + 0.4));
    const white = new THREE.Color('#ffffff');
    const green = new THREE.Color(SAFE_ZONE);
    const labelled = new Set<string>();
    const once = (kind: string, lat: number, lon: number) => {
      const key = `${kind}:${lat.toFixed(4)},${lon.toFixed(4)}`;
      if (labelled.has(key)) return false;
      labelled.add(key);
      return true;
    };

    for (const action of actions) {
      const tip = tipOf(action);
      for (const r of action.resources ?? []) {
        const route = (r as { route?: Parameters<typeof lineStringCoordinates>[0] }).route;
        if (route) acc.ribbon(world(lineStringCoordinates(route)), ROUTE_HALF_WIDTH * 1.6, new THREE.Color(FOCUS_ROUTE), 0.95, `Caminho do meio · ${tip}`);
      }
      for (const effect of action.simulationEffects ?? []) {
        if (effect.geometry?.type === 'LineString') acc.ribbon(world(lineStringCoordinates(effect.geometry)), LINE_HALF_WIDTH * 1.3, white, 1, tip);
        else for (const ring of polygonRings(effect.geometry)) acc.ribbon(world(ring), OUTLINE_HALF_WIDTH * 1.8, white, 1, tip, true);
      }
      if (action.type !== 'fire_attack') continue;
      // the crew's way out: a dashed arrow from where it works to its safety zone
      for (const route of action.escapeRoutes ?? []) {
        const points = world(lineStringCoordinates(route));
        for (const dash of dashes(points, DASH, GAP)) acc.ribbon(dash, ROUTE_HALF_WIDTH * 1.2, green, 0.95, `Via de fuga da equipa · ${action.title}`);
        const head = arrowHead(points);
        if (head) acc.fan(head, green, 0.95, `Via de fuga da equipa · ${action.title}`);
      }
      for (const zone of action.safetyZones ?? []) if (once('safe', zone.lat, zone.lon)) this.label('Zona segura', zone.lat, zone.lon, SAFE_ZONE);
      for (const look of action.lookouts ?? []) if (once('look', look.lat, look.lon)) this.label('Vigia', look.lat, look.lon, LOOKOUT);
    }
    const where = actions.map(whereOf).find(Boolean);
    if (where) this.label(shorten(actions[0].title), where.lat, where.lon, '#ffffff');

    const mesh = acc.build(9);
    if (mesh) {
      this.focusGroup.add(mesh);
      this.pickables.push(mesh as unknown as Pickable);
    }
    if (this.focusGroup.children.length) this.group.add(this.focusGroup);
  }

  isVisible(kind: PlanKind): boolean {
    return !this.hidden.has(kind);
  }

  setVisible(kind: PlanKind, on: boolean): void {
    if (on) this.hidden.delete(kind);
    else this.hidden.add(kind);
    const group = this.kindGroups.get(kind);
    if (group) group.visible = on;
  }

  private clear(): void {
    this.clearFocus();
    this.group.children.forEach((child) =>
      child.traverse((o) => {
        const object = o as THREE.Mesh | THREE.Points;
        object.geometry?.dispose();
        (object.material as THREE.Material | undefined)?.dispose();
      }),
    );
    this.group.clear();
    this.kindGroups.clear();
    this.accs.length = 0;
    this.plan = null;
    this.pickables.length = 0;
    KIND_ORDER.forEach((k) => (this.counts[k] = 0));
  }

  dispose(): void {
    this.clear();
  }
}
