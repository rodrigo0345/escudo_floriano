import type { VehicleCapability, VehicleInput, VehicleType } from '@/api';

/**
 * Reference catalogue of the vehicles Portuguese emergency organizations actually field, used to pre-fill the
 * resource forms and to drive dispatch planning. `confidence` says how each template was obtained:
 *  - `sourced`: the headline figures (water, fuel, speed...) were found in the linked public sources.
 *  - `estimate`: typical values for the class of vehicle; verify against the corporation's own fleet sheet.
 * Per-field notes say which numbers were NOT found online. Fuel capacity is the contract's `fuelCapacityL`.
 */
export interface VehicleTemplate {
  key: string;
  label: string;
  orgTypes: string[];
  type: VehicleType;
  typeCode: string;
  crewCapacity: number;
  minimumCrew: number;
  waterCapacityL?: number;
  foamCapacityL?: number;
  pumpFlowLpm?: number;
  stretcherCapacity?: number;
  passengerCapacity?: number;
  offRoad: boolean;
  maxSlopePercent?: number;
  cruiseSpeedKmh: number;
  rangeKm?: number;
  fuelCapacityL?: number;
  capabilities: VehicleCapability[];
  aerial?: {
    bucketCapacityL: number;
    loadMinutes: number;
    dropMinutes: number;
    cruiseSpeedKmh: number;
    maxWindKmh: number;
    minVisibilityM?: number;
    dayOnly: boolean;
  };
  confidence: 'sourced' | 'estimate';
  note: string;
  sources?: { label: string; url: string }[];
}

const GOV_VFCI = {
  label: 'portugal.gov.pt — veículos distribuídos aos Corpos de Bombeiros (PRR)',
  url: 'https://portugal.gov.pt/gc22/comunicacao/comunicados/distribuicao-de-veiculos-pelos-corpos-de-bombeiros',
};

export const VEHICLE_CATALOG: VehicleTemplate[] = [
  // ---------------------------------------------------------------- Bombeiros
  {
    key: 'vfci',
    label: 'VFCI · Veículo Florestal de Combate a Incêndios',
    orgTypes: ['fire_brigade'],
    type: 'forest_firefighting_vehicle',
    typeCode: 'VFCI',
    crewCapacity: 5,
    minimumCrew: 3,
    waterCapacityL: 3500,
    pumpFlowLpm: 1500,
    offRoad: true,
    maxSlopePercent: 40,
    cruiseSpeedKmh: 80,
    rangeKm: 500,
    fuelCapacityL: 200,
    capabilities: ['wildfire_attack', 'structure_protection', 'water_supply'],
    confidence: 'sourced',
    note: 'Água 3 500 L (fonte oficial). Equipa 1+4, caudal da bomba, combustível e autonomia: valores típicos (não encontrados online).',
    sources: [GOV_VFCI],
  },
  {
    key: 'vttf',
    label: 'VTTF · Veículo Tanque Tático Florestal',
    orgTypes: ['fire_brigade'],
    type: 'tanker_forest',
    typeCode: 'VTTF',
    crewCapacity: 2,
    minimumCrew: 2,
    waterCapacityL: 9000,
    pumpFlowLpm: 2000,
    offRoad: true,
    maxSlopePercent: 30,
    cruiseSpeedKmh: 80,
    rangeKm: 450,
    fuelCapacityL: 250,
    capabilities: ['wildfire_attack', 'water_supply'],
    confidence: 'sourced',
    note: 'Água 9 000 L (fonte oficial, designado «VTT»). Tripulação, bomba, combustível: típicos.',
    sources: [GOV_VFCI],
  },
  {
    key: 'vlci',
    label: 'VLCI · Veículo Ligeiro de Combate a Incêndios',
    orgTypes: ['fire_brigade'],
    type: 'light_firefighting_vehicle',
    typeCode: 'VLCI',
    crewCapacity: 3,
    minimumCrew: 2,
    waterCapacityL: 600,
    pumpFlowLpm: 400,
    offRoad: true,
    maxSlopePercent: 45,
    cruiseSpeedKmh: 90,
    rangeKm: 700,
    fuelCapacityL: 80,
    capabilities: ['wildfire_attack', 'reconnaissance'],
    confidence: 'estimate',
    note: 'Pick-up 4×4 com módulo de ataque rápido. Nenhuma ficha técnica pública encontrada: valores típicos.',
  },
  {
    key: 'vuci',
    label: 'VUCI · Veículo Urbano de Combate a Incêndios (Atego 4×4)',
    orgTypes: ['fire_brigade'],
    type: 'urban_firefighting_vehicle',
    typeCode: 'VUCI',
    crewCapacity: 6,
    minimumCrew: 4,
    waterCapacityL: 3500,
    foamCapacityL: 200,
    pumpFlowLpm: 2000,
    offRoad: false,
    cruiseSpeedKmh: 85,
    rangeKm: 550,
    fuelCapacityL: 200,
    capabilities: ['structure_protection', 'rescue', 'water_supply', 'wildfire_attack'],
    confidence: 'sourced',
    note: 'Referência Mercedes Atego 1530 AF 4×4 (TLF 3000): bomba 2 000 L/min a 10 bar, depósito 3 500 L, cabine 1+8. Combustível típico.',
    sources: [{ label: 'Magirus — TLF 3000', url: 'https://www.magirusgroup.com/de/serving-heroes/deliveries/detail/delivery/tlf-3000-for-rickling-12-2022/' }],
  },
  {
    key: 'unimog-4000',
    label: 'Tanque florestal pesado · Unimog U5023 (4 000 L)',
    orgTypes: ['fire_brigade', 'forest_service', 'civil_protection'],
    type: 'tanker_large',
    typeCode: 'U5023',
    crewCapacity: 3,
    minimumCrew: 2,
    waterCapacityL: 4000,
    foamCapacityL: 300,
    pumpFlowLpm: 3000,
    offRoad: true,
    maxSlopePercent: 70,
    cruiseSpeedKmh: 80,
    rangeKm: 600,
    fuelCapacityL: 240,
    capabilities: ['wildfire_attack', 'water_supply'],
    confidence: 'sourced',
    note: 'TEMAX TLF-4000/300 sobre Unimog U5023: água ≈4 000 L, espuma 300 L, depósito 240 L (ficha do fabricante). Caudal e tripulação: estimados.',
    sources: [{ label: 'TEMAX TLF-4000/300', url: 'https://www.temax.gr/2023/?p=3194' }],
  },
  {
    key: 'atego-1500',
    label: 'Viatura florestal média · Atego 4×4 (1 500 L)',
    orgTypes: ['fire_brigade', 'forest_service'],
    type: 'forest_firefighting_vehicle',
    typeCode: 'TLF1500',
    crewCapacity: 3,
    minimumCrew: 2,
    waterCapacityL: 1500,
    foamCapacityL: 150,
    pumpFlowLpm: 1000,
    offRoad: true,
    maxSlopePercent: 50,
    cruiseSpeedKmh: 85,
    rangeKm: 450,
    fuelCapacityL: 120,
    capabilities: ['wildfire_attack'],
    confidence: 'sourced',
    note: 'TEMAX TLF-1500/150 sobre Atego 918AF 4×4: água 1 500 L, espuma 150 L, depósito 120 L. Caudal e tripulação: estimados.',
    sources: [{ label: 'TEMAX TLF-1500/150', url: 'https://www.temax.gr/2023/?p=3316' }],
  },
  {
    key: 'vcoc',
    label: 'VCOC · Veículo de Comando e Comunicações',
    orgTypes: ['fire_brigade', 'civil_protection'],
    type: 'command_comms_vehicle',
    typeCode: 'VCOC',
    crewCapacity: 4,
    minimumCrew: 2,
    offRoad: false,
    cruiseSpeedKmh: 90,
    rangeKm: 700,
    fuelCapacityL: 90,
    capabilities: ['command_and_control', 'communications'],
    confidence: 'estimate',
    note: 'Valores típicos de furgão de comando; sem ficha pública.',
  },
  {
    key: 'vtpt',
    label: 'VTPT · Transporte de Pessoal',
    orgTypes: ['fire_brigade', 'civil_protection'],
    type: 'personnel_transport',
    typeCode: 'VTPT',
    crewCapacity: 9,
    minimumCrew: 1,
    passengerCapacity: 8,
    offRoad: false,
    cruiseSpeedKmh: 90,
    rangeKm: 800,
    fuelCapacityL: 80,
    capabilities: ['logistics', 'evacuation_transport'],
    confidence: 'estimate',
    note: 'Furgão de 9 lugares; típico.',
  },
  {
    key: 'bulldozer',
    label: 'Máquina de rasto (abertura de faixas)',
    orgTypes: ['municipality', 'forest_service', 'civil_protection', 'fire_brigade'],
    type: 'bulldozer',
    typeCode: 'MR',
    crewCapacity: 1,
    minimumCrew: 1,
    offRoad: true,
    maxSlopePercent: 60,
    cruiseSpeedKmh: 10,
    rangeKm: 80,
    fuelCapacityL: 400,
    capabilities: ['heavy_earthmoving', 'firebreak_construction'],
    confidence: 'estimate',
    note: 'Bulldozer médio; transportado em prancha até ao local. Valores típicos.',
  },
  // -------------------------------------------------------------------- INEM
  {
    key: 'absc',
    label: 'ABSC · Ambulância de Socorro (Sprinter)',
    orgTypes: ['inem', 'fire_brigade'],
    type: 'ambulance',
    typeCode: 'ABSC',
    crewCapacity: 2,
    minimumCrew: 2,
    stretcherCapacity: 1,
    offRoad: false,
    cruiseSpeedKmh: 100,
    rangeKm: 700,
    fuelCapacityL: 75,
    capabilities: ['medical_transport', 'evacuation_transport'],
    confidence: 'estimate',
    note: 'Mercedes Sprinter (diesel). Fontes online não confirmam as especificações do INEM; depósito 75 L é uma estimativa (depósitos Sprinter variam 75–91 L).',
  },
  {
    key: 'siv',
    label: 'SIV · Suporte Imediato de Vida',
    orgTypes: ['inem'],
    type: 'immediate_life_support_vehicle',
    typeCode: 'SIV',
    crewCapacity: 2,
    minimumCrew: 2,
    offRoad: false,
    cruiseSpeedKmh: 110,
    rangeKm: 700,
    fuelCapacityL: 60,
    capabilities: ['medical_transport', 'advanced_life_support'],
    confidence: 'estimate',
    note: 'Equipa: técnico de emergência + enfermeiro. Valores típicos.',
  },
  {
    key: 'vmer',
    label: 'VMER · Viatura Médica de Emergência e Reanimação',
    orgTypes: ['inem'],
    type: 'advanced_medical_vehicle',
    typeCode: 'VMER',
    crewCapacity: 3,
    minimumCrew: 2,
    offRoad: false,
    cruiseSpeedKmh: 120,
    rangeKm: 800,
    fuelCapacityL: 65,
    capabilities: ['advanced_life_support', 'medical_transport'],
    confidence: 'estimate',
    note: 'Equipa: médico + enfermeiro + condutor. Valores típicos.',
  },
  // --------------------------------------------------------------------- GNR
  {
    key: 'ueps-hilux',
    label: 'UEPS · Patrulha todo-o-terreno (Hilux 4×4)',
    orgTypes: ['gnr', 'psp'],
    type: 'all_terrain_patrol',
    typeCode: 'UEPS',
    crewCapacity: 4,
    minimumCrew: 2,
    passengerCapacity: 4,
    offRoad: true,
    maxSlopePercent: 60,
    cruiseSpeedKmh: 100,
    rangeKm: 800,
    fuelCapacityL: 80,
    capabilities: ['perimeter_security', 'traffic_control', 'evacuation_transport', 'reconnaissance'],
    confidence: 'sourced',
    note: 'Toyota Hilux 4×4: depósito 80 L, ≈11 L/100 km (distribuidor e catálogo UNICEF). Lotação 4 e velocidade: típicos.',
    sources: [{ label: 'UNICEF Supply — Hilux', url: 'https://supply.unicef.org/s0008821.html' }],
  },
  {
    key: 'bt-patrol',
    label: 'BT · Brigada de Trânsito (viatura)',
    orgTypes: ['gnr', 'psp'],
    type: 'traffic_unit',
    typeCode: 'BT',
    crewCapacity: 2,
    minimumCrew: 2,
    offRoad: false,
    cruiseSpeedKmh: 110,
    rangeKm: 800,
    fuelCapacityL: 60,
    capabilities: ['traffic_control', 'perimeter_security'],
    confidence: 'estimate',
    note: 'Valores típicos de viatura de patrulha.',
  },
  {
    key: 'moto',
    label: 'Mota de trânsito',
    orgTypes: ['gnr', 'psp'],
    type: 'motorcycle',
    typeCode: 'MOTO',
    crewCapacity: 1,
    minimumCrew: 1,
    offRoad: false,
    cruiseSpeedKmh: 110,
    rangeKm: 350,
    fuelCapacityL: 20,
    capabilities: ['traffic_control', 'reconnaissance'],
    confidence: 'estimate',
    note: 'Valores típicos.',
  },
  // ------------------------------------------------------------------ Aéreos
  {
    key: 'cl415',
    label: 'Canadair CL-415 / DHC-515 (anfíbio)',
    orgTypes: ['air_force', 'civil_protection', 'other'],
    type: 'airtanker',
    typeCode: 'CL-415',
    crewCapacity: 2,
    minimumCrew: 2,
    offRoad: true,
    cruiseSpeedKmh: 290,
    rangeKm: 2400,
    fuelCapacityL: 5791,
    capabilities: ['aerial_water_drop'],
    aerial: { bucketCapacityL: 6137, loadMinutes: 0.2, dropMinutes: 0.1, cruiseSpeedKmh: 290, maxWindKmh: 45, minVisibilityM: 3000, dayOnly: true },
    confidence: 'sourced',
    note: 'Carga 6 137 L (reabastece em ≈12 s por escoamento), cruzeiro ≈290 km/h, autonomia ≈2 400 km, combustível ≈5 790 L (asas). Vento máx.: estimado.',
    sources: [
      { label: 'feuxdeforet.fr — CL-415', url: 'https://feuxdeforet.fr/en/moyens-de-lutte/avions/canadair-cl-415/' },
      { label: 'De Havilland — DHC-515', url: 'https://dehavilland.com/dhc-515-firefighter/' },
    ],
  },
  {
    key: 'fireboss',
    label: 'Air Tractor AT-802F Fire Boss (anfíbio)',
    orgTypes: ['air_force', 'civil_protection', 'other'],
    type: 'airtanker',
    typeCode: 'AT-802F',
    crewCapacity: 1,
    minimumCrew: 1,
    offRoad: true,
    cruiseSpeedKmh: 278,
    rangeKm: 1100,
    capabilities: ['aerial_water_drop'],
    aerial: { bucketCapacityL: 3104, loadMinutes: 0.25, dropMinutes: 0.1, cruiseSpeedKmh: 278, maxWindKmh: 40, minVisibilityM: 3000, dayOnly: true },
    confidence: 'sourced',
    note: 'Depósito 3 104 L (820 USG), escoamento em <14 s, cruzeiro ≈150 kt. Combustível e autonomia: não encontrados (autonomia estimada).',
    sources: [{ label: 'Fire Boss LLC', url: 'https://www.firebossllc.com/?p=867' }],
  },
  {
    key: 'ka32',
    label: 'Kamov Ka-32A11BC (balde Bambi)',
    orgTypes: ['air_force', 'civil_protection', 'other'],
    type: 'helicopter',
    typeCode: 'Ka-32',
    crewCapacity: 3,
    minimumCrew: 2,
    offRoad: true,
    cruiseSpeedKmh: 245,
    rangeKm: 650,
    capabilities: ['aerial_water_drop', 'aerial_recon'],
    aerial: { bucketCapacityL: 4000, loadMinutes: 1, dropMinutes: 0.5, cruiseSpeedKmh: 245, maxWindKmh: 50, minVisibilityM: 2000, dayOnly: true },
    confidence: 'sourced',
    note: 'Balde de ~4 t (até 5 t), cruzeiro máx. 245 km/h, alcance ≈650 km. Atenção: a frota portuguesa está inoperacional desde 2022. Combustível: não encontrado.',
    sources: [{ label: 'The Aviationist — Ka-32 de Portugal', url: 'https://theaviationist.com/2024/09/13/portugal-transfers-its-inoperable-ka-32-firefighting-helicopters-to-ukraine/' }],
  },
  {
    key: 'uh60',
    label: 'Sikorsky UH-60A Black Hawk (balde)',
    orgTypes: ['air_force', 'civil_protection', 'other'],
    type: 'helicopter',
    typeCode: 'UH-60A',
    crewCapacity: 3,
    minimumCrew: 2,
    offRoad: true,
    cruiseSpeedKmh: 260,
    rangeKm: 580,
    fuelCapacityL: 1360,
    capabilities: ['aerial_water_drop', 'aerial_recon'],
    aerial: { bucketCapacityL: 3000, loadMinutes: 1, dropMinutes: 0.5, cruiseSpeedKmh: 260, maxWindKmh: 50, minVisibilityM: 2000, dayOnly: true },
    confidence: 'estimate',
    note: 'Balde ≈3 000 L, combustível interno ≈1 360 L, cruzeiro ≈260 km/h: valores do fabricante/típicos, não confirmados na pesquisa.',
  },
  {
    key: 'as350',
    label: 'Airbus AS350 B3 Écureuil (helicóptero ligeiro)',
    orgTypes: ['air_force', 'civil_protection', 'fire_brigade', 'other'],
    type: 'helicopter',
    typeCode: 'AS350B3',
    crewCapacity: 5,
    minimumCrew: 1,
    offRoad: true,
    cruiseSpeedKmh: 250,
    rangeKm: 650,
    fuelCapacityL: 540,
    capabilities: ['aerial_water_drop', 'aerial_recon'],
    aerial: { bucketCapacityL: 700, loadMinutes: 0.7, dropMinutes: 0.3, cruiseSpeedKmh: 250, maxWindKmh: 45, minVisibilityM: 2000, dayOnly: true },
    confidence: 'sourced',
    note: 'Combustível 540 L e cruzeiro ≈135 kt (agregadores). Capacidade do balde ≈700 L: típica.',
    sources: [{ label: 'PAS — AS350 B3', url: 'https://www.pas.com.eg/?p=9374' }],
  },
];

export const catalogFor = (orgType?: string): VehicleTemplate[] =>
  orgType ? VEHICLE_CATALOG.filter((t) => t.orgTypes.includes(orgType)) : VEHICLE_CATALOG;

/** Which catalogue template best matches an existing vehicle (by type code, then by vehicle type). */
export function templateForVehicle(v: { typeCode?: string; type: VehicleType }): VehicleTemplate | undefined {
  const code = v.typeCode?.toUpperCase();
  return (
    VEHICLE_CATALOG.find((t) => t.typeCode.toUpperCase() === code) ??
    VEHICLE_CATALOG.find((t) => t.type === v.type) ??
    (v.type === 'tanker_forest' ? VEHICLE_CATALOG.find((t) => t.key === 'vttf') : undefined)
  );
}

/** The `VehicleInput` fields a template provides (organization, callsign and station are the user's). */
export function templateToInput(t: VehicleTemplate): Omit<VehicleInput, 'organizationId' | 'callsign' | 'stationId'> {
  return {
    type: t.type,
    typeCode: t.typeCode,
    crewCapacity: t.crewCapacity,
    minimumCrew: t.minimumCrew,
    waterCapacityL: t.waterCapacityL,
    foamCapacityL: t.foamCapacityL,
    pumpFlowLpm: t.pumpFlowLpm,
    stretcherCapacity: t.stretcherCapacity,
    passengerCapacity: t.passengerCapacity,
    offRoad: t.offRoad,
    maxSlopePercent: t.maxSlopePercent,
    cruiseSpeedKmh: t.cruiseSpeedKmh,
    rangeKm: t.rangeKm,
    fuelCapacityL: t.fuelCapacityL,
    capabilities: t.capabilities,
    aerial: t.aerial,
    inService: true,
    metadata: { specConfidence: t.confidence, specTemplate: t.key },
  };
}
