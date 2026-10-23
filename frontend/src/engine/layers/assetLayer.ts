import * as THREE from 'three';

import type { Facility, FacilityKind, Place } from '@/api';
import type { Georef } from '@/domain/georef';
import { getOrgLogo } from '@/domain/organizationLogos';

import { badgeSprite, textSprite } from '../sprites';
import type { Pickable } from '../picking';

const ICON: Partial<Record<FacilityKind, [code: string, color: string]>> = {
  fire_station: ['B', '#b3392f'],
  gnr: ['G', '#3d7a50'],
  psp: ['P', '#ffffff'], // white plate: the crest's own background is white, a green one only contrasts with it
  civil_protection: ['PC', '#a8802a'],
  inem: ['EM', '#2f6bb0'],
  hospital: ['H', '#2f6bb0'],
  health_centre: ['CS', '#3a78b8'],
  town_hall: ['CM', '#607d8b'], // the blue-grey Google Maps gives civic buildings
  school: ['E', '#6c4a8a'],
  care_home: ['L', '#8a3d63'],
  shelter: ['A', '#2f7f77'],
  heliport: ['HE', '#4a5a68'],
  camp_site: ['PC', '#53703a'],
  fuel_station: ['C', '#a8602a'],
};

export const FACILITY_KIND_NAME: Record<FacilityKind, string> = {
  fire_station: 'Bombeiros',
  gnr: 'GNR',
  psp: 'PSP',
  civil_protection: 'Proteção Civil',
  inem: 'INEM',
  hospital: 'Hospital',
  health_centre: 'Centro de saúde',
  town_hall: 'Câmara',
  school: 'Escolas',
  care_home: 'Lares e residências',
  shelter: 'Abrigos',
  heliport: 'Heliportos',
  camp_site: 'Parques de campismo',
  fuel_station: 'Postos de combustível',
};

/** Map-style vector icons (Material Design, Apache 2.0, 24×24) for the civilian kinds that read better as a symbol than as a letter. */
const GLYPH: Partial<Record<FacilityKind, string>> = {
  // the columned civic building Google Maps uses for town halls (Material `account_balance`)
  town_hall: 'M4 10v7h3v-7H4zm6 0v7h3v-7h-3zM2 22h19v-3H2v3zm14-12v7h3v-7h-3zm-4.5-9L2 6v2h19V6l-9.5-5z',
  school: 'M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82zM12 3L1 9l11 6 9-5.18V17h2V9L12 3z',
  shelter: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  care_home:
    'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  // a tent: the opening is wound the other way so it is cut out of the triangle
  camp_site: 'M12 3L1.5 20h21L12 3zm0 7l4 7.5H8L12 10z',
  fuel_station:
    'M19.77 7.23l.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33 0 1.38 1.12 2.5 2.5 2.5.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h10v-7.5h1.5v5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9c0-.69-.28-1.32-.73-1.77zM12 10H6V5h6v5zm6 0c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z',
};

/** The plate colour of a kind of facility (the legend in the layers panel uses it as the swatch). */
export const facilityColor = (kind: FacilityKind): string => ICON[kind]?.[1] ?? '#666';

const CONFIDENCE_LABEL: Record<string, string> = { high: 'alta', medium: 'média', low: 'baixa' };

export type PlaceStatus = 'ok' | 'slow' | 'cut';

interface FacilityEntry {
  facility: Facility;
  sprite: THREE.Sprite;
}
interface PlaceEntry {
  place: Place;
  dot: THREE.Mesh;
  label: THREE.Sprite | null;
}

/** Facility badges (fire stations, GNR, hospitals, ...) and place dots, with hover tooltips and access-status coloring. */
export class AssetLayer {
  readonly group = new THREE.Group();
  private facilityEntries: FacilityEntry[] = [];
  private placeEntries: PlaceEntry[] = [];
  /** Kinds the operator switched off in the layers panel; kept across reloads of the facility list. */
  private hidden = new Set<FacilityKind>();

  constructor(private geo: Georef) {}

  get counts(): Partial<Record<FacilityKind, number>> {
    const counts: Partial<Record<FacilityKind, number>> = {};
    this.facilityEntries.forEach((f) => (counts[f.facility.kind] = (counts[f.facility.kind] ?? 0) + 1));
    return counts;
  }

  isVisible(kind: FacilityKind): boolean {
    return !this.hidden.has(kind);
  }

  setVisible(kind: FacilityKind, on: boolean): void {
    if (on) this.hidden.delete(kind);
    else this.hidden.add(kind);
    this.facilityEntries.forEach((f) => {
      if (f.facility.kind === kind) f.sprite.visible = on;
    });
  }

  setFacilities(list: Facility[]): void {
    this.facilityEntries.forEach((f) => this.group.remove(f.sprite));
    this.facilityEntries = list.map((facility) => {
      const [code, color] = ICON[facility.kind] ?? ['·', '#666'];
      const sprite = badgeSprite(code, color, getOrgLogo(facility.kind), GLYPH[facility.kind]);
      sprite.visible = !this.hidden.has(facility.kind);
      sprite.position.set(...this.geo.world(facility.position.lat, facility.position.lon, 5));
      const confidence = facility.confidence && facility.confidence !== 'high' ? `, confiança ${CONFIDENCE_LABEL[facility.confidence]}` : '';
      const capacity = facility.capacity ? `, ${facility.capacity} lugares` : '';
      (sprite.userData as { tip?: string }).tip = `${FACILITY_KIND_NAME[facility.kind] ?? facility.kind}: ${facility.name} (${facility.source}${confidence}${capacity})`;
      this.group.add(sprite);
      return { facility, sprite };
    });
  }

  setPlaces(list: Place[]): void {
    this.placeEntries.forEach((p) => {
      this.group.remove(p.dot);
      if (p.label) this.group.remove(p.label);
    });
    this.placeEntries = list.map((place, i) => {
      const r = 0.9 + Math.log10(Math.max(place.population ?? 10, 10)) * 0.55;
      const dot = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1.2, 14), new THREE.MeshBasicMaterial({ color: 0x38c172 }));
      const p = this.geo.world(place.position.lat, place.position.lon, 1.2);
      dot.position.set(...p);
      (dot.userData as { tip?: string }).tip = `${place.name} · ${place.population ?? 0} hab.${place.populationEstimated ? ' (estimativa)' : ''}`;
      let label: THREE.Sprite | null = null;
      if (i < 9) {
        label = textSprite(place.name, { size: 24 });
        label.position.set(p[0], p[1] + 4.5, p[2]);
        this.group.add(label);
      }
      this.group.add(dot);
      return { place, dot, label };
    });
  }

  /** Paints place dots by access status (`ok`/`slow`/`cut`), or by isolation probability in ensemble mode. */
  paintPlaces(status: PlaceStatus[], probability: number[] | null): void {
    this.placeEntries.forEach((entry, i) => {
      const color = probability
        ? new THREE.Color(probability[i] > 0.5 ? 0xff2020 : probability[i] > 0 ? 0xf5b301 : 0x38c172)
        : new THREE.Color(status[i] === 'cut' ? 0xff2d2d : status[i] === 'slow' ? 0xf5b301 : 0x38c172);
      (entry.dot.material as THREE.MeshBasicMaterial).color.copy(color);
    });
  }

  get places(): Place[] {
    return this.placeEntries.map((e) => e.place);
  }

  get pickables(): Pickable[] {
    return [
      ...this.facilityEntries.filter((f) => f.sprite.visible).map((f) => f.sprite as Pickable),
      ...this.placeEntries.map((p) => p.dot as Pickable),
    ];
  }
}
