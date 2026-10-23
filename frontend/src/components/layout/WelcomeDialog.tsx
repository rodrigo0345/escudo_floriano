import { useEffect, useRef, useState } from 'react';

import styles from './layout.module.css';

const SEEN_KEY = 'firetrace.welcomeSeen';

/** Shown once per browser session (the tab's session storage); when the browser keeps no storage it shows on every opening, which is harmless. */
function seen(): boolean {
  try {
    return window.sessionStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** The welcome card on opening: the shield, the name and what the app is for. Closed with the button, Esc or a click outside. */
export function WelcomeDialog() {
  const [open, setOpen] = useState(() => !seen());
  const start = useRef<HTMLButtonElement>(null);

  const close = () => {
    try {
      window.sessionStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* not remembered: it shows again on the next opening */
    }
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    start.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        e.stopImmediatePropagation(); // the map's shortcuts wait until the card is gone
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  return (
    <div className={styles.shortcutBackdrop} onClick={close} role="presentation">
      <div className={styles.welcome} role="dialog" aria-modal="true" aria-labelledby="welcome-title" onClick={(e) => e.stopPropagation()}>
        <img className={styles.welcomeLogo} src="/escudo-floriano.png" alt="" />
        <h2 id="welcome-title">Escudo Floriano</h2>
        <small className={styles.welcomeTag}>Hack4Guimarães 2035</small>
        <p>
          Bem-vindo ao Escudo Floriano, um mapa tático 3D com inteligência artificial multiagente que reúne os Bombeiros, a GNR, o INEM e a Proteção Civil numa única
          plataforma. Prevê a evolução dos incêndios e permite testar estratégias de atuação antes de as pôr em prática.
        </p>
        <p className={styles.welcomeMotto}>«Proteger quem nos protege.»</p>
        <button ref={start} type="button" className={styles.welcomeStart} onClick={close}>
          Começar
        </button>
        <small className="mut">
          Carregue em <kbd>?</kbd> para ver os atalhos de teclado.
        </small>
      </div>
    </div>
  );
}
