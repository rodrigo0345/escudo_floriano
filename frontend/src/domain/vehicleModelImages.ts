import React, { useState } from 'react';

import type { VehicleType } from '@/api';

export interface VehiclePhotoInfo {
  url: string;
  label: string;
  caption: string;
}

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
  light_firefighting_vehicle: {
    url: '/vehicles/gnr_ueps.jpg',
    label: 'VLCI — Veículo Ligeiro de Combate a Incêndios',
    caption: 'Pick-up 4x4 de primeira intervenção com kit de ataque rápido de 600 L.',
  },

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
  bus: {
    url: '/vehicles/evac_bus.jpg',
    label: 'Autocarro de Evacuação (55 Lugares)',
    caption: 'Autocarro pesado para evacuação rápida de civis de aglomerados populacionais ameaçados.',
  },
  personnel_transport: {
    url: '/vehicles/evac_bus.jpg',
    label: 'VTTP — Transporte de Pessoal / Evacuação',
    caption: 'Viatura adaptada para transporte de operacionais e evacuação preventiva de residentes.',
  },

  // Command & Drone
  command_vehicle: {
    url: '/vehicles/command_pco.jpg',
    label: 'PCO — Posto de Comando Operacional',
    caption: 'Viatura pesada de comando tático no teatro de operações com telecomunicações e planeamento.',
  },
  command_comms_vehicle: {
    url: '/vehicles/command_pco.jpg',
    label: 'VETA / VCOC — Telecomunicações e Apoio',
    caption: 'Viatura de transmissão de dados, satélite e coordenação com o CDOS / CNEPC.',
  },
  drone: {
    url: '/vehicles/drone_recon.jpg',
    label: 'Drone de Reconhecimento e Vigilância Térmica',
    caption: 'Aeronave não-tripulada com câmara térmica para monitorização de frentes e corredores de fuga.',
  },

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
 * Returns photo info for a vehicle type, catalog template key, or vehicle object.
 */
export function getVehiclePhoto(
  type?: VehicleType | string | null,
  tplKey?: string | null,
): VehiclePhotoInfo | null {
  if (tplKey && VEHICLE_MODEL_PHOTOS[tplKey]) {
    return VEHICLE_MODEL_PHOTOS[tplKey];
  }
  if (type && VEHICLE_MODEL_PHOTOS[type]) {
    return VEHICLE_MODEL_PHOTOS[type];
  }
  return null;
}

export interface VehiclePhotoProps {
  type?: VehicleType | string | null;
  tplKey?: string | null;
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
  size = 48,
  className = '',
  showCaption = false,
  style,
}: VehiclePhotoProps) {
  const photo = getVehiclePhoto(type, tplKey);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  if (!photo || error) return null;

  const isFill = size === 'fill';
  const w = typeof size === 'number' ? size : typeof size === 'object' ? size.width : 48;
  const h = typeof size === 'number' ? Math.round(size * 0.65) : typeof size === 'object' ? size.height : 32;

  const imgStyle: React.CSSProperties = {
    width: isFill ? '100%' : `${w}px`,
    height: isFill ? '100%' : `${h}px`,
    objectFit: 'cover',
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
      onLoad: () => setLoaded(true),
      onError: () => setError(true),
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
