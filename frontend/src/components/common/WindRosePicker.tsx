import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

import { compass } from '@/domain/georef';

import styles from './WindRosePicker.module.css';

interface Props {
  value: number;
  onChange: (deg: number) => void;
  disabled?: boolean;
}

const normalize = (deg: number): number => ((deg % 360) + 360) % 360;
const ROSE = Array.from({ length: 8 }, (_, i) => ({ deg: i * 45, label: compass(i * 45) }));
const TICKS = Array.from({ length: 16 }, (_, i) => i * 22.5);
const CARDINALS = new Set(['N', 'E', 'S', 'O']);

/** Clickable compass rose showing where the wind blows *to*; the value remains the meteorological `from` bearing. */
export function WindRosePicker({ value, onChange, disabled = false }: Props) {
  const svg = useRef<SVGSVGElement>(null);

  const fromPointer = (e: PointerEvent<SVGSVGElement>) => {
    if (disabled || !svg.current) return;
    const rect = svg.current.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    const to = (Math.atan2(dx, -dy) * 180) / Math.PI;
    onChange(normalize(to + 180));
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    fromPointer(e);
  };

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const step = e.shiftKey ? 15 : 5;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(normalize(value + step));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(normalize(value - step));
    }
  };

  const toDeg = normalize(value + 180);
  const rad = (toDeg * Math.PI) / 180;
  const ux = Math.sin(rad);
  const uy = -Math.cos(rad);
  const tip = [ux * 31, uy * 31];
  const base = [ux * 21, uy * 21];
  const tail = [-ux * 16, -uy * 16];
  const px = -uy;
  const py = ux;
  const left = [base[0] + px * 5.4, base[1] + py * 5.4];
  const right = [base[0] - px * 5.4, base[1] - py * 5.4];

  return (
    <svg
      ref={svg}
      className={styles.rose}
      viewBox="-50 -50 100 100"
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="Direção de onde sopra o vento (a seta aponta para onde sopra)"
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)} graus de ${compass(value)}; sopra para ${compass(value + 180)}`}
      aria-disabled={disabled}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (e.buttons === 1) fromPointer(e);
      }}
      onKeyDown={onKeyDown}
    >
      <circle r="42" className={styles.rim} />
      <circle r="31" className={styles.inner} />
      {TICKS.map((deg) => {
        const r = (deg * Math.PI) / 180;
        const outer = deg % 90 === 0 ? 42 : deg % 45 === 0 ? 40 : 38.5;
        return (
          <line
            key={deg}
            x1={Math.sin(r) * 31}
            y1={-Math.cos(r) * 31}
            x2={Math.sin(r) * outer}
            y2={-Math.cos(r) * outer}
            className={deg % 90 === 0 ? styles.tickMajor : deg % 45 === 0 ? styles.tick : styles.tickMinor}
          />
        );
      })}
      {ROSE.map(({ deg, label }) => {
        const r = (deg * Math.PI) / 180;
        return (
          <text
            key={label}
            x={Math.sin(r) * 35.5}
            y={-Math.cos(r) * 35.5}
            textAnchor="middle"
            dominantBaseline="central"
            className={`${styles.label} ${CARDINALS.has(label) ? styles.cardinal : ''} ${label === 'N' ? styles.north : ''}`}
          >
            {label}
          </text>
        );
      })}
      <line x1={tail[0]} y1={tail[1]} x2={base[0]} y2={base[1]} className={styles.shaft} />
      <polygon points={`${tip[0]},${tip[1]} ${left[0]},${left[1]} ${right[0]},${right[1]}`} className={styles.arrowHead} />
      <circle r="3.5" className={styles.hub} />
    </svg>
  );
}
