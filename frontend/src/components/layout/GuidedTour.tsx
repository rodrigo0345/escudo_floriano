import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useAppStore } from '@/store/appStore';
import type { PanelTab } from '@/store/types';

import styles from './layout.module.css';

/** Dispatched on `window` to start the tour (from the welcome card or the shortcuts help). */
export const START_TOUR_EVENT = 'firetrace:start-tour';

const CARD_WIDTH = 290;
const GAP = 14;

interface Step {
  target: string;
  title: string;
  text: string;
  /** the tab shown in this step (the steps about the map, the timeline and the speed show the incident) */
  tab: PanelTab;
}

const STEPS: Step[] = [
  { target: 'map', title: 'O mapa', text: 'Aqui vê o fogo, os meios e as estradas. Arraste para rodar e use a roda do rato para aproximar.', tab: 'incident' },
  { target: 'tab-incident', title: 'Incidente', text: 'O resumo do fogo, com a área ardida e a velocidade em cada marco, e o formulário para simular com outra meteorologia.', tab: 'incident' },
  { target: 'plans', title: 'Planos', text: 'Os agentes propõem dois planos. Compare os feridos, a área ardida e as casas atingidas e escolha um.', tab: 'plans' },
  { target: 'tab-roads', title: 'Estradas', text: 'As estradas que o fogo corta ou torna lentas, e a partir de que minuto. O número é o das estradas cortadas.', tab: 'roads' },
  { target: 'tab-assets', title: 'Meios', text: 'Os meios no terreno de Bombeiros, GNR, INEM e Proteção Civil, e os pontos de água para combate.', tab: 'assets' },
  { target: 'tab-weather', title: 'Meteo', text: 'O vento, a temperatura e a humidade ao longo do tempo, que mandam no avanço do fogo.', tab: 'weather' },
  { target: 'tab-resources', title: 'Recursos', text: 'Onde cada corporação regista os seus quartéis, viaturas e pessoal.', tab: 'resources' },
  { target: 'timeline', title: 'A linha do tempo', text: 'Arraste a bolinha para ver o fogo crescer e os meios a chegar, minuto a minuto.', tab: 'incident' },
  { target: 'speed', title: 'A velocidade', text: 'Mais lenta para seguir os meios, mais rápida para ver o fogo crescer. Também pode usar J e K.', tab: 'incident' },
];

/** A guided tour in four steps: the rest of the screen dims, the part being explained stays lit, and a small card says what it is. Esc leaves it. */
export function GuidedTour() {
  const [step, setStep] = useState<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const setTab = useAppStore((s) => s.setTab);

  const startedOn = useRef<PanelTab>('incident');
  const stepRef = useRef(0); // the keyboard handler reads the current step without being recreated at every step

  useEffect(() => {
    const start = () => {
      startedOn.current = useAppStore.getState().tab;
      setStep(0);
    };
    window.addEventListener(START_TOUR_EVENT, start);
    return () => window.removeEventListener(START_TOUR_EVENT, start);
  }, []);

  /** Leaving the tour (done, skipped or Esc) puts the screen back on the tab it started from. */
  const close = () => {
    setStep(null);
    setRect(null);
    setTab(startedOn.current);
  };

  // measure the target after the step (and the tab it needs) has been drawn, and again when the window changes
  useLayoutEffect(() => {
    if (step === null) return undefined;
    const current = STEPS[step];
    setTab(current.tab);
    const measure = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${current.target}"]`);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    const later = window.setTimeout(measure, 120); // the panel of a new tab is drawn a moment after the switch
    window.addEventListener('resize', measure);
    return () => {
      window.clearTimeout(later);
      window.removeEventListener('resize', measure);
    };
  }, [step, setTab]);

  useEffect(() => {
    if (step === null) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const stop = () => {
        e.preventDefault();
        e.stopImmediatePropagation(); // the map's shortcuts wait until the tour is over
      };
      if (e.key === 'Escape') {
        stop();
        close();
      } else if (e.key === 'Enter' || e.key === 'ArrowRight') {
        stop();
        if (stepRef.current + 1 < STEPS.length) setStep(stepRef.current + 1);
        else close();
      } else if (e.key === 'ArrowLeft') {
        stop();
        setStep((s) => (s === null ? s : Math.max(0, s - 1)));
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
        stop(); // a letter or digit does nothing while the tour is open
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [step]);

  stepRef.current = step ?? 0;
  if (step === null) return null;
  const current = STEPS[step];
  const last = step === STEPS.length - 1;

  // the card sits beside the lit part, on the side with room: above a bar at the bottom, left of a column at the right, else inside the corner of a large area
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardWidth = Math.min(CARD_WIDTH, vw - 24);
  const cardStyle: React.CSSProperties = { width: cardWidth };
  if (rect) {
    const clampX = (x: number) => Math.max(12, Math.min(vw - cardWidth - 12, x));
    if (rect.top > vh * 0.6) {
      cardStyle.left = clampX(rect.left + rect.width / 2 - cardWidth / 2);
      cardStyle.bottom = vh - rect.top + GAP;
    } else if (rect.left > vw * 0.55 && rect.left - cardWidth - GAP > 12) {
      cardStyle.left = rect.left - cardWidth - GAP;
      cardStyle.top = Math.max(12, rect.top + 12);
    } else {
      cardStyle.left = clampX(rect.left + 16);
      cardStyle.top = Math.max(12, rect.top + 16);
    }
  } else {
    cardStyle.left = (vw - cardWidth) / 2;
    cardStyle.top = vh / 3;
  }

  return (
    <div className={styles.tour} role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {rect ? <div className={styles.tourSpot} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} /> : <div className={styles.tourDim} />}
      <div className={styles.tourCard} style={cardStyle}>
        <b id="tour-title">{current.title}</b>
        <p>{current.text}</p>
        <div className={styles.tourFoot}>
          <button type="button" className={styles.tourSkip} onClick={close}>
            Saltar visita
          </button>
          <span className={styles.tourCount}>
            {step + 1} de {STEPS.length}
          </span>
          {step > 0 ? (
            <button type="button" onClick={() => setStep(step - 1)}>
              Anterior
            </button>
          ) : null}
          <button type="button" className={styles.tourNext} onClick={() => (last ? close() : setStep(step + 1))} autoFocus>
            {last ? 'Concluir' : 'Seguinte'}
          </button>
        </div>
      </div>
    </div>
  );
}
