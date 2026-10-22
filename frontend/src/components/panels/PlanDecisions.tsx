import { useMemo, useState } from 'react';

import type { ActionStatus, Plan, PlanAction, Vehicle } from '@/api';
import { Tag } from '@/components/common/StatCard';
import { actionWindows, phaseAt, PHASE_LABEL, windowText, type ActionPhase } from '@/domain/actionTiming';
import { OrgLogo } from '@/domain/organizationLogos';
import { decisionsOf, GOAL_ORDER, GOALS, OBJECTIVE_LABEL, whereOf, type Decision, type Goal } from '@/domain/planDecisions';
import { VEHICLE_TYPE_LABEL } from '@/domain/resourceLabels';
import { VehicleModelPhoto } from '@/domain/vehicleModelImages';
import { useWorld } from '@/engine/EngineContext';
import { useAppStore } from '@/store/appStore';
import { useResourcesStore } from '@/store/resourcesStore';

import styles from './panels.module.css';

const PHASE_TAG: Record<ActionPhase, 'ok' | 'warn' | 'bad'> = { active: 'ok', en_route: 'warn', upcoming: 'warn', done: 'bad' };
const PRIORITY_LABEL: Record<string, string> = { critical: 'Crítica', high: 'Alta' };
const UNIT_CHIPS = 6;

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

const statusKind = (status: ActionStatus): 'ok' | 'warn' | 'bad' => (status === 'completed' ? 'ok' : status === 'blocked' || status === 'failed' ? 'bad' : 'warn');

/**
 * What the agents decided, read as decisions grouped by what they are trying to achieve (protect people, stop the fire, defend buildings,
 * control access, command and support). Each card says what the decision does, why, the effect the agent expects, when and with whom; the
 * units of a decision (one action each) open below it. Picking a card puts that decision on the map, with its escape routes and safety zones.
 */
export function PlanDecisions({ plan, onMap, showOnMap, busyActionId, onProgress }: {
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
  const [nowOnly, setNowOnly] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [orgFilter, setOrgFilter] = useState<string | null>(null);

  const windows = useMemo(() => actionWindows(plan), [plan]);
  const decisions = useMemo(() => decisionsOf(plan, windows), [plan, windows]);
  const vehicleOf = useMemo(() => new Map(vehicles.map((v) => [v.id as string, v])), [vehicles]);
  const orgOf = (id: string) => organizations.find((o) => o.id === id);
  const cursor = onMap && run ? t : null;
  const phaseOf = (d: Decision): ActionPhase | null => (cursor === null ? null : phaseAt(d.window, cursor));

  const shown = decisions.filter(
    (d) => (orgFilter === null || d.organizationIds.includes(orgFilter)) && (!nowOnly || phaseOf(d) === 'active' || phaseOf(d) === 'en_route'),
  );
  const orgIds = [...new Set(decisions.flatMap((d) => d.organizationIds))].sort((a, b) => (orgOf(a)?.name ?? a).localeCompare(orgOf(b)?.name ?? b));
  const objectives = [...(plan.objectives ?? [])].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  const focusedKey = decisions.find((d) => d.actions.some((a) => a.id === focused))?.key ?? null;

  const pick = (d: Decision) => {
    if (focusedKey === d.key) {
      setOpenKey(null);
      return setFocused(null);
    }
    setOpenKey(d.key);
    setFocused(d.actions[0].id as string);
    if (!onMap) showOnMap();
    const where = d.actions.map(whereOf).find(Boolean);
    if (where && world) world.focusOnLatLon(where.lat, where.lon);
  };

  return (
    <>
      <div className={styles.actionsHead}>
        <h3>
          O que os agentes decidiram
          <small className="note">
            {' '}
            · {decisions.length} decisões · {plan.actions.length} ações
          </small>
        </h3>
        {cursor !== null ? (
          <button className={nowOnly ? 'on' : ''} onClick={() => setNowOnly(!nowOnly)} title={`Só o que decorre em T+${Math.round(cursor)} min`}>
            Só o que decorre agora
          </button>
        ) : null}
      </div>
      {objectives.length ? (
        <div className={styles.objectives}>
          <small className="note">Prioridades do plano:</small>
          {objectives.map((o) => (
            <span key={o.objective} className={styles.objective}>
              {OBJECTIVE_LABEL[o.objective] ?? o.objective}
              {o.weight !== undefined ? <small> {Math.round(o.weight * 100)}%</small> : null}
            </span>
          ))}
        </div>
      ) : null}
      {orgIds.length > 1 ? (
        <div className={styles.orgFilter}>
          <button className={orgFilter === null ? 'on' : ''} onClick={() => setOrgFilter(null)}>Todas</button>
          {orgIds.map((id) => (
            <button key={id} className={orgFilter === id ? 'on' : ''} onClick={() => setOrgFilter(orgFilter === id ? null : id)}>
              <OrgLogo org={orgOf(id) ?? id} size={14} inline />
              {orgOf(id)?.shortName ?? orgOf(id)?.name ?? id}
            </button>
          ))}
        </div>
      ) : null}
      {cursor === null ? <small className="note">Simule o plano e ponha-o no mapa para ver o que decorre em cada minuto.</small> : null}
      {!shown.length ? <p className="note">{nowOnly ? 'Nada a decorrer neste minuto: avance a linha do tempo ou desligue o filtro.' : 'Sem decisões para esta organização.'}</p> : null}

      {GOAL_ORDER.map((goal: Goal) => {
        const inGoal = shown.filter((d) => d.goal === goal);
        if (!inGoal.length) return null;
        return (
          <section key={goal} className={styles.goal} style={{ borderLeftColor: GOALS[goal].color }}>
            <div className={styles.goalHead}>
              <b>{GOALS[goal].label}</b>
              <small className="note">
                {inGoal.length} {inGoal.length === 1 ? 'decisão' : 'decisões'}
              </small>
            </div>
            <small className={`note ${styles.goalHint}`}>{GOALS[goal].hint}</small>
            {inGoal.map((d) => (
              <DecisionCard
                key={d.key}
                decision={d}
                phase={phaseOf(d)}
                on={focusedKey === d.key}
                open={openKey === d.key}
                planActive={plan.status === 'active'}
                busyActionId={busyActionId}
                orgName={(id) => orgOf(id)?.shortName ?? orgOf(id)?.name ?? id}
                org={(id) => orgOf(id) ?? id}
                vehicleOf={vehicleOf}
                onPick={() => pick(d)}
                onToggle={() => setOpenKey(openKey === d.key ? null : d.key)}
                onProgress={onProgress}
              />
            ))}
          </section>
        );
      })}
    </>
  );
}

function DecisionCard({ decision: d, phase, on, open, planActive, busyActionId, orgName, org, vehicleOf, onPick, onToggle, onProgress }: {
  decision: Decision;
  phase: ActionPhase | null;
  on: boolean;
  open: boolean;
  planActive: boolean;
  busyActionId: string | null;
  orgName: (id: string) => string;
  org: (id: string) => Parameters<typeof OrgLogo>[0]['org'];
  vehicleOf: ReadonlyMap<string, Vehicle>;
  onPick: () => void;
  onToggle: () => void;
  onProgress: (action: PlanAction, status: ActionStatus) => void;
}) {
  const units = d.actions.flatMap((a) => (a.resources ?? []).filter((r) => r.resourceType === 'vehicle' || r.resourceType === 'personnel_pool'));
  const unique = [...new Map(units.map((r) => [r.resourceId as string, r])).values()];
  const personnel = unique.reduce((s, r) => s + (r.personnel ?? 0), 0);
  const statuses = d.actions.reduce<Partial<Record<ActionStatus, number>>>((c, a) => ({ ...c, [a.status ?? 'planned']: (c[a.status ?? 'planned'] ?? 0) + 1 }), {});
  const safetyCount = [
    d.escapeRoutes ? `${d.escapeRoutes} ${d.escapeRoutes === 1 ? 'via de fuga' : 'vias de fuga'}` : '',
    d.safetyZones ? `${d.safetyZones} ${d.safetyZones === 1 ? 'zona segura' : 'zonas seguras'}` : '',
    d.lookouts ? `${d.lookouts} ${d.lookouts === 1 ? 'vigia' : 'vigias'}` : '',
  ].filter(Boolean);

  return (
    <div className={`${styles.decision} ${on ? styles.actionCardOn : ''}`} onClick={onPick} title={on ? 'Tirar do mapa' : 'Mostrar no mapa'}>
      <div className={styles.actionCardHead}>
        {PRIORITY_LABEL[d.priority] ? <Tag kind={d.priority === 'critical' ? 'bad' : 'warn'}>{PRIORITY_LABEL[d.priority]}</Tag> : null}
        {phase ? <Tag kind={PHASE_TAG[phase]}>{PHASE_LABEL[phase]}</Tag> : null}
        <small className="note" style={{ marginLeft: 'auto' }}>{windowText(d.window)}</small>
      </div>
      <b className={styles.actionTitle}>
        {d.title}
        {d.actions.length > 1 ? <span className={styles.unitCount}> ×{d.actions.length}</span> : null}
      </b>
      {d.what ? <p className={styles.what}>{d.what}</p> : null}
      {d.why ? (
        <p className={`${styles.why} ${open ? '' : styles.clamp}`}>
          <span>Porquê</span> {d.why}
        </p>
      ) : null}
      {d.effect ? (
        <p className={styles.why}>
          <span>Efeito esperado</span> {d.effect}
        </p>
      ) : null}

      <div className={styles.decisionWho}>
        {d.organizationIds.map((id) => (
          <span key={id} className={styles.orgChip} title={orgName(id)}>
            <OrgLogo org={org(id)} size={16} inline />
            {orgName(id)}
          </span>
        ))}
        {unique.length ? (
          <small className="note">
            · {unique.length} {unique.length === 1 ? 'meio' : 'meios'}
            {personnel ? ` · ${personnel} operacionais` : ''}
          </small>
        ) : null}
      </div>
      {unique.length ? (
        <div className={styles.unitChips}>
          {unique.slice(0, open ? unique.length : UNIT_CHIPS).map((r) => {
            const v = r.resourceType === 'vehicle' ? vehicleOf.get(r.resourceId as string) : undefined;
            return (
              <span key={r.resourceId as string} className={styles.unitChip} title={v ? `${v.callsign} · ${VEHICLE_TYPE_LABEL[v.type] ?? v.type}` : String(r.resourceId)}>
                {v ? <VehicleModelPhoto type={v.type} size={{ width: 34, height: 22 }} /> : null}
                <span>{v?.callsign ?? (r.resourceType === 'personnel_pool' ? 'Equipa a pé' : String(r.resourceId))}</span>
                {r.personnel ? <small>{r.personnel} p</small> : null}
              </span>
            );
          })}
          {!open && unique.length > UNIT_CHIPS ? <small className="note">+{unique.length - UNIT_CHIPS}</small> : null}
        </div>
      ) : null}

      <div className={styles.actionTags}>
        {Object.entries(statuses).map(([status, n]) => (
          <span key={status} title="Estado reportado pela organização">
            <Tag kind={statusKind(status as ActionStatus)}>
              {ACTION_STATUS_LABEL[status as ActionStatus]}
              {d.actions.length > 1 ? ` ${n}` : ''}
            </Tag>
          </span>
        ))}
        <button
          className={styles.linkBtn}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          {open ? 'Menos' : 'Detalhes'}
        </button>
      </div>

      {open ? (
        <div className={styles.decisionMore} onClick={(event) => event.stopPropagation()}>
          {d.safety || safetyCount.length ? (
            <p className={styles.why}>
              <span>Segurança das equipas</span> {d.safety}
              {safetyCount.length ? (
                <small className="note">
                  {' '}
                  ({safetyCount.join(' · ')}
                  {on ? ', no mapa a tracejado' : ', escolha a decisão para as ver no mapa'})
                </small>
              ) : null}
            </p>
          ) : null}
          {d.confidence !== null ? (
            <p className={styles.why}>
              <span>Confiança do agente</span> {Math.round(d.confidence * 100)}%
            </p>
          ) : null}
          {d.actions.length > 1 || planActive ? (
            <div className={styles.decisionUnits}>
              {d.actions.map((a) => {
                const unit = (a.resources ?? [])[0];
                const v = unit?.resourceType === 'vehicle' ? vehicleOf.get(unit.resourceId as string) : undefined;
                const id = a.id as string;
                const status = a.status ?? 'planned';
                return (
                  <div key={id} className={styles.decisionUnit}>
                    <span>{v?.callsign ?? orgName(a.organizationId as string)}</span>
                    <Tag kind={statusKind(status)}>{ACTION_STATUS_LABEL[status]}</Tag>
                    {planActive ? (
                      <span className={styles.stepBtns}>
                        {(ACTION_NEXT[status] ?? []).map((step) => (
                          <button
                            key={step.status}
                            disabled={busyActionId !== null}
                            title={`Marcar como ${ACTION_STATUS_LABEL[step.status]}`}
                            onClick={() => onProgress(a, step.status)}
                          >
                            {busyActionId === id ? '…' : step.label}
                          </button>
                        ))}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
