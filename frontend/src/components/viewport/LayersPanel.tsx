import { useEffect, useState } from 'react';

import type { WaterPointKind } from '@/api';
import { LegendDots, SegmentedControl } from '@/components/common/SegmentedControl';
import { windColorCss } from '@/domain/colors';
import { useEngine, useWorld } from '@/engine/EngineContext';
import { PLAN_KINDS, type PlanKind } from '@/engine/layers/planLayer';
import { WATER_KINDS } from '@/engine/layers/waterLayer';
import type { ViewModeName } from '@/engine/viewMode';
import { useAppStore } from '@/store/appStore';
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

/** 3D/2D switch, base-layer switch, smoke overlay toggle, the legend for the active base layer, and water-point filters. */
export function LayersPanel() {
  return (
    <div className={styles.layers}>
      <div className={styles.layerControls}>
        <ViewModeSwitch />
        <BaseLayerSwitch />
      </div>
      <div className={styles.layerPanel}>
        <WaterBox />
        <OverlayBox />
        <PlanBox />
        <BaseLayerLegend />
      </div>
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

function OverlayBox() {
  const smokeEnabled = useAppStore((s) => s.smokeEnabled);
  const setSmokeEnabled = useAppStore((s) => s.setSmokeEnabled);
  const windEnabled = useAppStore((s) => s.windEnabled);
  const setWindEnabled = useAppStore((s) => s.setWindEnabled);
  const windDensity = useAppStore((s) => s.windDensity);
  const setWindDensity = useAppStore((s) => s.setWindDensity);
  return (
    <section className={styles.layerSection}>
      <div className={styles.sectionHead}>
        <b className={styles.sectionTitle}>Sobreposições</b>
        <span className={styles.sectionMeta}>camadas</span>
      </div>
      <div className={styles.toggleGroup}>
        <label className={styles.overlayRow}>
          <input type="checkbox" checked={smokeEnabled} onChange={(e) => setSmokeEnabled(e.target.checked)} />
          <span>Fumo</span>
        </label>
        {smokeEnabled ? (
          <div className={styles.overlayLegend}>
            <LegendDots items={SMOKE_LEGEND.map((label, i) => ({ label, color: `rgba(${190 - i * 38},${185 - i * 41},${175 - i * 41},${0.25 + i * 0.22})` }))} />
            <span className={styles.legendNote}>estradas sem visibilidade a castanho</span>
          </div>
        ) : null}
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
  return (
    <div className={styles.box}>
      <b>Plano {plan.variant ?? ''} dos agentes</b>
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
      <span className="mut">passe o rato sobre um elemento para ver a ação e a razão do agente</span>
    </div>
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
