import styles from './common.module.css';

interface Option<T extends string> {
  value: T;
  label: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  title,
}: {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  title?: string;
}) {
  return (
    <div className={styles.seg} title={title}>
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A row of colored swatches with labels (map legends). */
export function LegendDots({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className={styles.legendDots}>
      {items.map((i) => (
        <span key={i.label}>
          <i style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}
