import { useMemo, useState } from 'react';

import type { LatLon, Plan } from '@/api';
import { ATTACK_KINDS, attacksOf, personnelByMinute, type AttackKind, type AttackRow } from '@/domain/planAttacks';
import { useWorld } from '@/engine/EngineContext';
import { useAppStore } from '@/store/appStore';
import { useResourcesStore } from '@/store/resourcesStore';

import styles from './panels.module.css';

const REINFORCEMENT = '#ff9f1a';
const CURVE_H = 56;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * The combat side of one plan, made to be read: a curve of the operatives working on the fire minute by minute, then one bar per action
 * (thin while the unit travels, solid while it works, as solid as it is effective), with the playback minute across all of them. A row opens the
 * whole decision (who, from where, when, how hard, why, safety) and puts that action on the map with the road its unit takes.
 */
export function AttackTimeline({ plan, onMap, showOnMap }: { plan: Plan; onMap: boolean; showOnMap: () => void }) {
  const world = useWorld();
  const run = useAppStore((s) => s.run);
  const t = useAppStore((s) => s.t);
  const focused = useAppStore((s) => s.focusedActionId);
  const setFocused = useAppStore((s) => s.setFocusedAction);
  const setTime = useAppStore((s) => s.setTime);
  const places = useAppStore((s) => s.data?.places);
  const resources = useResourcesStore();
  const [hidden, setHidden] = useState<Set<AttackKind>>(new Set());
  const [nowOnly, setNowOnly] = useState(false);

  const rows = useMemo(() => {
    const where = new Map<string, LatLon>((places ?? []).map((p) => [p.id as string, p.position]));
    return attacksOf(plan, resources, where);
  }, [plan, resources, places]);

  const horizon = Math.max(60, Math.round(run?.durationMinutes ?? Math.max(...rows.map((r) => (Number.isFinite(r.end) ? r.end : r.start)), 60)));
  const curve = useMemo(() => personnelByMinute(rows, horizon), [rows, horizon]);
  const peak = curve.reduce((best, v, i) => (v > curve[best] ? i : best), 0);
  const cursor = onMap && run ? Math.min(t, horizon) : null;
  const x = (minute: number) => `${(Math.max(0, Math.min(horizon, minute)) / horizon) * 100}%`;

  const counts = rows.reduce<Record<AttackKind, number>>((c, r) => ({ ...c, [r.kind]: c[r.kind] + 1 }), { ground: 0, air: 0, fuel: 0, defence: 0 });
  const shown = rows.filter((r) => !hidden.has(r.kind) && (!nowOnly || cursor === null || (r.start <= cursor && cursor < r.end)));
  const personnel = rows.reduce((s, r) => s + r.personnel, 0);
  const vehicles = rows.reduce((s, r) => s + r.vehicles, 0);
  const late = rows.filter((r) => r.start >= horizon).length;
  const firstOnFire = rows.filter((r) => r.kind === 'ground' || r.kind === 'air').reduce((m, r) => Math.min(m, r.start), Infinity);
  const workingNow = cursor === null ? null : rows.filter((r) => r.start <= cursor && cursor < r.end);

  const pick = (row: AttackRow) => {
    if (focused === row.id) return setFocused(null);
    setFocused(row.id);
    if (!onMap) showOnMap();
    if (row.where && world) world.focusOnLatLon(row.where.lat, row.where.lon);
  };
  const seeWorking = (row: AttackRow) => {
    if (!onMap) showOnMap();
    setTime(Math.min(horizon, Math.round(row.start) + 1));
    if (row.where && world) world.focusOnLatLon(row.where.lat, row.where.lon);
  };

  if (!rows.length) return <p className="note">Este plano não tem ações de combate ao fogo.</p>;

  // the curve of operatives at work, as a closed area under the minute-by-minute count
  const top = Math.max(1, curve[peak]);
  const path = `M0,${CURVE_H} ${curve.map((v, i) => `L${(i / horizon) * 1000},${CURVE_H - (v / top) * (CURVE_H - 4)}`).join(' ')} L1000,${CURVE_H} Z`;
  const ticks = Array.from({ length: Math.floor(horizon / 60) + 1 }, (_, i) => i * 60);

  return (
    <div className={styles.attack}>
      <div className={styles.attackFacts}>
        <span>
          <b>{rows.length}</b> ações de combate
        </span>
        <span>
          <b>{personnel}</b> operacionais · <b>{vehicles}</b> veículos
        </span>
        {Number.isFinite(firstOnFire) ? (
          <span>
            1.ª equipa no fogo <b>T+{Math.round(firstOnFire)}</b>
          </span>
        ) : null}
        <span>
          pico <b>{curve[peak]}</b> op. às T+{peak}
        </span>
        {workingNow ? (
          <span>
            agora (T+{cursor}): <b>{workingNow.reduce((s, r) => s + r.personnel, 0)}</b> op. em {workingNow.length} ações
          </span>
        ) : null}
      </div>

      <div className={styles.curve} title="Operacionais a trabalhar no fogo, minuto a minuto">
        <svg viewBox={`0 0 1000 ${CURVE_H}`} preserveAspectRatio="none">
          <path d={path} />
        </svg>
        {cursor !== null ? <i className={styles.cursor} style={{ left: x(cursor) }} /> : null}
      </div>
      <div className={styles.ticks}>
        {ticks.map((m) => (
          <span key={m} style={{ left: x(m) }}>
            {m ? `${m / 60} h` : 'T+0'}
          </span>
        ))}
      </div>

      <div className={styles.attackFilters}>
        {(Object.keys(ATTACK_KINDS) as AttackKind[])
          .filter((k) => counts[k])
          .map((k) => (
            <button
              key={k}
              className={hidden.has(k) ? '' : 'on'}
              style={{ borderColor: ATTACK_KINDS[k].color }}
              onClick={() => setHidden((h) => {
                const next = new Set(h);
                if (next.has(k)) next.delete(k);
                else next.add(k);
                return next;
              })}
            >
              {ATTACK_KINDS[k].label} ({counts[k]})
            </button>
          ))}
        {cursor !== null ? (
          <button className={nowOnly ? 'on' : ''} onClick={() => setNowOnly((v) => !v)}>
            Só a trabalhar agora
          </button>
        ) : null}
      </div>

      <div className={styles.gantt}>
        {cursor !== null ? <i className={styles.cursor} style={{ left: `calc(var(--gantt-label) + (100% - var(--gantt-label)) * ${Math.min(horizon, cursor) / horizon})` }} /> : null}
        {shown.map((r) => {
          const color = ATTACK_KINDS[r.kind].color;
          const on = focused === r.id;
          const ends = Math.min(horizon, Number.isFinite(r.end) ? r.end : horizon);
          const from = Math.min(r.start, horizon - 2); // an action that starts after the end still shows a stub at the right edge
          return (
            <div key={r.id}>
              <button className={`${styles.ganttRow} ${on ? styles.ganttOn : ''}`} onClick={() => pick(r)} title={`${r.title}\n${r.rationale}`}>
                <span className={styles.ganttLabel} style={r.reinforcement ? { borderLeftColor: REINFORCEMENT } : undefined}>
                  {r.wave !== null ? <em>T+{r.wave}</em> : null}
                  {r.units}
                  <small>{r.label}</small>
                </span>
                <span className={styles.ganttTrack}>
                  {from > r.leaves ? <i className={styles.travel} style={{ left: x(r.leaves), width: x(from - r.leaves), borderColor: color }} /> : null}
                  <i
                    className={styles.work}
                    style={{ left: x(from), width: x(Math.max(2, ends - from)), background: color, opacity: 0.35 + 0.65 * Math.min(1, r.effectiveness) }}
                  />
                  {r.start >= horizon ? <small className={styles.late}>depois do fim</small> : null}
                </span>
              </button>
              {on ? <AttackDetail row={r} horizon={horizon} seeWorking={() => seeWorking(r)} /> : null}
            </div>
          );
        })}
      </div>
      <small className="note">
        Barra fina: a caminho · barra cheia: a trabalhar (mais opaca = mais eficaz) · borda laranja: reforço de outro distrito · linha branca: minuto no mapa.
        {late ? ` ${late} ações começam depois do fim da simulação (não contam no resultado).` : ''}
      </small>
    </div>
  );
}

function AttackDetail({ row, horizon, seeWorking }: { row: AttackRow; horizon: number; seeWorking: () => void }) {
  const ends = Number.isFinite(row.end) ? `T+${Math.round(row.end)}` : 'até ao fim';
  return (
    <div className={styles.attackDetail}>
      <b>{row.title}</b>
      <dl>
        <dt>Quem</dt>
        <dd>
          {row.units} · {row.orgName}
          {row.reinforcement ? ' · reforço' : ''}
        </dd>
        {row.fromStation ? (
          <>
            <dt>De</dt>
            <dd>{row.fromStation}</dd>
          </>
        ) : null}
        <dt>Quando</dt>
        <dd>
          sai T+{Math.round(row.leaves)} · chega T+{Math.round(row.arrives)} · trabalha T+{Math.round(row.start)} → {ends}
          {row.dependsOnEvacuation ? ' (depois da evacuação)' : ''}
        </dd>
        <dt>Meios</dt>
        <dd>
          {row.personnel} operacionais{row.vehicles ? ` · ${row.vehicles} veículos` : ''}
          {row.waterL ? ` · ${row.waterL} L de água` : ''}
        </dd>
        <dt>Eficácia</dt>
        <dd>
          {pct(row.effectiveness)} <small className="note">(o quanto trava o fogo onde trabalha, já com reabastecimentos e cansaço)</small>
        </dd>
        {row.expectedEffect ? (
          <>
            <dt>Efeito</dt>
            <dd>{row.expectedEffect}</dd>
          </>
        ) : null}
        <dt>Porquê</dt>
        <dd>{row.rationale || '—'}</dd>
        {row.safetyNotes ? (
          <>
            <dt>Segurança</dt>
            <dd>{row.safetyNotes}</dd>
          </>
        ) : null}
      </dl>
      {row.start < horizon ? <button onClick={seeWorking}>Ver no mapa a trabalhar (T+{Math.round(row.start) + 1})</button> : null}
    </div>
  );
}
