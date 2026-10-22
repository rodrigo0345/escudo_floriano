import type { ActionPriority, Plan, PlanAction } from '@/api';

import type { ActionWindow } from './actionTiming';

/**
 * The agents' plan read as decisions instead of rows: what they are trying to achieve (the goal), what each decision does in one sentence,
 * why, and with which units. The agents publish one action per unit (nine vehicles defending the same camp site are nine actions with the
 * same title), so actions of the same type and title are one decision with N units.
 */
export type Goal = 'people' | 'fire' | 'buildings' | 'access' | 'support';

export const GOALS: Record<Goal, { label: string; hint: string; color: string }> = {
  people: { label: 'Proteger pessoas', hint: 'Evacuar, abrigar, avisar e socorrer quem está no caminho do fogo.', color: '#ff7a1a' },
  fire: { label: 'Travar o fogo', hint: 'Onde as equipas e os meios aéreos atacam o fogo, e como.', color: '#ffd400' },
  buildings: { label: 'Defender edifícios', hint: 'Casas e equipamentos que as equipas defendem no local.', color: '#c07bff' },
  access: { label: 'Controlar acessos', hint: 'Estradas cortadas e trânsito controlado: afastar civis e deixar passar o socorro.', color: '#ff3b3b' },
  support: { label: 'Comando e apoio', hint: 'Posto de comando, meios em espera, reforços e reconhecimento.', color: '#4da3ff' },
};
export const GOAL_ORDER = Object.keys(GOALS) as Goal[];

const GOAL_OF: Record<PlanAction['type'], Goal> = {
  evacuation: 'people',
  shelter_in_place: 'people',
  public_alert: 'people',
  medical_standby: 'people',
  fire_attack: 'fire',
  air_support_request: 'fire',
  structure_protection: 'buildings',
  road_closure: 'access',
  traffic_control_point: 'access',
  establish_command_post: 'support',
  stage_resources: 'support',
  dispatch_units: 'support',
  request_reinforcements: 'support',
  reconnaissance: 'support',
  custom: 'support',
};

/** The plan's objectives (`Objective.objective`), as the operator reads them. */
export const OBJECTIVE_LABEL: Record<string, string> = {
  protect_life: 'Vidas',
  protect_buildings: 'Edifícios',
  keep_access_routes: 'Acessos',
  protect_infrastructure: 'Infraestruturas',
  protect_environment: 'Ambiente',
  minimize_burned_area: 'Menos área ardida',
  protect_responders: 'Segurança das equipas',
};

const TACTIC: Record<string, string> = {
  direct: 'Ataque direto: as equipas apagam a frente do fogo de perto',
  indirect: 'Ataque indireto: linha de contenção feita à distância, à frente do fogo',
  parallel: 'Ataque paralelo: linha junto à frente, a acompanhá-la',
  flank: 'Ataque pelo flanco: estreitar a frente pelos lados',
  backfire: 'Contrafogo: queimar à frente do fogo para lhe tirar o combustível',
  hold_line: 'Segurar uma linha já feita para o fogo não a passar',
};
const DROP_AGENT: Record<string, string> = { water: 'água', retardant: 'retardante', foam: 'espuma' };
const LINE_METHOD: Record<string, string> = { handline: 'linha de mangueira', wet_line: 'linha molhada', machine: 'linha aberta com máquina' };
const EVACUATION_MODE: Record<string, string> = { mandatory: 'obrigatória', recommended: 'recomendada', precautionary: 'preventiva' };
const STRUCTURE_TACTIC: Record<string, string> = {
  wetting: 'molhar à volta',
  defensible_space: 'limpar o espaço à volta',
  foam: 'cobrir com espuma',
  sprinklers: 'aspersores',
  hold_and_defend: 'ficar e defender no local',
};
const TRAFFIC_MODE: Record<string, string> = {
  stop: 'ninguém passa',
  alternating_one_way: 'trânsito alternado',
  diversion: 'desvio',
  escort: 'escolta',
  residents_only: 'só moradores',
};
const MISSION: Record<string, string> = {
  initial_attack: 'ataque inicial',
  direct_attack: 'ataque direto',
  indirect_attack: 'ataque indireto',
  structure_protection: 'defesa de edifícios',
  water_shuttle: 'transporte de água',
  rescue: 'salvamento',
  medical_response: 'socorro médico',
  traffic_control: 'controlo de trânsito',
  patrol: 'patrulha',
  recon: 'reconhecimento',
  logistics: 'logística',
  mop_up: 'rescaldo',
};
const AIR_SUPPORT: Record<string, string> = { helicopter_water: 'helicóptero com balde', airtanker: 'avião de combate', recon_aircraft: 'avião de reconhecimento', drone: 'drone' };
const RECON_METHOD: Record<string, string> = { drone: 'drone', helicopter: 'helicóptero', ground_patrol: 'patrulha no terreno', lookout_tower: 'posto de vigia' };
const ALERT_CHANNEL: Record<string, string> = {
  cell_broadcast: 'alerta no telemóvel',
  sms: 'SMS',
  radio: 'rádio',
  sirens: 'sirenes',
  social_media: 'redes sociais',
  door_to_door: 'porta a porta',
  road_signs: 'painéis na estrada',
  website: 'site',
};

const PRIORITY_RANK: Record<ActionPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };

type Json = Record<string, unknown>;
type Target = { label?: string };
const labelsOf = (targets: (Target | undefined)[] | undefined): string =>
  [...new Set((targets ?? []).map((t) => t?.label?.trim()).filter((l): l is string => !!l))].join(', ');
const list = (items: string[]): string => (items.length > 1 ? `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}` : items[0] ?? '');

/** One sentence on what the action does, from its typed fields (not its title, which the card already shows). */
export function whatOf(action: PlanAction): string {
  switch (action.type) {
    case 'fire_attack': {
      const effect = (action.simulationEffects ?? [])[0] as unknown as Json | undefined;
      // some agents write the tactic in their own words instead of the enum: show what they wrote
      const tactic = TACTIC[action.tactic] ?? (action.tactic ? `Ataque ao fogo: ${action.tactic}` : 'Ataque ao fogo');
      const how =
        effect?.type === 'aerial_drop'
          ? `Largada aérea de ${DROP_AGENT[String(effect.agent)] ?? 'água'} para atrasar a frente`
          : effect?.type === 'fire_line' && LINE_METHOD[String(effect.method)]
            ? `${tactic}, com ${LINE_METHOD[String(effect.method)]}`
            : tactic;
      return action.objective ? `${how}. Objetivo: ${action.objective}` : how;
    }
    case 'evacuation': {
      const who = action.estimatedPeople ? `~${action.estimatedPeople} pessoas` : 'as pessoas';
      const to = labelsOf(action.shelters?.map((s) => ({ label: s.name })));
      return `Retirar ${who} da zona${to ? ` para ${to}` : ''} (evacuação ${EVACUATION_MODE[action.mode] ?? action.mode})`;
    }
    case 'shelter_in_place':
      return `Manter as pessoas abrigadas em casa enquanto o fogo passa${action.guidance ? `: ${action.guidance}` : ''}`;
    case 'structure_protection': {
      const where = labelsOf(action.targets);
      const how = action.tactic ? ` (${STRUCTURE_TACTIC[action.tactic] ?? action.tactic})` : '';
      return `Defender ${where || 'os edifícios'} no local quando o fogo chegar${how}`;
    }
    case 'road_closure': {
      const n = action.roadIds?.length ?? 0;
      const emergency = (action.exemptions ?? []).includes('emergency_vehicles');
      return `Cortar ${n ? `${n} ${n === 1 ? 'troço' : 'troços'} de estrada` : 'a estrada'}: ${emergency ? 'civis não passam, o socorro passa' : 'ninguém passa'}`;
    }
    case 'traffic_control_point':
      return `Posto de controlo de trânsito: ${TRAFFIC_MODE[action.mode] ?? action.mode}${action.instructions ? `. ${action.instructions}` : ''}`;
    case 'medical_standby': {
      const where = labelsOf(action.positions);
      const alert = action.hospitalAlert === 'full_activation' ? ' · hospitais ativados' : action.hospitalAlert === 'prepare' ? ' · hospitais em alerta' : '';
      return `Ambulâncias em prevenção${where ? ` em ${where}` : ''}, prontas para socorrer${alert}`;
    }
    case 'establish_command_post':
      return `Montar o posto de comando${action.location.label ? ` em ${action.location.label}` : ''}${action.radioChannel ? ` · canal ${action.radioChannel}` : ''}`;
    case 'stage_resources':
      return `Deixar meios em espera${action.stagingArea.label ? ` em ${action.stagingArea.label}` : ''}, prontos a sair`;
    case 'dispatch_units':
      return `Enviar meios para ${MISSION[action.mission] ?? action.mission}${action.target.label ? ` em ${action.target.label}` : ''}`;
    case 'air_support_request':
      return `Pedir ${AIR_SUPPORT[action.supportKind] ?? action.supportKind}${action.requestedFrom ? ` a ${action.requestedFrom}` : ''}${action.targetArea.label ? ` para ${action.targetArea.label}` : ''}`;
    case 'public_alert': {
      const text = action.messages?.[0]?.text;
      return `Avisar a população por ${list(action.channels.map((c) => ALERT_CHANNEL[c] ?? c))}${text ? `: «${text}»` : ''}`;
    }
    case 'request_reinforcements': {
      const vehicles = (action.vehicles ?? []).reduce((s, v) => s + v.quantity, 0);
      const people = (action.personnel ?? []).reduce((s, p) => s + p.quantity, 0);
      const what = [vehicles ? `${vehicles} veículos` : '', people ? `${people} operacionais` : ''].filter(Boolean).join(' e ');
      return `Pedir reforços${what ? ` (${what})` : ''}${action.region ? ` de ${action.region}` : ''}`;
    }
    case 'reconnaissance':
      return `Vigiar o fogo com ${RECON_METHOD[action.method] ?? action.method}${action.updateIntervalMinutes ? `, com novidades a cada ${action.updateIntervalMinutes} min` : ''}`;
    default:
      return action.description ?? '';
  }
}

/** Actions of the same type and title are one decision (the agents publish one action per unit). */
export const decisionKey = (action: PlanAction): string => `${action.type}|${action.title.trim()}`;

export interface Decision {
  key: string;
  goal: Goal;
  title: string;
  what: string;
  why: string;
  effect: string;
  safety: string;
  /** Escape routes, safety zones and lookouts the crews of a fire attack were given (drawn on the map when the decision is picked). */
  escapeRoutes: number;
  safetyZones: number;
  lookouts: number;
  priority: ActionPriority;
  confidence: number | null;
  organizationIds: string[];
  actions: PlanAction[];
  /** From the first unit's start to the last unit's end. */
  window: ActionWindow;
}

/** The plan's decisions, by goal order, then the most urgent and earliest first. */
export function decisionsOf(plan: Plan, windows: ReadonlyMap<string, ActionWindow>): Decision[] {
  const groups = new Map<string, PlanAction[]>();
  for (const action of plan.actions as PlanAction[]) groups.set(decisionKey(action), [...(groups.get(decisionKey(action)) ?? []), action]);

  const decisions = [...groups.entries()].map(([key, actions]): Decision => {
    const first = actions[0];
    const spans = actions.map((a) => windows.get(a.id as string)).filter((w): w is ActionWindow => !!w);
    const confidences = actions.map((a) => a.confidence).filter((c): c is number => typeof c === 'number');
    const attacks = actions.filter((a) => a.type === 'fire_attack');
    return {
      key,
      goal: GOAL_OF[first.type] ?? 'support',
      title: first.title,
      what: whatOf(first),
      why: (first.rationale || first.description || '').trim(),
      effect: (first.expectedEffect ?? '').trim(),
      safety: (first.safetyNotes ?? '').trim(),
      escapeRoutes: attacks.reduce((s, a) => s + (a.escapeRoutes?.length ?? 0), 0),
      safetyZones: attacks.reduce((s, a) => s + (a.safetyZones?.length ?? 0), 0),
      lookouts: attacks.reduce((s, a) => s + (a.lookouts?.length ?? 0), 0),
      priority: actions.reduce<ActionPriority>((best, a) => (PRIORITY_RANK[a.priority ?? 'normal'] < PRIORITY_RANK[best] ? a.priority ?? 'normal' : best), 'low'),
      confidence: confidences.length ? confidences.reduce((s, c) => s + c, 0) / confidences.length : null,
      organizationIds: [...new Set(actions.flatMap((a) => [a.organizationId as string, ...((a.supportingOrganizationIds ?? []) as string[])]))],
      actions,
      window: spans.length
        ? { leaves: Math.min(...spans.map((w) => w.leaves)), start: Math.min(...spans.map((w) => w.start)), end: Math.max(...spans.map((w) => w.end)) }
        : { leaves: 0, start: 0, end: Infinity },
    };
  });
  return decisions.sort(
    (a, b) => GOAL_ORDER.indexOf(a.goal) - GOAL_ORDER.indexOf(b.goal) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.window.start - b.window.start,
  );
}

/** Where an action happens, for the camera: its own point, else the middle of its first drawn effect. */
export function whereOf(action: PlanAction): { lat: number; lon: number } | null {
  const a = action as unknown as Json;
  for (const p of [a.position, a.anchorPoint, (a.location as Json | undefined)?.position, ((a.checkpoints as Json[] | undefined) ?? [])[0]?.position]) {
    const point = p as { lat?: number; lon?: number } | undefined;
    if (point && typeof point.lat === 'number' && typeof point.lon === 'number') return { lat: point.lat, lon: point.lon };
  }
  for (const e of (a.simulationEffects as Json[] | undefined) ?? []) {
    const g = e.geometry as { type?: string; coordinates?: unknown } | undefined;
    const pts = g?.type === 'LineString' ? (g.coordinates as number[][]) : g?.type === 'Polygon' ? ((g.coordinates as number[][][])[0] ?? []) : [];
    if (pts.length) return { lat: pts.reduce((s, p) => s + p[1], 0) / pts.length, lon: pts.reduce((s, p) => s + p[0], 0) / pts.length };
  }
  return null;
}
