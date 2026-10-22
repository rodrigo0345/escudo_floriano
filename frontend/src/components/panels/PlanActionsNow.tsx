import { useEffect, useMemo, useState } from 'react';

import type { Plan, PlanAction, Vehicle } from '@/api';
import { Tag } from '@/components/common/StatCard';
import { actionWindows, phaseAt, PHASE_LABEL, windowText, type ActionPhase } from '@/domain/actionTiming';
import { OrgLogo } from '@/domain/organizationLogos';
import { VEHICLE_TYPE_LABEL } from '@/domain/resourceLabels';
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
export function PlanActionsNow({ plan, onMap, showOnMap }: { plan: Plan; onMap: boolean; showOnMap: () => void }) {
  const world = useWorld();
  const run = useAppStore((s) => s.run);
  const t = useAppStore((s) => s.t);
  const focused = useAppStore((s) => s.focusedActionId);
  const setFocused = useAppStore((s) => s.setFocusedAction);
  const organizations = useResourcesStore((s) => s.organizations);
  const vehicles = useResourcesStore((s) => s.vehicles);
  const [all, setAll] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const selectedUnitId = useAppStore((s) => s.selectedUnitId);
  const selectUnit = useAppStore((s) => s.selectUnit);

  const windows = useMemo(() => actionWindows(plan), [plan]);
  const vehicleOf = useMemo(() => new Map(vehicles.map((v) => [v.id as string, v])), [vehicles]);
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
  const active = cursor === null ? 0 : rows.filter((r) => r.phase === 'active').length;

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
        <h3>
          {nowOnly ? `A decorrer em T+${Math.round(cursor!)} min` : `Todas as ações (${plan.actions.length})`}
          {nowOnly ? <small className="note"> · {active} em curso · {rows.length - active} a caminho</small> : null}
        </h3>
        {cursor !== null ? (
          <button className={all ? '' : 'on'} onClick={() => setAll(!all)}>
            {all ? 'Só o que decorre agora' : 'Ver todas'}
          </button>
        ) : (
          <small className="note">Ponha o plano no mapa para ver o que decorre em cada minuto.</small>
        )}
      </div>
      {!rows.length ? <p className="note">Nada a decorrer neste minuto: avance a linha do tempo.</p> : null}
      {[...groups.entries()]
        .sort(([a], [b]) => (orgOf(a)?.name ?? a).localeCompare(orgOf(b)?.name ?? b))
        .map(([organizationId, list]) => {
          const org = orgOf(organizationId);
          return (
            <div key={organizationId} className={styles.actionGroup}>
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
                  </div>
                );
              })}
            </div>
          );
        })}
    </>
  );
}
