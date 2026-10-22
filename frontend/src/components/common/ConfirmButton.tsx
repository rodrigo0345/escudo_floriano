import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';

import styles from './common.module.css';

const ARM_MS = 2000; // the second click only counts after this: a double click does not confirm by accident
const RESET_MS = 8000; // an unconfirmed button goes back to normal

/**
 * A button that asks inside the page instead of a browser dialog: the first click turns it into the question (`confirm`,
 * with `detail` under it) and locks it for two seconds while a bar fills; then it turns into the answer (`yes`, e.g.
 * "Sim, apagar") and a click on it does it. "Cancelar", or leaving it alone, puts it back.
 */
export function ConfirmButton({ children, confirm = 'Tens a certeza?', yes = 'Sim', detail, onConfirm, className, disabled, title }: {
  children: ReactNode;
  confirm?: string;
  yes?: string;
  detail?: ReactNode;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [stage, setStage] = useState<'idle' | 'asking' | 'ready'>('idle');
  const timers = useRef<number[]>([]);

  const clear = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => clear, []);

  const reset = () => {
    clear();
    setStage('idle');
  };

  const click = (event: MouseEvent) => {
    event.stopPropagation();
    if (stage === 'idle') {
      setStage('asking');
      timers.current.push(window.setTimeout(() => setStage('ready'), ARM_MS), window.setTimeout(() => setStage('idle'), RESET_MS));
      return;
    }
    if (stage !== 'ready') return;
    reset();
    onConfirm();
  };

  return (
    <span className={styles.confirmWrap}>
      <button
        className={`${className ?? ''} ${stage === 'asking' ? styles.confirmAsking : stage === 'ready' ? styles.confirmReady : ''}`}
        disabled={disabled || stage === 'asking'}
        onClick={click}
        title={stage === 'idle' ? title : undefined}
      >
        {stage === 'asking' ? confirm : stage === 'ready' ? yes : children}
      </button>
      {stage !== 'idle' && detail ? <small className={styles.confirmDetail}>{detail}</small> : null}
      {stage !== 'idle' ? (
        <button
          className={styles.confirmCancel}
          onClick={(event) => {
            event.stopPropagation();
            reset();
          }}
        >
          Cancelar
        </button>
      ) : null}
    </span>
  );
}
