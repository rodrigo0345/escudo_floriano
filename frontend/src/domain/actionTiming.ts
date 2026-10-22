import type { Plan, PlanAction } from '@/api';

/**
 * When each action of a plan happens, in minutes of the plan's run, the way the backend's unit simulator times it (`PlanTiming`, `OperationSimulator`):
 * the unit leaves at the action's `at_time` trigger (or when the action it waits for ends), arrives `etaMinutes` later and works for the action's
 * stay (`expectedDurationMinutes`, else the backend's default window). Actions that carry `simulationEffects` work exactly when their effects do (the
 * effects' `start` is on the run's clock); a fire line or fuel break stays once made; a road closure lasts until its `until`.
 */
export interface ActionWindow {
  /** The unit sets off. */
  leaves: number;
  /** It starts doing what the action says (arrived and working, or the closure in force). */
  start: number;
  /** It stops (`Infinity`: to the end of the run). */
  end: number;
}

export type ActionPhase = 'upcoming' | 'en_route' | 'active' | 'done';

export const PHASE_LABEL: Record<ActionPhase, string> = {
  upcoming: 'a seguir',
  en_route: 'a caminho',
  active: 'em curso',
  done: 'terminada',
};

/** The backend's `DefaultActionWindowMinutes`: how long a unit stays when the action does not say. */
const DEFAULT_STAY_MIN = 30;
const ALERT_MIN = 30;

type Json = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const LASTING = new Set(['fire_line', 'fuel_removal']);

/** Every action's window, by action id. */
export function actionWindows(plan: Plan): Map<string, ActionWindow> {
  const byId = new Map((plan.actions as PlanAction[]).map((a) => [String(a.id), a as unknown as Json]));
  const out = new Map<string, ActionWindow>();
  const busy = new Set<string>();

  const windowOf = (id: string): ActionWindow => {
    const known = out.get(id);
    if (known) return known;
    const action = byId.get(id);
    if (!action || busy.has(id)) return { leaves: 0, start: 0, end: Infinity };
    busy.add(id);

    const trigger = action.trigger as { kind?: string; at?: { offsetMinutes?: number }; actionId?: string } | undefined;
    let leaves = 0;
    if (trigger?.kind === 'at_time') leaves = num(trigger.at?.offsetMinutes) ?? 0;
    else if (trigger?.kind === 'on_action_complete' && trigger.actionId) {
      const before = windowOf(String(trigger.actionId)).end;
      leaves = Number.isFinite(before) ? before : 0;
    }
    const resources = (action.resources as Json[] | undefined) ?? [];
    const eta = Math.max(0, ...resources.map((r) => num(r.etaMinutes) ?? 0));
    const stay = num(action.expectedDurationMinutes);

    const effects = (action.simulationEffects as Json[] | undefined) ?? [];
    const timed = effects.filter((e) => num((e.start as Json | undefined)?.offsetMinutes) !== undefined);
    let window: ActionWindow;
    if (timed.length) {
      const starts = timed.map((e) => num((e.start as Json).offsetMinutes)!);
      const ends = timed.map((e, i) => {
        const length = num(e.durationMinutes) ?? num(e.effectDurationMinutes);
        if (length !== undefined) return starts[i] + length;
        if (LASTING.has(String(e.type))) return Infinity;
        const by = num((e.completeBy as Json | undefined)?.offsetMinutes);
        return by !== undefined ? by : starts[i] + (stay ?? 60);
      });
      const start = Math.min(...starts);
      window = { leaves: Math.min(leaves, Math.max(0, start - eta)), start, end: Math.max(...ends) };
    } else {
      const arrives = leaves + eta;
      switch (action.type) {
        case 'road_closure': {
          const until = num((action.until as Json | undefined)?.offsetMinutes);
          window = { leaves, start: leaves, end: until !== undefined ? Math.max(until, leaves) : Infinity };
          break;
        }
        case 'public_alert':
          window = { leaves, start: leaves, end: leaves + ALERT_MIN };
          break;
        case 'establish_command_post':
        case 'shelter_in_place':
          window = { leaves, start: arrives, end: stay !== undefined ? arrives + stay : Infinity };
          break;
        default:
          window = { leaves, start: arrives, end: arrives + (stay ?? (resources.length ? DEFAULT_STAY_MIN : Infinity)) };
      }
    }
    busy.delete(id);
    out.set(id, window);
    return window;
  };

  for (const id of byId.keys()) windowOf(id);
  return out;
}

export function phaseAt(window: ActionWindow, t: number): ActionPhase {
  if (t < window.leaves) return 'upcoming';
  if (t < window.start) return 'en_route';
  if (t < window.end) return 'active';
  return 'done';
}

/** `T+12→T+80 min`, or `T+12→fim`. */
export function windowText(window: ActionWindow): string {
  return `T+${Math.round(window.start)}→${Number.isFinite(window.end) ? `T+${Math.round(window.end)}` : 'fim'} min`;
}
