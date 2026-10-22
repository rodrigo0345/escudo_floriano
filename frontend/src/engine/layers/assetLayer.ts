import * as THREE from 'three';

import type { Facility, FacilityKind, Place } from '@/api';
import type { Georef } from '@/domain/georef';
import { getOrgLogo } from '@/domain/organizationLogos';

import { badgeSprite, textSprite } from '../sprites';
import type { Pickable } from '../picking';

const ICON: Partial<Record<FacilityKind, [code: string, color: string]>> = {
  fire_station: ['B', '#b3392f'],
  gnr: ['G', '#3d7a50'],
  psp: ['P', '#2f6a4f'],
  civil_protection: ['PC', '#a8802a'],
  inem: ['EM', '#2f6bb0'],
  hospital: ['H', '#2f6bb0'],
  health_centre: ['CS', '#3a78b8'],
  town_hall: ['CM', '#6a5b4f'],
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

  constructor(private geo: Georef) {}

  setFacilities(list: Facility[]): void {
    this.facilityEntries.forEach((f) => this.group.remove(f.sprite));
    this.facilityEntries = list.map((facility) => {
      const [code, color] = ICON[facility.kind] ?? ['·', '#666'];
      const sprite = badgeSprite(code, color, getOrgLogo(facility.kind));
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
      ...this.facilityEntries.map((f) => f.sprite as Pickable),
      ...this.placeEntries.map((p) => p.dot as Pickable),
    ];
  }
}
