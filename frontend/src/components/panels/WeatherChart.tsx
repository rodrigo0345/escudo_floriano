import type { WeatherSample } from '@/api';

import styles from './panels.module.css';

const W = 320;
const H = 150;
const LEFT = 10;
const WIDTH = 300;
const TOP = 20;
const HEIGHT = 110;

/** Wind, humidity and temperature over time as three polylines (the Meteo tab and the sim form's preview). `cursorMs` marks an instant. */
export function WeatherChart({ samples, cursorMs = null }: { samples: WeatherSample[]; cursorMs?: number | null }) {
  if (!samples.length) return null;
  const t0 = +new Date(samples[0].time);
  const t1 = +new Date(samples[samples.length - 1].time);
  const x = (t: number) => LEFT + ((t - t0) / (t1 - t0 || 1)) * WIDTH;
  const maxWind = Math.max(...samples.map((s) => s.windKmh ?? 0), 10);
  const temps = samples.map((s) => s.tempC ?? 0);
  const minT = Math.min(...temps);
  const maxT = Math.max(...temps, minT + 1);
  const line = (value: (s: WeatherSample) => number) =>
    samples.map((s) => `${x(+new Date(s.time)).toFixed(1)},${(TOP + HEIGHT - value(s) * HEIGHT).toFixed(1)}`).join(' ');

  return (
    <>
      <svg className={styles.chart} viewBox={`0 0 ${W} ${H}`}>
        <polyline fill="none" stroke="#e5484d" strokeWidth="1.5" strokeDasharray="4 3" points={line((s) => ((s.tempC ?? 0) - minT) / (maxT - minT))} />
        <polyline fill="none" stroke="#4c8dff" strokeWidth="2" points={line((s) => (s.humidityPct ?? 0) / 100)} />
        <polyline fill="none" stroke="#ff6a1a" strokeWidth="2" points={line((s) => (s.windKmh ?? 0) / maxWind)} />
        {cursorMs != null ? <line x1={x(cursorMs)} x2={x(cursorMs)} y1="8" y2={TOP + HEIGHT + 5} stroke="#fff" strokeDasharray="3 3" /> : null}
      </svg>
      <div className={styles.chartLegend}>
        <span>
          <i style={{ background: '#ff6a1a' }} />
          vento (máx {maxWind.toFixed(0)} km/h)
        </span>
        <span>
          <i style={{ background: '#4c8dff' }} />
          humidade %
        </span>
        <span>
          <i style={{ background: '#e5484d' }} />
          temp. ({minT.toFixed(0)}–{maxT.toFixed(0)} °C)
        </span>
      </div>
    </>
  );
}
