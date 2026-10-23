import { Fragment, useEffect, useMemo, useState } from 'react';

import type { ActionStatus, Plan, PlanAction, Vehicle } from '@/api';
import { Icon } from '@/components/common/Icon';
import { Tag } from '@/components/common/StatCard';
import { actionWindows, phaseAt, PHASE_LABEL, windowText, type ActionPhase } from '@/domain/actionTiming';
import { OrgLogo } from '@/domain/organizationLogos';
import { coreOrganizationIds, VEHICLE_TYPE_LABEL } from '@/domain/resourceLabels';
import { VehicleModelPhoto } from '@/domain/vehicleModelImages';
import { useWorld } from '@/engine/EngineContext';
import { useAppStore } from '@/store/appStore';
import { useResourcesStore } from '@/store/resourcesStore';

import styles from './panels.module.css';

/** What each kind of action is, in words an operator reads. */
const ACTION_KIND: Record<string, string> = {
  fire_attack: 'Combate ao fogo',
  dispatch_units: 'Envio de meios',
  stage_resources: 'Pré-posicionamento',
  establish_command_post: 'Posto de comando',
  road_closure: 'Corte de estrada',
  traffic_control_point: 'Patrulha de trânsito',
  evacuation: 'Evacuação',
  shelter_in_place: 'Abrigo no local',
  structure_protection: 'Defesa de edifícios',
  medical_standby: 'Prevenção médica',
  air_support_request: 'Pedido de meios aéreos',
  public_alert: 'Aviso à população',
  request_reinforcements: 'Pedido de reforços',
  reconnaissance: 'Reconhecimento',
  custom: 'Outra',
};

const PHASE_TAG: Record<ActionPhase, 'ok' | 'warn' | 'bad'> = { active: 'ok', en_route: 'warn', upcoming: 'warn', done: 'bad' };
const PHASE_ORDER: Record<ActionPhase, number> = { active: 0, en_route: 1, upcoming: 2, done: 3 };

const ACTION_STATUS_LABEL: Record<ActionStatus, string> = {
  planned: 'Planeada',
  acknowledged: 'Reconhecida',
  in_progress: 'Em curso',
  completed: 'Concluída',
  blocked: 'Bloqueada',
  cancelled: 'Cancelada',
  failed: 'Falhou',
};

// Completed/cancelled actions cannot be reopened: completedAt would otherwise remain set.
const ACTION_NEXT: Partial<Record<ActionStatus, { label: string; status: ActionStatus }[]>> = {
  planned: [{ label: 'Iniciar', status: 'in_progress' }],
  acknowledged: [{ label: 'Iniciar', status: 'in_progress' }],
  in_progress: [
    { label: 'Concluir', status: 'completed' },
    { label: 'Bloqueada', status: 'blocked' },
  ],
  blocked: [{ label: 'Retomar', status: 'in_progress' }],
  failed: [{ label: 'Retomar', status: 'in_progress' }],
};

type Json = Record<string, unknown>;

function whereOf(action: PlanAction): { lat: number; lon: number } | null {
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

/**
 * Every action of a plan, by organization (with its emblem), as it stands at the playback minute: under way, on the road, still to come or over,
 * and the vehicles doing it (GNR patrol cars included), with their photo, callsign and crew. By default only what is happening at that minute is listed
 * (the map shows the same), so the operator reads the operation as it unfolds; a row puts that action on the map.
 */
export function PlanActionsNow({ plan, onMap, showOnMap, busyActionId, onProgress }: {
  plan: Plan;
  onMap: boolean;
  showOnMap: () => void;
  busyActionId: string | null;
  onProgress: (action: PlanAction, status: ActionStatus) => void;
}) {
  const world = useWorld();
  const run = useAppStore((s) => s.run);
  const t = useAppStore((s) => s.t);
  const focused = useAppStore((s) => s.focusedActionId);
  const setFocused = useAppStore((s) => s.setFocusedAction);
  const organizations = useResourcesStore((s) => s.organizations);
  const vehicles = useResourcesStore((s) => s.vehicles);
  const [all, setAll] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [orgFilter, setOrgFilter] = useState<string | null>(null);
  const [showReinforcements, setShowReinforcements] = useState(false);
  const selectedUnitId = useAppStore((s) => s.selectedUnitId);
  const selectUnit = useAppStore((s) => s.selectUnit);

  const windows = useMemo(() => actionWindows(plan), [plan]);
  const vehicleOf = useMemo(() => new Map(vehicles.map((v) => [v.id as string, v])), [vehicles]);
  const coreIds = useMemo(() => coreOrganizationIds(organizations), [organizations]);
  const cursor = onMap && run ? t : null;
  const nowOnly = cursor !== null && !all;

  const rows = (plan.actions as PlanAction[])
    .map((action) => {
      const window = windows.get(action.id as string)!;
      return { action, window, phase: cursor === null ? ('upcoming' as ActionPhase) : phaseAt(window, cursor) };
    })
    .filter((r) => !nowOnly || r.phase === 'active' || r.phase === 'en_route')
    .sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || a.window.start - b.window.start);

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const id = row.action.organizationId ?? '—';
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }
  const orgOf = (id: string) => organizations.find((o) => o.id === id);
  const orgIds = [...new Set(plan.actions.map((a) => a.organizationId ?? '—'))]
    .sort((a, b) => (orgOf(a)?.name ?? a).localeCompare(orgOf(b)?.name ?? b));
  const visibleGroups = [...groups.entries()].filter(([id]) => orgFilter === null || id === orgFilter);
  const active = cursor === null ? 0 : rows.filter((r) => r.phase === 'active').length;
  // the concelho's four corporations first; reinforcements and other organizations under one "Reforços" entry, closed unless asked for
  const isCore = (id: string) => coreIds.has(id);
  const coreChipIds = orgIds.filter(isCore);
  const extraIds = orgIds.filter((id) => !isCore(id));
  const extraOpen = showReinforcements || (orgFilter !== null && !isCore(orgFilter));
  const sortedGroups = visibleGroups.sort(([a], [b]) => (orgOf(a)?.name ?? a).localeCompare(orgOf(b)?.name ?? b));
  const coreGroups = sortedGroups.filter(([id]) => isCore(id));
  const extraGroups = sortedGroups.filter(([id]) => !isCore(id));
  const shownGroups = extraOpen ? [...coreGroups, ...extraGroups] : coreGroups;
  const extraActions = extraGroups.reduce((sum, [, list]) => sum + list.length, 0);
  const orgChip = (id: string) => (
    <button key={id} className={orgFilter === id ? 'on' : ''} onClick={() => setOrgFilter(id)}>
      <OrgLogo org={orgOf(id) ?? id} size={14} inline />
      {orgOf(id)?.shortName ?? orgOf(id)?.name ?? id}
    </button>
  );
  const reinforcementsHead = extraGroups.length ? (
    <button type="button" className={styles.reinforcementsHead} onClick={() => setShowReinforcements(!extraOpen)} aria-expanded={extraOpen}>
      <b>Reforços</b>
      <small className="note">
        {extraGroups.length} {extraGroups.length === 1 ? 'corporação' : 'corporações'} · {extraActions} {extraActions === 1 ? 'ação' : 'ações'}
      </small>
      <span className={`${styles.reinforcementsChevron} ${extraOpen ? styles.reinforcementsChevronOpen : ''}`} aria-hidden="true">
        <Icon name="chevron" size={14} />
      </span>
    </button>
  ) : null;

  // a vehicle clicked on the map: focus the action it is doing at this minute (else the next one it has, else the last it had)
  useEffect(() => {
    if (!selectedUnitId) return;
    const mine = (plan.actions as PlanAction[]).filter((a) => (a.resources ?? []).some((r) => r.resourceId === selectedUnitId));
    const minute = cursor ?? 0;
    const ranked = mine
      .map((a) => ({ a, w: windows.get(a.id as string)!, phase: phaseAt(windows.get(a.id as string)!, minute) }))
      .sort((x, y) => PHASE_ORDER[x.phase] - PHASE_ORDER[y.phase] || (x.phase === 'done' ? y.w.end - x.w.end : x.w.start - y.w.start));
    const chosen = ranked[0]?.a;
    selectUnit(null);
    if (!chosen) return;
    const id = chosen.id as string;
    setFocused(id);
    setOpenRow(id);
    setAll(true);
    setOrgFilter(null); // the vehicle's action may belong to another organization than the one filtered
    if (!coreIds.has(chosen.organizationId as string)) setShowReinforcements(true); // ...or to a reinforcement
    setTimeout(() => document.getElementById(`action-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
    const where = whereOf(chosen);
    if (where && world) world.focusOnLatLon(where.lat, where.lon);
  }, [selectedUnitId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (action: PlanAction) => {
    const id = action.id as string;
    setOpenRow(openRow === id ? null : id);
    if (focused === id) return setFocused(null);
    setFocused(id);
    if (!onMap) showOnMap();
    const where = whereOf(action);
    if (where && world) world.focusOnLatLon(where.lat, where.lon);
  };

  return (
    <>
      <div className={styles.actionsHead}>
        <div className={styles.actionsHeadText}>
          <span className={styles.actionsHeadTitle}>{nowOnly ? `A decorrer · T+${Math.round(cursor!)} min` : `Todas as ações · ${plan.actions.length}`}</span>
          {nowOnly ? (
            <span className={styles.actionsCounts}>
              <span className={styles.countPill}>
                <b>{active}</b> em curso
              </span>
              <span className={styles.countPill}>
                <b>{rows.length - active}</b> a caminho
              </span>
            </span>
          ) : cursor === null ? (
            <small className="note">Ponha o plano no mapa para ver o que decorre em cada minuto.</small>
          ) : null}
        </div>
        {cursor !== null ? (
          <button type="button" className={styles.actionsToggle} onClick={() => setAll(!all)}>
            {all ? 'Só agora' : 'Ver todas'}
          </button>
        ) : null}
      </div>
      <div className={styles.orgFilter}>
        <button className={orgFilter === null ? 'on' : ''} onClick={() => setOrgFilter(null)}>Todas</button>
        {coreChipIds.map(orgChip)}
        {extraIds.length ? (
          <button className={extraOpen ? 'on' : ''} onClick={() => setShowReinforcements(!extraOpen)} aria-expanded={extraOpen} title="Grupos de reforço e outras organizações">
            Reforços ({extraIds.length})
          </button>
        ) : null}
        {extraOpen ? extraIds.map(orgChip) : null}
      </div>
      {!visibleGroups.length ? <p className="note">{nowOnly ? 'Nada a decorrer neste minuto com este filtro: avance a linha do tempo ou veja todas.' : 'Sem ações para esta organização.'}</p> : null}
      {shownGroups.map(([organizationId, list], index) => {
          const org = orgOf(organizationId);
          return (
            <Fragment key={organizationId}>
            {index === coreGroups.length ? reinforcementsHead : null}
            <div className={styles.actionGroup}>
              <div className={styles.orgHead}>
                <OrgLogo org={org ?? organizationId} size={26} inline />
                <b>{org?.shortName ?? org?.name ?? organizationId}</b>
                <small className="note" style={{ marginLeft: 'auto' }}>
                  {list.length} {list.length === 1 ? 'ação' : 'ações'}
                </small>
              </div>
              {list.map(({ action, window, phase }) => {
                const id = action.id as string;
                const units = (action.resources ?? []).filter((r) => r.resourceType === 'vehicle' || r.resourceType === 'personnel_pool');
                return (
                  <div key={id} id={`action-${id}`} className={`${styles.actionCard} ${focused === id ? styles.actionCardOn : ''}`} onClick={() => pick(action)} title="Mostrar no mapa">
                    <div className={styles.actionCardHead}>
                      <span className={styles.actionKind}>{ACTION_KIND[action.type] ?? action.type}</span>
                      {cursor !== null ? <Tag kind={PHASE_TAG[phase]}>{PHASE_LABEL[phase]}</Tag> : null}
                      <small className="note" style={{ marginLeft: 'auto' }}>{windowText(window)}</small>
                    </div>
                    <b className={styles.actionTitle}>{action.title}</b>
                    {action.supportingOrganizationIds?.length ? (
                      <small className="note">Apoia: {action.supportingOrganizationIds.map((id) => orgOf(id)?.name ?? id).join(', ')}</small>
                    ) : null}
                    {units.length ? (
                      <div className={styles.unitChips}>
                        {units.map((r) => {
                          const v: Vehicle | undefined = r.resourceType === 'vehicle' ? vehicleOf.get(r.resourceId as string) : undefined;
                          return (
                            <span key={r.resourceId as string} className={styles.unitChip} title={v ? `${v.callsign} · ${VEHICLE_TYPE_LABEL[v.type] ?? v.type}` : String(r.resourceId)}>
                              {v ? <VehicleModelPhoto type={v.type} size={{ width: 34, height: 22 }} /> : null}
                              <span>{v?.callsign ?? (r.resourceType === 'personnel_pool' ? 'Equipa a pé' : String(r.resourceId))}</span>
                              {r.personnel ? <small>{r.personnel} p</small> : null}
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                    {openRow === id && action.rationale ? <small className={styles.rationale}>{action.rationale}</small> : null}
                    <div className={styles.actionTags}>
                      <Tag kind={action.priority === 'critical' ? 'bad' : 'ok'}>{action.priority ?? 'normal'}</Tag>
                      <span title="Estado reportado pela organização">
                        <Tag kind={action.status === 'completed' ? 'ok' : action.status === 'blocked' || action.status === 'failed' ? 'bad' : 'warn'}>
                          {ACTION_STATUS_LABEL[action.status ?? 'planned']}
                        </Tag>
                      </span>
                      {plan.status === 'active' ? (
                        <span className={styles.stepBtns}>
                          {(ACTION_NEXT[action.status ?? 'planned'] ?? []).map((step) => (
                            <button
                              key={step.status}
                              disabled={busyActionId !== null}
                              title={`Marcar como ${ACTION_STATUS_LABEL[step.status]}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                onProgress(action, step.status);
                              }}
                            >
                              {busyActionId === id ? '…' : step.label}
                            </button>
                          ))}
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
            </Fragment>
          );
        })}
      {!extraOpen ? reinforcementsHead : null}
    </>
  );
}
