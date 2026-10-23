import type { ReactNode } from 'react';

import styles from './common.module.css';

export function StatCard({ label, value, sub, className, title }: { label: string; value: ReactNode; sub?: ReactNode; className?: string; title?: string }) {
  return (
    <div className={`${styles.card} ${className ?? ''}`} title={title ?? (typeof sub === 'string' ? sub : undefined)}>
      <small>{label}</small>
      <b>{value}</b>
      {sub ? <small>{sub}</small> : null}
    </div>
  );
}

export function CardGrid({ children }: { children: ReactNode }) {
  return <div className={styles.cards}>{children}</div>;
}

/** A label/value row; with `onClick` it is a button (keyboard too) that highlights on hover. */
export function Row({ children, className, onClick, title }: { children: ReactNode; className?: string; onClick?: () => void; title?: string }) {
  if (!onClick) return <div className={`${styles.row} ${className ?? ''}`}>{children}</div>;
  return (
    <div
      className={`${styles.row} ${styles.rowLink} ${className ?? ''}`}
      role="button"
      tabIndex={0}
      title={title}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </div>
  );
}

export function Tag({ kind, children }: { kind: 'bad' | 'ok' | 'warn'; children: ReactNode }) {
  return <span className={`${styles.tag} ${styles[kind]}`}>{children}</span>;
}

export function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className={styles.progress}>
      <i style={{ width: `${percent}%` }} />
    </div>
  );
}
