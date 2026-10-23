import type {
  DispatchStatus,
  EquipmentKind,
  OrganizationType,
  PersonnelRole,
  StationKind,
  VehicleCapability,
  VehicleStatus,
  VehicleType,
} from '@/api';

/** Portuguese labels for the enums of `api-spec/openapi.json` (values stay snake_case on the wire). */
export const ORG_TYPE_LABEL: Record<OrganizationType, string> = {
  fire_brigade: 'Bombeiros',
  gnr: 'GNR',
  psp: 'PSP',
  inem: 'INEM',
  civil_protection: 'Proteção Civil',
  municipality: 'Município',
  forest_service: 'Serviço florestal',
  air_force: 'Força Aérea',
  other: 'Outra',
};

const CORE_ORG_TYPES: OrganizationType[] = ['fire_brigade', 'gnr', 'inem', 'civil_protection'];

type OrgLike = { id?: string | null; type: OrganizationType; tags?: string[] | null; createdAt?: string | null };

/**
 * The four corporations of the concelho (Bombeiros, GNR, INEM, ANEPC): for each of those kinds, the oldest organization without tags (the reinforcement
 * groups, aerial means and pre-positioned crews all carry one), else the oldest of that kind. Everything else is grouped under "Reforços", closed until the
 * operator opens it.
 */
export function coreOrganizationIds(orgs: OrgLike[]): Set<string> {
  const ids = new Set<string>();
  for (const type of CORE_ORG_TYPES) {
    const ofType = orgs.filter((o) => o.type === type).sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
    const pick = ofType.find((o) => !(o.tags ?? []).length) ?? ofType[0];
    if (pick?.id) ids.add(pick.id);
  }
  return ids;
}

export const STATION_KIND_LABEL: Record<StationKind, string> = {
  fire_station: 'Quartel de bombeiros',
  gnr_post: 'Posto GNR',
  psp_station: 'Esquadra PSP',
  inem_base: 'Base INEM',
  civil_protection_hq: 'Comando de Proteção Civil',
  command_post: 'Posto de comando',
  staging_area: 'Zona de concentração',
  helipad: 'Heliporto',
  other: 'Outra',
};

export const VEHICLE_TYPE_LABEL: Record<VehicleType, string> = {
  forest_firefighting_vehicle: 'Veículo florestal de combate a incêndios',
  light_firefighting_vehicle: 'Veículo ligeiro de combate a incêndios',
  urban_firefighting_vehicle: 'Veículo urbano de combate a incêndios',
  tanker_forest: 'Veículo tanque florestal',
  tanker_urban: 'Veículo tanque urbano',
  tanker_large: 'Tanque de grande capacidade',
  command_vehicle: 'Veículo de comando',
  command_comms_vehicle: 'Comando e comunicações',
  operations_vehicle: 'Veículo de operações',
  rescue_vehicle: 'Veículo de socorro',
  ambulance: 'Ambulância',
  advanced_medical_vehicle: 'Viatura médica (VMER)',
  immediate_life_support_vehicle: 'Suporte imediato de vida (SIV)',
  patrol_car: 'Carro de patrulha',
  motorcycle: 'Mota',
  traffic_unit: 'Unidade de trânsito',
  all_terrain_patrol: 'Patrulha todo-o-terreno',
  personnel_transport: 'Transporte de pessoal',
  bus: 'Autocarro',
  bulldozer: 'Bulldozer',
  heavy_machinery: 'Maquinaria pesada',
  tractor_plow: 'Trator com charrua',
  helicopter: 'Helicóptero',
  airtanker: 'Avião de combate',
  drone: 'Drone',
  other: 'Outro',
};

export const CAPABILITY_LABEL: Record<VehicleCapability, string> = {
  wildfire_attack: 'Ataque a incêndio rural',
  structure_protection: 'Proteção de estruturas',
  water_supply: 'Abastecimento de água',
  rescue: 'Socorro',
  extrication: 'Desencarceramento',
  evacuation_transport: 'Transporte de evacuação',
  medical_transport: 'Transporte médico',
  advanced_life_support: 'Suporte avançado de vida',
  traffic_control: 'Controlo de trânsito',
  perimeter_security: 'Segurança de perímetro',
  command_and_control: 'Comando e controlo',
  communications: 'Comunicações',
  reconnaissance: 'Reconhecimento',
  aerial_water_drop: 'Largada aérea de água',
  aerial_recon: 'Reconhecimento aéreo',
  heavy_earthmoving: 'Movimentação de terras',
  firebreak_construction: 'Abertura de faixas',
  logistics: 'Logística',
  lighting: 'Iluminação',
  hazmat: 'Matérias perigosas',
};

export const ROLE_LABEL: Record<PersonnelRole, string> = {
  firefighter: 'Bombeiro',
  forest_firefighter: 'Bombeiro florestal',
  crew_leader: 'Chefe de equipa',
  officer: 'Oficial',
  commander: 'Comandante',
  paramedic: 'Técnico de emergência',
  emergency_physician: 'Médico de emergência',
  nurse: 'Enfermeiro',
  police_officer: 'Agente policial',
  gnr_soldier: 'Militar GNR',
  traffic_officer: 'Agente de trânsito',
  rescue_specialist: 'Especialista de socorro',
  drone_pilot: 'Piloto de drone',
  driver_operator: 'Condutor / operador',
  comms_operator: 'Operador de comunicações',
  civil_protection_technician: 'Técnico de Proteção Civil',
  volunteer: 'Voluntário',
  other: 'Outro',
};

export const EQUIPMENT_LABEL: Record<EquipmentKind, string> = {
  hose_line: 'Linha de mangueira',
  portable_pump: 'Motobomba portátil',
  portable_water_tank: 'Depósito de água portátil',
  chainsaw: 'Motosserra',
  hand_tools: 'Ferramentas manuais',
  ppe_set: 'Equipamento de proteção individual',
  breathing_apparatus: 'Aparelho respiratório',
  handheld_radio: 'Rádio portátil',
  vehicle_radio: 'Rádio de viatura',
  satellite_phone: 'Telefone satélite',
  generator: 'Gerador',
  lighting_tower: 'Torre de iluminação',
  road_barrier: 'Barreira de estrada',
  traffic_cone: 'Cone de sinalização',
  road_sign: 'Sinal de trânsito',
  shelter_tent: 'Tenda de abrigo',
  stretcher: 'Maca',
  medical_kit: 'Kit médico',
  defibrillator: 'Desfibrilhador',
  thermal_camera: 'Câmara térmica',
  gps_tracker: 'Localizador GPS',
  megaphone: 'Megafone',
  other: 'Outro',
};

export const VEHICLE_STATUS_LABEL: Record<VehicleStatus, string> = {
  available: 'Disponível',
  assigned: 'Atribuído',
  dispatched: 'Despachado',
  en_route: 'A caminho',
  on_scene: 'No local',
  returning: 'A regressar',
  refilling: 'A reabastecer',
  out_of_service: 'Fora de serviço',
  maintenance: 'Em manutenção',
  unavailable: 'Indisponível',
};

export const UNIT_PHASE_LABEL: Record<'base' | 'ordered' | 'en_route' | 'working' | 'to_water' | 'filling' | 'returning' | 'refueling', string> = {
  base: 'No quartel',
  ordered: 'Ordem recebida',
  en_route: 'A caminho',
  working: 'No local',
  to_water: 'A caminho da água',
  filling: 'A carregar água',
  returning: 'A regressar',
  refueling: 'A reabastecer',
};

/** The server's `DispatchStatus` values, as shown on the unit tooltip. */
export const DISPATCH_STATUS_LABEL: Record<DispatchStatus, string> = {
  ordered: 'Ordem recebida',
  en_route: 'A caminho',
  on_scene: 'No local',
  working: 'A trabalhar',
  refilling: 'A reabastecer água',
  resting: 'Em descanso',
  grounded: 'Em terra',
  returning: 'A regressar',
  completed: 'Concluído',
  cancelled: 'Cancelado',
  failed: 'Falhou',
};

/** Display colour per organization type (map markers and lists). */
export const ORG_COLOR: Record<string, string> = {
  fire_brigade: '#ff3b3b',
  gnr: '#38c172',
  psp: '#1b8f55',
  inem: '#4c8dff',
  civil_protection: '#f5b301',
  air_force: '#b583ff',
  municipality: '#d9a066',
  forest_service: '#7bd389',
};

export const enumEntries = <K extends string>(labels: Record<K, string>): [K, string][] => Object.entries(labels) as [K, string][];
