import { useEffect, useState } from 'react';

import { http, simulationsApi, type Simulation } from '@/api';
import { Row } from '@/components/common/StatCard';
import { MILESTONE_MINUTES } from '@/domain/simulationForm';
import { formatDateTime, formatTime } from '@/domain/weather';
import { useAppStore } from '@/store/appStore';

import { SimulationForm } from './SimulationForm';

const nf = (n: number) => n.toLocaleString('pt-PT');
const minutesLabel = (m: number) => (m >= 60 ? `${m / 60} h` : `${m} min`);

/** Scenario milestones, plus the form used to launch a custom simulation. */
function IncidentSummary() {
  const run = useAppStore((s) => s.run);
  const scenarioId = useAppStore((s) => s.scenarioId);
  const scenarios = useAppStore((s) => s.data?.scenarios ?? []);

  const scenario = scenarios.find((x) => x.id === scenarioId);

  return (
    <>
      <h3>{scenario ? scenario.name : 'Incidente'}</h3>
      {!run ? <p className="note">Escolha um cenário ou crie um personalizado.</p> : null}

      {run ? (
        <>
          <h3>Marcos</h3>
          {run.summary
            .filter((r) => MILESTONE_MINUTES.includes(r.tMin))
            .map((r) => (
              <Row key={r.tMin}>
                <span>
                  {minutesLabel(r.tMin)} <small>{formatTime(r.time ?? run.startMs + r.tMin * 60000)}</small>
                </span>
                <span>
                  {nf(r.areaHa)} ha · {r.headSpeedMmin ?? '—'} m/min
                </span>
              </Row>
            ))}
        </>
      ) : null}
    </>
  );
}

/** One metric row of the cost-of-delay readout: `base agora` vs `base tardia` plus the delta between the two real runs. */
function DelayMetricRow({ label, unit, now, late, decimals = 0 }: { label: string; unit: string; now?: number; late?: number; decimals?: number }) {
  const nf = (v: number) => v.toLocaleString('pt-PT', { maximumFractionDigits: decimals });
  const missing = now == null || late == null;
  const delta = missing ? null : late - now;
  return (
    <Row>
      <span>{label}</span>
      <span>
        {missing ? (
          '—'
        ) : (
          <>
            {nf(now)} → {nf(late)} {unit}
            <b style={{ marginLeft: 8, color: delta ? (delta > 0 ? 'var(--bad)' : 'var(--ok)') : undefined }}>
              {delta ? `${delta > 0 ? '+' : '−'}${nf(Math.abs(delta))} ${unit}` : 'igual'}
            </b>
          </>
        )}
      </span>
    </Row>
  );
}

/**
 * "Custo do atraso": what a later decision would have cost, computed from two real backend runs — the
 * baseline on screen ("base agora", final metrics from the store) against another succeeded baseline the
 * operator picks ("base tardia"). No second run, no numbers: the truthfulness rule forbids inventing any.
 */
function CostOfDelay() {
  const run = useAppStore((s) => s.run);
  const baseSimulationId = useAppStore((s) => s.baseSimulationId);
  const locationId = useAppStore((s) => s.locationId);
  const [open, setOpen] = useState(false);
  const [others, setOthers] = useState<Simulation[] | null>(null);
  const [late, setLate] = useState<Simulation | null>(null);
  const [nowSim, setNowSim] = useState<Simulation | null>(null);
  const [error, setError] = useState<string | null>(null);

  // "Base agora": the focused baseline's final metrics. When a baseline run is on screen the store already
  // holds them (run.simulation.stats); when a plan's what-if is on screen, fetch the baseline it ran against.
  useEffect(() => {
    const sim = run?.simulation;
    if (!sim || sim.kind !== 'what_if') {
      setNowSim(sim ?? null);
      return;
    }
    setNowSim(null);
    if (!baseSimulationId) return;
    let cancelled = false;
    simulationsApi
      .get(baseSimulationId)
      .then((base) => {
        if (!cancelled) setNowSim(base);
      })
      .catch(() => {
        if (!cancelled) setNowSim(null);
      });
    return () => {
      cancelled = true;
    };
  }, [run, baseSimulationId]);

  // "Base tardia" candidates: the location's other succeeded baseline runs (the focused one excluded).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    http
      .get<{ items: Simulation[] }>('/simulations', {
        params: { locationId: locationId ?? undefined, status: 'succeeded', kind: 'baseline', limit: 50 },
      })
      .then(({ data }) => {
        if (cancelled) return;
        const focused = new Set([run?.id, baseSimulationId].filter(Boolean) as string[]);
        const candidates = data.items.filter((s) => !focused.has(s.id as string));
        setOthers(candidates);
        // a previously picked "base tardia" may not be a candidate any more (the shown run changed):
        // dropping it keeps the readout and the selector in agreement instead of comparing a stale run
        setLate((current) => (current && candidates.some((s) => s.id === current.id) ? current : null));
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open, run, baseSimulationId, locationId]);

  const nowStart = nowSim ? +new Date(nowSim.scenarioSnapshot.start) : NaN;
  const lateStart = late ? +new Date(late.scenarioSnapshot.start) : NaN;
  const delayMin = Number.isFinite(nowStart) && Number.isFinite(lateStart) ? Math.round((lateStart - nowStart) / 60000) : null;
  const delayLabel =
    delayMin == null ? null : delayMin === 0 ? 'mesma hora de início' : `${delayMin > 0 ? '' : '−'}${Math.abs(delayMin)} min ${delayMin > 0 ? 'mais tarde' : '(mais cedo)'}`;
  const stats = (sim: Simulation | null) => sim?.stats;
  const sNow = stats(nowSim);
  const sLate = stats(late);

  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary style={{ cursor: 'pointer', userSelect: 'none' }}>
        <h3 style={{ display: 'inline', margin: 0 }}>Custo do atraso</h3>
      </summary>
      {!run || !nowSim ? (
        <p className="note">Carrega uma simulação base para comparar o custo de decidir mais tarde.</p>
      ) : others == null && !error ? (
        <p className="note">A procurar outras linhas base…</p>
      ) : error ? (
        <p className="note" style={{ color: 'var(--bad)' }}>
          Não consegui listar outras linhas base: {error}
        </p>
      ) : !others?.length ? (
        <p className="note">Corre uma segunda linha base com início adiado para comparar.</p>
      ) : (
        <>
          <select
            value={late?.id ?? ''}
            onChange={(e) => setLate(others.find((s) => s.id === e.target.value) ?? null)}
            style={{ width: '100%', margin: '6px 0', fontSize: 12 }}
            aria-label="Corrida base tardia a comparar"
          >
            <option value="">Escolher linha base tardia…</option>
            {others.map((s) => (
              <option key={s.id} value={s.id as string}>
                {formatDateTime(s.scenarioSnapshot.start)}{s.label ? ` — ${s.label}` : ''}
              </option>
            ))}
          </select>
          {late ? (
            <>
              <p className="note">
                Comparar com uma decisão {delayLabel} · início {formatTime(nowStart)} → {formatTime(lateStart)}
              </p>
              <DelayMetricRow label="Área ardida" unit="ha" now={sNow?.burnedHa} late={sLate?.burnedHa} decimals={1} />
              <DelayMetricRow label="Habitações afetadas" unit="habitações" now={sNow?.buildingsAffected} late={sLate?.buildingsAffected} />
              <DelayMetricRow label="População exposta" unit="pessoas" now={sNow?.populationExposed} late={sLate?.populationExposed} />
            </>
          ) : null}
        </>
      )}
    </details>
  );
}

export function IncidentPanel() {
  const probMode = useAppStore((s) => s.probMode);
  const setProbMode = useAppStore((s) => s.setProbMode);
  return (
    <>
      <IncidentSummary />
      <CostOfDelay />
      <SimulationForm />
      <h3>Vista</h3>
      <label className="note">
        <input type="checkbox" checked={probMode} onChange={(e) => setProbMode(e.target.checked)} /> Mostrar probabilidade de corte/isolamento (ensemble)
      </label>
    </>
  );
}
