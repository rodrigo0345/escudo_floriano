import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  plansApi,
  simulationsApi,
  type Action,
  type ActionPatch,
  type ActionStatus,
  type Plan,
  type PlanSummary,
  type PlanStatus,
  type Simulation,
} from '@/api';
import { Row, Tag } from '@/components/common/StatCard';
import { OrgLogo } from '@/domain/organizationLogos';
import { useSimulationActions } from '@/hooks/useSimulationActions';
import { useAppStore } from '@/store/appStore';
import { useResourcesStore } from '@/store/resourcesStore';

import { AttackTimeline } from './AttackTimeline';
import { PlanEditor } from './PlanEditor';
import { PlanRequestBox } from './PlanRequestBox';
import styles from './panels.module.css';

const nf = (n: number) => n.toLocaleString('pt-PT');
const ACTIONS_SHOWN = 40;

const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  proposed: 'Proposto',
  selected: 'Selecionado',
  active: 'Ativo',
  completed: 'Concluído',
  discarded: 'Descartado',
  cancelled: 'Cancelado',
};

const PLAN_STATUS_KIND: Record<PlanStatus, 'ok' | 'warn' | 'bad'> = {
  proposed: 'warn',
  selected: 'warn',
  active: 'ok',
  completed: 'ok',
  discarded: 'bad',
  cancelled: 'bad',
};

const ACTION_STATUS_LABEL: Record<string, string> = {
  planned: 'Planeada',
  acknowledged: 'Reconhecida',
  in_progress: 'Em curso',
  completed: 'Concluída',
  blocked: 'Bloqueada',
  cancelled: 'Cancelada',
  failed: 'Falhou',
};

/**
 * Próximos passos de execução por estado atual — os valores reais de `ActionStatus` (G5).
 * `cancelled` fica sem passos; `completed` também: o backend só preenche `completedAt` (nunca o limpa),
 * por isso reabrir uma ação concluída deixaria o registo com `completedAt` e estado `in_progress`.
 */
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

type Stats = NonNullable<Simulation['stats']>;
const METRICS: { key: 'burnedHa' | 'crownFireHa' | 'buildingsAffected' | 'populationExposed' | 'crewCasualties'; label: string; unit: string }[] = [
  { key: 'burnedHa', label: 'Área ardida', unit: ' ha' },
  { key: 'crownFireHa', label: 'Fogo de copas', unit: ' ha' },
  { key: 'buildingsAffected', label: 'Edifícios atingidos', unit: '' },
  { key: 'populationExposed', label: 'População exposta', unit: '' },
  { key: 'crewCasualties', label: 'Baixas de equipas', unit: '' }, // only a plan's what-if has it: the cost of the plan in people
];

/** `-26%` against the baseline; green when the plan did better (lower is better for every metric here). */
function Delta({ value, base }: { value?: number; base?: number }) {
  if (value == null || !base) return null;
  const pct = ((value - base) / base) * 100;
  return <Tag kind={pct <= 0 ? 'ok' : 'bad'}>{`${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`}</Tag>;
}

type CompareRow = { label: string; unit?: string; value: (sim?: Simulation) => number | undefined };

const COMPARE_ROWS: CompareRow[] = [
  { label: 'Área ardida', unit: ' ha', value: (s) => s?.stats?.burnedHa },
  { label: 'Fogo de copas', unit: ' ha', value: (s) => s?.stats?.crownFireHa },
  { label: 'Edifícios atingidos', value: (s) => s?.stats?.buildingsAffected },
  { label: 'População exposta', value: (s) => s?.stats?.populationExposed },
  { label: 'Pessoal em zona de fogo', value: (s) => s?.crewExposures?.reduce((sum, e) => sum + e.personnel, 0) },
  { label: 'Baixas de pessoal', value: (s) => s?.stats?.crewCasualties },
  { label: 'Estradas cortadas', value: (s) => s?.stats?.roadsCut },
];

/** One screen for the decision: base/A/B final metrics side by side, each plan against the baseline. */
function CompareTable({ base, plans, runs, edited }: { base?: Simulation; plans: PlanSummary[]; runs: Map<string, Simulation>; edited: Set<string> }) {
  const columns = plans.filter((p) => runs.has(p.id as string));
  if (columns.length === 0) return null;
  return (
    <div className={styles.compareCard}>
      <h3>Comparação</h3>
      <p className="note">Mesma base e o mesmo minuto final. Verde = melhor do que a base. ′ = ajustado pelo operador.</p>
      <div className={styles.compareScroll}>
        <table className={styles.compareTable}>
          <thead>
            <tr>
              <th>Indicador</th>
              <th>Base</th>
              {columns.map((p) => (
                <th key={p.id as string} title={p.title}>
                  {p.variant ?? 'Plano'}{edited.has(p.id as string) ? '′' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARE_ROWS.map((row) => {
              const baseline = row.value(base);
              return (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td>
                    <b>{baseline == null ? '—' : `${nf(baseline)}${row.unit ?? ''}`}</b>
                  </td>
                  {columns.map((p) => {
                    const value = row.value(runs.get(p.id as string));
                    return (
                      <td key={p.id as string}>
                        <b>{value == null ? '—' : `${nf(value)}${row.unit ?? ''}`}</b>
                        <Delta value={value} base={baseline} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatsRows({ stats, base }: { stats?: Stats; base?: Stats }) {
  if (!stats) return null;
  return (
    <>
      {METRICS.filter((m) => stats[m.key] != null).map((m) => (
        <Row key={m.key}>
          <span>{m.label}</span>
          <span>
            {nf(stats[m.key] as number)}
            {m.unit} {base ? <Delta value={stats[m.key]} base={base[m.key]} /> : null}
          </span>
        </Row>
      ))}
    </>
  );
}

/** What each organization's agents did in a plan (`metadata["agents.metrics"]`, written by the agents service): the numbers the engine does not give. */
interface AgentMetrics {
  people: { atRisk: number; evacuatedInTime: number; sheltered: number; exposed: number; vulnerableAtRisk: number; vulnerableEvacuated: number };
  civilProtection: { evacuations: number; withShelter: number; transports: number; publicAlerts: number; commandPost: boolean };
  gnr: { roadsClosed: number; roadsWithoutPatrol: number; patrols: number };
  inem: { ambulancesOnStandby: number; hospitalsAlerted: number };
  units: { committed: number; forwardReserve: number; noSafeSpot: number };
  fire: { outAtMinute: number | null };
}

function metricsOf(plan: Plan | undefined): AgentMetrics | null {
  const value = (plan?.metadata as Record<string, unknown> | undefined)?.['agents.metrics'];
  return value && typeof value === 'object' ? (value as AgentMetrics) : null;
}

function AgentRows({ m }: { m: AgentMetrics | null }) {
  if (!m) return null;
  return (
    <>
      <Row>
        <span>Fogo</span>
        <span>{m.fire?.outAtMinute != null ? <Tag kind="ok">{`extinto às T+${m.fire.outAtMinute} min`}</Tag> : <Tag kind="warn">ativo no fim</Tag>}</span>
      </Row>
      <Row>
        <span title="Modelo dos agentes: o motor não conta evacuações">Pessoas evacuadas a tempo</span>
        <span>
          {nf(m.people.evacuatedInTime)} de {nf(m.people.atRisk)}
          {m.people.sheltered ? ` · ${nf(m.people.sheltered)} abrigadas` : ''}
          {m.people.exposed ? ` · ${nf(m.people.exposed)} expostas` : ''}
        </span>
      </Row>
      <Row>
        <span>Proteção Civil</span>
        <span>
          {m.civilProtection.evacuations} evacuações · {m.civilProtection.publicAlerts} avisos{m.civilProtection.commandPost ? ' · posto de comando' : ''}
        </span>
      </Row>
      <Row>
        <span>GNR</span>
        <span>
          {m.gnr.roadsClosed} cortes patrulhados{m.gnr.roadsWithoutPatrol ? ` · ${m.gnr.roadsWithoutPatrol} sem patrulha` : ''}
        </span>
      </Row>
      <Row>
        <span>INEM</span>
        <span>{m.inem.ambulancesOnStandby} ambulâncias de prevenção</span>
      </Row>
      <Row>
        <span>Meios</span>
        <span>
          {m.units.committed} no terreno{m.units.forwardReserve ? ` · ${m.units.forwardReserve} em reserva avançada` : ''}
          {m.units.noSafeSpot ? ` · ${m.units.noSafeSpot} sem posição segura` : ''}
        </span>
      </Row>
    </>
  );
}

/** What the agents proposed for the baseline on screen: the plans, what each one does to the fire, and each action with its reason. */
export function PlansPanel() {
  const baseId = useAppStore((s) => s.baseSimulationId);
  const run = useAppStore((s) => s.run);
  const showBanner = useAppStore((s) => s.showBanner);
  const setFocusedAction = useAppStore((s) => s.setFocusedAction);
  const { showSimulationById } = useSimulationActions();
  const organizations = useResourcesStore((s) => s.organizations);
  const resourcesLoaded = useResourcesStore((s) => s.loaded);
  const loadResources = useResourcesStore((s) => s.load);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState<Simulation | null>(null);
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [runs, setRuns] = useState<Map<string, Simulation>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Plan | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [full, setFull] = useState<Map<string, Plan>>(new Map()); // the whole plans: the list has no metadata (the agents' metrics)
  const [orgFilter, setOrgFilter] = useState<string | null>(null); // G5: null = todas as organizações

  useEffect(() => {
    if (!resourcesLoaded) void loadResources();
  }, [resourcesLoaded, loadResources]);

  const orgName = useCallback(
    (organizationId: string) => organizations.find((o) => o.id === organizationId)?.name ?? organizationId,
    [organizations],
  );

  const refresh = useCallback(async (silent = false) => {
    if (!baseId) return;
    if (!silent) setLoading(true); // a background refresh must not flash "A carregar…"
    setError(null);
    try {
      const locationId = useAppStore.getState().locationId;
      const baseline = await simulationsApi.get(baseId);
      const bySim = await plansApi.listForSimulation(baseId);
      const listed = bySim.length > 0
        ? bySim
        : (baseline.scenarioId ? await plansApi.all({ locationId: locationId ?? undefined, scenarioId: baseline.scenarioId }) : []);
      const ordered = [...listed].sort((a, b) => String(a.variant ?? '').localeCompare(String(b.variant ?? '')) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
      setBase(baseline);
      setPlans(ordered);
      setRuns(ordered.length ? await plansApi.whatIfRuns(ordered.map((p) => p.id as string)) : new Map());
      const plansFull = await Promise.all(ordered.map((p) => plansApi.get(p.id as string).catch(() => null)));
      setFull(new Map(plansFull.filter((p): p is Plan => !!p).map((p) => [p.id as string, p])));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [baseId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshSilently = useCallback(() => void refresh(true), [refresh]);

  // The `agents` service publishes plans (and runs their what-ifs) a minute or so after a baseline finishes: keep looking while
  // there are none, a what-if is still running, or a plan is under 3 minutes old and has no what-if yet.
  const waiting =
    plans.length === 0 ||
    plans.some((p) => {
      const status = runs.get(p.id as string)?.status;
      if (status === 'queued' || status === 'running') return true;
      return !status && Date.now() - Date.parse(String(p.createdAt ?? '')) < 3 * 60_000;
    });
  useEffect(() => {
    if (!baseId || !waiting) return undefined;
    const timer = setInterval(() => void refresh(true), 8000);
    return () => clearInterval(timer);
  }, [baseId, waiting, refresh]);

  const simulate = async (plan: PlanSummary) => {
    if (!baseId) return;
    setBusy(`sim:${plan.id as string}`);
    try {
      const sim = await plansApi.simulateAndWait(plan.id as string, baseId);
      setRuns((previous) => new Map(previous).set(plan.id as string, sim));
    } catch (e) {
      showBanner(`Simulação do plano: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  /** The operator's approval path: proposed → selected → active → completed. */
  const transition = async (plan: PlanSummary, next: 'select' | 'activate' | 'complete') => {
    const id = plan.id as string;
    setBusy(`${next}:${id}`);
    try {
      const updated =
        next === 'select'
          ? await plansApi.select(id)
          : next === 'activate'
            ? await plansApi.activate(id)
            : await plansApi.patch(id, { status: 'completed' });
      setOpen((current) => (current?.id === id ? updated : current));
      await refresh(true);
    } catch (e) {
      showBanner(`Plano ${plan.variant ?? plan.title}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  /** G5: registo de execução (`PATCH /plans/{id}/actions/{actionId}`, merge-patch — só o campo alterado). Otimista, com reversão. */
  const patchAction = async (planId: string, action: Action, patch: ActionPatch) => {
    const before = open;
    if (!before || before.id !== planId) return;
    const replaceAction = (plan: Plan, updated: Action): Plan => ({ ...plan, actions: plan.actions.map((a) => (a.id === updated.id ? updated : a)) });
    setOpen(replaceAction(before, { ...action, status: patch.status ?? action.status })); // otimista
    setBusy(`act:${action.id as string}`);
    try {
      const updated = await plansApi.patchAction(planId, action.id as string, patch);
      setOpen((current) => (current?.id === planId ? replaceAction(current, updated) : current));
      setFull((previous) => {
        const plan = previous.get(planId);
        return plan ? new Map(previous).set(planId, replaceAction(plan, updated)) : previous;
      });
    } catch (e) {
      // revert only if the panel still shows this plan: the operator may have switched plans meanwhile
      setOpen((current) => (current?.id === planId ? before : current));
      showBanner(`Ação “${action.title}”: ${e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const toggleActions = async (plan: PlanSummary) => {
    setFocusedAction(null);
    setEditingId(null);
    setOrgFilter(null);
    if (open?.id === plan.id) return setOpen(null);
    try {
      setOpen(await plansApi.get(plan.id as string));
    } catch (e) {
      showBanner(`Plano: ${(e as Error).message}`);
    }
  };

  /** A6: open the operator's editor for this plan (the full plan carries the actions; the list only counts them). */
  const editPlan = async (plan: PlanSummary) => {
    setFocusedAction(null);
    setEditingId(plan.id as string);
    if (open?.id !== plan.id) {
      try {
        setOpen(await plansApi.get(plan.id as string));
      } catch (e) {
        setEditingId(null);
        showBanner(`Plano: ${(e as Error).message}`);
      }
    }
  };

  const savedEdit = async (updated: Plan, simulation: Simulation) => {
    setOpen(updated);
    setEditingId(null);
    setRuns((previous) => new Map(previous).set(updated.id as string, simulation));
    await refresh(true);
    void showSimulationById(simulation.id as string);
  };

  if (!baseId) return <p className="note">Escolha um cenário para ver os planos que os agentes propuseram.</p>;

  const showing = run?.simulation;
  const showingPlan = showing?.kind === 'what_if' ? plans.find((p) => p.id === showing.planId) : null;
  const edited = new Set(
    [...full.values()].filter((p) => (p.metadata as Record<string, unknown> | undefined)?.['operator.editedAt']).map((p) => p.id as string),
  );

  return (
    <>
      <h3>Planos dos agentes</h3>
      <p className="note">
        A mostrar no mapa:{' '}
        <b>{showing?.kind === 'what_if' ? `o plano ${showingPlan?.variant ?? ''} (${showingPlan?.title ?? showing.planId})` : 'a simulação base, sem resposta'}</b>{' '}
        <small>{showing?.id}</small>
      </p>

      <h3>Sem resposta (base)</h3>
      <StatsRows stats={base?.stats} />
      {showing?.id !== baseId ? (
        <button className={styles.spaced} onClick={() => void showSimulationById(baseId)}>
          Ver a base no mapa
        </button>
      ) : null}

      <PlanRequestBox baseId={baseId} onPlans={refreshSilently} />

      <CompareTable base={base ?? undefined} plans={plans} runs={runs} edited={edited} />

      {loading ? <p className="note">A carregar planos…</p> : null}
      {error ? <p className="note">Erro: {error}</p> : null}
      {!loading && !error && !plans.length ? (
        <p className="note">
          Ainda não há planos para esta simulação. O serviço dos agentes (<code>docker compose up -d agents</code>) publica-os sozinho poucos minutos depois de a base terminar
          (avalia cada plano com o motor antes de o publicar), ou quando os pede acima; esta lista atualiza-se.
        </p>
      ) : null}

      {plans.map((plan) => {
        const id = plan.id as string;
        const sim = runs.get(id);
        const status = (plan.status ?? 'proposed') as PlanStatus;
        const statusKind = PLAN_STATUS_KIND[status] ?? 'warn';
        const shownActions = open?.id === id ? open.actions.slice(0, ACTIONS_SHOWN) : [];
        const groups = new Map<string, typeof shownActions>();
        for (const action of shownActions) {
          const organizationId = action.organizationId ?? '—';
          const list = groups.get(organizationId);
          if (list) list.push(action);
          else groups.set(organizationId, [action]);
        }
        const executable = status === 'active'; // só o plano ativo está a ser executado (o backend recusa o resto com 409)
        const orgOrder = [...groups.keys()].sort((a, b) => orgName(a).localeCompare(orgName(b)));
        return (
          <div key={id} className={`${styles.group} ${styles.spaced}`}>
            <div>
              <b>{plan.title}</b> {plan.variant ? <Tag kind="warn">{plan.variant}{edited.has(id) ? '′' : ''}</Tag> : null}{' '}
              {edited.has(id) ? <span title="Ajustado pelo operador (A6); o what-if ao lado é deste ajuste"><Tag kind="warn">ajustado</Tag></span> : null}
              <Tag kind={statusKind}>{PLAN_STATUS_LABEL[status] ?? status}</Tag>
              <br />
              <small className="note">
                {plan.strategy} · {plan.actionCounts?.total ?? '?'} ações · {plan.alertLevel ?? '—'}
                {plan.createdAt ? ` · ${new Date(plan.createdAt).toLocaleString('pt-PT')}` : ''}
              </small>
            </div>
            {sim ? <StatsRows stats={sim.stats} base={base?.stats} /> : <small className="note">Ainda sem simulação deste plano.</small>}
            <AgentRows m={metricsOf(full.get(id))} />
            <div className={styles.two}>
              {sim ? (
                <button className={showing?.id === sim.id ? 'on' : ''} onClick={() => void showSimulationById(sim.id as string)}>
                  {showing?.id === sim.id ? 'No mapa' : 'Ver no mapa'}
                </button>
              ) : (
                <button disabled={busy === `sim:${id}`} onClick={() => void simulate(plan)}>
                  {busy === `sim:${id}` ? 'A simular…' : 'Simular o plano'}
                </button>
              )}
              <button onClick={() => void toggleActions(plan)}>{open?.id === id ? 'Esconder ações' : 'Ver ações'}</button>
              {status === 'proposed' || status === 'selected' || status === 'active' ? (
                <button className={editingId === id ? 'on' : ''} onClick={() => void editPlan(plan)}>
                  {editingId === id ? 'A ajustar…' : 'Editar plano'}
                </button>
              ) : null}
              {status === 'proposed' ? (
                <button disabled={busy === `select:${id}`} onClick={() => void transition(plan, 'select')}>
                  {busy === `select:${id}` ? 'A selecionar…' : 'Selecionar'}
                </button>
              ) : null}
              {status === 'selected' ? (
                <button disabled={busy === `activate:${id}`} onClick={() => void transition(plan, 'activate')}>
                  {busy === `activate:${id}` ? 'A ativar…' : 'Ativar'}
                </button>
              ) : null}
              {status === 'active' ? (
                <button disabled={busy === `complete:${id}`} onClick={() => void transition(plan, 'complete')}>
                  {busy === `complete:${id}` ? 'A encerrar…' : 'Encerrar'}
                </button>
              ) : null}
            </div>
            {open?.id === id && editingId === id ? (
              <PlanEditor plan={open} baseId={baseId} orgName={orgName} onCancel={() => setEditingId(null)} onSaved={savedEdit} onError={showBanner} />
            ) : null}
            {open?.id === id && editingId !== id ? (
              <div className={styles.actionGroups}>
                <h3>Combate ao fogo</h3>
                <AttackTimeline plan={open} onMap={!!sim && showing?.id === sim.id} showOnMap={() => sim && void showSimulationById(sim.id as string)} />
                <h3>Todas as ações ({open.actions.length}), por organização</h3>
                <div className={styles.orgFilter}>
                  <button className={orgFilter === null ? 'on' : ''} onClick={() => setOrgFilter(null)}>Todas</button>
                  {orgOrder.map((organizationId) => (
                    <button key={organizationId} className={orgFilter === organizationId ? 'on' : ''} onClick={() => setOrgFilter(organizationId)}>
                      <OrgLogo org={organizations.find((o) => o.id === organizationId) ?? organizationId} size={14} inline />
                      {orgName(organizationId)}
                    </button>
                  ))}
                </div>
                {orgOrder
                  .filter((organizationId) => !orgFilter || organizationId === orgFilter)
                  .map((organizationId) => [organizationId, groups.get(organizationId) as typeof shownActions] as const)
                  .map(([organizationId, actions]) => (
                  <div key={organizationId} className={styles.actionGroup}>
                    <div className={styles.orgHead} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <OrgLogo org={organizations.find((o) => o.id === organizationId) ?? organizationId} size={24} inline />
                      <b>{orgName(organizationId)}</b>
                      <small className="note" style={{ marginLeft: 'auto' }}>{actions.length} ação(ões)</small>
                    </div>
                    {actions.map((a) => (
                      <Row key={a.id}>
                        <span className={styles.actionText}>
                          <b>{a.title}</b>
                          {a.rationale ? <small className={styles.rationale}>{a.rationale}</small> : null}
                          <small className="note">
                            {a.type} · {orgName(a.organizationId ?? organizationId)}
                            {a.supportingOrganizationIds?.length ? ` · apoia: ${a.supportingOrganizationIds.map(orgName).join(', ')}` : ''}
                          </small>
                        </span>
                        <span className={styles.actionTags}>
                          <Tag kind={a.priority === 'critical' ? 'bad' : 'ok'}>{a.priority ?? 'normal'}</Tag>
                          <Tag kind={a.status === 'completed' ? 'ok' : a.status === 'blocked' ? 'bad' : 'warn'}>
                            {ACTION_STATUS_LABEL[a.status ?? 'planned'] ?? a.status ?? 'planeada'}
                          </Tag>
                          {executable && (ACTION_NEXT[a.status ?? 'planned'] ?? []).length ? (
                            <span className={styles.stepBtns}>
                              {(ACTION_NEXT[a.status ?? 'planned'] ?? []).map((step) => (
                                <button
                                  key={step.status}
                                  disabled={busy === `act:${a.id as string}`}
                                  title={`Marcar como ${ACTION_STATUS_LABEL[step.status] ?? step.status}`}
                                  onClick={() => void patchAction(id, a, { status: step.status })}
                                >
                                  {busy === `act:${a.id as string}` ? '…' : step.label}
                                </button>
                              ))}
                            </span>
                          ) : null}
                        </span>
                      </Row>
                    ))}
                  </div>
                ))}
                {open.actions.length > ACTIONS_SHOWN ? <small className="note">… e mais {open.actions.length - ACTIONS_SHOWN} ações (a razão de cada uma está na dica ao passar o rato).</small> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
