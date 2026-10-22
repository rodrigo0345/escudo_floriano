import { useEffect } from 'react';

import { Icon } from '@/components/common/Icon';
import { useAppStore } from '@/store/appStore';

import styles from './viewport.module.css';

/** Transient hint pill (progress, "click the terrain to pick an ignition", ...). Auto-clears timed hints. */
export function Hint() {
  const hint = useAppStore((s) => s.hint);
  if (!hint) return null;
  return <div className={styles.hint}>{hint}</div>;
}

/** A message that stays until dismissed (errors) or fades on its own (warnings). */
export function Banner() {
  const banner = useAppStore((s) => s.banner);
  const dismiss = useAppStore((s) => s.dismissBanner);

  useEffect(() => {
    if (banner?.kind !== 'warn') return;
    const timer = setTimeout(dismiss, 8000);
    return () => clearTimeout(timer);
  }, [banner, dismiss]);

  if (!banner) return null;
  return (
    <div className={`${styles.banner} ${styles[banner.kind]}`} role="alert">
      <span>{banner.text}</span>
      <button aria-label="Fechar" onClick={dismiss}>
        <Icon name="close" />
      </button>
    </div>
  );
}

export function LoadingOverlay() {
  const data = useAppStore((s) => s.data);
  const bootError = useAppStore((s) => s.bootError);
  if (data && !bootError) return null;
  return <div className={styles.loading}>{bootError ? `Erro: ${bootError}` : 'A carregar terreno e satélite…'}</div>;
}
