import { useEffect, useRef, useState } from 'react';

import type { Action } from '@/api';
import { Icon } from '@/components/common/Icon';
import { alertStartMinute } from '@/domain/planEdit';
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
const RESUME_MS = 4_000;
const MAX_VISIBLE = 2;

export function AlertToast() {
  const activePlan = useAppStore((s) => s.activePlan);
  const t = useAppStore((s) => s.t);
  const run = useAppStore((s) => s.run);
  const data = useAppStore((s) => s.data);
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
    const planId = activePlan && run ? `${activePlan.id}:${run.id}` : null;
    if (lastPlanId.current !== planId) {
      // A different plan/run is on the map: discard old toasts. At T+0 include immediate alerts;
      // a switch halfway through the run does not replay alerts already in the past.
      lastPlanId.current = planId;
      lastT.current = t === 0 ? -1 : t;
      timers.current.forEach((id) => window.clearTimeout(id));
      timers.current.clear();
      setToasts([]);
    }
    const prev = lastT.current;
    lastT.current = t;
    if (prev != null && t < prev) {
      // Rewinding to the start re-arms immediate/T+0 alerts for the next forward tick.
      if (t === 0) lastT.current = -1;
      return;
    }
    if (prev == null || t <= prev || !activePlan || !run || !data || run.simulation.planId !== activePlan.id) return;
    // Which `public_alert` actions did we just cross (prev < start <= t)? The latest wins on a big jump.
    let fired: { action: AlertAction; start: number } | null = null;
    for (const action of activePlan.actions ?? []) {
      if (action.type !== 'public_alert') continue;
      const start = alertStartMinute(action, run, data);
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
  }, [t, activePlan, run, data]);

  const stopTimer = (key: string) => {
    const pending = timers.current.get(key);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      timers.current.delete(key);
    }
  };
  const dismiss = (key: string) => {
    stopTimer(key);
    setToasts((current) => current.filter((x) => x.key !== key));
  };
  /** After the operator has read it (the pointer leaves), the alert goes away a few seconds later. */
  const resumeTimer = (key: string) => {
    stopTimer(key);
    timers.current.set(key, window.setTimeout(() => dismiss(key), RESUME_MS));
  };

  if (!toasts.length) return null;
  return (
    <div className={styles.alertToastStack}>
      {toasts.map((toast) => (
        <div
          key={toast.key}
          role="alert"
          tabIndex={0}
          className={`${styles.alertToast} ${toast.severity === 'red' ? styles.alertToastRed : ''}`}
          onMouseEnter={() => stopTimer(toast.key)}
          onMouseLeave={() => resumeTimer(toast.key)}
          title="Passe o rato para ler o aviso"
        >
          <span className={styles.alertToastIcon}>
            <Icon name="alert" size={15} />
          </span>
          <span className={styles.alertToastBody}>
            <strong className={styles.alertToastTitle}>Alerta à população</strong>
            <span className={styles.alertToastText}>{toast.title}</span>
            <span className={styles.alertToastMore}>
              {toast.message ? <span className={styles.alertToastMessage}>{toast.message}</span> : null}
              {toast.channels.length ? <span className={styles.alertToastChannels}>Via {toast.channels.join(', ')}</span> : null}
            </span>
          </span>
          <button type="button" className={styles.alertToastClose} onClick={() => dismiss(toast.key)} aria-label="Fechar o alerta" title="Fechar">
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
