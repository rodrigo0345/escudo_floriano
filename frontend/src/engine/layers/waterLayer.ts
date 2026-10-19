import * as THREE from 'three';

import type { WaterPoint, WaterPointKind } from '@/api';
import type { Georef } from '@/domain/georef';

import { pointBadgeTexture } from '../sprites';
import type { Pickable } from '../picking';

export interface WaterKindInfo {
  label: string;
  one: string;
  glyph: string;
  color: string;
  size: number;
  on: boolean;
}

export const WATER_KINDS: Record<WaterPointKind, WaterKindInfo> = {
  hydrant: { label: 'Bocas de incêndio', one: 'Boca de incêndio', glyph: 'H', color: '#18b4ff', size: 11, on: true },
  dry_hydrant: { label: 'Pontos de aspiração', one: 'Ponto de aspiração', glyph: 'A', color: '#8f7bff', size: 12, on: true },
  tank: { label: 'Tanques e depósitos', one: 'Tanque / depósito', glyph: 'T', color: '#b86bff', size: 13, on: true },
  reservoir: { label: 'Albufeiras e lagos', one: 'Albufeira / lago', glyph: '≈', color: '#1f6fe0', size: 17, on: true },
  pond: { label: 'Charcas e lagoas', one: 'Charca / lagoa', glyph: '≈', color: '#1fc9b0', size: 14, on: true },
  river_access: { label: 'Acessos a cursos de água', one: 'Acesso a curso de água', glyph: '~', color: '#2bb3a3', size: 12, on: true },
  swimming_pool: { label: 'Piscinas', one: 'Piscina', glyph: '▭', color: '#7fd9f5', size: 8, on: false },
};

const HYDRANT_TYPE_LABEL: Record<string, string> = { pillar: 'de coluna', underground: 'subterrânea', wall: 'de parede', pipe: 'de tubo' };

const formatLiters = (l: number) => (l >= 1e6 ? `${(l / 1e6).toFixed(1)} milhões de L` : l >= 1000 ? `${Math.round(l / 1000)} mil L` : `${Math.round(l)} L`);
const formatArea = (m2: number) => (m2 >= 10000 ? `${(m2 / 10000).toFixed(1)} ha` : `${Math.round(m2)} m²`);

export function describeWaterPoint(p: WaterPoint): string {
  const bits: string[] = [];
  if (p.hydrantType) bits.push(HYDRANT_TYPE_LABEL[p.hydrantType] ?? p.hydrantType);
  if (p.diameterMm) bits.push(`Ø${Math.round(p.diameterMm)} mm`);
  if (p.areaM2) bits.push(`área ~${formatArea(p.areaM2)}`);
  if (p.capacityL) bits.push(`${p.capacityEstimated ? '~' : ''}${formatLiters(p.capacityL)}${p.capacityEstimated ? ' (estimativa)' : ''}`);
  const near = p.roadDistanceM != null ? Math.round(p.roadDistanceM) : null;
  bits.push(p.truckAccessible ? (near != null && near > 5 ? `autotanque: via a ${near} m` : 'acessível a autotanque') : `sem acesso de autotanque${near != null ? ` (via a ${near} m)` : ''}`);
  if (p.helicopterAccessible) bits.push('serve helicóptero');
  if (p.access === 'private') bits.push('privado');
  return `${WATER_KINDS[p.kind].one}: ${p.name ?? '—'} · ${bits.join(' · ')}`;
}

interface KindGroup {
  items: WaterPoint[];
  points: THREE.Points;
}

/** Fire-suppression water sources: one point cloud per kind (cheap at thousands of points), fixed pixel size, hover tooltip, per-kind visibility toggle. */
export class WaterLayer {
  readonly group = new THREE.Group();
  private readonly byKind = new Map<WaterPointKind, KindGroup>();

  constructor(
    geo: Georef,
    list: WaterPoint[],
  ) {
    (Object.keys(WATER_KINDS) as WaterPointKind[]).forEach((kind) => {
      const items = list.filter((p) => p.kind === kind);
      if (!items.length) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(items.flatMap((p) => geo.world(p.position.lat, p.position.lon, 3)), 3),
      );
      const info = WATER_KINDS[kind];
      const points = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({ size: info.size, sizeAttenuation: false, map: pointBadgeTexture(info.glyph, info.color), transparent: true, alphaTest: 0.35, depthTest: false }),
      );
      points.renderOrder = 22;
      points.visible = info.on;
      points.frustumCulled = false;
      (points as unknown as Pickable).userData.tipFor = (i: number) => describeWaterPoint(items[i]);
      this.group.add(points);
      this.byKind.set(kind, { items, points });
    });
  }

  get counts(): Partial<Record<WaterPointKind, number>> {
    const out: Partial<Record<WaterPointKind, number>> = {};
    this.byKind.forEach((v, k) => (out[k] = v.items.length));
    return out;
  }

  setVisible(kind: WaterPointKind, on: boolean): void {
    const group = this.byKind.get(kind);
    if (group) group.points.visible = on;
  }

  get pickables(): Pickable[] {
    return [...this.byKind.values()].filter((v) => v.points.visible).map((v) => v.points as unknown as Pickable);
  }
}
