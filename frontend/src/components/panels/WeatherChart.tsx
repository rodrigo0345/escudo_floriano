import type { WeatherSample } from '@/api';

import styles from './panels.module.css';

const W = 320;
const H = 155;
const LEFT = 10;
const WIDTH = 300;
const TOP = 20;
const HEIGHT = 110;

/**
 * Weather timeline chart (Epic E7):
 * - Polylines for Wind speed, Gusts, Temperature, Air Humidity, Rain, and Clouds.
 * - Shaded risk bands for intervals satisfying the "30-30-30" rule.
 * - Interactive cursor line marking current playback minute `cursorMs`.
 */
export function WeatherChart({ samples, cursorMs = null }: { samples: WeatherSample[]; cursorMs?: number | null }) {
  if (!samples.length) return null;
  const t0 = +new Date(samples[0].time);
  const t1 = +new Date(samples[samples.length - 1].time);
  const x = (t: number) => LEFT + ((t - t0) / (t1 - t0 || 1)) * WIDTH;

  const maxWindVal = Math.max(
    ...samples.map((s) => Math.max(s.windKmh ?? 0, s.gustKmh ?? 0)),
    10,
  );
  const maxWind = Math.ceil(maxWindVal / 5) * 5;

  const temps = samples.map((s) => s.tempC ?? 0);
  const minT = Math.min(...temps);
  const maxT = Math.max(...temps, minT + 1);

  const maxPrecip = Math.max(...samples.map((s) => s.precipitationMmH ?? 0), 0);
  const hasClouds = samples.some((s) => (s.cloudCoverPct ?? 0) > 10);
  const hasGusts = samples.some((s) => s.gustKmh != null && s.gustKmh > (s.windKmh ?? 0));

  const line = (value: (s: WeatherSample) => number) =>
    samples.map((s) => `${x(+new Date(s.time)).toFixed(1)},${(TOP + HEIGHT - Math.max(0, Math.min(1, value(s))) * HEIGHT).toFixed(1)}`).join(' ');

  // Identify 30-30-30 danger intervals for background highlighting
  const dangerSpans: { x1: number; x2: number }[] = [];
  const dtHalf = samples.length > 1 ? (+new Date(samples[1].time) - +new Date(samples[0].time)) / 2 : 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const is30 = (s.tempC ?? 0) >= 30 && (s.humidityPct ?? 0) <= 30 && ((s.windKmh ?? 0) >= 30 || (s.gustKmh ?? 0) >= 30);
    if (is30) {
      const curT = +new Date(s.time);
      const spanX1 = Math.max(LEFT, x(curT - dtHalf));
      const spanX2 = Math.min(LEFT + WIDTH, x(curT + dtHalf));
      const prev = dangerSpans[dangerSpans.length - 1];
      if (prev && spanX1 <= prev.x2 + 2) {
        prev.x2 = spanX2;
      } else {
        dangerSpans.push({ x1: spanX1, x2: spanX2 });
      }
    }
  }

  return (
    <>
      <svg className={styles.chart} viewBox={`0 0 ${W} ${H}`}>
        {/* 30-30-30 Extreme Fire Weather Shaded Bands */}
        {dangerSpans.map((span, idx) => (
          <g key={idx}>
            <rect
              x={span.x1}
              y={TOP}
              width={Math.max(4, span.x2 - span.x1)}
              height={HEIGHT}
              fill="rgba(239, 68, 68, 0.16)"
              stroke="rgba(239, 68, 68, 0.35)"
              strokeWidth="0.5"
            />
            <text x={span.x1 + 3} y={TOP + 10} fontSize="7" fill="#ef4444" fontWeight="bold">
              30-30-30
            </text>
          </g>
        ))}

        {/* Rain area / line */}
        {maxPrecip > 0 ? (
          <polyline
            fill="none"
            stroke="#38bdf8"
            strokeWidth="2"
            strokeDasharray="2 2"
            points={line((s) => (s.precipitationMmH ?? 0) / Math.max(maxPrecip, 5))}
          />
        ) : null}

        {/* Cloud Cover subtle dotted curve */}
        {hasClouds ? (
          <polyline
            fill="none"
            stroke="#94a3b8"
            strokeWidth="1.2"
            strokeDasharray="2 3"
            opacity="0.6"
            points={line((s) => (s.cloudCoverPct ?? 0) / 100)}
          />
        ) : null}

        {/* Temperature */}
        <polyline
          fill="none"
          stroke="#e5484d"
          strokeWidth="1.5"
          strokeDasharray="4 3"
          points={line((s) => ((s.tempC ?? 0) - minT) / (maxT - minT))}
        />

        {/* Relative Humidity */}
        <polyline fill="none" stroke="#d8b26a" strokeWidth="2" points={line((s) => (s.humidityPct ?? 0) / 100)} />

        {/* Wind Gusts */}
        {hasGusts ? (
          <polyline
            fill="none"
            stroke="#fdba74"
            strokeWidth="1.2"
            strokeDasharray="3 2"
            points={line((s) => (s.gustKmh ?? s.windKmh ?? 0) / maxWind)}
          />
        ) : null}

        {/* Sustained Wind Speed */}
        <polyline fill="none" stroke="#ff6a1a" strokeWidth="2" points={line((s) => (s.windKmh ?? 0) / maxWind)} />

        {/* Playback time cursor */}
        {cursorMs != null ? (
          <g>
            <line x1={x(cursorMs)} x2={x(cursorMs)} y1="6" y2={TOP + HEIGHT + 5} stroke="#ffffff" strokeWidth="1.5" strokeDasharray="3 3" />
            <circle cx={x(cursorMs)} cy={TOP + HEIGHT + 4} r="2.5" fill="#ffffff" />
          </g>
        ) : null}
      </svg>
      <div className={styles.chartLegend}>
        <span>
          <i style={{ background: '#ff6a1a' }} />
          vento ({maxWind.toFixed(0)} km/h)
        </span>
        {hasGusts ? (
          <span>
            <i style={{ background: '#fdba74' }} />
            rajadas
          </span>
        ) : null}
        <span>
          <i style={{ background: '#d8b26a' }} />
          humidade %
        </span>
        <span>
          <i style={{ background: '#e5484d' }} />
          temp. ({minT.toFixed(0)}–{maxT.toFixed(0)} °C)
        </span>
        {maxPrecip > 0 ? (
          <span>
            <i style={{ background: '#38bdf8' }} />
            chuva (máx {maxPrecip.toFixed(1)} mm/h)
          </span>
        ) : null}
        {hasClouds ? (
          <span>
            <i style={{ background: '#94a3b8' }} />
            nuvens %
          </span>
        ) : null}
      </div>
    </>
  );
}
