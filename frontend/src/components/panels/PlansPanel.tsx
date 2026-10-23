import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  plansApi,
  simulationsApi,
  type Action,
  type ActionPatch,
  type Plan,
  type PlanSummary,
  type PlanStatus,
  type Simulation,
} from '@/api';
import { ConfirmButton } from '@/components/common/ConfirmButton';
import { Row, Tag } from '@/components/common/StatCard';
import { useSimulationActions } from '@/hooks/useSimulationActions';
import { useAppStore } from '@/store/appStore';
import { useResourcesStore } from '@/store/resourcesStore';

import { AttackTimeline } from './AttackTimeline';
import { PlanDecisions } from './PlanDecisions';
import { PlanEditor } from './PlanEditor';
import { PlanRequestBox } from './PlanRequestBox';
import styles from './panels.module.css';

const nf = (n: number) => n.toLocaleString('pt-PT');

const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  proposed: 'Proposto',
  selected: 'Escolhido',
  active: 'Em execução',
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

/** The newest plan of each variant (A, B): what the operator is shown. Without variants, the newest plan alone. */
function latestPair(plans: PlanSummary[]): PlanSummary[] {
  const newest = (a: PlanSummary, b: PlanSummary) => (String(b.createdAt ?? '') > String(a.createdAt ?? '') ? b : a);
  const byVariant = new Map<string, PlanSummary>();
  for (const plan of plans) {
    const key = String(plan.variant ?? '');
    const known = byVariant.get(key);
    byVariant.set(key, known ? newest(known, plan) : plan);
  }
  const pair = ['A', 'B'].flatMap((v) => (byVariant.has(v) ? [byVariant.get(v)!] : []));
  if (pair.length) return pair;
  return plans.length ? [plans.reduce(newest)] : [];
}

/** The plans the operator is offered: the ones they chose or are running (always, whatever the agents publish later), then the newest A and B still to decide on. */
function plansShown(plans: PlanSummary[]): PlanSummary[] {
  const rank = (p: PlanSummary) => (p.status === 'active' ? 0 : 1);
  const pinned = plans
    .filter((p) => p.status === 'active' || p.status === 'selected')
    .sort((a, b) => rank(a) - rank(b) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  const fresh = latestPair(plans.filter((p) => p.status === 'proposed' || p.status === 'discarded'));
  const shown = [...pinned, ...fresh];
  return shown.length ? shown : latestPair(plans); // only closed plans left (completed, cancelled): show the newest pair as history
}

/** The operator's path for a plan (`POST /select`, `POST /activate`, `PATCH status=completed`), as the steps the card shows. */
const PLAN_FLOW: PlanStatus[] = ['proposed', 'selected', 'active', 'completed'];

/** What the backend lets the operator delete (`PlanPolicy`): a plan that is or was in execution stays as history. */
const DELETABLE: PlanStatus[] = ['proposed', 'selected', 'discarded'];

/** What a plan commits when it is put into execution: the backend dispatches every vehicle and crew and opens every road closure. */
function commitmentOf(plan: Plan | undefined): { units: number; closures: number } {
  const actions = plan?.actions ?? [];
  const units = new Set(actions.flatMap((a) => (a.resources ?? []).filter((r) => r.resourceType !== 'equipment').map((r) => r.resourceId as string)));
  return { units: units.size, closures: actions.filter((a) => a.type === 'road_closure').length };
}

const PLAN_STYLE: Record<string, { name: string; hint: string }> = {
  A: { name: 'Ofensivo', hint: 'parar o fogo' },
  B: { name: 'Defensivo', hint: 'proteger pessoas e casas' },
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
          {m.gnr.roadsClosed} acessos fechados{m.gnr.roadsWithoutPatrol ? ` · ${m.gnr.roadsWithoutPatrol} abertos (sem patrulha)` : ''}
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
  const orgName = (id: string) => organizations.find((o) => o.id === id)?.name ?? id;
  const resourcesLoaded = useResourcesStore((s) => s.loaded);
  const loadResources = useResourcesStore((s) => s.load);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState<Simulation | null>(null);
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [older, setOlder] = useState<PlanSummary[]>([]); // earlier plans of this simulation, never offered but still deletable
  const [runs, setRuns] = useState<Map<string, Simulation>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Plan | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [full, setFull] = useState<Map<string, Plan>>(new Map()); // the whole plans: the list has no metadata (the agents' metrics)

  useEffect(() => {
    if (!resourcesLoaded) void loadResources();
  }, [resourcesLoaded, loadResources]);

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
      const ordered = plansShown(listed); // the plan being run or chosen, then the newest A and B: older plans are never offered
      setBase(baseline);
      setPlans(ordered);
      setOlder(listed.filter((p) => !ordered.includes(p)).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))));
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

  /**
   * The operator's approval path: proposed → selected (the other plans of this simulation are discarded, nothing is sent yet) →
   * active (every vehicle and crew is dispatched and every road closure opened, all or nothing) → completed (dispatches cancelled, closures lifted).
   * The two steps that move real resources are confirmed in the card first (ConfirmButton).
   */
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

  /** "Ver plano": the plan's what-if goes on the map and its actions open below, so the map and the list are always the same plan. */
  const togglePlan = async (plan: PlanSummary) => {
    setFocusedAction(null);
    setEditingId(null);
    if (open?.id === plan.id) return setOpen(null);
    try {
      setOpen(await plansApi.get(plan.id as string));
      const sim = runs.get(plan.id as string);
      if (sim && run?.simulation.id !== sim.id) void showSimulationById(sim.id as string);
    } catch (e) {
      // a plan can disappear under the list (the agents replace or withdraw one): say so and show the list as it is now
      showBanner(`Plano ${plan.variant ?? plan.title}: já não existe (a lista foi atualizada). ${(e as Error).message}`);
      void refresh(true);
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

  /** Deletes a plan once the operator confirms it in its button (it cannot be undone): old plans need not pile up. Only DELETABLE ones are offered. */
  const removePlan = async (plan: PlanSummary) => {
    const id = plan.id as string;
    const name = `${plan.variant ? `${plan.variant} ` : ''}«${plan.title}»`;
    setBusy(`del:${id}`);
    try {
      await plansApi.delete(id);
      if (open?.id === id) {
        setOpen(null);
        setEditingId(null);
        setFocusedAction(null);
      }
      // the map should not keep showing the what-if of a plan that no longer exists
      const onMap = run?.simulation;
      if (onMap?.kind === 'what_if' && onMap.planId === id && baseId) void showSimulationById(baseId);
      await refresh(true);
    } catch (e) {
      showBanner(`Apagar o plano ${name}: ${e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const savedEdit = async (updated: Plan, simulation: Simulation) => {
    setOpen(updated);
    setEditingId(null);
    setRuns((previous) => new Map(previous).set(updated.id as string, simulation));
    await refresh(true);
    void showSimulationById(simulation.id as string);
  };

  // a vehicle clicked on the map: open the plan on the map so its decisions can show what that vehicle is doing
  const selectedUnitId = useAppStore((s) => s.selectedUnitId);
  useEffect(() => {
    if (!selectedUnitId) return;
    const planId = run?.simulation.kind === 'what_if' ? run.simulation.planId : null;
    const shown = plans.find((p) => p.id === planId);
    if (shown && open?.id !== shown.id) void togglePlan(shown);
    else if (!shown) useAppStore.getState().selectUnit(null);
  }, [selectedUnitId, run, plans, open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!baseId) return <p className="note">Escolha um cenário para ver os planos que os agentes propuseram.</p>;

  const showing = run?.simulation;
  const baseStats = base?.stats;
  const edited = new Set(
    [...full.values()].filter((p) => (p.metadata as Record<string, unknown> | undefined)?.['operator.editedAt']).map((p) => p.id as string),
  );

  /** One of the two plans, as a card: what it does to the fire at a glance, and the buttons. */
  const card = (plan: PlanSummary) => {
    const id = plan.id as string;
    const sim = runs.get(id);
    const status = (plan.status ?? 'proposed') as PlanStatus;
    const variant = String(plan.variant ?? '');
    const look = PLAN_STYLE[variant];
    const m = metricsOf(full.get(id));
    const onMap = !!sim && showing?.id === sim.id;
    const stats = sim?.stats;
    const { units, closures } = commitmentOf(full.get(id));
    // choosing this plan discards the other plans still proposed (the backend leaves a chosen or running one alone)
    const others = plans.filter((p) => p.id !== id && p.status === 'proposed').map((p) => p.variant).filter(Boolean);
    const other = others.length > 1 ? `Os planos ${others.join(' e ')} ficam descartados.` : others.length === 1 ? `O plano ${others[0]} fica descartado.` : '';
    // the plan being run or chosen stays on top, whatever the agents publish later: full width when new plans are proposed beside it
    const pinned = status === 'active' || status === 'selected';
    // the one next step of this plan, said with what it does
    const next =
      status === 'proposed'
        ? { step: 'select' as const, label: 'Escolher este plano', hint: `${other ? `${other} ` : ''}Ainda não se envia nenhum meio: pode editar e simular antes.` }
        : status === 'selected'
          ? {
              step: 'activate' as const,
              label: 'Pôr em execução',
              hint: full.has(id)
                ? `Despacha ${units} meios${closures ? `, corta ${closures} estradas` : ''} e dá as tarefas às organizações.`
                : 'Despacha os meios do plano, corta as estradas e dá as tarefas às organizações.',
            }
          : status === 'active'
            ? { step: 'complete' as const, label: 'Encerrar a operação', hint: 'Os meios regressam e as estradas reabrem.' }
            : null;
    const closedNote = status === 'discarded' ? 'Descartado: foi escolhido o outro plano.' : status === 'completed' ? 'Operação encerrada.' : status === 'cancelled' ? 'Plano cancelado.' : null;
    const tile = (label: string, value: number | undefined, baseValue: number | undefined, unit = '') => (
      <div className={styles.planTile}>
        <small>{label}</small>
        <b>{value == null ? '—' : `${nf(Math.round(value * 10) / 10)}${unit}`}</b>
        <Delta value={value} base={baseValue} />
      </div>
    );
    return (
      <div
        key={id}
        className={`${styles.planCard} ${onMap ? styles.planCardOn : ''} ${variant === 'B' ? styles.planCardB : ''} ${closedNote ? styles.planCardClosed : ''} ${pinned ? styles.planCardPinned : ''} ${pinned && plans.length > 2 ? styles.planCardWide : ''}`}
        title={plan.title}
      >
        <div className={styles.planCardHead}>
          <span className={styles.planLetter}>
            {variant || '·'}
            {edited.has(id) ? '′' : ''}
          </span>
          <div>
            <b>{look?.name ?? plan.title}</b>
            <small className="note">{look?.hint ?? plan.strategy}</small>
          </div>
          {edited.has(id) ? (
            <span title="Ajustado pelo operador (A6); o what-if é deste ajuste">
              <Tag kind="warn">ajustado</Tag>
            </span>
          ) : (
            <span />
          )}
        </div>
        {PLAN_FLOW.includes(status) ? (
          <ol className={styles.planFlow} aria-label="Etapa do plano">
            {PLAN_FLOW.map((s, i) => {
              const at = PLAN_FLOW.indexOf(status);
              return (
                <li key={s} className={i === at ? styles.planStepOn : i < at ? styles.planStepDone : ''}>
                  {PLAN_STATUS_LABEL[s]}
                </li>
              );
            })}
          </ol>
        ) : (
          <Tag kind={PLAN_STATUS_KIND[status] ?? 'warn'}>{PLAN_STATUS_LABEL[status] ?? status}</Tag>
        )}
        {sim ? (
          <div className={styles.planTiles}>
            {tile('Área ardida', stats?.burnedHa, baseStats?.burnedHa, ' ha')}
            {tile('Edifícios', stats?.buildingsAffected, baseStats?.buildingsAffected)}
            {tile('Baixas', stats?.crewCasualties, undefined)}
            {tile('Meios', m?.units.committed, undefined)}
          </div>
        ) : (
          <small className="note">Ainda sem simulação deste plano.</small>
        )}
        {next ? (
          <div className={styles.planNext}>
            {next.step === 'select' ? (
              <button className={styles.primaryButton} disabled={busy === `select:${id}`} onClick={() => void transition(plan, 'select')}>
                {busy === `select:${id}` ? '…' : next.label}
              </button>
            ) : (
              // these two move real vehicles and roads: asked in the card, second click after two seconds
              <ConfirmButton
                className={styles.primaryButton}
                disabled={busy === `${next.step}:${id}`}
                yes={next.step === 'activate' ? 'Sim, pôr em execução' : 'Sim, encerrar'}
                onConfirm={() => void transition(plan, next.step)}
              >
                {busy === `${next.step}:${id}` ? '…' : next.label}
              </ConfirmButton>
            )}
            <small className="note">{next.hint}</small>
          </div>
        ) : closedNote ? (
          <small className="note">{closedNote}</small>
        ) : null}
        <div className={styles.planSecondary}>
          <button className={open?.id === id && editingId !== id ? 'on' : ''} onClick={() => void togglePlan(plan)} title="As decisões dos agentes, e o plano no mapa">
            {open?.id === id && editingId !== id ? 'Fechar decisões' : 'Ver decisões'}
          </button>
          {!sim ? (
            <button disabled={busy === `sim:${id}`} onClick={() => void simulate(plan)} title="Corre o fogo com este plano aplicado (e se fizermos isto?)">
              {busy === `sim:${id}` ? 'A simular…' : 'Simular'}
            </button>
          ) : null}
          {status === 'proposed' || status === 'selected' || status === 'active' ? (
            <button className={editingId === id ? 'on' : ''} onClick={() => void editPlan(plan)} title="Ajustar as ações e os meios; o plano volta a ser simulado">
              {editingId === id ? 'A editar…' : 'Editar'}
            </button>
          ) : null}
          {DELETABLE.includes(status) ? (
            <ConfirmButton
              className={styles.dangerButton}
              disabled={busy === `del:${id}`}
              yes="Sim, apagar"
              detail="Não se pode desfazer."
              onConfirm={() => void removePlan(plan)}
            >
              {busy === `del:${id}` ? 'A apagar…' : 'Apagar'}
            </ConfirmButton>
          ) : null}
        </div>
      </div>
    );
  };

  const openPlan = open && plans.some((p) => p.id === open.id) ? open : null;
  const openId = openPlan?.id as string | undefined;
  const openSim = openId ? runs.get(openId) : undefined;
  const openOnMap = !!openSim && showing?.id === openSim.id;

  return (
    <>
      <div className={styles.plansHead}>
        <h3>Planos dos agentes</h3>
        <PlanRequestBox baseId={baseId} onPlans={refreshSilently} />
      </div>

      {baseStats ? (
        <p className={styles.baseNote}>
          <span>Sem resposta:</span> <b>{nf(Math.round((baseStats.burnedHa ?? 0) * 10) / 10)} ha</b> · <b>{nf(baseStats.buildingsAffected ?? 0)}</b> edifícios
          {showing?.id !== baseId ? (
            <button className={styles.linkButton} style={{ marginLeft: 'auto' }} onClick={() => void showSimulationById(baseId)}>
              ver no mapa
            </button>
          ) : (
            <span style={{ marginLeft: 'auto' }}>
              <Tag kind="warn">no mapa</Tag>
            </span>
          )}
        </p>
      ) : null}

      {loading ? <p className="note">A carregar planos…</p> : null}
      {error ? <p className="note">Erro: {error}</p> : null}
      {!loading && !error && !plans.length ? <p className="note">Ainda não há planos para esta simulação: peça-os acima.</p> : null}

      <div className={styles.planPair}>{plans.map(card)}</div>

      {openPlan && openId ? (
        <div className={styles.actionGroups}>
          <h3>
            Plano {openPlan.variant ?? ''}: o que se passa
            <small className="note"> · {openPlan.title}</small>
          </h3>
          {editingId === openId ? (
            <PlanEditor plan={openPlan} baseId={baseId} orgName={orgName} onCancel={() => setEditingId(null)} onSaved={savedEdit} onError={showBanner} />
          ) : (
            <>
              <PlanDecisions
                key={openId}
                plan={openPlan}
                onMap={openOnMap}
                showOnMap={() => openSim && void showSimulationById(openSim.id as string)}
                busyActionId={busy?.startsWith('act:') ? busy.slice(4) : null}
                onProgress={(action, status) => void patchAction(openId, action, { status })}
              />
              <details className={styles.moreDetails}>
                <summary>Cronograma do combate, minuto a minuto</summary>
                <AttackTimeline plan={openPlan} onMap={openOnMap} showOnMap={() => openSim && void showSimulationById(openSim.id as string)} />
              </details>
            </>
          )}
        </div>
      ) : null}

      {plans.length || older.length ? (
        <details className={styles.moreDetails}>
          <summary>Comparação e detalhes{older.length ? ` · ${older.length} planos anteriores` : ''}</summary>
          <CompareTable base={base ?? undefined} plans={plans} runs={runs} edited={edited} />
          {base?.stats ? (
            <div className={`${styles.group} ${styles.spaced}`}>
              <b>Sem resposta (base)</b>
              <StatsRows stats={base.stats} />
            </div>
          ) : null}
          {plans.map((plan) => (
            <div key={plan.id as string} className={`${styles.group} ${styles.spaced}`}>
              <b>{plan.title}</b>
              <br />
              <small className="note">
                {plan.strategy} · {plan.actionCounts?.total ?? '?'} ações · {plan.alertLevel ?? '—'}
                {plan.createdAt ? ` · ${new Date(plan.createdAt).toLocaleString('pt-PT')}` : ''}
              </small>
              <AgentRows m={metricsOf(full.get(plan.id as string))} />
            </div>
          ))}
          {older.length ? (
            <div className={`${styles.group} ${styles.spaced}`}>
              <b>Planos anteriores ({older.length})</b>
              <small className="note">
                Já não são propostos (há um A e um B mais recentes). Apague os que não interessam; os que estiveram em execução ficam como histórico.
              </small>
              {older.map((plan) => (
                <Row key={plan.id as string}>
                  <span className={styles.actionText}>
                    {plan.variant ? <Tag kind="warn">{plan.variant}</Tag> : null} {plan.title}
                    <br />
                    <small className="note">
                      {PLAN_STATUS_LABEL[(plan.status ?? 'proposed') as PlanStatus] ?? plan.status}
                      {plan.createdAt ? ` · ${new Date(plan.createdAt).toLocaleString('pt-PT')}` : ''}
                    </small>
                  </span>
                  {DELETABLE.includes((plan.status ?? 'proposed') as PlanStatus) ? (
                    <ConfirmButton className={styles.dangerButton} yes="Sim, apagar" disabled={busy === `del:${plan.id as string}`} onConfirm={() => void removePlan(plan)}>
                      {busy === `del:${plan.id as string}` ? '…' : 'Apagar'}
                    </ConfirmButton>
                  ) : (
                    <small className="note">histórico</small>
                  )}
                </Row>
              ))}
            </div>
          ) : null}
        </details>
      ) : null}
    </>
  );
}
