import { useEffect, useState, type ChangeEvent } from 'react';

import { weatherApi, type ValidationIssue, type WeatherSample } from '@/api';
import { Icon, WEATHER_EVENT_ICON } from '@/components/common/Icon';
import { SegmentedControl } from '@/components/common/SegmentedControl';
import { WindRosePicker } from '@/components/common/WindRosePicker';
import { ProgressBar } from '@/components/common/StatCard';
import { compass } from '@/domain/georef';
import {
  bearingDelta,
  buildPreviewRequest,
  buildSimulationRequest,
  createTimelineKeyframe,
  createTimelineRangeEvent,
  defaultFormValues,
  resizeCustomEvents,
  type CustomWeatherEventType,
  type SimulationFormValues,
  type TimelineKeyframe,
  type TimelineRangeEvent,
} from '@/domain/simulationForm';
import { useProviderBase } from '@/hooks/useProviderBase';
import { useSimulationActions } from '@/hooks/useSimulationActions';
import { useWorld } from '@/engine/EngineContext';
import { useAppStore } from '@/store/appStore';

import styles from './panels.module.css';
import { WeatherChart } from './WeatherChart';

const MEMBER_OPTIONS = [
  { value: 3, label: '3 · rápido' },
  { value: 6, label: '6' },
  { value: 12, label: '12 · normal' },
];

const round1 = (v: number) => Math.round(v * 10) / 10;

const EVENT_TYPE_LABEL: Record<CustomWeatherEventType, string> = {
  rain: 'Chuva',
  storm: 'Trovoada',
  clouds: 'Neblina',
  wind_shift: 'Vento',
  wind_scale: 'Vento ×',
  wind_set: 'Vento fixo',
  gust_burst: 'Rajada',
  front_passage: 'Frente',
  temperature_shift: 'Temperatura',
  humidity_shift: 'Humidade',
  heat_dry: 'Calor',
};

/** One-click run lengths; the minutes field below still takes any value up to the server's limit. */
const DURATION_PRESETS = [60, 180, 360, 720];

/** "Simulate with other weather": interactive range-based events, provider base, ignitions and ensemble. */
export function SimulationForm() {
  const run = useAppStore((s) => s.run);
  const locationId = useAppStore((s) => s.locationId);
  const data = useAppStore((s) => s.data);
  const ignitions = useAppStore((s) => s.ignitions);
  const pickIgnitionSlot = useAppStore((s) => s.pickIgnitionSlot);
  const job = useAppStore((s) => s.job);
  const progress = useAppStore((s) => s.progress);
  const limits = useAppStore((s) => s.capabilities?.limits);
  const storeCustomEvents = useAppStore((s) => s.customEvents);
  const storeKeyframes = useAppStore((s) => s.weatherKeyframes);
  const setCustomEvents = useAppStore((s) => s.setCustomEvents);
  const setWeatherKeyframes = useAppStore((s) => s.setWeatherKeyframes);
  const addIgnition = useAppStore((s) => s.addIgnition);
  const updateIgnition = useAppStore((s) => s.updateIgnition);
  const removeIgnition = useAppStore((s) => s.removeIgnition);
  const setIgnitions = useAppStore((s) => s.setIgnitions);
  const setPickIgnitionSlot = useAppStore((s) => s.setPickIgnitionSlot);
  const setHint = useAppStore((s) => s.setHint);
  const setScenario = useAppStore((s) => s.setScenario);
  const world = useWorld();
  const { runSimulation, cancelJob } = useSimulationActions();

  const [values, setValues] = useState<SimulationFormValues>(() => defaultFormValues(run));
  const [weatherTouched, setWeatherTouched] = useState(false);
  const [preview, setPreview] = useState<WeatherSample[] | null>(null);
  const [previewWarnings, setPreviewWarnings] = useState<ValidationIssue[]>([]);
  const [previewEvents, setPreviewEvents] = useState(0);
  const [previewKeyframes, setPreviewKeyframes] = useState(0);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const baseState = useProviderBase(run, locationId, values.start, values.duration);
  const base = baseState.base;
  const baseKey = locationId ? `${locationId}|${values.start}|${values.duration}` : null;

  const set = <K extends keyof SimulationFormValues>(key: K, value: SimulationFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));
  const setWeather = (
    key: 'windKmh' | 'windFromDeg' | 'humPct' | 'tempC' | 'precipitationMmH' | 'cloudCoverPct',
    value: number,
  ) => {
    setWeatherTouched(true);
    setPreview(null);
    setValues((v) => ({ ...v, [key]: value }));
  };
  const weatherNum =
    (key: 'windKmh' | 'windFromDeg' | 'humPct' | 'tempC' | 'precipitationMmH' | 'cloudCoverPct') =>
    (e: ChangeEvent<HTMLInputElement>) =>
      setWeather(key, e.target.value === '' ? 0 : +e.target.value);
  const baseForWindow = (start: string, duration: number) =>
    base && locationId && baseState.key === `${locationId}|${start}|${duration}` ? base : null;

  // Sync store custom events and curve points into form state
  useEffect(() => {
    setValues((v) => ({ ...v, customEvents: storeCustomEvents }));
  }, [storeCustomEvents]);
  useEffect(() => {
    setValues((v) => ({ ...v, keyframes: storeKeyframes }));
  }, [storeKeyframes]);

  // when a scenario's run loads, reset the form to that scenario's values
  useEffect(() => {
    if (!run) return;
    const defaults = defaultFormValues(run);
    const initial = defaultFormValues(run, baseForWindow(defaults.start, defaults.duration));
    initial.customEvents = storeCustomEvents;
    initial.keyframes = storeKeyframes;
    setValues(initial);
    setWeatherTouched(false);
    setPreview(null);
  }, [run?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // provider base arrives asynchronously: seed the absolute controls unless the operator already edited them
  useEffect(() => {
    if (!base || weatherTouched || values.mode !== 'provider' || baseState.key !== baseKey) return;
    setPreview(null);
    setValues((v) => ({
      ...v,
      windKmh: round1(base.windKmh),
      windFromDeg: Math.round(base.dirDeg),
      humPct: round1(base.humPct),
      tempC: round1(base.tempC),
    }));
  }, [base, baseKey, baseState.key, values.mode, weatherTouched]);

  // keep custom event windows, curve points and ignition delays inside the run duration
  useEffect(() => {
    setValues((v) => ({
      ...v,
      customEvents: resizeCustomEvents(v.customEvents, v.duration),
      keyframes: v.keyframes.map((k) => ({ ...k, minute: Math.min(v.duration, Math.max(0, k.minute)) })).sort((a, b) => a.minute - b.minute),
    }));
    const clamped = ignitions.map((ig, i) =>
      i > 0 ? { ...ig, timeOffsetMinutes: Math.min(ig.timeOffsetMinutes ?? 0, values.duration) } : ig,
    );
    if (clamped.some((ig, i) => ig.timeOffsetMinutes !== ignitions[i].timeOffsetMinutes)) setIgnitions(clamped);
  }, [values.duration]); // eslint-disable-line react-hooks/exhaustive-deps

  // adding/removing/moving an ignition in this panel updates the map markers immediately
  useEffect(() => {
    if (world) world.fire.setIgnitions(ignitions);
  }, [world, ignitions]);

  const busyByUser = !!job && !job.auto;
  const maxMembers = limits?.maxEnsembleMembers;
  const memberOptions = MEMBER_OPTIONS.filter((o) => !maxMembers || o.value <= maxMembers);
  const maxDuration = limits?.maxDurationMinutes ?? 720;
  const maxIgnitions = Math.min(2, limits?.maxIgnitions ?? 2);
  const windFactor = base && base.windKmh > 0.1 ? values.windKmh / base.windKmh : null;
  const dirShift = base ? bearingDelta(values.windFromDeg, base.dirDeg) : 0;
  const humShift = base ? values.humPct - base.humPct : 0;
  const tempShift = base ? values.tempC - base.tempC : 0;
  const baseReady = values.mode !== 'provider' || (!!base && baseState.key === baseKey);
  const requireBase = () => {
    if (baseReady) return true;
    setHint('A obter a meteorologia do provedor…');
    return false;
  };

  const applyResolved = (resolved: { samples?: WeatherSample[]; warnings?: ValidationIssue[]; events?: unknown[]; keyframes?: unknown[] }) => {
    setPreview(resolved.samples ?? []);
    setPreviewWarnings(resolved.warnings ?? []);
    setPreviewEvents(resolved.events?.length ?? 0);
    setPreviewKeyframes(resolved.keyframes?.length ?? 0);
  };

  // Every edit calls `POST /weather/resolve` (debounced) and redraws the chart: the preview is always what the engine will see.
  useEffect(() => {
    if (!locationId || !baseReady) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const resolved = await weatherApi.resolve(buildPreviewRequest(values, locationId, base));
        if (!cancelled) applyResolved(resolved);
      } catch (e) {
        if (!cancelled) setPreviewWarnings([{ severity: 'error', code: 'weather_preview_failed', message: (e as Error).message }]);
      }
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [values, locationId, baseReady, base, baseState.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPreview = async () => {
    if (!locationId || !requireBase()) return;
    try {
      applyResolved(await weatherApi.resolve(buildPreviewRequest(values, locationId, base)));
    } catch (e) {
      setHint(`Meteorologia: ${(e as Error).message}`);
    }
  };

  const onRun = () => {
    if (!locationId || !ignitions.length || !requireBase()) return;
    try {
      const request = buildSimulationRequest(values, locationId, ignitions, base);
      setScenario('custom');
      void runSimulation(request);
    } catch (e) {
      setHint(`Simulação: ${(e as Error).message}`);
    }
  };

  const addSecondIgnition = () => {
    if (ignitions.length >= maxIgnitions) return;
    const center = data?.location.weatherPoint ?? data?.location.center;
    const first = ignitions[0]?.position;
    const origin = first ?? center;
    if (!origin) return;
    addIgnition({
      position: { lat: origin.lat + 0.0025, lon: origin.lon + 0.0025 },
      label: 'Foco 2',
      timeOffsetMinutes: Math.min(45, Math.max(0, values.duration)),
    });
  };

  // Custom Range Event Handlers (Requirement 1 & 1.1)
  const addCustomRangeEvent = (type: CustomWeatherEventType) => {
    setPreview(null);
    const start = Math.min(Math.max(0, values.duration - 60), 60);
    const end = Math.min(values.duration, start + 60);
    const ev = createTimelineRangeEvent(type, start, end, values.duration);
    const next = [...values.customEvents, ev];
    setValues((v) => ({ ...v, customEvents: next }));
    setCustomEvents(next);
    setExpandedEventId(ev.id);
  };

  const updateCustomRangeEvent = (id: string, patch: Partial<TimelineRangeEvent>) => {
    setPreview(null);
    const next = values.customEvents.map((e) => (e.id === id ? { ...e, ...patch } : e));
    setValues((v) => ({ ...v, customEvents: next }));
    setCustomEvents(next);
  };

  const removeCustomRangeEvent = (id: string) => {
    setPreview(null);
    const next = values.customEvents.filter((e) => e.id !== id);
    setValues((v) => ({ ...v, customEvents: next }));
    setCustomEvents(next);
  };

  // Keyframe curve handlers: the timeline can also drag/edit them; this list keeps the numeric curve editable in the form.
  const addKeyframe = () => {
    const minute = Math.min(values.duration, Math.max(0, Math.round(values.duration / 2)));
    const kf = createTimelineKeyframe(minute, {
      windKmh: values.windKmh,
      windFromDeg: values.windFromDeg,
      tempC: values.tempC,
      humidityPct: values.humPct,
    });
    const next = [...values.keyframes, kf].sort((a, b) => a.minute - b.minute);
    setValues((v) => ({ ...v, keyframes: next }));
    setWeatherKeyframes(next);
  };

  const updateKeyframe = (id: string, patch: Partial<TimelineKeyframe>) => {
    const next = values.keyframes
      .map((k) => (k.id === id ? { ...k, ...patch } : k))
      .sort((a, b) => a.minute - b.minute);
    setValues((v) => ({ ...v, keyframes: next }));
    setWeatherKeyframes(next);
  };

  const removeKeyframe = (id: string) => {
    const next = values.keyframes.filter((k) => k.id !== id);
    setValues((v) => ({ ...v, keyframes: next }));
    setWeatherKeyframes(next);
  };

  return (
    <>
      <h3>Simular com outra meteorologia</h3>
      <div className={styles.form}>
        <div className={styles.two}>
          <label>
            Início (UTC)
            <input type="datetime-local" value={values.start} onChange={(e) => set('start', e.target.value)} />
          </label>
          <label>
            Duração (min)
            <input
              type="number"
              min={15}
              max={maxDuration}
              step={15}
              value={values.duration}
              onChange={(e) => set('duration', e.target.value === '' ? 0 : Math.min(maxDuration, +e.target.value))}
              onBlur={() => set('duration', Math.max(15, Math.min(maxDuration, values.duration)))}
            />
          </label>
        </div>
        <SegmentedControl
          title="Duração da simulação"
          options={DURATION_PRESETS.filter((m) => m <= maxDuration).map((m) => ({ value: String(m), label: `${m / 60} h` }))}
          value={String(values.duration)}
          onChange={(m) => set('duration', +m)}
        />

        <label>
          Meteorologia
          <select value={values.mode} onChange={(e) => set('mode', e.target.value as SimulationFormValues['mode'])}>
            <option value="provider">Real da data, com ajustes</option>
            <option value="manual">Manual (constante)</option>
          </select>
        </label>

        <div className={styles.group}>
          <div className={styles.baseLine}>
            <span>Base {baseState.fallback ? 'aproximada' : 'do provedor'}:</span>
            {base ? (
              <b>
                {Math.round(base.windKmh)} km/h de {compass(base.dirDeg)} · {Math.round(base.humPct)}% · {Math.round(base.tempC)} °C
              </b>
            ) : (
              <b>{baseState.loading ? 'a obter…' : 'sem dados'}</b>
            )}
          </div>
          {base && base.windKmh <= 0.1 ? (
            <small className={styles.warn}>Vento base nulo: usa-se vento absoluto.</small>
          ) : null}
          {baseState.loading ? <small className="mut">A obter a meteorologia do provedor…</small> : null}
          {baseState.error ? (
            <small className={styles.warn}>
              Provedor indisponível; a usar a série efetiva do cenário como aproximação. {baseState.error}
            </small>
          ) : null}

          <div className={styles.two}>
            <label>
              Vento (km/h)
              <input type="number" min={0} max={150} step={1} value={values.windKmh} onChange={weatherNum('windKmh')} />
            </label>
            <label>
              Humidade (%)
              <input type="number" min={1} max={100} step={1} value={values.humPct} onChange={weatherNum('humPct')} />
            </label>
          </div>

          <div className={styles.roseRow}>
            <WindRosePicker value={values.windFromDeg} onChange={(deg) => setWeather('windFromDeg', Math.round(deg))} />
            <div className={styles.roseMeta}>
              <label>
                Vento de (°) <b>{compass(values.windFromDeg)}</b>
                <input
                  type="number"
                  min={0}
                  max={360}
                  step={5}
                  value={Math.round(values.windFromDeg)}
                  onChange={weatherNum('windFromDeg')}
                />
              </label>
              <small className="mut">O ar sopra para {compass(values.windFromDeg + 180)}.</small>
            </div>
          </div>

          <div className={styles.two}>
            <label>
              Temperatura (°C)
              <input type="number" step={1} value={values.tempC} onChange={weatherNum('tempC')} />
            </label>
            <label>
              Chuva base (mm/h)
              <input
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={values.precipitationMmH}
                onChange={weatherNum('precipitationMmH')}
              />
            </label>
          </div>

          <label>
            Neblina / Nuvens base (%)
            <input
              type="number"
              min={0}
              max={100}
              step={5}
              value={values.cloudCoverPct}
              onChange={weatherNum('cloudCoverPct')}
            />
          </label>

          {values.mode === 'provider' ? (
            <small className="mut">
              Ajuste face à base: {windFactor != null ? `${Math.round(windFactor * 100)}% de vento` : 'vento base nulo'} ·{' '}
              {dirShift > 0 ? '+' : ''}
              {Math.round(dirShift)}° · {humShift > 0 ? '+' : ''}
              {round1(humShift)} p.p. · {tempShift > 0 ? '+' : ''}
              {round1(tempShift)} °C
              {values.precipitationMmH > 0 ? ` · +${round1(values.precipitationMmH)} mm/h chuva` : ''}
              {values.cloudCoverPct > 0 ? ` · ${Math.round(values.cloudCoverPct)}% nuvens` : ''}
            </small>
          ) : null}
        </div>

        {/* Compact Range-based Weather Events Section */}
        <div className={styles.rangeEventsSection}>
          <div className={styles.rangeEventsHead}>
            <div className={styles.rangeHeadRow}>
              <h4>Eventos no Tempo (T+)</h4>
              {values.customEvents.length > 0 && (
                <span className={styles.eventCountBadge}>{values.customEvents.length}</span>
              )}
            </div>
          </div>

          {/* Quick-add buttons */}
          <div className={styles.quickAddRow}>
            <button
              type="button"
              className={styles.quickAddBtn}
              onClick={() => addCustomRangeEvent('rain')}
              title="Adicionar intervalo com chuva"
            >
              <Icon name="rain" /> Chuva
            </button>
            <button
              type="button"
              className={styles.quickAddBtn}
              onClick={() => addCustomRangeEvent('storm')}
              title="Adicionar trovoada com vento e chuva"
            >
              <Icon name="storm" /> Trovoada
            </button>
            <button
              type="button"
              className={styles.quickAddBtn}
              onClick={() => addCustomRangeEvent('clouds')}
              title="Adicionar neblina / nuvens densas"
            >
              <Icon name="cloud" /> Neblina
            </button>
            <button
              type="button"
              className={styles.quickAddBtn}
              onClick={() => addCustomRangeEvent('wind_shift')}
              title="Adicionar rotação do vento"
            >
              <Icon name="wind" /> Vento
            </button>
            <button
              type="button"
              className={styles.quickAddBtn}
              onClick={() => addCustomRangeEvent('heat_dry')}
              title="Adicionar calor e seca"
            >
              <Icon name="sun" /> Calor
            </button>
            <button
              type="button"
              className={styles.quickAddBtn}
              onClick={() => addCustomRangeEvent('wind_set')}
              title="Fixar vento e rumo numa janela"
            >
              <Icon name="wind" /> Vento fixo
            </button>
            <button
              type="button"
              className={styles.quickAddBtn}
              onClick={() => addCustomRangeEvent('gust_burst')}
              title="Adicionar rajadas de pico"
            >
              <Icon name="gust" /> Rajada
            </button>
            <button
              type="button"
              className={styles.quickAddBtn}
              onClick={() => addCustomRangeEvent('front_passage')}
              title="Adicionar passagem de frente (vento, temperatura, humidade e chuva)"
            >
              <Icon name="front" /> Frente
            </button>
            <button
              type="button"
              className={styles.quickAddBtn}
              onClick={() => addCustomRangeEvent('temperature_shift')}
              title="Adicionar variação ou valor fixo de temperatura"
            >
              <Icon name="thermometer" /> Temp.
            </button>
            <button
              type="button"
              className={styles.quickAddBtn}
              onClick={() => addCustomRangeEvent('humidity_shift')}
              title="Adicionar variação ou valor fixo de humidade"
            >
              <Icon name="humidity" /> Humidade
            </button>
            <button
              type="button"
              className={styles.quickAddBtn}
              onClick={addKeyframe}
              title="Adicionar um ponto-chave à curva meteorológica (arrastável na timeline)"
            >
              <Icon name="clock" /> Curva
            </button>
            <button
              type="button"
              className={styles.quickAddBtn}
              onClick={addSecondIgnition}
              disabled={ignitions.length >= maxIgnitions}
              title="Adicionar foco secundário"
            >
              <Icon name="flame" /> 2.º Foco
            </button>
          </div>

          {/* Slim mini-timeline track showing scheduled event spans */}
          {values.customEvents.length > 0 && (
            <div className={styles.miniTimelineWrap}>
              <div className={styles.miniTimelineTrack}>
                {values.customEvents.map((ev) => {
                  const left = Math.min(100, Math.max(0, (ev.startMinute / values.duration) * 100));
                  const width = Math.min(100 - left, Math.max(4, ((ev.endMinute - ev.startMinute) / values.duration) * 100));
                  let bg = 'rgba(56, 189, 248, 0.8)';
                  if (ev.type === 'storm') bg = 'rgba(168, 85, 247, 0.8)';
                  if (ev.type === 'clouds') bg = 'rgba(148, 163, 184, 0.8)';
                  if (ev.type === 'wind_shift' || ev.type === 'wind_scale') bg = 'rgba(251, 191, 36, 0.8)';
                  if (ev.type === 'heat_dry') bg = 'rgba(248, 113, 113, 0.8)';

                  return (
                    <div
                      key={ev.id}
                      className={styles.miniEventBand}
                      style={{
                        left: `${left}%`,
                        width: `${width}%`,
                        background: bg,
                        opacity: ev.enabled ? 1 : 0.35,
                      }}
                      title={`${ev.label}: T+${ev.startMinute}–${ev.endMinute} min`}
                    />
                  );
                })}
              </div>
              <div className={styles.miniTimelineTicks}>
                <span>T+0</span>
                <span>T+{values.duration}m</span>
              </div>
            </div>
          )}

          {/* Compact collapsible list of custom event items */}
          <div className={styles.customEventsList}>
            {values.customEvents.length === 0 ? (
              <span className={styles.noEventsNote}>
                Sem eventos temporais. Clique na timeline inferior ou use os botões acima.
              </span>
            ) : (
              values.customEvents.map((ev) => {
                const isExpanded = expandedEventId === ev.id;
                let summaryText = '';
                if (ev.type === 'rain') summaryText = `${ev.intensityMmH ?? 6} mm/h`;
                else if (ev.type === 'storm') summaryText = `${ev.intensityMmH ?? 15} mm/h · ${ev.windKmh ?? 42} km/h`;
                else if (ev.type === 'clouds') summaryText = `${ev.cloudCoverPct ?? 85}%`;
                else if (ev.type === 'wind_shift')
                  summaryText = ev.windFromDeg != null ? `${ev.windFromDeg}° ${compass(ev.windFromDeg)}` : `${(ev.deltaDeg ?? 90) > 0 ? '+' : ''}${ev.deltaDeg ?? 90}°`;
                else if (ev.type === 'wind_scale') summaryText = `${Math.round((ev.windFactor ?? 1.5) * 100)}%`;
                else if (ev.type === 'wind_set') summaryText = `${ev.windKmh ?? 30} km/h · ${compass(ev.windFromDeg ?? 270)}`;
                else if (ev.type === 'gust_burst') summaryText = `${ev.peakGustKmh ?? 70} km/h`;
                else if (ev.type === 'front_passage') summaryText = `${ev.windKmh ?? 42} km/h · ${ev.precipitationMmH ?? 4} mm/h`;
                else if (ev.type === 'temperature_shift')
                  summaryText = ev.setMode ? `= ${ev.setC ?? 35}°C` : `${(ev.tempDeltaC ?? 5) > 0 ? '+' : ''}${ev.tempDeltaC ?? 5}°C`;
                else if (ev.type === 'humidity_shift')
                  summaryText = ev.setMode ? `= ${ev.setPct ?? 20}%` : `${(ev.humidityDeltaPct ?? -15) > 0 ? '+' : ''}${ev.humidityDeltaPct ?? -15}%`;
                else if (ev.type === 'heat_dry') summaryText = `+${ev.tempDeltaC ?? 4}°C · ${ev.humidityDeltaPct ?? -15}%`;

                return (
                  <div key={ev.id} className={`${styles.eventCardCompact} ${!ev.enabled ? styles.eventDisabled : ''}`}>
                    <div className={styles.eventRowHead}>
                      <input
                        type="checkbox"
                        className={styles.eventCheckbox}
                        checked={ev.enabled}
                        onChange={(e) => updateCustomRangeEvent(ev.id, { enabled: e.target.checked })}
                        title={ev.enabled ? 'Desativar evento' : 'Ativar evento'}
                      />
                      <span
                        className={styles.eventTypeName}
                        onClick={() => setExpandedEventId(isExpanded ? null : ev.id)}
                        title="Clique para expandir/recolher"
                      >
                        <Icon name={WEATHER_EVENT_ICON[ev.type] ?? 'cloud'} /> {EVENT_TYPE_LABEL[ev.type]}
                      </span>
                      <span className={styles.eventTimePill}>
                        T+{ev.startMinute}–{ev.endMinute}m
                      </span>
                      <span className={styles.eventSummaryPill} title={summaryText}>
                        {summaryText}
                      </span>
                      <div className={styles.eventRowActions}>
                        <button
                          type="button"
                          className={styles.eventExpandBtn}
                          onClick={() => setExpandedEventId(isExpanded ? null : ev.id)}
                          title={isExpanded ? 'Recolher' : 'Ajustar parâmetros'}
                        >
                          {isExpanded ? '▲' : '▼'}
                        </button>
                        <button
                          type="button"
                          className={styles.eventDeleteBtn}
                          onClick={() => removeCustomRangeEvent(ev.id)}
                          title="Remover evento"
                          aria-label="Remover evento"
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </div>
                    </div>

                    {/* Detailed controls rendered only when expanded */}
                    {isExpanded && (
                      <div className={styles.eventExpandedBody}>
                        <div className={styles.eventCardRange}>
                          <span>T+</span>
                          <input
                            type="number"
                            min={0}
                            max={ev.endMinute - 5}
                            step={5}
                            value={ev.startMinute}
                            onChange={(e) => {
                              const val = Math.max(0, Math.min(ev.endMinute - 5, +e.target.value || 0));
                              updateCustomRangeEvent(ev.id, { startMinute: val });
                            }}
                          />
                          <span>a</span>
                          <input
                            type="number"
                            min={ev.startMinute + 5}
                            max={values.duration}
                            step={5}
                            value={ev.endMinute}
                            onChange={(e) => {
                              const val = Math.min(values.duration, Math.max(ev.startMinute + 5, +e.target.value || 0));
                              updateCustomRangeEvent(ev.id, { endMinute: val });
                            }}
                          />
                          <span>min</span>
                        </div>

                        {/* Spatial Scope & Dimension Controls (Point 2) */}
                        <div className={styles.eventScopeRow}>
                          <span className={styles.scopeLabel}>Âmbito:</span>
                          <div className={styles.scopeButtons}>
                            <button
                              type="button"
                              className={`${styles.scopeBtn} ${(!ev.scope || ev.scope === 'global') ? styles.scopeBtnActive : ''}`}
                              onClick={() => updateCustomRangeEvent(ev.id, { scope: 'global' })}
                              title="Aplica-se em todo o território do concelho"
                            >
                              <Icon name="globe" /> Concelho todo
                            </button>
                            <button
                              type="button"
                              className={`${styles.scopeBtn} ${ev.scope === 'local' ? styles.scopeBtnActive : ''}`}
                              onClick={() => {
                                const primaryIg = ignitions[0];
                                updateCustomRangeEvent(ev.id, {
                                  scope: 'local',
                                  centerLat: ev.centerLat ?? primaryIg?.position?.lat ?? world?.geo.centerLat,
                                  centerLon: ev.centerLon ?? primaryIg?.position?.lon ?? world?.geo.centerLon,
                                  radiusKm: ev.radiusKm ?? 4,
                                });
                              }}
                              title="Concentrado num foco ou zona com dimensão ajustável"
                            >
                              <Icon name="pin" /> Localizado
                            </button>
                          </div>
                        </div>

                        {ev.scope === 'local' && (
                          <div className={styles.localSpotControls}>
                            <div className={styles.spotPickerRow}>
                              <button
                                type="button"
                                className={styles.spotPickerBtn}
                                onClick={() => {
                                  const primaryIg = ignitions[0];
                                  if (primaryIg) {
                                    updateCustomRangeEvent(ev.id, {
                                      centerLat: primaryIg.position.lat,
                                      centerLon: primaryIg.position.lon,
                                    });
                                  }
                                }}
                                title="Centrar no foco de incêndio ativo"
                              >
                                <Icon name="target" /> No foco de incêndio
                              </button>
                              <span className={styles.spotCoord}>
                                {ev.centerLat != null ? `${ev.centerLat.toFixed(3)}, ${ev.centerLon?.toFixed(3)}` : 'Centro concelho'}
                              </span>
                            </div>
                            <label className={styles.radiusLabel}>
                              <span>
                                Dimensão (Raio): <b>{ev.radiusKm ?? 4} km</b>
                              </span>
                              <input
                                type="range"
                                min={1}
                                max={10}
                                step={0.5}
                                value={ev.radiusKm ?? 4}
                                onChange={(e) => updateCustomRangeEvent(ev.id, { radiusKm: +e.target.value })}
                              />
                            </label>
                            <div style={{ fontSize: '0.78em', color: '#94a3b8', marginTop: 4, lineHeight: 1.3 }}>
                              <Icon name="info" size={12} /> Foco visual 3D (precursor Epic D3): nuvens e precipitação concentradas neste raio no mapa; o motor de simulação atual calcula a meteorologia à escala do concelho.
                            </div>
                          </div>
                        )}

                        <div className={styles.eventCardControls}>
                          {ev.type === 'rain' && (
                            <label>
                              <span>
                                Intensidade: <b>{ev.intensityMmH ?? 6.0} mm/h</b>
                              </span>
                              <input
                                type="range"
                                min={1}
                                max={30}
                                step={0.5}
                                value={ev.intensityMmH ?? 6.0}
                                onChange={(e) => updateCustomRangeEvent(ev.id, { intensityMmH: +e.target.value })}
                              />
                            </label>
                          )}

                          {ev.type === 'storm' && (
                            <>
                              <label>
                                <span>
                                  Chuva: <b>{ev.intensityMmH ?? 15.0} mm/h</b>
                                </span>
                                <input
                                  type="range"
                                  min={5}
                                  max={50}
                                  step={1}
                                  value={ev.intensityMmH ?? 15.0}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { intensityMmH: +e.target.value })}
                                />
                              </label>
                              <label>
                                <span>
                                  Vento: <b>{ev.windKmh ?? 42} km/h</b>
                                </span>
                                <input
                                  type="range"
                                  min={20}
                                  max={90}
                                  step={2}
                                  value={ev.windKmh ?? 42}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { windKmh: +e.target.value })}
                                />
                              </label>
                            </>
                          )}

                          {ev.type === 'clouds' && (
                            <label>
                              <span>
                                Neblina / Nuvens: <b>{ev.cloudCoverPct ?? 85}%</b>
                              </span>
                              <input
                                type="range"
                                min={20}
                                max={100}
                                step={5}
                                value={ev.cloudCoverPct ?? 85}
                                onChange={(e) => updateCustomRangeEvent(ev.id, { cloudCoverPct: +e.target.value })}
                              />
                            </label>
                          )}

                          {(ev.type === 'rain' || ev.type === 'storm' || ev.type === 'clouds') && (
                            <>
                              <label>
                                <span>
                                  Construção Prévia: <b>{ev.buildupMinutes ?? (ev.type === 'storm' ? 30 : ev.type === 'clouds' ? 15 : 20)} min</b>
                                  <small style={{ display: 'block', fontSize: '0.76rem', color: 'var(--text-muted, #8e9bb0)', marginTop: '2px' }}>
                                    nuvens começam a armar em T+{Math.max(0, ev.startMinute - (ev.buildupMinutes ?? (ev.type === 'storm' ? 30 : ev.type === 'clouds' ? 15 : 20)))} min
                                  </small>
                                </span>
                                <input
                                  type="range"
                                  min={5}
                                  max={45}
                                  step={5}
                                  value={ev.buildupMinutes ?? (ev.type === 'storm' ? 30 : ev.type === 'clouds' ? 15 : 20)}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { buildupMinutes: +e.target.value })}
                                />
                              </label>
                              <label>
                                <span>
                                  Dissipação Posterior: <b>{ev.dissipationMinutes ?? 20} min</b>
                                  <small style={{ display: 'block', fontSize: '0.76rem', color: 'var(--text-muted, #8e9bb0)', marginTop: '2px' }}>
                                    nuvens dissipam até T+{ev.endMinute + (ev.dissipationMinutes ?? 20)} min
                                  </small>
                                </span>
                                <input
                                  type="range"
                                  min={5}
                                  max={45}
                                  step={5}
                                  value={ev.dissipationMinutes ?? 20}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { dissipationMinutes: +e.target.value })}
                                />
                              </label>
                            </>
                          )}

                          {ev.type === 'wind_shift' && (
                            <>
                              <label>
                                <span>
                                  Direção: <b>{ev.windFromDeg ?? 270}° ({compass(ev.windFromDeg ?? 270)})</b>
                                </span>
                                <input
                                  type="range"
                                  min={0}
                                  max={360}
                                  step={15}
                                  value={ev.windFromDeg ?? 270}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { windFromDeg: +e.target.value })}
                                />
                              </label>
                              <label>
                                <span>
                                  Velocidade: <b>{ev.windKmh ?? 35} km/h</b>
                                </span>
                                <input
                                  type="range"
                                  min={5}
                                  max={100}
                                  step={1}
                                  value={ev.windKmh ?? 35}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { windKmh: +e.target.value })}
                                />
                              </label>
                            </>
                          )}

                          {ev.type === 'wind_scale' && (
                            <>
                              <label>
                                <span>
                                  Multiplicador Vento: <b>{ev.windFactor ?? 1.7}x</b>
                                </span>
                                <input
                                  type="range"
                                  min={1.1}
                                  max={3.0}
                                  step={0.1}
                                  value={ev.windFactor ?? 1.7}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { windFactor: +e.target.value })}
                                />
                              </label>
                              <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, fontSize: '0.85em', cursor: 'pointer', marginTop: 4 }}>
                                <input
                                  type="checkbox"
                                  checked={ev.applyToGusts ?? false}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { applyToGusts: e.target.checked })}
                                />
                                <span>Incluir rajadas</span>
                              </label>
                            </>
                          )}

                          {ev.type === 'heat_dry' && (
                            <>
                              <label>
                                <span>
                                  Aumento Temp: <b>+{ev.tempDeltaC ?? 6} °C</b>
                                </span>
                                <input
                                  type="range"
                                  min={1}
                                  max={12}
                                  step={1}
                                  value={ev.tempDeltaC ?? 6}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { tempDeltaC: +e.target.value })}
                                />
                              </label>
                              <label>
                                <span>
                                  Queda Humidade: <b>{ev.humidityDeltaPct ?? -20} %</b>
                                </span>
                                <input
                                  type="range"
                                  min={-40}
                                  max={-5}
                                  step={5}
                                  value={ev.humidityDeltaPct ?? -20}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { humidityDeltaPct: +e.target.value })}
                                />
                              </label>
                            </>
                          )}

                          {ev.type === 'wind_set' && (
                            <>
                              <label>
                                <span>
                                  Vento fixo: <b>{ev.windKmh ?? 30} km/h</b>
                                </span>
                                <input
                                  type="range"
                                  min={0}
                                  max={120}
                                  step={1}
                                  value={ev.windKmh ?? 30}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { windKmh: +e.target.value })}
                                />
                              </label>
                              <label>
                                <span>
                                  De: <b>{ev.windFromDeg ?? 270}° ({compass(ev.windFromDeg ?? 270)})</b>
                                </span>
                                <input
                                  type="range"
                                  min={0}
                                  max={360}
                                  step={15}
                                  value={ev.windFromDeg ?? 270}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { windFromDeg: +e.target.value })}
                                />
                              </label>
                              <label>
                                <span>
                                  Transição: <b>{ev.rampMinutes ?? 15} min</b>
                                </span>
                                <input
                                  type="range"
                                  min={0}
                                  max={60}
                                  step={5}
                                  value={ev.rampMinutes ?? 15}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { rampMinutes: +e.target.value })}
                                />
                              </label>
                            </>
                          )}

                          {ev.type === 'gust_burst' && (
                            <>
                              <label>
                                <span>
                                  Rajada de pico: <b>{ev.peakGustKmh ?? 70} km/h</b>
                                </span>
                                <input
                                  type="range"
                                  min={30}
                                  max={150}
                                  step={5}
                                  value={ev.peakGustKmh ?? 70}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { peakGustKmh: +e.target.value })}
                                />
                              </label>
                              <label>
                                <span>
                                  Intervalo: <b>{ev.periodMinutes ?? 5} min</b>
                                </span>
                                <input
                                  type="range"
                                  min={0.5}
                                  max={30}
                                  step={0.5}
                                  value={ev.periodMinutes ?? 5}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { periodMinutes: +e.target.value })}
                                />
                              </label>
                            </>
                          )}

                          {ev.type === 'front_passage' && (
                            <>
                              <label>
                                <span>
                                  Vento: <b>{ev.windKmh ?? 42} km/h de {compass(ev.windFromDeg ?? 240)}</b>
                                </span>
                                <input
                                  type="range"
                                  min={0}
                                  max={120}
                                  step={1}
                                  value={ev.windKmh ?? 42}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { windKmh: +e.target.value })}
                                />
                              </label>
                              <label>
                                <span>
                                  De: <b>{ev.windFromDeg ?? 240}°</b>
                                </span>
                                <input
                                  type="range"
                                  min={0}
                                  max={360}
                                  step={15}
                                  value={ev.windFromDeg ?? 240}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { windFromDeg: +e.target.value })}
                                />
                              </label>
                              <label>
                                <span>
                                  ΔTemperatura: <b>{ev.tempDeltaC ?? -6} °C</b>
                                </span>
                                <input
                                  type="range"
                                  min={-12}
                                  max={12}
                                  step={1}
                                  value={ev.tempDeltaC ?? -6}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { tempDeltaC: +e.target.value })}
                                />
                              </label>
                              <label>
                                <span>
                                  ΔHumidade: <b>{ev.humidityDeltaPct ?? 30} %</b>
                                </span>
                                <input
                                  type="range"
                                  min={-40}
                                  max={40}
                                  step={5}
                                  value={ev.humidityDeltaPct ?? 30}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { humidityDeltaPct: +e.target.value })}
                                />
                              </label>
                              <label>
                                <span>
                                  Chuva: <b>{ev.precipitationMmH ?? 4} mm/h</b>
                                </span>
                                <input
                                  type="range"
                                  min={0}
                                  max={50}
                                  step={0.5}
                                  value={ev.precipitationMmH ?? 4}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { precipitationMmH: +e.target.value })}
                                />
                              </label>
                            </>
                          )}

                          {(ev.type === 'temperature_shift' || ev.type === 'humidity_shift') && (
                            <>
                              <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                                <input
                                  type="checkbox"
                                  checked={ev.setMode ?? false}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { setMode: e.target.checked })}
                                />
                                <span>Fixar valor absoluto</span>
                              </label>
                              {ev.type === 'temperature_shift' ? (
                                ev.setMode ? (
                                  <label>
                                    <span>
                                      Temperatura: <b>{ev.setC ?? 35} °C</b>
                                    </span>
                                    <input
                                      type="range"
                                      min={-10}
                                      max={50}
                                      step={1}
                                      value={ev.setC ?? 35}
                                      onChange={(e) => updateCustomRangeEvent(ev.id, { setC: +e.target.value })}
                                    />
                                  </label>
                                ) : (
                                  <label>
                                    <span>
                                      ΔTemperatura: <b>{ev.tempDeltaC ?? 5} °C</b>
                                    </span>
                                    <input
                                      type="range"
                                      min={-12}
                                      max={12}
                                      step={1}
                                      value={ev.tempDeltaC ?? 5}
                                      onChange={(e) => updateCustomRangeEvent(ev.id, { tempDeltaC: +e.target.value })}
                                    />
                                  </label>
                                )
                              ) : ev.setMode ? (
                                <label>
                                  <span>
                                    Humidade: <b>{ev.setPct ?? 20} %</b>
                                  </span>
                                  <input
                                    type="range"
                                    min={1}
                                    max={100}
                                    step={1}
                                    value={ev.setPct ?? 20}
                                    onChange={(e) => updateCustomRangeEvent(ev.id, { setPct: +e.target.value })}
                                  />
                                </label>
                              ) : (
                                <label>
                                  <span>
                                    ΔHumidade: <b>{ev.humidityDeltaPct ?? -15} %</b>
                                  </span>
                                  <input
                                    type="range"
                                    min={-40}
                                    max={40}
                                    step={5}
                                    value={ev.humidityDeltaPct ?? -15}
                                    onChange={(e) => updateCustomRangeEvent(ev.id, { humidityDeltaPct: +e.target.value })}
                                  />
                                </label>
                              )}
                              <label>
                                <span>
                                  Transição: <b>{ev.rampMinutes ?? 15} min</b>
                                </span>
                                <input
                                  type="range"
                                  min={0}
                                  max={60}
                                  step={5}
                                  value={ev.rampMinutes ?? 15}
                                  onChange={(e) => updateCustomRangeEvent(ev.id, { rampMinutes: +e.target.value })}
                                />
                              </label>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Sparse curve points: the arbitrary keyframe curves of `WeatherSpec.keyframes` */}
        <div className={styles.rangeEventsSection}>
          <div className={styles.rangeEventsHead}>
            <div className={styles.rangeHeadRow}>
              <h4>Curva meteorológica (pontos-chave)</h4>
              {values.keyframes.length > 0 && <span className={styles.eventCountBadge}>{values.keyframes.length}</span>}
            </div>
          </div>
          <small className="mut">
            Pontos esparsos: cada campo vazio continua a seguir a meteorologia base. Arraste os losangos na timeline para mover; clique num deles para editar todos os campos.
          </small>
          <div className={styles.customEventsList}>
            {values.keyframes.length === 0 ? (
              <span className={styles.noEventsNote}>Sem pontos-chave: a série base é usada em todo o período.</span>
            ) : (
              values.keyframes.map((kf) => {
                const summary =
                  [
                    kf.windKmh != null ? `${kf.windKmh} km/h` : null,
                    kf.windFromDeg != null ? compass(kf.windFromDeg) : null,
                    kf.tempC != null ? `${kf.tempC}°C` : null,
                    kf.humidityPct != null ? `${kf.humidityPct}% HR` : null,
                    kf.gustKmh != null ? `rajada ${kf.gustKmh}` : null,
                    kf.precipitationMmH != null ? `${kf.precipitationMmH} mm/h` : null,
                    kf.cloudCoverPct != null ? `${kf.cloudCoverPct}% nuvens` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'só tempo';
                return (
                  <div key={kf.id} className={styles.eventCardCompact}>
                    <div className={styles.eventRowHead}>
                      <Icon name="clock" />
                      <span className={styles.eventTypeName}>Ponto-chave</span>
                      <label className={styles.eventTimePill} title="Minuto desde o início">
                        T+
                        <input
                          type="number"
                          min={0}
                          max={values.duration}
                          step={5}
                          value={kf.minute}
                          style={{ width: 52, marginLeft: 3 }}
                          onChange={(e) => updateKeyframe(kf.id, { minute: Math.max(0, Math.min(values.duration, +e.target.value || 0)) })}
                        />
                        m
                      </label>
                      <span className={styles.eventSummaryPill} title={summary}>
                        {summary}
                      </span>
                      <div className={styles.eventRowActions}>
                        <button
                          type="button"
                          className={styles.eventDeleteBtn}
                          onClick={() => removeKeyframe(kf.id)}
                          title="Remover ponto-chave"
                          aria-label="Remover ponto-chave"
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className={styles.quickAddRow}>
            <button type="button" className={styles.quickAddBtn} onClick={addKeyframe} title="Adicionar um ponto-chave à curva">
              <Icon name="clock" /> Adicionar ponto
            </button>
          </div>
        </div>

        <label>
          Ensemble (simulações com a meteorologia perturbada)
          <select value={values.members} onChange={(e) => set('members', +e.target.value)}>
            {memberOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <div className={styles.ignitions}>
          {ignitions.map((ig, i) => (
            <div key={i} className={styles.ignitionRow}>
              <div>
                <b>{ig.label ?? `Foco ${i + 1}`}</b>
                <small className="mut">
                  {ig.position.lat.toFixed(4)}, {ig.position.lon.toFixed(4)}
                  {ig.timeOffsetMinutes ? ` · T+${ig.timeOffsetMinutes} min` : ''}
                </small>
              </div>
              {i > 0 ? (
                <label className={styles.delay} title="Minutos desde o início">
                  <span>Atraso</span>
                  <input
                    type="number"
                    min={0}
                    max={values.duration}
                    step={5}
                    value={ig.timeOffsetMinutes ?? 0}
                    onChange={(e) =>
                      updateIgnition(i, {
                        timeOffsetMinutes: Math.max(0, Math.min(values.duration, +e.target.value || 0)),
                      })
                    }
                  />
                </label>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  const next = pickIgnitionSlot === i ? null : (i as 0 | 1);
                  setPickIgnitionSlot(next);
                  setHint(next != null ? `Clique no terreno para mover o foco ${i + 1}` : '');
                }}
              >
                {pickIgnitionSlot === i ? 'Clique no terreno…' : 'Mover'}
              </button>
              {i > 0 ? (
                <button type="button" onClick={() => removeIgnition(i)} title="Remover segundo foco">
                  ×
                </button>
              ) : null}
            </div>
          ))}
          <button
            type="button"
            onClick={addSecondIgnition}
            disabled={ignitions.length >= maxIgnitions || !(data?.location.weatherPoint ?? data?.location.center)}
          >
            Adicionar 2.º foco
          </button>
        </div>

        <div className={styles.two}>
          <button type="button" onClick={onPreview}>
            Pré-visualizar
          </button>
          <button type="button" className="primary" onClick={onRun} disabled={busyByUser || !ignitions.length}>
            Simular
          </button>
        </div>

        {job && progress?.text ? (
          <div>
            <div className="note">{progress.text}</div>
            <ProgressBar percent={progress.percent} />
          </div>
        ) : null}
        {job ? (
          <button type="button" onClick={() => void cancelJob()}>
            Cancelar simulação
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            const defaults = defaultFormValues(run);
            const reset = defaultFormValues(run, baseForWindow(defaults.start, defaults.duration));
            reset.customEvents = storeCustomEvents;
            reset.keyframes = storeKeyframes;
            setValues(reset);
            setWeatherTouched(false);
            setPreview(null);
          }}
        >
          Repor os valores do cenário
        </button>

        {preview ? (
          <div>
            <h3>Meteorologia prevista</h3>
            <small className="mut">
              Pré-visualização automática: {previewEvents} evento(s) e {previewKeyframes} ponto(s)-chave aplicados pelo servidor (inclui ajustes de base).
            </small>
            <WeatherChart samples={preview} />
            {previewWarnings.length > 0 ? (
              <div className={styles.weatherWarnings}>
                {previewWarnings.map((warning, i) => (
                  <small key={`${warning.code}-${i}`} className={styles.warn}>
                    <Icon name="alert" size={12} /> {warning.code}: {warning.message}
                  </small>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
