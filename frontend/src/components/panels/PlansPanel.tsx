import { useCallback, useEffect, useState } from 'react';

import { plansApi, simulationsApi, type Plan, type PlanSummary, type Simulation } from '@/api';
import { Row, Tag } from '@/components/common/StatCard';
import { useSimulationActions } from '@/hooks/useSimulationActions';
import { useAppStore } from '@/store/appStore';

import { AttackTimeline } from './AttackTimeline';
import styles from './panels.module.css';

const nf = (n: number) => n.toLocaleString('pt-PT');
const ACTIONS_SHOWN = 40;

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

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState<Simulation | null>(null);
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [runs, setRuns] = useState<Map<string, Simulation>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Plan | null>(null);
  const [full, setFull] = useState<Map<string, Plan>>(new Map()); // the whole plans: the list has no metadata (the agents' metrics)

  const refresh = useCallback(async (silent = false) => {
    if (!baseId) return;
    if (!silent) setLoading(true); // a background refresh must not flash "A carregar…"
    setError(null);
    try {
      const [baseline, listed] = await Promise.all([simulationsApi.get(baseId), plansApi.listForSimulation(baseId)]);
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
    setBusy(plan.id as string);
    try {
      const sim = await plansApi.simulateAndWait(plan.id as string, baseId);
      setRuns((previous) => new Map(previous).set(plan.id as string, sim));
    } catch (e) {
      showBanner(`Simulação do plano: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const toggleActions = async (plan: PlanSummary) => {
    setFocusedAction(null);
    if (open?.id === plan.id) return setOpen(null);
    try {
      setOpen(await plansApi.get(plan.id as string));
    } catch (e) {
      showBanner(`Plano: ${(e as Error).message}`);
    }
  };

  if (!baseId) return <p className="note">Escolha um cenário para ver os planos que os agentes propuseram.</p>;

  const showing = run?.simulation;
  const showingPlan = showing?.kind === 'what_if' ? plans.find((p) => p.id === showing.planId) : null;

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

      {loading ? <p className="note">A carregar planos…</p> : null}
      {error ? <p className="note">Erro: {error}</p> : null}
      {!loading && !error && !plans.length ? (
        <p className="note">
          Ainda não há planos para esta simulação. O serviço dos agentes (<code>docker compose up -d agents</code>) publica-os sozinho poucos minutos depois de a base terminar (avalia cada plano com o motor antes de o publicar); esta lista atualiza-se.
          Sem o serviço: <code>python -m firetrace_agents --simulation-id {baseId}</code>.
        </p>
      ) : null}

      {plans.map((plan) => {
        const id = plan.id as string;
        const sim = runs.get(id);
        return (
          <div key={id} className={`${styles.group} ${styles.spaced}`}>
            <div>
              <b>{plan.title}</b> {plan.variant ? <Tag kind="warn">{plan.variant}</Tag> : null}
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
                <button disabled={busy === id} onClick={() => void simulate(plan)}>
                  {busy === id ? 'A simular…' : 'Simular o plano'}
                </button>
              )}
              <button onClick={() => void toggleActions(plan)}>{open?.id === id ? 'Esconder ações' : 'Ver ações'}</button>
            </div>
            {open?.id === id ? (
              <div>
                <h3>Combate ao fogo</h3>
                <AttackTimeline plan={open} onMap={!!sim && showing?.id === sim.id} showOnMap={() => sim && void showSimulationById(sim.id as string)} />
                <h3>Todas as ações ({open.actions.length})</h3>
                {open.actions.slice(0, ACTIONS_SHOWN).map((a) => (
                  <Row key={a.id}>
                    <span title={a.rationale ?? ''}>
                      {a.title}
                      <br />
                      <small className="note">{a.type} · {a.organizationId}</small>
                    </span>
                    <Tag kind={a.priority === 'critical' ? 'bad' : 'ok'}>{a.priority ?? 'normal'}</Tag>
                  </Row>
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
