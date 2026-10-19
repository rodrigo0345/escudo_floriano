import { useEffect, useRef } from 'react';

import { useEngine } from '@/engine/EngineContext';

import styles from './viewport.module.css';

/** North arrow that follows the camera azimuth (updated straight on the DOM each frame, never through React state). Click = north up. */
export function Compass() {
  const engine = useEngine();
  const needle = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!engine) return;
    return engine.onFrame((_ts, azimuth) => {
      if (needle.current) needle.current.style.transform = `rotate(${-azimuth}rad)`;
    });
  }, [engine]);

  return (
    <button className={styles.compass} title="Clique para pôr o norte para cima" onClick={() => engine?.viewMode.resetNorth()}>
      <div ref={needle} className={styles.needle}>
        ▲<br />
        <small>N</small>
      </div>
    </button>
  );
}
