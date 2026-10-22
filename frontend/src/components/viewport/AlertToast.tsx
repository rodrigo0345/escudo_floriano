import { useEffect, useRef, useState } from 'react';

import type { Action } from '@/api';
import { triggerStartMinute } from '@/domain/planEdit';
import { useAppStore } from '@/store/appStore';

import styles from './viewport.module.css';

/**
 * The "ALERTA À POPULAÇÃO" moment: when the playback minute crosses the start of a `public_alert`
 * action of the plan shown on the map (`activePlan`), a prominent toast names the alerted area and
 * shows the message the population would receive. Fires once per forward crossing of each action's
 * start minute (scrubbing back before it re-arms); a scrub that jumps over several alerts shows only
 * the latest, and at most two toasts stay visible. Only the shown plan's actions ever fire.
 */

/** A scheduled `public_alert` action: the `Action` union narrowed to the alert variant. */
type AlertAction = Action & { type: 'public_alert' };

type Toast = {
  key: string;
  title: string;
  message?: string;
  severity?: 'green' | 'yellow' | 'orange' | 'red';
  channels: string[];
};

const DISMISS_MS = 12_000;
const MAX_VISIBLE = 2;

export function AlertToast() {
  const activePlan = useAppStore((s) => s.activePlan);
  const t = useAppStore((s) => s.t);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const lastT = useRef<number | null>(null);
  const lastPlanId = useRef<string | null>(null);
  /** Pending auto-dismiss timers, keyed by toast key: re-firing the same alert replaces its timer
   *  (an old one firing early would remove the freshly shown toast) and fired timers remove themselves. */
  const timers = useRef(new Map<string, number>());

  useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id));
      timers.current.clear();
    },
    [],
  );

  useEffect(() => {
    const planId = activePlan?.id ?? null;
    if (lastPlanId.current !== planId) {
      // A different plan is now on the map: drop the previous plan's toasts and re-baseline —
      // only real forward crossings fire, never "everything already past" on a plan switch.
      lastPlanId.current = planId;
      lastT.current = t;
      timers.current.forEach((id) => window.clearTimeout(id));
      timers.current.clear();
      setToasts([]);
      return;
    }
    const prev = lastT.current;
    lastT.current = t;
    if (prev == null || t <= prev || !activePlan) return;
    // Which `public_alert` actions did we just cross (prev < start <= t)? The latest wins on a big jump.
    let fired: { action: AlertAction; start: number } | null = null;
    for (const action of activePlan.actions ?? []) {
      if (action.type !== 'public_alert') continue;
      const start = triggerStartMinute(action); // `at_time` trigger → `at.offsetMinutes`; conditional/manual → null
      if (start == null || !(prev < start && t >= start)) continue;
      if (!fired || start > fired.start) fired = { action, start };
    }
    if (!fired) return;
    const action = fired.action;
    // Prefer the Portuguese message if present (the operator UI and the alerts are Portuguese-first);
    // fall back to the first message so a missing translation never blanks the alert.
    const message =
      action.messages.find((m) => m.language?.toLowerCase().startsWith('pt'))?.text ?? action.messages[0]?.text;
    const toast: Toast = {
      key: `${activePlan.id}:${action.id}:${fired.start}`,
      title: action.title,
      message,
      severity: action.severity,
      channels: action.channels ?? [],
    };
    setToasts((current) => [toast, ...current.filter((x) => x.key !== toast.key)].slice(0, MAX_VISIBLE));
    const previous = timers.current.get(toast.key);
    if (previous !== undefined) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      timers.current.delete(toast.key);
      setToasts((current) => current.filter((x) => x.key !== toast.key));
    }, DISMISS_MS);
    timers.current.set(toast.key, timer);
  }, [t, activePlan]);

  if (!toasts.length) return null;
  return (
    <div className={styles.alertToastStack}>
      {toasts.map((toast) => (
        <button
          type="button"
          key={toast.key}
          className={`${styles.alertToast} ${toast.severity === 'red' ? styles.alertToastRed : ''}`}
          onClick={() => {
            const pending = timers.current.get(toast.key);
            if (pending !== undefined) {
              window.clearTimeout(pending);
              timers.current.delete(toast.key);
            }
            setToasts((current) => current.filter((x) => x.key !== toast.key));
          }}
          title="Clique para fechar o aviso"
        >
          <span className={styles.alertToastIcon}>⚠</span>
          <span className={styles.alertToastBody}>
            <strong className={styles.alertToastTitle}>ALERTA À POPULAÇÃO</strong>
            <span className={styles.alertToastText}>{toast.title}</span>
            {toast.message ? <span className={styles.alertToastMessage}>{toast.message}</span> : null}
            {toast.channels.length ? <span className={styles.alertToastChannels}>Via {toast.channels.join(', ')}</span> : null}
          </span>
        </button>
      ))}
    </div>
  );
}
