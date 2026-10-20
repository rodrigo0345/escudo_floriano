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

export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`${styles.row} ${className ?? ''}`}>{children}</div>;
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
