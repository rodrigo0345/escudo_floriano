import { useCallback, useEffect, useRef, useState } from 'react';

import { planRequestsApi, type PlanRequest, type PlanRequestStatus } from '@/api';
import { ProgressBar, Tag } from '@/components/common/StatCard';
import { useAppStore } from '@/store/appStore';

import styles from './panels.module.css';

const POLL_MS = 2000;
/** A request nobody has claimed after this long: the agents service is probably not running. */
const UNCLAIMED_WARN_MS = 30_000;
const HISTORY_SHOWN = 4;

const STATUS_LABEL: Record<PlanRequestStatus, string> = {
  queued: 'Na fila',
  planning: 'A planear',
  simulating: 'A simular',
  done: 'Concluído',
  failed: 'Falhou',
};

const STATUS_KIND: Record<PlanRequestStatus, 'ok' | 'warn' | 'bad'> = {
  queued: 'warn',
  planning: 'warn',
  simulating: 'warn',
  done: 'ok',
  failed: 'bad',
};

/** The agents' steps, in order, as the `progress.phase` they report. */
const STEPS: { label: string; phases: string[] }[] = [
  { label: 'Na fila', phases: ['queued'] },
  { label: 'A compor A e B', phases: ['claimed', 'composing'] },
  { label: 'Segurança das equipas', phases: ['judging', 'adapting'] },
  { label: 'A publicar', phases: ['publishing'] },
  { label: 'What-if no motor', phases: ['simulating'] },
  { label: 'Pronto', phases: ['done'] },
];

const isOpen = (r: PlanRequest | null | undefined): boolean => !!r && (r.status === 'queued' || r.status === 'planning' || r.status === 'simulating');

const stepOf = (r: PlanRequest): number => {
  if (r.status === 'done') return STEPS.length - 1;
  const phase = r.progress?.phase ?? r.status;
  const i = STEPS.findIndex((s) => s.phases.includes(phase));
  return i < 0 ? 0 : i;
};

const since = (iso?: string | null): string => {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

/**
 * "Ask the agents for a new plan": sends a request for the baseline on screen (`POST /simulations/{id}/plan-requests`) and follows it while the agents service
 * claims it, composes plans A and B, checks them for crew safety, publishes them and runs their what-ifs. The plans list refreshes as soon as plans exist.
 */
export function PlanRequestBox({ baseId, onPlans }: { baseId: string; onPlans: () => void }) {
  const t = useAppStore((s) => s.t);
  const showBanner = useAppStore((s) => s.showBanner);
  const [requests, setRequests] = useState<PlanRequest[]>([]);
  const [note, setNote] = useState('');
  const [fromNow, setFromNow] = useState(true);
  const [sending, setSending] = useState(false);
  const [, setTick] = useState(0); // re-render for the elapsed time while open
  const seenPlans = useRef<string>('');

  const current = requests[0] ?? null;
  const open = isOpen(current);

  const load = useCallback(async () => {
    try {
      const page = await planRequestsApi.list({ simulationId: baseId, limit: HISTORY_SHOWN + 1 });
      setRequests(page.items);
    } catch {
      setRequests([]); // an older backend without /plan-requests: the box still lets the operator try
    }
  }, [baseId]);

  useEffect(() => {
    seenPlans.current = '';
    void load();
  }, [load]);

  // follow the open request; refresh the plans when it publishes them and when it ends
  useEffect(() => {
    if (!open || !current?.id) return undefined;
    const id = current.id as string;
    const timer = setInterval(async () => {
      setTick((n) => n + 1);
      try {
        const next = await planRequestsApi.get(id);
        setRequests((list) => list.map((r) => (r.id === id ? next : r)));
        const plans = `${next.status === 'done' ? 'done:' : ''}${(next.planIds ?? []).join(',')}`;
        if (plans !== seenPlans.current && (next.planIds?.length || next.status === 'done')) {
          seenPlans.current = plans;
          onPlans();
        }
        if (next.status === 'failed') showBanner(`Os agentes não conseguiram planear: ${next.error ?? 'sem razão'}`);
      } catch {
        /* a missed poll: the next one catches up */
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [open, current?.id, onPlans, showBanner]);

  const ask = async () => {
    setSending(true);
    try {
      const created = await planRequestsApi.create(baseId, {
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(fromNow && t > 0 ? { atMinute: Math.round(t) } : {}),
        requestedBy: 'Operador (interface)',
      });
      seenPlans.current = '';
      setRequests((list) => [created, ...list.filter((r) => r.id !== created.id)]);
      setNote('');
    } catch (e) {
      showBanner(`Pedido de plano: ${(e as Error).message}`);
    } finally {
      setSending(false);
    }
  };

  const unclaimed = current?.status === 'queued' && Date.now() - Date.parse(String(current.createdAt ?? '')) > UNCLAIMED_WARN_MS;
  const step = current ? stepOf(current) : -1;

  return (
    <div className={`${styles.compareCard} ${styles.spaced}`}>
      <h3>Pedir um novo plano aos agentes</h3>
      {open && current ? (
        <>
          <div>
            <Tag kind={STATUS_KIND[current.status]}>{STATUS_LABEL[current.status]}</Tag>{' '}
            <small className="note">
              {current.claimedBy ? `${current.claimedBy} · ` : ''}há {since(current.createdAt)}
              {current.atMinute != null ? ` · decide em T+${current.atMinute} min` : ''}
            </small>
          </div>
          <ProgressBar percent={current.progress?.percent ?? 0} />
          <ol className={styles.requestSteps}>
            {STEPS.map((s, i) => (
              <li key={s.label} className={i < step ? styles.stepDone : i === step ? styles.stepNow : ''}>
                {s.label}
              </li>
            ))}
          </ol>
          {current.progress?.message ? <small className="note">{current.progress.message}</small> : null}
          {current.note ? <small className="note">Pedido: “{current.note}”</small> : null}
          {unclaimed ? (
            <small className="note">
              Nenhum agente pegou no pedido ainda: podem estar a acabar outro plano (um de cada vez), ou o serviço não está a correr (<code>docker compose up -d agents</code>).
            </small>
          ) : null}
        </>
      ) : (
        <>
          <p className="note">
            Os agentes compõem um novo par de planos (A ofensivo, B defensivo) para esta simulação, avaliam-nos no motor e publicam-nos aqui, mesmo que já haja planos.
          </p>
          <textarea rows={2} maxLength={500} placeholder="Nota para os agentes (opcional), p. ex. “o vento vai rodar: defender Sande primeiro”" value={note} onChange={(e) => setNote(e.target.value)} />
          <label className="note">
            <input type="checkbox" checked={fromNow} disabled={t <= 0} onChange={(e) => setFromNow(e.target.checked)} /> Decidir a partir do minuto no ecrã ({t > 0 ? `T+${Math.round(t)} min` : 'início'})
          </label>
          <button disabled={sending} onClick={() => void ask()}>
            {sending ? 'A enviar…' : 'Pedir novo plano aos agentes'}
          </button>
          {current?.status === 'failed' ? <small className="note">Último pedido falhou: {current.error}</small> : null}
        </>
      )}
      {requests.length > (open ? 1 : 0) ? (
        <details>
          <summary className="note">Pedidos anteriores</summary>
          {requests.slice(open ? 1 : 0, HISTORY_SHOWN + (open ? 1 : 0)).map((r) => (
            <div key={r.id as string} className={styles.baseLine}>
              <Tag kind={STATUS_KIND[r.status]}>{STATUS_LABEL[r.status]}</Tag>
              <span>{r.createdAt ? new Date(r.createdAt).toLocaleString('pt-PT') : ''}</span>
              {r.planIds?.length ? <span>{r.planIds.length} planos</span> : null}
              {r.note ? <span>“{r.note}”</span> : null}
              {r.status === 'failed' && r.error ? <span title={r.error}>{r.error.slice(0, 80)}</span> : null}
            </div>
          ))}
        </details>
      ) : null}
    </div>
  );
}
