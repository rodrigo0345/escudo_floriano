import { useEffect, useState } from 'react';

import type { WaterPointKind } from '@/api';
import { LegendDots, SegmentedControl } from '@/components/common/SegmentedControl';
import { windColorCss } from '@/domain/colors';
import { useEngine, useWorld } from '@/engine/EngineContext';
import { PLAN_KINDS, type PlanKind } from '@/engine/layers/planLayer';
import { WATER_KINDS } from '@/engine/layers/waterLayer';
import type { ViewModeName } from '@/engine/viewMode';
import { useAppStore } from '@/store/appStore';
import { liveBudget, type CityManifest, type CitySource } from '@/engine/layers/photorealLayer';
import type { BaseLayer } from '@/store/types';

import styles from './viewport.module.css';

const BASE_LAYERS: { value: BaseLayer; label: string }[] = [
  { value: 'satellite', label: 'Satélite' },
  { value: 'topo', label: 'Topográfico' },
  { value: 'species', label: 'Tipos de árvores' },
];
const VIEW_MODES: { value: ViewModeName; label: string }[] = [
  { value: '3d', label: '3D' },
  { value: '2d', label: '2D' },
];
const ELEVATION_GRADIENT = 'linear-gradient(90deg,#669e66,#9ec273,#dbd68c,#cca673,#ad8c73,#ebe6e0)';
const SMOKE_LEGEND = ['neblina', 'reduzida', 'fraca', 'densa'];
const WIND_LEGEND = [5, 15, 30, 50].map((kmh) => ({ label: `${kmh} km/h`, color: windColorCss(kmh) }));

const OPEN_KEY = 'firetrace.layersOpen';

/** Whether the layers panel was left open last time; closed by default so the map has the room (storage can be blocked: then closed). */
function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** 3D/2D switch, base-layer switch, and a "Camadas" button that opens the panel: smoke, wind and plan overlays, the legend for the active base layer, and water-point filters. */
export function LayersPanel() {
  const [open, setOpen] = useState(readOpen);
  const toggle = () =>
    setOpen((was) => {
      try {
        window.localStorage.setItem(OPEN_KEY, was ? '0' : '1');
      } catch {
        /* a blocked storage only means the choice is not remembered */
      }
      return !was;
    });

  return (
    <div className={styles.layers}>
      <div className={styles.layerControls}>
        <ViewModeSwitch />
        <BaseLayerSwitch />
        <button type="button" className={`${styles.layersToggle} ${open ? styles.layersToggleOn : ''}`} onClick={toggle} aria-expanded={open} title={open ? 'Esconder as camadas' : 'Mostrar as camadas'}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3 3 8l9 5 9-5-9-5Z" />
            <path d="m3 12 9 5 9-5" />
            <path d="m3 16 9 5 9-5" />
          </svg>
          Camadas
        </button>
      </div>
      {open ? (
        <div className={styles.layerPanel}>
          <CityBox />
          <WaterBox />
          <OverlayBox />
          <PlanBox />
          <BaseLayerLegend />
        </div>
      ) : null}
    </div>
  );
}

function ViewModeSwitch() {
  const engine = useEngine();
  const setHint = useAppStore((s) => s.setHint);
  const [mode, setMode] = useState<ViewModeName>('3d');

  useEffect(() => {
    if (!engine) return;
    return engine.viewMode.onChange((m) => {
      setMode(m);
      setHint(m === '2d' ? 'Vista 2D: arraste para deslocar, roda para zoom' : '');
      if (m === '2d') setTimeout(() => useAppStore.getState().setHint(''), 3000);
    });
  }, [engine, setHint]);

  return <SegmentedControl title="Modo de navegação" options={VIEW_MODES} value={mode} onChange={(m) => engine?.viewMode.set(m)} />;
}

function BaseLayerSwitch() {
  const baseLayer = useAppStore((s) => s.baseLayer);
  const setBaseLayer = useAppStore((s) => s.setBaseLayer);
  return <SegmentedControl options={BASE_LAYERS} value={baseLayer} onChange={setBaseLayer} />;
}

/**
 * The photoreal 3D city. It is offered only when local tiles exist (saved once with `tools/fetch_tiles3d.py`); it is off until the operator turns it on, and without tiles
 * nothing is shown and nothing is requested. Its provider's credit is shown on the map while it is on.
 */
function CityBox() {
  const world = useWorld();
  const cityEnabled = useAppStore((s) => s.cityEnabled);
  const setCityEnabled = useAppStore((s) => s.setCityEnabled);
  const citySource = useAppStore((s) => s.citySource);
  const setCitySource = useAppStore((s) => s.setCitySource);
  const setCityKey = useAppStore((s) => s.setCityKey);
  const [manifest, setManifest] = useState<CityManifest | null | undefined>(undefined);
  const [typedKey, setTypedKey] = useState('');
  const [trim, setTrim] = useState(0);
  const budget = liveBudget();

  useEffect(() => {
    if (!world) return;
    let cancelled = false;
    setManifest(undefined);
    void world.city.probe().then((m) => !cancelled && setManifest(m));
    return () => {
      cancelled = true;
    };
  }, [world]);

  if (!world || manifest === undefined) return null;
  const live = citySource === 'live' || !manifest;
  const switchOn = () => {
    setCitySource(live ? 'live' : 'local');
    if (live) setCityKey(typedKey.trim());
    setCityEnabled(true);
  };
  return (
    <section className={styles.layerSection}>
      <div className={styles.sectionHead}>
        <b className={styles.sectionTitle}>Cidade 3D</b>
        <span className={styles.sectionMeta}>{cityEnabled ? (live ? 'ao vivo' : 'tiles locais') : 'desligada'}</span>
      </div>
      {manifest ? (
        <SegmentedControl
          options={[
            { value: 'live', label: 'Ao vivo (Google)' },
            { value: 'local', label: 'Cópia local' },
          ]}
          value={live ? 'live' : 'local'}
          onChange={(v) => {
            setCityEnabled(false);
            setCitySource(v as CitySource);
          }}
        />
      ) : null}
      {cityEnabled ? (
        <>
          <label className={styles.overlayRow}>
            <input type="checkbox" checked onChange={() => setCityEnabled(false)} />
            <span>Cidade 3D ligada (desligar)</span>
          </label>
          <label className={styles.cityRow}>
            <span className={styles.densityLabel}>Altura {trim > 0 ? '+' : ''}{trim} m</span>
            <input
              type="range"
              className={styles.densitySlider}
              min={-40}
              max={40}
              step={1}
              value={trim}
              onChange={(e) => {
                setTrim(+e.target.value);
                world.city.setHeightTrim(+e.target.value);
              }}
            />
          </label>
          <span className={styles.sectionNote}>se os edifícios flutuam ou afundam no terreno, ajuste a altura</span>
        </>
      ) : live ? (
        <>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Chave Google Map Tiles (não é guardada)"
            value={typedKey}
            onChange={(e) => setTypedKey(e.target.value)}
            className={styles.cityKey}
          />
          <button className="primary" disabled={!typedKey.trim() || budget.used >= budget.limit} onClick={switchOn}>
            Ligar cidade 3D
          </button>
          <span className={styles.sectionNote}>
            A chave fica só em memória e desaparece ao desligar ou recarregar. Cada ligação abre uma sessão paga (cerca de 0,006 $); hoje {budget.used}/{budget.limit}.
            Os tiles carregam por zonas e ficam mais nítidos ao aproximar.
          </span>
        </>
      ) : (
        <>
          <button className="primary" onClick={switchOn}>
            Ligar cidade 3D (cópia local)
          </button>
          <span className={styles.sectionNote}>
            {manifest?.source} · {((manifest?.bytes ?? 0) / 1e9).toFixed(1)} GB · obtido a {manifest ? new Date(manifest.fetchedAt).toLocaleDateString('pt-PT') : ''}. Menos nítida de perto.
          </span>
        </>
      )}
    </section>
  );
}

function OverlayBox() {
  const smokeEnabled = useAppStore((s) => s.smokeEnabled);
  const setSmokeEnabled = useAppStore((s) => s.setSmokeEnabled);
  const aftermathEnabled = useAppStore((s) => s.aftermathEnabled);
  const setAftermathEnabled = useAppStore((s) => s.setAftermathEnabled);
  const windEnabled = useAppStore((s) => s.windEnabled);
  const setWindEnabled = useAppStore((s) => s.setWindEnabled);
  const cloudsEnabled = useAppStore((s) => s.cloudsEnabled);
  const setCloudsEnabled = useAppStore((s) => s.setCloudsEnabled);
  const windDensity = useAppStore((s) => s.windDensity);
  const setWindDensity = useAppStore((s) => s.setWindDensity);
  return (
    <section className={styles.layerSection}>
      <div className={styles.sectionHead}>
        <b className={styles.sectionTitle}>Sobreposições</b>
        <span className={styles.sectionMeta}>camadas</span>
      </div>
      <div className={styles.toggleGroup}>
        <label className={styles.overlayRow} title="Aproximação visual ilustrativa gerada por partículas GPU; sem massa nem dinâmica real sobre a propagação do fogo">
          <input type="checkbox" checked={smokeEnabled} onChange={(e) => setSmokeEnabled(e.target.checked)} />
          <span>Fumo</span>
          <span className={styles.disclaimerTag} title="Aproximação visual (partículas GPU)">estimativa visual</span>
        </label>
        {smokeEnabled ? (
          <div className={styles.overlayLegend}>
            <LegendDots items={SMOKE_LEGEND.map((label, i) => ({ label, color: `rgba(${190 - i * 38},${185 - i * 41},${175 - i * 41},${0.25 + i * 0.22})` }))} />
            <span className={styles.legendNote}>estradas sem visibilidade a castanho</span>
          </div>
        ) : null}
      </div>
      <div className={styles.toggleGroup}>
        <label className={styles.overlayRow} title="Depois das chamas: fumo fino na floresta, brasas e fumo leve no mato, cinza levada pelo vento nos campos, colunas de fumo escuro nas casas. Desvanece com o tempo.">
          <input type="checkbox" checked={aftermathEnabled} onChange={(e) => setAftermathEnabled(e.target.checked)} />
          <span>Rescaldo</span>
          <span className={styles.disclaimerTag} title="Aproximação visual (partículas GPU)">estimativa visual</span>
        </label>
      </div>
      <div className={styles.toggleGroup}>
        <label className={styles.overlayRow}>
          <input type="checkbox" checked={windEnabled} onChange={(e) => setWindEnabled(e.target.checked)} />
          <span>Vento 3D</span>
        </label>
        {windEnabled ? (
          <div className={styles.overlayLegend}>
            <LegendDots items={WIND_LEGEND} />
            <div className={styles.densityRow}>
              <span className={styles.densityLabel}>Densidade</span>
              <input
                type="range"
                className={styles.densitySlider}
                min={20}
                max={100}
                step={5}
                value={windDensity}
                onChange={(e) => setWindDensity(+e.target.value)}
                aria-label="Densidade das setas de vento"
              />
              <span className={styles.densityValue}>{windDensity}%</span>
            </div>
            <span className={styles.legendNote}>campo com concentração e deflexão junto ao fogo</span>
          </div>
        ) : null}
      </div>
      <div className={styles.toggleGroup}>
        <label className={styles.overlayRow} title="Camada de nuvens 3D e cobertura nublada proporcional à meteorologia">
          <input type="checkbox" checked={cloudsEnabled} onChange={(e) => setCloudsEnabled(e.target.checked)} />
          <span>Nuvens 3D</span>
        </label>
      </div>
    </section>
  );
}

/** Legend and per-kind switches for the agents' plan drawn on the map (only while a plan's simulation is on screen). */
function PlanBox() {
  const world = useWorld();
  const plan = useAppStore((s) => s.activePlan);
  const [, redraw] = useState(0);

  useEffect(() => world?.plan.subscribe(() => redraw((n) => n + 1)), [world]);

  if (!world || !plan) return null;
  const kinds = (Object.keys(PLAN_KINDS) as PlanKind[]).filter((k) => world.plan.counts[k]);
  if (!kinds.length) return null;
  const total = kinds.reduce((sum, k) => sum + (world.plan.counts[k] ?? 0), 0);
  return (
    <section className={styles.layerSection}>
      <div className={styles.sectionHead}>
        <b className={styles.sectionTitle}>Plano {plan.variant ?? ''} dos agentes</b>
        <span className={styles.sectionMeta}>{total} elementos</span>
      </div>
      <label className={styles.waterKind}>
        <input type="checkbox" checked={world.plan.isOnlyActive()} onChange={(e) => world.plan.setOnlyActive(e.target.checked)} />
        <span>Só o que está a decorrer no minuto da linha do tempo</span>
      </label>
      {kinds.map((k) => (
        <label className={styles.waterKind} key={k}>
          <input
            type="checkbox"
            checked={world.plan.isVisible(k)}
            onChange={(e) => {
              world.plan.setVisible(k, e.target.checked);
              redraw((n) => n + 1);
            }}
          />
          <i style={{ background: PLAN_KINDS[k].color }} />
          <span>{PLAN_KINDS[k].label}</span>
          <small>{world.plan.counts[k]}</small>
        </label>
      ))}
      <span className={styles.sectionNote}>passe o rato sobre um elemento para ver a ação e a razão do agente</span>
    </section>
  );
}

function BaseLayerLegend() {
  const baseLayer = useAppStore((s) => s.baseLayer);
  const data = useAppStore((s) => s.data);
  const world = useWorld();
  if (!data) return null;

  if (baseLayer === 'satellite') {
    return (
      <section className={styles.layerSection}>
        <div className={styles.sectionHead}>
          <b className={styles.sectionTitle}>{world?.terrain.sourceLabel ?? 'Satélite'}</b>
          <span className={styles.sectionMeta}>base</span>
        </div>
        <span className={styles.sectionNote}>árvores, plantações, caminhos e edifícios visíveis</span>
      </section>
    );
  }
  if (baseLayer === 'topo') {
    const { min, max } = data.location.elevationM ?? {};
    return (
      <section className={styles.layerSection}>
        <div className={styles.sectionHead}>
          <b className={styles.sectionTitle}>Topografia</b>
          <span className={styles.sectionMeta}>elevação</span>
        </div>
        <div className={styles.ramp} style={{ background: ELEVATION_GRADIENT }} />
        <div className={styles.rampLabels}>
          <span>{min != null ? `${Math.round(min)} m` : ''}</span>
          <span>{max != null ? `${Math.round(max)} m` : ''}</span>
        </div>
        <span className={styles.sectionNote}>curvas de nível de 20 m (mestras de 100 m) e relevo sombreado</span>
      </section>
    );
  }
  const rows = data.vegetation.classes
    .filter((k) => (k.sharePct ?? 0) >= 0.05)
    .sort((a, b) => (b.sharePct ?? 0) - (a.sharePct ?? 0));
  return (
    <section className={styles.layerSection}>
      <div className={styles.sectionHead}>
        <b className={styles.sectionTitle}>Vegetação</b>
        <span className={styles.sectionMeta}>{rows.length} classes</span>
      </div>
      {rows.map((k) => (
        <div className={styles.lg} key={k.id}>
          <i style={{ background: k.color }} />
          <span>{k.label}</span>
          <small>{(k.sharePct ?? 0).toFixed(1)}%</small>
        </div>
      ))}
      <span className={styles.sectionNote}>eucaliptal por fenologia (Sentinel-2): provável, sem verdade de terreno</span>
    </section>
  );
}

function WaterBox() {
  const world = useWorld();
  const data = useAppStore((s) => s.data);
  const [visible, setVisible] = useState<Partial<Record<WaterPointKind, boolean>>>({});

  useEffect(() => {
    setVisible(Object.fromEntries((Object.keys(WATER_KINDS) as WaterPointKind[]).map((k) => [k, WATER_KINDS[k].on])));
  }, [world]);

  if (!world || !data) return null;
  const counts = world.water.counts;
  const kinds = (Object.keys(WATER_KINDS) as WaterPointKind[]).filter((k) => counts[k]);
  if (!kinds.length) return null;
  const trucks = data.waterPoints.filter((p) => p.truckAccessible).length;
  const total = kinds.reduce((sum, k) => sum + (counts[k] ?? 0), 0);

  return (
    <section className={styles.layerSection}>
      <div className={styles.sectionHead}>
        <b className={styles.sectionTitle}>Água para combate</b>
        <span className={styles.sectionMeta}>{total} pontos</span>
      </div>
      {kinds.map((k) => (
        <label className={styles.waterKind} key={k}>
          <input
            type="checkbox"
            checked={visible[k] ?? false}
            onChange={(e) => {
              world.water.setVisible(k, e.target.checked);
              setVisible((v) => ({ ...v, [k]: e.target.checked }));
            }}
          />
          <i style={{ background: WATER_KINDS[k].color }} />
          <span>{WATER_KINDS[k].label}</span>
          <small>{counts[k]}</small>
        </label>
      ))}
      <span className={styles.sectionNote}>{trucks} acessíveis a autotanque · passe o rato sobre um ponto para ver o detalhe</span>
    </section>
  );
}
