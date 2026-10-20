import { useEffect, useRef } from 'react';

import { useEngine } from '@/engine/EngineContext';

import styles from './viewport.module.css';

const ROSE = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'] as const;
const TICKS = Array.from({ length: 24 }, (_, i) => i * 15);

/** Compass rose that follows the camera azimuth. Click = north up. */
export function Compass() {
  const engine = useEngine();
  const needle = useRef<SVGGElement>(null);

  useEffect(() => {
    if (!engine) return;
    return engine.onFrame((_ts, azimuth) => {
      if (needle.current) needle.current.style.transform = `rotate(${-azimuth}rad)`;
    });
  }, [engine]);

  return (
    <button
      className={styles.compass}
      title="Clique para pôr o norte para cima"
      aria-label="Bússola. Clique para pôr o norte para cima"
      onClick={() => engine?.viewMode.resetNorth()}
    >
      <svg className={styles.compassRose} viewBox="-50 -50 100 100" aria-hidden="true">
        <circle r="47" className={styles.compassFace} />
        <circle r="39" className={styles.compassInner} />
        {TICKS.map((deg) => {
          const r = (deg * Math.PI) / 180;
          const major = deg % 90 === 0;
          const mid = deg % 45 === 0;
          return (
            <line
              key={deg}
              x1={Math.sin(r) * (major ? 37 : 39)}
              y1={-Math.cos(r) * (major ? 37 : 39)}
              x2={Math.sin(r) * 45}
              y2={-Math.cos(r) * 45}
              className={major ? styles.tickMajor : mid ? styles.tickMid : styles.tickMinor}
            />
          );
        })}
        {ROSE.map((label, i) => {
          const r = (i * 45 * Math.PI) / 180;
          return (
            <text
              key={label}
              x={Math.sin(r) * 32}
              y={-Math.cos(r) * 32}
              textAnchor="middle"
              dominantBaseline="central"
              className={`${styles.compassLabel} ${i % 2 === 0 ? styles.compassCardinal : ''} ${label === 'N' ? styles.compassNorth : ''}`}
            >
              {label}
            </text>
          );
        })}
        <g ref={needle} className={styles.compassNeedle}>
          <path d="M0 -34 L7 -6 L0 -11 L-7 -6 Z" className={styles.needleNorth} />
          <path d="M0 34 L7 6 L0 11 L-7 6 Z" className={styles.needleSouth} />
        </g>
        <circle r="3.4" className={styles.compassHub} />
      </svg>
    </button>
  );
}
