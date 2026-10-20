import { useEffect, useState } from 'react';

import type { WaterPointKind } from '@/api';
import { LegendDots, SegmentedControl } from '@/components/common/SegmentedControl';
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

/** 3D/2D switch, base-layer switch, smoke overlay toggle, the legend for the active base layer, and water-point filters. */
export function LayersPanel() {
  return (
    <div className={styles.layers}>
      <ViewModeSwitch />
      <BaseLayerSwitch />
      <OverlayBox />
      <PlanBox />
      <BaseLayerLegend />
      <WaterBox />
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
  return (
    <div className={styles.box}>
      <label className={styles.overlayRow}>
        <input type="checkbox" checked={smokeEnabled} onChange={(e) => setSmokeEnabled(e.target.checked)} /> Fumo
      </label>
      {smokeEnabled ? (
        <div className={styles.overlayLegend}>
          <LegendDots items={SMOKE_LEGEND.map((label, i) => ({ label, color: `rgba(${190 - i * 38},${185 - i * 41},${175 - i * 41},${0.25 + i * 0.22})` }))} />
          <span className="mut">estradas sem visibilidade a castanho</span>
        </div>
      ) : null}
    </div>
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
      <div className={styles.box}>
        <b>{world?.terrain.sourceLabel ?? 'Satélite'}</b>
        <br />
        <span className="mut">árvores, plantações, caminhos e edifícios visíveis</span>
      </div>
    );
  }
  if (baseLayer === 'topo') {
    const { min, max } = data.location.elevationM ?? {};
    return (
      <div className={styles.box}>
        <b>Topografia</b>
        <div className={styles.ramp} style={{ background: ELEVATION_GRADIENT }} />
        <div className={styles.rampLabels}>
          <span>{min != null ? `${Math.round(min)} m` : ''}</span>
          <span>{max != null ? `${Math.round(max)} m` : ''}</span>
        </div>
        <span className="mut">curvas de nível de 20 m (mestras de 100 m) e relevo sombreado</span>
      </div>
    );
  }
  const rows = data.vegetation.classes
    .filter((k) => (k.sharePct ?? 0) >= 0.05)
    .sort((a, b) => (b.sharePct ?? 0) - (a.sharePct ?? 0));
  return (
    <div className={styles.box}>
      <b>Tipos de árvores e vegetação</b>
      {rows.map((k) => (
        <div className={styles.lg} key={k.id}>
          <i style={{ background: k.color }} />
          <span>{k.label}</span>
          <small>{(k.sharePct ?? 0).toFixed(1)}%</small>
        </div>
      ))}
      <span className="mut">eucaliptal por fenologia (Sentinel-2): provável, sem verdade de terreno</span>
    </div>
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

  return (
    <div className={styles.box}>
      <b>Água para combate</b>
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
      <span className="mut">{trucks} acessíveis a autotanque · passe o rato sobre um ponto para ver o detalhe</span>
    </div>
  );
}
