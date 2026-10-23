import { useEffect, useRef, useState } from 'react';

import { Icon } from '@/components/common/Icon';
import { PLAYBACK_SPEEDS, speedIndex, speedLabel, stepSpeed } from '@/domain/playbackSpeed';
import { useAppStore } from '@/store/appStore';

import styles from './layout.module.css';

/**
 * Playback speed, as a video player does it: a button with the current speed opens a panel with the speed in large type, a knob to drag between the steps
 * (−/+ on either side, J/K from the keyboard) and the steps as chips.
 */
export function SpeedControl() {
  const speed = useAppStore((s) => s.speed);
  const setSpeed = useAppStore((s) => s.setSpeed);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  const index = speedIndex(speed);
  return (
    <div className={styles.speed} ref={box}>
      <button type="button" className={styles.speedButton} onClick={() => setOpen(!open)} aria-expanded={open} title="Velocidade de reprodução (J mais lenta, K mais rápida)">
        <span className="mut">Velocidade</span> <b>{speedLabel(speed)}</b>
        <Icon name="chevron" size={12} />
      </button>
      {open ? (
        <div className={styles.speedPanel} role="dialog" aria-label="Velocidade de reprodução">
          <div className={styles.popoverHead}>
            <span>Velocidade de reprodução</span>
            <button type="button" className={styles.popoverClose} onClick={() => setOpen(false)} aria-label="Fechar">
              ×
            </button>
          </div>
          <b className={styles.speedValue}>{speedLabel(speed)}</b>
          <div className={styles.speedSlider}>
            <button type="button" onClick={() => setSpeed(stepSpeed(speed, -1))} disabled={index === 0} aria-label="Mais lenta (J)" title="Mais lenta (J)">
              −
            </button>
            <div className={styles.speedTrack}>
              <input
                type="range"
                min={0}
                max={PLAYBACK_SPEEDS.length - 1}
                step={1}
                value={index}
                onChange={(e) => setSpeed(PLAYBACK_SPEEDS[+e.target.value])}
                aria-label="Velocidade"
                aria-valuetext={speedLabel(speed)}
              />
              {/* one mark per step: the knob only stops on these */}
              <div className={styles.speedTicks} aria-hidden="true">
                {PLAYBACK_SPEEDS.map((s, i) => (
                  <i key={s} className={i <= index ? styles.speedTickOn : ''} />
                ))}
              </div>
            </div>
            <button type="button" onClick={() => setSpeed(stepSpeed(speed, 1))} disabled={index === PLAYBACK_SPEEDS.length - 1} aria-label="Mais rápida (K)" title="Mais rápida (K)">
              +
            </button>
          </div>
          <div className={styles.speedChips}>
            {PLAYBACK_SPEEDS.map((s) => (
              <button key={s} type="button" className={s === PLAYBACK_SPEEDS[index] ? styles.speedChipActive : ''} onClick={() => setSpeed(s)}>
                {speedLabel(s)}
              </button>
            ))}
          </div>
          <small className={`mut ${styles.speedKeys}`}>
            <kbd>J</kbd> mais lenta · <kbd>K</kbd> mais rápida
          </small>
        </div>
      ) : null}
    </div>
  );
}
