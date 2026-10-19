import { useEffect, useRef } from 'react';

import { useEngine, useWorld } from '@/engine/EngineContext';

import styles from './viewport.module.css';

const NICE_METERS = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000];
const TARGET_PX = 130;

/** A ground-distance ruler: always visible so the operator can judge how far things are at the current zoom. */
export function ScaleBar() {
  const engine = useEngine();
  const world = useWorld();
  const line = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!engine || !world) return;
    const unit = world.geo.unit;
    return engine.onFrame(() => {
      const metersPerPx = engine.worldUnitsPerPixel() * unit;
      const meters = NICE_METERS.reduce((best, m) => (Math.abs(m / metersPerPx - TARGET_PX) < Math.abs(best / metersPerPx - TARGET_PX) ? m : best));
      if (line.current) line.current.style.width = `${Math.max(4, Math.round(meters / metersPerPx))}px`;
      if (label.current) label.current.textContent = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
    });
  }, [engine, world]);

  return (
    <div className={styles.scaleBar}>
      <div ref={line} className={styles.scaleLine} />
      <span ref={label} className={styles.scaleLabel} />
    </div>
  );
}
