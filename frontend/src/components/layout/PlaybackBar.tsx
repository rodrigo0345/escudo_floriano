import { useMemo } from 'react';

import { formatDateTime } from '@/domain/weather';
import { useAppStore } from '@/store/appStore';

import styles from './layout.module.css';

const JUMPS = [15, 30, 60, 120, 180, 360];
const SPEEDS = [1, 5, 10, 30, 60];

const EVENT_LABEL: Record<string, string> = {
  wind_shift: 'Vento roda',
  wind_scale: 'Vento muda',
  wind_set: 'Vento fixo',
  humidity_shift: 'Humidade muda',
  temperature_shift: 'Temperatura muda',
  front_passage: 'Frente passa',
};

type TimeSpec = { offsetMinutes?: number; time?: string };

const offsetOf = (spec: TimeSpec | null | undefined, startMs: number): number | null => {
  if (!spec) return null;
  if ('offsetMinutes' in spec && typeof spec.offsetMinutes === 'number') return spec.offsetMinutes;
  if ('time' in spec && spec.time) {
    const at = Date.parse(spec.time);
    return Number.isFinite(at) ? (at - startMs) / 60_000 : null;
  }
  return null;
};

/** Play/pause, current instant, quick jumps, scrubber and playback speed. */
export function PlaybackBar() {
  const run = useAppStore((s) => s.run);
  const t = useAppStore((s) => s.t);
  const playing = useAppStore((s) => s.playing);
  const speed = useAppStore((s) => s.speed);
  const setPlaying = useAppStore((s) => s.setPlaying);
  const setSpeed = useAppStore((s) => s.setSpeed);
  const setTime = useAppStore((s) => s.setTime);

  const duration = run?.durationMinutes ?? 180;
  const flags = useMemo(() => {
    if (!run) return [];
    const snapshot = run.simulation.scenarioSnapshot;
    const list: { at: number; label: string; kind: 'weather' | 'ignition' }[] = [];
    for (const event of snapshot.weather?.events ?? []) {
      if (event.enabled === false) continue;
      const start = 'start' in event ? event.start : 'at' in event ? event.at : 'window' in event ? event.window?.start : null;
      const at = offsetOf(start, run.startMs);
      if (at == null || at < 0 || at > duration) continue;
      list.push({ at, label: EVENT_LABEL[event.type] ?? 'Meteorologia muda', kind: 'weather' });
    }
    for (const ignition of snapshot.ignitions ?? []) {
      const at = ignition.timeOffsetMinutes ?? 0;
      if (at < 0 || at > duration) continue;
      list.push({ at, label: ignition.label ?? `Foco a T+${at} min`, kind: 'ignition' });
    }
    return list;
  }, [run, duration]);

  const togglePlay = () => {
    if (!run) return;
    if (t >= run.durationMinutes) setTime(0);
    setPlaying(!playing);
  };

  return (
    <footer className={styles.bar}>
      <button className={styles.play} title="Reproduzir / pausar" onClick={togglePlay}>
        {playing ? 'Pausar' : 'Reproduzir'}
      </button>
      <div className={styles.clock}>
        <b>{run ? formatDateTime(run.startMs + t * 60000) : '—'}</b>
        <small>{run ? `T+${Math.floor(t / 60)} h ${String(t % 60).padStart(2, '0')} min` : ''}</small>
      </div>
      <div className={styles.jumps}>
        {JUMPS.filter((m) => m <= duration).map((m) => (
          <button key={m} onClick={() => setTime(m)}>
            {m >= 60 ? `${m / 60} h` : `${m} min`}
          </button>
        ))}
      </div>
      <div className={styles.scrubWrap}>
        <input
          className={styles.scrub}
          type="range"
          min={0}
          max={duration}
          step={1}
          value={t}
          onChange={(e) => {
            setPlaying(false);
            setTime(+e.target.value);
          }}
        />
        <div className={styles.flags} aria-hidden="true">
          {flags.map((flag, i) => (
            <i
              key={`${flag.kind}-${flag.at}-${i}`}
              className={flag.kind === 'ignition' ? styles.flagIgnition : styles.flagWeather}
              style={{ left: `${Math.min(100, Math.max(0, (flag.at / duration) * 100))}%` }}
              title={flag.label}
            />
          ))}
        </div>
      </div>
      <label className="mut">
        Velocidade{' '}
        <select value={speed} onChange={(e) => setSpeed(+e.target.value)}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s} min/s
            </option>
          ))}
        </select>
      </label>
    </footer>
  );
}
