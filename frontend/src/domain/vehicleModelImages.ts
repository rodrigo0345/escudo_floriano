import React, { useState } from 'react';

import type { VehicleType } from '@/api';

export interface VehiclePhotoInfo {
  url: string;
  label: string;
  caption: string;
  /** A cut-out on white: shown whole (`contain`) instead of cropped to fill the frame. */
  cutout?: boolean;
}

/**
 * Photos of the exact vehicle class, by its Portuguese designation: the `typeCode` of a registered vehicle, or the first word of its
 * callsign ("HEBP 01"), since the aircraft carry the model in `typeCode` (UH-60A, AS350B3…) and their role in the callsign.
 */
export const VEHICLE_CODE_PHOTOS: Record<string, VehiclePhotoInfo> = {
  UMIPE: {
    url: '/vehicles/umipe.jpg',
    label: 'UMIPE — Unidade Móvel de Intervenção Psicológica de Emergência (INEM)',
    caption: 'Viatura do INEM com psicólogos para apoio a vítimas, familiares e operacionais.',
  },
  PMA: {
    url: '/vehicles/pma.jpg',
    label: 'PMA — Posto Médico Avançado',
    caption: 'Viatura de apoio que monta um posto médico de triagem e estabilização junto ao teatro de operações.',
  },
  VTTP: {
    url: '/vehicles/vttp.jpg',
    label: 'VTTP — Veículo Todo-o-Terreno de Transporte de Pessoal',
    caption: 'Transporte de operacionais e evacuação preventiva de residentes.',
  },
  AUTOCARRO: {
    url: '/vehicles/autocarro.jpg',
    label: 'Autocarro de Evacuação',
    caption: 'Autocarro pesado para evacuação de civis de aglomerados ameaçados.',
  },
  VETA: {
    url: '/vehicles/veta.jpg',
    label: 'VETA — Veículo Especial de Telecomunicações e Apoio',
    caption: 'Viatura de comunicações (rádio, satélite, dados) e coordenação com o CDOS / CNEPC.',
    cutout: true,
  },
  VCOC: {
    url: '/vehicles/vcoc.jpg',
    label: 'VCOC — Veículo de Comando e Comunicações',
    caption: 'Posto de comando móvel com meios de comunicação para o comandante das operações.',
  },
  VCOT: {
    url: '/vehicles/vcot.jpg',
    label: 'VCOT — Veículo de Comando Tático',
    caption: 'Pick-up 4x4 de comando tático para o chefe de setor no terreno.',
    cutout: true,
  },
  VMAT: {
    url: '/vehicles/vmat.jpg',
    label: 'VMAT — Veículo de Apoio Logístico / Material',
    caption: 'Transporte de material, combustível e abastecimentos para as equipas no teatro de operações.',
  },
  VLCI: {
    url: '/vehicles/vlci.jpg',
    label: 'VLCI — Veículo Ligeiro de Combate a Incêndios',
    caption: 'Pick-up 4x4 de primeira intervenção com módulo de água e kit de ataque rápido.',
    cutout: true,
  },
  DRONE: {
    url: '/vehicles/drone.jpg',
    label: 'Drone de Reconhecimento e Vigilância Térmica',
    caption: 'Aeronave não tripulada com câmara térmica para monitorizar frentes e corredores de fuga.',
  },
  HEBP: {
    url: '/vehicles/hebp.jpg',
    label: 'HEBP — Helicóptero Bombardeiro Pesado',
    caption: 'Helicóptero pesado com balde de 3.000–4.500 L para ataque à cabeça do incêndio.',
  },
  HEBL: {
    url: '/vehicles/hebl.jpg',
    label: 'HEBL — Helicóptero Bombardeiro Ligeiro',
    caption: 'Helicóptero ligeiro de ataque inicial com balde de 800–1.200 L e brigada helitransportada.',
  },
  HECO: {
    url: '/vehicles/heco.jpg',
    label: 'HECO — Helicóptero de Coordenação',
    caption: 'Helicóptero de coordenação aérea e reconhecimento sobre o teatro de operações.',
  },
};

/**
 * Verified photos of Portuguese emergency services vehicle models.
 */
export const VEHICLE_MODEL_PHOTOS: Record<string, VehiclePhotoInfo> = {
  // Firefighting trucks (Portuguese fleet)
  forest_firefighting_vehicle: {
    url: '/vehicles/vfci_portugues.jpg',
    label: 'VFCI — Veículo Florestal de Combate a Incêndios (Portugal)',
    caption: 'Camião florestal 4x4 todo-o-terreno pesado com bomba de alta pressão, cabina blindada e autoproteção térmica dos Bombeiros Voluntários portugueses.',
  },
  vfci: {
    url: '/vehicles/vfci_portugues.jpg',
    label: 'VFCI — Veículo Florestal de Combate a Incêndios',
    caption: 'Viatura florestal tática pesada com depósito de água de 3.500 L e linhas de carretel de ataque rápido.',
  },
  urban_firefighting_vehicle: {
    url: '/vehicles/vfci_portugues.jpg',
    label: 'VUCI — Veículo Urbano de Combate a Incêndios',
    caption: 'Autotanque urbano dos Corpos de Bombeiros Voluntários.',
  },
  tanker_forest: {
    url: '/vehicles/vttu_volvo.jpg',
    label: 'VTTU / VTTF — Veículo Tanque Tático (Volvo)',
    caption: 'Autotanque pesado Volvo de grande capacidade (10.000 L) dos Bombeiros de Portugal para abastecimento contínuo a frentes de incêndio florestal.',
  },
  tanker_urban: {
    url: '/vehicles/vttu_volvo.jpg',
    label: 'VTTU — Veículo Tanque Tático Urbano (Volvo)',
    caption: 'Cisterna pesada Volvo de grande capacidade (10.000 L) para abastecimento hídrico.',
  },
  tanker_large: {
    url: '/vehicles/vttu_volvo.jpg',
    label: 'VTGC — Tanque de Grande Capacidade',
    caption: 'Cisterna pesada de reabastecimento contínuo para apoio a viaturas no teatro de operações.',
  },
  vttu: {
    url: '/vehicles/vttu_volvo.jpg',
    label: 'VTTU — Veículo Tanque Tático Urbano/Florestal (Volvo)',
    caption: 'Viatura cisterna pesada com capacidade de 10.000 L de água e bomba de 2.000 L/min.',
  },
  vttf: {
    url: '/vehicles/vttu_volvo.jpg',
    label: 'VTTF — Veículo Tanque Tático Florestal (Volvo)',
    caption: 'Autotanque pesado florestal com depósito de grande capacidade para alimentação das linhas de combate.',
  },
  light_firefighting_vehicle: VEHICLE_CODE_PHOTOS.VLCI,

  // Medical ambulances
  ambulance: {
    url: '/vehicles/absc_inem.jpg',
    label: 'ABSC — Ambulância de Socorro (INEM / Bombeiros)',
    caption: 'Mercedes-Benz Sprinter equipada com suporte básico e equipamento de reanimação pré-hospitalar.',
  },
  advanced_medical_vehicle: {
    url: '/vehicles/absc_inem.jpg',
    label: 'VMER — Viatura Médica de Emergência e Reanimação',
    caption: 'Viatura rápida de intervenção médica com médico e enfermeiro do INEM.',
  },
  immediate_life_support_vehicle: {
    url: '/vehicles/absc_inem.jpg',
    label: 'SIV — Suporte Imediato de Vida',
    caption: 'Viatura rápida tripulada por enfermeiro e socorrista do INEM.',
  },

  // Transport & Evacuation
  bus: VEHICLE_CODE_PHOTOS.AUTOCARRO,
  personnel_transport: VEHICLE_CODE_PHOTOS.VTTP,

  // Command & Drone
  command_vehicle: {
    url: '/vehicles/command_pco.jpg',
    label: 'PCO — Posto de Comando Operacional',
    caption: 'Viatura pesada de comando tático no teatro de operações com telecomunicações e planeamento.',
  },
  command_comms_vehicle: VEHICLE_CODE_PHOTOS.VETA,
  drone: VEHICLE_CODE_PHOTOS.DRONE,

  // Police / Patrol
  all_terrain_patrol: {
    url: '/vehicles/gnr_ueps.jpg',
    label: 'UEPS — Unidade de Emergência de Proteção e Socorro (GNR)',
    caption: 'Pick-up todo-o-terreno da GNR armada para vigilância florestal, ataque inicial e evacuações.',
  },
  patrol_car: {
    url: '/vehicles/gnr_patrol.jpg',
    label: 'Patrulha GNR / Trânsito',
    caption: 'Viatura ligeira de patrulhamento da Guarda Nacional Republicana para segurança de perímetro e tráfego.',
  },
  traffic_unit: {
    url: '/vehicles/gnr_patrol.jpg',
    label: 'GNR — Destacamento de Trânsito',
    caption: 'Viatura de patrulha e regulação rodoviária para corte de vias e facilitação de comboios de socorro.',
  },

  // Helicopters
  helicopter: {
    url: '/vehicles/as350_heli.jpg',
    label: 'Helicóptero de Combate a Incêndios (Bambi Bucket)',
    caption: 'Aeronave de asa rotativa com balde para ataque inicial e suporte a brigadas terrestres.',
  },
  uh60: {
    url: '/vehicles/uh60_heli.jpg',
    label: 'Sikorsky UH-60A Black Hawk (HEBP)',
    caption: 'Helicóptero bombardeiro pesado com balde Bambi de 3.000 L a 4.000 L da Proteção Civil / ANEPC.',
  },
  as350: {
    url: '/vehicles/as350_heli.jpg',
    label: 'Airbus AS350 B3 Écureuil (HEBL)',
    caption: 'Helicóptero ligeiro de ataque rápido e coordenação aérea com balde de 1.000 L.',
  },
  ka32: {
    url: '/vehicles/ka32_heli.jpg',
    label: 'Kamov Ka-32A11BC (HEBP)',
    caption: 'Helicóptero bombardeiro pesado de rotor coaxial da frota de combate a incêndios de Portugal.',
  },

  // Airplanes
  airtanker: {
    url: '/vehicles/canadair_plane.jpg',
    label: 'Canadair CL-215 / Air Tractor Fire Boss',
    caption: 'Avião anfíbio de combate a incêndios florestais para largadas concentradas de água com retardante.',
  },
};

/**
 * The photo of a vehicle, most specific first: its designation (`typeCode`, then the callsign's first word, "HEBP 01" → HEBP), then a catalog
 * template key, then its generic type.
 */
export function getVehiclePhoto(
  type?: VehicleType | string | null,
  tplKey?: string | null,
  typeCode?: string | null,
  callsign?: string | null,
): VehiclePhotoInfo | null {
  const code = typeCode?.trim().toUpperCase();
  if (code && VEHICLE_CODE_PHOTOS[code]) return VEHICLE_CODE_PHOTOS[code];
  const role = callsign?.trim().split(/[\s-]+/)[0]?.toUpperCase();
  if (role && VEHICLE_CODE_PHOTOS[role]) return VEHICLE_CODE_PHOTOS[role];
  if (tplKey && VEHICLE_CODE_PHOTOS[tplKey.toUpperCase()]) return VEHICLE_CODE_PHOTOS[tplKey.toUpperCase()];
  if (tplKey && VEHICLE_MODEL_PHOTOS[tplKey]) return VEHICLE_MODEL_PHOTOS[tplKey];
  if (type && VEHICLE_MODEL_PHOTOS[type]) return VEHICLE_MODEL_PHOTOS[type];
  return null;
}

export interface VehiclePhotoProps {
  type?: VehicleType | string | null;
  tplKey?: string | null;
  typeCode?: string | null;
  callsign?: string | null;
  size?: number | { width: number; height: number } | 'fill';
  className?: string;
  showCaption?: boolean;
  style?: React.CSSProperties;
}

/**
 * Clean component that displays the real vehicle model photo.
 */
export function VehicleModelPhoto({
  type,
  tplKey,
  typeCode,
  callsign,
  size = 48,
  className = '',
  showCaption = false,
  style,
}: VehiclePhotoProps) {
  const photo = getVehiclePhoto(type, tplKey, typeCode, callsign);
  // load/error state belongs to one picture: a reused element showing another vehicle starts over (a failed photo hid every later one)
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const loaded = !!photo && loadedUrl === photo.url;

  if (!photo || failedUrl === photo.url) return null;

  const isFill = size === 'fill';
  const w = typeof size === 'number' ? size : typeof size === 'object' ? size.width : 48;
  const h = typeof size === 'number' ? Math.round(size * 0.65) : typeof size === 'object' ? size.height : 32;

  const imgStyle: React.CSSProperties = {
    width: isFill ? '100%' : `${w}px`,
    height: isFill ? '100%' : `${h}px`,
    objectFit: photo.cutout ? 'contain' : 'cover',
    background: photo.cutout ? '#fff' : undefined,
    borderRadius: isFill ? '0' : '6px',
    border: isFill ? 'none' : '1px solid var(--line, rgba(255,255,255,0.12))',
    display: 'block',
    opacity: loaded ? 1 : 0.4,
    transition: 'opacity 0.2s ease',
  };

  return React.createElement(
    'div',
    {
      className,
      style: {
        display: isFill ? 'flex' : 'inline-flex',
        flexDirection: 'column',
        width: isFill ? '100%' : undefined,
        height: isFill ? '100%' : undefined,
        ...style,
      },
      title: photo.label,
    },
    React.createElement('img', {
      src: photo.url,
      alt: photo.label,
      style: imgStyle,
      loading: 'lazy',
      onLoad: () => setLoadedUrl(photo.url),
      onError: () => setFailedUrl(photo.url),
    }),
    showCaption && !isFill
      ? React.createElement(
          'span',
          { style: { fontSize: '11px', color: 'var(--muted, #8a94a0)', lineHeight: '1.2', maxWidth: `${w}px` } },
          photo.label,
        )
      : null,
  );
}
