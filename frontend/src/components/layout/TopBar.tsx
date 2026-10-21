import { useSimulationActions } from '@/hooks/useSimulationActions';
import { formatDateTime } from '@/domain/weather';
import { useAppStore } from '@/store/appStore';
import type { PanelTab } from '@/store/types';

import styles from './layout.module.css';

const TABS: { value: PanelTab; label: string }[] = [
  { value: 'incident', label: 'Incidente' },
  { value: 'plans', label: 'Planos' },
  { value: 'roads', label: 'Estradas' },
  { value: 'assets', label: 'Meios' },
  { value: 'weather', label: 'Meteo' },
  { value: 'resources', label: 'Recursos' },
];

/** Brand, location/scenario pickers, the simulated period, the panel tabs and the API docs link. */
export function TopBar() {
  const locations = useAppStore((s) => s.locations);
  const locationId = useAppStore((s) => s.locationId);
  const scenarios = useAppStore((s) => s.data?.scenarios ?? []);
  const scenarioId = useAppStore((s) => s.scenarioId);
  const run = useAppStore((s) => s.run);
  const activePlan = useAppStore((s) => s.activePlan);
  const baseSimulationId = useAppStore((s) => s.baseSimulationId);
  const t = useAppStore((s) => s.t);
  const tab = useAppStore((s) => s.tab);
  const setTab = useAppStore((s) => s.setTab);
  const setHelpOpen = useAppStore((s) => s.setHelpOpen);
  const roadsCut = useAppStore((s) => s.run?.impact?.at(s.t).cut.length ?? 0);
  const facilityCount = useAppStore((s) => s.data?.facilities.length ?? 0);
  const { selectScenario } = useSimulationActions();

  const badge = (tabName: PanelTab) => (tabName === 'roads' ? roadsCut : tabName === 'assets' ? facilityCount : null);

  const scenarioName = scenarios.find((s) => s.id === scenarioId)?.name ?? (scenarioId === 'custom' ? 'Cenário personalizado' : '—');
  const simulation = run?.simulation;
  const focusLabel = simulation?.kind === 'what_if'
    ? `Plano ${activePlan?.variant ?? simulation.planId?.slice(0, 8) ?? '—'}`
    : 'Base (sem resposta)';
  const focusId = simulation?.id ?? baseSimulationId;

  return (
    <header className={styles.top}>
      <div className={styles.brand}>
        FireTrace <small>Coordenação de resposta a incêndios rurais</small>
      </div>
      <div className={styles.selects}>
        <select
          title="Local"
          value={locationId ?? ''}
          onChange={(e) => {
            window.location.search = `?loc=${e.target.value}`;
          }}
        >
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <select title="Cenário" value={scenarioId ?? ''} onChange={(e) => void selectScenario(e.target.value)}>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          <option value="custom">Cenário personalizado…</option>
        </select>
      </div>
      <div className={`mut ${styles.period}`}>
        {run ? `${formatDateTime(run.startMs)} → ${formatDateTime(run.startMs + run.durationMinutes * 60000)}` : ''}
      </div>
      <div
        className={styles.focusChip}
        title={focusId ? `Simulação ${focusId} · minuto ${t}` : 'Nenhuma simulação no mapa'}
      >
        <span className={styles.focusScenario}>{scenarioName}</span>
        <span className={styles.focusSep}>·</span>
        <b>{focusLabel}</b>
        {focusId ? (
          <>
            <span className={styles.focusSep}>·</span>
            <code>{focusId}</code>
          </>
        ) : null}
        <span className={styles.focusSep}>·</span>
        <span>T+{t} min</span>
      </div>
      <nav className={styles.tabs}>
        {TABS.map((t) => (
          <button key={t.value} className={tab === t.value ? 'on' : ''} onClick={() => setTab(t.value)}>
            {t.label}
            {badge(t.value) !== null ? <span className={styles.badge}>{badge(t.value)}</span> : null}
          </button>
        ))}
      </nav>
      <div className={styles.spacer} />
      <button className={styles.helpLink} onClick={() => setHelpOpen(true)} title="Atalhos de teclado (?)">
        Atalhos
      </button>
      <a className={styles.apiLink} href="/swagger" target="_blank" rel="noopener noreferrer" title="Documentação interativa da API (Swagger)">
        API
      </a>
    </header>
  );
}
