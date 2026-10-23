import { useEffect } from 'react';

import { speedLabel, stepSpeed } from '@/domain/playbackSpeed';
import { useEngine } from '@/engine/EngineContext';
import { useAppStore } from '@/store/appStore';
import type { PanelTab } from '@/store/types';

import styles from './layout.module.css';

const TABS: PanelTab[] = ['incident', 'plans', 'roads', 'assets', 'weather', 'resources'];

const isTypingTarget = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
};

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Espaço', action: 'Reproduzir / pausar' },
  { keys: '[  ]', action: 'Recuar / avançar 1 minuto' },
  { keys: 'J  K', action: 'Velocidade mais lenta / mais rápida (até 30 s/s, para seguir os meios)' },
  { keys: '1 – 6', action: 'Abrir separador Incidente, Planos, Estradas, Meios, Meteo ou Recursos' },
  { keys: 'V', action: 'Alternar vista 3D / 2D' },
  { keys: 'R ou N', action: 'Norte para cima' },
  { keys: 'M', action: 'Modo probabilístico' },
  { keys: 'F', action: 'Camada de fumo' },
  { keys: 'G', action: 'Camada de vento 3D' },
  { keys: 'I', action: 'Separador Incidente' },
  { keys: 'H', action: 'Modo foto: esconder painéis, barras e ícones; os meios continuam no mapa (H ou Esc para voltar)' },
  { keys: '?', action: 'Abrir / fechar esta ajuda' },
  { keys: 'Esc', action: 'Fechar esta ajuda' },
];

/**
 * Global operator shortcuts. Text fields and buttons keep their native keyboard behavior;
 * a help overlay (also opened from the top bar) documents the deliberately small key set.
 */
export function KeyboardShortcuts() {
  const engine = useEngine();
  const helpOpen = useAppStore((s) => s.helpOpen);
  const setHelpOpen = useAppStore((s) => s.setHelpOpen);

  useEffect(() => {
    let hintTimer = 0; // the speed set with J/K shows for a moment on the map
    const onKey = (e: KeyboardEvent) => {
      const s = useAppStore.getState();
      if (e.key === 'Escape') {
        if (s.helpOpen) {
          s.setHelpOpen(false);
          e.preventDefault();
        } else if (s.cleanView) {
          s.setCleanView(false); // Esc also brings the interface back
          e.preventDefault();
        }
        return;
      }
      if (e.key === '?' && !isTypingTarget(e.target)) {
        s.setHelpOpen(!s.helpOpen);
        e.preventDefault();
        return;
      }
      if (s.helpOpen || isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === ' ' || e.key === 'Spacebar') {
        if (!s.run) return;
        if (!s.playing && s.t >= s.run.durationMinutes) s.setTime(0);
        s.setPlaying(!s.playing);
        e.preventDefault();
        return;
      }
      if (e.key === '[' || e.key === ']') {
        if (!s.run) return;
        const delta = e.key === '[' ? -1 : 1;
        s.setPlaying(false);
        s.setTime(Math.max(0, Math.min(s.run.durationMinutes, s.t + delta)));
        e.preventDefault();
        return;
      }
      if (/^[1-6]$/.test(e.key)) {
        s.setTab(TABS[Number(e.key) - 1]);
        e.preventDefault();
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'v':
          if (engine) engine.viewMode.set(engine.viewMode.mode === '2d' ? '3d' : '2d');
          break;
        case 'r':
        case 'n':
          engine?.viewMode.resetNorth();
          break;
        case 'm':
          s.setProbMode(!s.probMode);
          break;
        case 'f':
          s.setSmokeEnabled(!s.smokeEnabled);
          break;
        case 'g':
          s.setWindEnabled(!s.windEnabled);
          break;
        case 'i':
          s.setTab('incident');
          break;
        case 'h':
          s.setCleanView(!s.cleanView);
          break;
        case 'j':
        case 'k': {
          const speed = stepSpeed(s.speed, e.key.toLowerCase() === 'j' ? -1 : 1);
          s.setSpeed(speed);
          s.setHint(`Velocidade ${speedLabel(speed)}`);
          window.clearTimeout(hintTimer);
          hintTimer = window.setTimeout(() => {
            if (useAppStore.getState().hint === `Velocidade ${speedLabel(speed)}`) useAppStore.getState().setHint('');
          }, 1200);
          break;
        }
        default:
          return;
      }
      e.preventDefault();
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(hintTimer);
    };
  }, [engine]);

  if (!helpOpen) return null;
  return (
    <div className={styles.shortcutBackdrop} onClick={() => setHelpOpen(false)} role="presentation">
      <div className={styles.shortcutModal} role="dialog" aria-modal="true" aria-labelledby="shortcut-title" onClick={(e) => e.stopPropagation()}>
        <div className={styles.shortcutHead}>
          <div>
            <h3 id="shortcut-title">Atalhos de teclado</h3>
            <small className="mut">Funcionam fora de campos de texto.</small>
          </div>
          <button type="button" onClick={() => setHelpOpen(false)} aria-label="Fechar atalhos">
            ×
          </button>
        </div>
        <div className={styles.shortcutGrid}>
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className={styles.shortcutRow}>
              <kbd>{shortcut.keys}</kbd>
              <span>{shortcut.action}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
