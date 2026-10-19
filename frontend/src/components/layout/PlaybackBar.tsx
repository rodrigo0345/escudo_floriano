import { formatDateTime } from '@/domain/weather';
import { useAppStore } from '@/store/appStore';

import styles from './layout.module.css';

const JUMPS = [15, 30, 60, 120, 180, 360];
const SPEEDS = [1, 5, 10, 30, 60];

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
