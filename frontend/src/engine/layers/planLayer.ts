import * as THREE from 'three';

import type { Plan, PlanAction } from '@/api';
import { lineStringCoordinates, polygonRings, type LonLat } from '@/domain/geojson';
import type { Georef, WorldPoint } from '@/domain/georef';

import type { Pickable } from '../picking';

export type PlanKind = 'fire_line' | 'aerial_drop' | 'crew_deployment' | 'structure_protection' | 'evacuation' | 'safety';

export const PLAN_KINDS: Record<PlanKind, { label: string; color: string }> = {
  fire_line: { label: 'Linhas de fogo', color: '#ffd400' },
  aerial_drop: { label: 'Largadas aéreas', color: '#3b8cff' },
  crew_deployment: { label: 'Zonas das equipas', color: '#33e06a' },
  structure_protection: { label: 'Defesa de edifícios', color: '#c07bff' },
  evacuation: { label: 'Evacuações', color: '#ff7a1a' },
  safety: { label: 'Vias de fuga, zonas seguras, vigias', color: '#ffffff' },
};
const KIND_ORDER = Object.keys(PLAN_KINDS) as PlanKind[];

// Half-widths in world units (1 unit = 10 m): a fire line is ~50 m wide on screen so it reads from the whole-map view.
const LINE_HALF_WIDTH = 2.5;
const DROP_HALF_WIDTH = 4;
const OUTLINE_HALF_WIDTH = 1.1;
const ROUTE_HALF_WIDTH = 1;
const PLACE_RING_M = 160;
const LIFT = 2.2;

const FIRE_LINE_COLORS: Record<string, string> = { handline: '#ffd400', wet_line: '#00e5ff', machine: '#ff9f1a' };
const DROP_COLORS: Record<string, string> = { water: '#3b8cff', retardant: '#ff4fa3', foam: '#f4f4f4' };

/** Triangles accumulated for one mesh; `tips[i]` is the tooltip of triangle `i` (what a hover on that face shows). */
class MeshAcc {
  readonly positions: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];
  readonly tips: string[] = [];

  /** A ribbon of constant half-width along `points` (like the road layer), `closed` joins the last point back to the first. */
  ribbon(points: WorldPoint[], halfWidth: number, color: THREE.Color, alpha: number, tip: string, closed = false): void {
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
  }

  /** A translucent convex polygon as a fan from its centroid (every vertex follows the terrain, so it drapes over hills). */
  fan(ring: WorldPoint[], color: THREE.Color, alpha: number, tip: string): void {
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
    return mesh;
  }
}

interface Bucket {
  ribbons: MeshAcc;
  fills: MeshAcc;
  markers: { positions: number[]; colors: number[]; tips: string[] };
}

const tipOf = (action: PlanAction): string => {
  const why = (action.rationale ?? '').replace(/\s+/g, ' ').trim();
  const head = `${action.title} · ${action.organizationId} · ${action.priority ?? 'normal'}`;
  return why ? `${head} — ${why.length > 230 ? `${why.slice(0, 230)}…` : why}` : head;
};

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

/**
 * What the agents' plan does, drawn on the terrain: fire lines across the fire's path, aerial-drop curtains, crew zones,
 * building defence and evacuation areas, plus the escape routes / safety zones / lookouts of each attack. Hover shows the
 * action and the agent's reason. The plan's `simulationEffects` are what the backend simulated, so this is what was run.
 */
export class PlanLayer {
  readonly group = new THREE.Group();
  readonly pickables: Pickable[] = [];
  readonly counts: Record<PlanKind, number> = { fire_line: 0, aerial_drop: 0, crew_deployment: 0, structure_protection: 0, evacuation: 0, safety: 0 };
  private readonly kindGroups = new Map<PlanKind, THREE.Group>();
  private readonly hidden = new Set<PlanKind>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly geo: Georef) {}

  /** Called after every `setPlan`, so the legend (React) can re-read `counts` once the layer is built. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** `places` maps a place/facility id to where it is (a `structure_protection` effect names the place, not a shape). */
  setPlan(plan: Plan | null, places: ReadonlyMap<string, { lat: number; lon: number }>): void {
    this.clear();
    if (!plan) return;
    const buckets = new Map<PlanKind, Bucket>(KIND_ORDER.map((k) => [k, { ribbons: new MeshAcc(), fills: new MeshAcc(), markers: { positions: [], colors: [], tips: [] } }]));
    const world = (ring: LonLat[]): WorldPoint[] => ring.map(([lon, lat]) => this.geo.world(lat, lon, LIFT));

    const shape = (kind: PlanKind, geometry: Parameters<typeof lineStringCoordinates>[0], color: THREE.Color, tip: string, width: number) => {
      const b = buckets.get(kind)!;
      if (geometry?.type === 'LineString') {
        b.ribbons.ribbon(world(lineStringCoordinates(geometry)), width, color, 0.95, tip);
        this.counts[kind]++;
      } else {
        const rings = polygonRings(geometry);
        rings.forEach((ring) => {
          b.fills.fan(world(ring), color, 0.3, tip);
          b.ribbons.ribbon(world(ring), OUTLINE_HALF_WIDTH, color, 0.95, tip, true);
        });
        if (rings.length) this.counts[kind]++;
      }
    };
    const marker = (lat: number, lon: number, color: THREE.Color, tip: string) => {
      const m = buckets.get('safety')!.markers;
      m.positions.push(...this.geo.world(lat, lon, 3));
      m.colors.push(color.r, color.g, color.b);
      m.tips.push(tip);
      this.counts.safety++;
    };
    const placeRing = (id: string | undefined): LonLat[] | null => {
      const at = id ? places.get(id) : undefined;
      return at ? circleRing(at.lat, at.lon, PLACE_RING_M) : null;
    };

    for (const action of plan.actions) {
      const tip = tipOf(action);
      for (const effect of action.simulationEffects ?? []) {
        switch (effect.type) {
          case 'fire_line':
            shape('fire_line', effect.geometry, new THREE.Color(FIRE_LINE_COLORS[effect.method ?? ''] ?? PLAN_KINDS.fire_line.color), tip, LINE_HALF_WIDTH);
            break;
          case 'aerial_drop':
            shape('aerial_drop', effect.geometry, new THREE.Color(DROP_COLORS[effect.agent ?? ''] ?? PLAN_KINDS.aerial_drop.color), tip, DROP_HALF_WIDTH);
            break;
          case 'crew_deployment':
            shape('crew_deployment', effect.geometry, new THREE.Color(PLAN_KINDS.crew_deployment.color), tip, LINE_HALF_WIDTH);
            break;
          case 'structure_protection': {
            const color = new THREE.Color(PLAN_KINDS.structure_protection.color);
            const ring = placeRing(effect.placeId);
            if (effect.geometry) shape('structure_protection', effect.geometry, color, tip, LINE_HALF_WIDTH);
            else if (ring) {
              const b = buckets.get('structure_protection')!;
              b.fills.fan(world(ring), color, 0.3, tip);
              b.ribbons.ribbon(world(ring), OUTLINE_HALF_WIDTH, color, 0.95, tip, true);
              this.counts.structure_protection++;
            }
            break;
          }
          case 'evacuation': {
            const color = new THREE.Color(PLAN_KINDS.evacuation.color);
            if (effect.geometry) shape('evacuation', effect.geometry, color, tip, LINE_HALF_WIDTH);
            else
              for (const id of effect.placeIds ?? []) {
                const ring = placeRing(id);
                if (!ring) continue;
                const b = buckets.get('evacuation')!;
                b.fills.fan(world(ring), color, 0.3, tip);
                b.ribbons.ribbon(world(ring), OUTLINE_HALF_WIDTH, color, 0.95, tip, true);
                this.counts.evacuation++;
              }
            break;
          }
          default:
            break; // road closures, backfires...: nothing to draw yet
        }
      }
      if (action.type === 'fire_attack') {
        const white = new THREE.Color(PLAN_KINDS.safety.color);
        for (const route of action.escapeRoutes ?? []) {
          buckets.get('safety')!.ribbons.ribbon(world(lineStringCoordinates(route)), ROUTE_HALF_WIDTH, white, 0.85, `Via de fuga · ${tip}`);
        }
        for (const zone of action.safetyZones ?? []) marker(zone.lat, zone.lon, new THREE.Color('#3dff7a'), `Zona de segurança · ${action.title}`);
        for (const look of action.lookouts ?? []) marker(look.lat, look.lon, new THREE.Color('#ffe14d'), `Vigia · ${action.title}`);
      }
    }

    KIND_ORDER.forEach((kind) => {
      const b = buckets.get(kind)!;
      const kindGroup = new THREE.Group();
      for (const [acc, order] of [[b.fills, 6], [b.ribbons, 7]] as const) {
        const mesh = acc.build(order);
        if (!mesh) continue;
        kindGroup.add(mesh);
        this.pickables.push(mesh as unknown as Pickable);
      }
      if (b.markers.tips.length) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(b.markers.positions, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(b.markers.colors, 3));
        const points = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, vertexColors: true, depthTest: false }));
        points.renderOrder = 8;
        points.userData.tipFor = (i: number) => b.markers.tips[i] ?? '';
        kindGroup.add(points);
        this.pickables.push(points as unknown as Pickable);
      }
      kindGroup.visible = !this.hidden.has(kind);
      this.kindGroups.set(kind, kindGroup);
      this.group.add(kindGroup);
    });
    this.listeners.forEach((listener) => listener());
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
    this.group.children.forEach((child) =>
      child.traverse((o) => {
        const object = o as THREE.Mesh | THREE.Points;
        object.geometry?.dispose();
        (object.material as THREE.Material | undefined)?.dispose();
      }),
    );
    this.group.clear();
    this.kindGroups.clear();
    this.pickables.length = 0;
    KIND_ORDER.forEach((k) => (this.counts[k] = 0));
  }

  dispose(): void {
    this.clear();
  }
}
