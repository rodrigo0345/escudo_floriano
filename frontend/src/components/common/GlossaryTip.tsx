import { useId, useState } from 'react';
import { createPortal } from 'react-dom';

import { GLOSSARY, type GlossaryTerm } from '@/domain/glossary';

import styles from './common.module.css';

const WIDTH = 260;

/**
 * A small «i» that explains a technical term on hover or focus. The explanation is drawn in the page body (a portal), so it is not cut off by a panel
 * or a scrolling table that holds the label.
 */
export function GlossaryTip({ term }: { term: GlossaryTerm }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const id = useId();
  const entry = GLOSSARY[term];

  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setAt({ left: Math.max(8, Math.min(window.innerWidth - WIDTH - 8, r.left + r.width / 2 - WIDTH / 2)), top: r.bottom + 6 });
  };
  const hide = () => setAt(null);

  return (
    <>
      <span
        className={styles.glossaryTip}
        role="button"
        tabIndex={0}
        aria-label={`${entry.title}: ${entry.text}`}
        aria-describedby={at ? id : undefined}
        onMouseEnter={(e) => show(e.currentTarget)}
        onMouseLeave={hide}
        onFocus={(e) => show(e.currentTarget)}
        onBlur={hide}
        onKeyDown={(e) => e.key === 'Escape' && hide()}
      >
        i
      </span>
      {at
        ? createPortal(
            <div id={id} role="tooltip" className={styles.glossaryPop} style={{ left: at.left, top: at.top, width: WIDTH }}>
              <b>{entry.title}</b>
              <span>{entry.text}</span>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
