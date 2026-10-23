import { useEffect, useState } from 'react';

import type { FacilityKind, WaterPointKind } from '@/api';
import { Icon } from '@/components/common/Icon';
import { LegendDots, SegmentedControl } from '@/components/common/SegmentedControl';
import { windColorCss } from '@/domain/colors';
import { useEngine, useEngineContext, useWorld } from '@/engine/EngineContext';
import { FACILITY_KIND_NAME, facilityColor } from '@/engine/layers/assetLayer';
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

const VISUAL_ONLY = 'Ilustrativo: não entra na simulação.';

/** A small "i" that explains on hover (or focus) instead of a line of text under the control. */
function InfoTip({ text }: { text: string }) {
  return (
    <span className={styles.infoTip} title={text} aria-label={text} role="img" tabIndex={0}>
      <Icon name="info" size={12} />
    </span>
  );
}

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
          <FacilitiesBox />
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
        <b className={styles.sectionTitle}>
          Cidade 3D{' '}
          <InfoTip
            text={
              live
                ? `Ao vivo: a chave não é guardada; cada ligação é uma sessão paga (~0,006 $), hoje ${budget.used}/${budget.limit}.`
                : `${manifest?.source ?? 'Cópia local'} · ${((manifest?.bytes ?? 0) / 1e9).toFixed(1)} GB · ${manifest ? new Date(manifest.fetchedAt).toLocaleDateString('pt-PT') : ''}. Menos nítida de perto.`
            }
          />
        </b>
        <span className={styles.sectionMeta}>{cityEnabled ? (live ? 'ao vivo' : 'cópia local') : 'desligada'}</span>
      </div>
      {manifest && !cityEnabled ? (
        <div className={styles.citySeg}>
          <SegmentedControl
            options={[
              { value: 'live', label: 'Ao vivo' },
              { value: 'local', label: 'Cópia local' },
            ]}
            value={live ? 'live' : 'local'}
            onChange={(v) => {
              setCityEnabled(false);
              setCitySource(v as CitySource);
            }}
          />
        </div>
      ) : null}
      {cityEnabled ? (
        <>
          <label className={styles.cityRow}>
            <span className={styles.densityLabel}>
              Altura {trim > 0 ? '+' : ''}
              {trim} m <InfoTip text="Ajuste se os edifícios flutuam ou afundam no terreno." />
            </span>
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
          <button className={styles.cityButton} onClick={() => setCityEnabled(false)}>
            Desligar
          </button>
        </>
      ) : live ? (
        <div className={styles.cityConnect}>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Chave Google Map Tiles"
            value={typedKey}
            onChange={(e) => setTypedKey(e.target.value)}
            className={styles.cityKey}
          />
          <button className="primary" disabled={!typedKey.trim() || budget.used >= budget.limit} onClick={switchOn}>
            Ligar
          </button>
        </div>
      ) : (
        <button className={`primary ${styles.cityButton}`} onClick={switchOn}>
          Ligar cidade 3D
        </button>
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
  const thunderEnabled = useAppStore((s) => s.thunderEnabled);
  const setThunderEnabled = useAppStore((s) => s.setThunderEnabled);
  const windDensity = useAppStore((s) => s.windDensity);
  const setWindDensity = useAppStore((s) => s.setWindDensity);
  const { ensembleEnabled, setEnsembleEnabled } = useEngineContext();
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
          <InfoTip text={`${VISUAL_ONLY} Estradas sem visibilidade a castanho.`} />
        </label>
        {smokeEnabled ? (
          <div className={styles.overlayLegend}>
            <LegendDots items={SMOKE_LEGEND.map((label, i) => ({ label, color: `rgba(${190 - i * 38},${185 - i * 41},${175 - i * 41},${0.25 + i * 0.22})` }))} />
          </div>
        ) : null}
      </div>
      <HousesToggle />
      <div className={styles.toggleGroup}>
        <label className={styles.overlayRow}>
          <input type="checkbox" checked={aftermathEnabled} onChange={(e) => setAftermathEnabled(e.target.checked)} />
          <span>Rescaldo</span>
          <InfoTip text={`Brasas, cinza e fumo depois das chamas. ${VISUAL_ONLY}`} />
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
          </div>
        ) : null}
      </div>
      <div className={styles.toggleGroup}>
        <div className={styles.overlayRow}>
          <label className={styles.overlayLabel}>
            <input type="checkbox" checked={cloudsEnabled} onChange={(e) => setCloudsEnabled(e.target.checked)} />
            <span>Nuvens 3D</span>
          </label>
          {cloudsEnabled ? (
            <button
              type="button"
              className={`${styles.soundToggle} ${thunderEnabled ? styles.soundToggleOn : ''}`}
              onClick={() => setThunderEnabled(!thunderEnabled)}
              aria-pressed={thunderEnabled}
              title={thunderEnabled ? 'Som de trovão ligado (clique para silenciar). Começa após o primeiro clique na página.' : 'Ligar o som de trovão'}
            >
              <Icon name={thunderEnabled ? 'sound' : 'soundOff'} size={13} />
              <span>Trovão</span>
            </button>
          ) : null}
          <InfoTip text={`Trovoada com relâmpagos e rajadas. ${VISUAL_ONLY}`} />
        </div>
      </div>
      <div className={styles.toggleGroup}>
        <label className={styles.overlayRow}>
          <input type="checkbox" checked={ensembleEnabled} onChange={(e) => setEnsembleEnabled(e.target.checked)} />
          <span>Melhor e pior cenário</span>
          <InfoTip text="Até onde o fogo chega no melhor e no pior caso, entre várias simulações com pequenas variações." />
        </label>
        {ensembleEnabled ? (
          <div className={styles.overlayLegend}>
            {/* the p10 (optimistic) dashed ring and the p90 (pessimistic) translucent area, in ensembleLayer's colours */}
            <div className={styles.rangeLegend}>
              <span>
                <i className={styles.swatchBest} /> melhor caso
              </span>
              <span>
                <i className={styles.swatchWorst} /> pior caso
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** The yellow squares: one dot per building. Turning them off only hides the dots; the plan's crowds, rings and water stay. */
function HousesToggle() {
  const world = useWorld();
  const [, redraw] = useState(0);
  if (!world) return null;
  return (
    <div className={styles.toggleGroup}>
      <label className={styles.overlayRow}>
        <input
          type="checkbox"
          checked={world.people.housesVisible}
          onChange={(e) => {
            world.people.setHousesVisible(e.target.checked);
            redraw((n) => n + 1);
          }}
        />
        <span>Casas</span>
        <InfoTip text="Um ponto por edifício: bege intacto, laranja a arder, escuro depois de arder. Esconder não altera a simulação." />
      </label>
    </div>
  );
}

/** Legend and per-kind switches for the agents' plan drawn on the map (only while a plan's simulation is on screen). */
function PlanBox() {
  const world = useWorld();
  const plan = useAppStore((s) => s.activePlan);
  const [, redraw] = useState(0);
  const [open, setOpen] = useState(false); // closed by default: the legend is long and the map is what matters

  useEffect(() => world?.plan.subscribe(() => redraw((n) => n + 1)), [world]);

  if (!world || !plan) return null;
  const kinds = (Object.keys(PLAN_KINDS) as PlanKind[]).filter((k) => world.plan.counts[k]);
  if (!kinds.length) return null;
  const total = kinds.reduce((sum, k) => sum + (world.plan.counts[k] ?? 0), 0);
  const label = open ? 'Esconder a legenda do plano' : 'Mostrar a legenda do plano';
  return (
    <section className={styles.layerSection}>
      <div className={`${styles.sectionHead} ${open ? '' : styles.sectionHeadClosed}`}>
        <b className={styles.sectionTitle}>
          Plano {plan.variant ?? ''} dos agentes <InfoTip text="Passe o rato sobre um elemento para ver a ação e a razão do agente." />
        </b>
        <span className={styles.sectionMeta}>{total} elementos</span>
        <button type="button" className={styles.sectionToggle} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={label} title={label}>
          {open ? '−' : '+'}
        </button>
      </div>
      {open ? (
        <>
      <label className={styles.overlayRow}>
        <input type="checkbox" checked={world.plan.isOnlyActive()} onChange={(e) => world.plan.setOnlyActive(e.target.checked)} />
        <span>Só o que decorre agora</span>
        <InfoTip text="Mostra só as ações em curso no minuto da linha do tempo." />
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
        </>
      ) : null}
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
      </section>
    );
  }
  if (baseLayer === 'topo') {
    const { min, max } = data.location.elevationM ?? {};
    return (
      <section className={styles.layerSection}>
        <div className={styles.sectionHead}>
          <b className={styles.sectionTitle}>
            Topografia <InfoTip text="Curvas de nível de 20 m (mestras de 100 m) e relevo sombreado." />
          </b>
          <span className={styles.sectionMeta}>elevação</span>
        </div>
        <div className={styles.ramp} style={{ background: ELEVATION_GRADIENT }} />
        <div className={styles.rampLabels}>
          <span>{min != null ? `${Math.round(min)} m` : ''}</span>
          <span>{max != null ? `${Math.round(max)} m` : ''}</span>
        </div>
      </section>
    );
  }
  const rows = data.vegetation.classes
    .filter((k) => (k.sharePct ?? 0) >= 0.05)
    .sort((a, b) => (b.sharePct ?? 0) - (a.sharePct ?? 0));
  return (
    <section className={styles.layerSection}>
      <div className={styles.sectionHead}>
        <b className={styles.sectionTitle}>
          Vegetação <InfoTip text="Eucaliptal estimado por fenologia (Sentinel-2): provável, sem confirmação no terreno." />
        </b>
        <span className={styles.sectionMeta}>{rows.length} classes</span>
      </div>
      {rows.map((k) => (
        <div className={styles.lg} key={k.id}>
          <i style={{ background: k.color }} />
          <span>{k.label}</span>
          <small>{(k.sharePct ?? 0).toFixed(1)}%</small>
        </div>
      ))}
    </section>
  );
}

/** Per-kind switches for the facility icons on the map (fire stations, schools, shelters, ...), closed by default like the water box. */
function FacilitiesBox() {
  const world = useWorld();
  const data = useAppStore((s) => s.data);
  const [, redraw] = useState(0);
  const [open, setOpen] = useState(false);

  if (!world || !data) return null;
  const counts = world.assets.counts;
  const kinds = (Object.keys(FACILITY_KIND_NAME) as FacilityKind[]).filter((k) => counts[k]);
  if (!kinds.length) return null;
  const shown = kinds.filter((k) => world.assets.isVisible(k)).length;
  const label = open ? 'Esconder os tipos de instalação' : 'Mostrar os tipos de instalação';
  const setAll = (on: boolean) => {
    kinds.forEach((k) => world.assets.setVisible(k, on));
    redraw((n) => n + 1);
  };
  return (
    <section className={styles.layerSection}>
      <div className={`${styles.sectionHead} ${open ? '' : styles.sectionHeadClosed}`}>
        <b className={styles.sectionTitle}>
          Instalações <InfoTip text="Escolha que ícones aparecem no mapa. Não altera a simulação." />
        </b>
        <span className={styles.sectionMeta}>
          {shown}/{kinds.length} tipos
        </span>
        <button type="button" className={styles.sectionToggle} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={label} title={label}>
          {open ? '−' : '+'}
        </button>
      </div>
      {open ? (
        <>
          {kinds.map((k) => (
            <label className={styles.waterKind} key={k}>
              <input
                type="checkbox"
                checked={world.assets.isVisible(k)}
                onChange={(e) => {
                  world.assets.setVisible(k, e.target.checked);
                  redraw((n) => n + 1);
                }}
              />
              <i style={{ background: facilityColor(k) }} />
              <span>{FACILITY_KIND_NAME[k]}</span>
              <small>{counts[k]}</small>
            </label>
          ))}
          <div className={styles.densityRow}>
            <button type="button" className={styles.cityButton} onClick={() => setAll(true)}>
              Todas
            </button>
            <button type="button" className={styles.cityButton} onClick={() => setAll(false)}>
              Nenhuma
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function WaterBox() {
  const world = useWorld();
  const data = useAppStore((s) => s.data);
  const [visible, setVisible] = useState<Partial<Record<WaterPointKind, boolean>>>({});
  const [open, setOpen] = useState(false); // closed by default, like the plan's legend

  useEffect(() => {
    setVisible(Object.fromEntries((Object.keys(WATER_KINDS) as WaterPointKind[]).map((k) => [k, WATER_KINDS[k].on])));
  }, [world]);

  if (!world || !data) return null;
  const counts = world.water.counts;
  const kinds = (Object.keys(WATER_KINDS) as WaterPointKind[]).filter((k) => counts[k]);
  if (!kinds.length) return null;
  const trucks = data.waterPoints.filter((p) => p.truckAccessible).length;
  const total = kinds.reduce((sum, k) => sum + (counts[k] ?? 0), 0);

  const label = open ? 'Esconder os tipos de ponto de água' : 'Mostrar os tipos de ponto de água';
  return (
    <section className={styles.layerSection}>
      <div className={`${styles.sectionHead} ${open ? '' : styles.sectionHeadClosed}`}>
        <b className={styles.sectionTitle}>
          Água para combate <InfoTip text={`${trucks} acessíveis a autotanque. Passe o rato sobre um ponto para ver o detalhe.`} />
        </b>
        <span className={styles.sectionMeta}>{total} pontos</span>
        <button type="button" className={styles.sectionToggle} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={label} title={label}>
          {open ? '−' : '+'}
        </button>
      </div>
      {open && kinds.map((k) => (
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
    </section>
  );
}
