import { useEffect, useState, type ChangeEvent } from 'react';

import { weatherApi, type WeatherSample } from '@/api';
import { WindRosePicker } from '@/components/common/WindRosePicker';
import { ProgressBar } from '@/components/common/StatCard';
import { compass } from '@/domain/georef';
import {
  bearingDelta,
  buildPreviewRequest,
  buildSimulationRequest,
  defaultFormValues,
  presetAvailable,
  resizePresetEvents,
  type PresetId,
  type SimulationFormValues,
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

/** "Simulate with other weather": absolute wind/humidity/temperature, provider base, presets and two ignitions. */
export function SimulationForm() {
  const run = useAppStore((s) => s.run);
  const locationId = useAppStore((s) => s.locationId);
  const data = useAppStore((s) => s.data);
  const ignitions = useAppStore((s) => s.ignitions);
  const pickIgnitionSlot = useAppStore((s) => s.pickIgnitionSlot);
  const job = useAppStore((s) => s.job);
  const progress = useAppStore((s) => s.progress);
  const limits = useAppStore((s) => s.capabilities?.limits);
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
  const baseState = useProviderBase(run, locationId, values.start, values.duration);
  const base = baseState.base;
  const baseKey = locationId ? `${locationId}|${values.start}|${values.duration}` : null;

  const set = <K extends keyof SimulationFormValues>(key: K, value: SimulationFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const num = (key: keyof SimulationFormValues) => (e: ChangeEvent<HTMLInputElement>) =>
    set(key, (e.target.value === '' ? 0 : +e.target.value) as never);
  const setWeather = (key: 'windKmh' | 'windFromDeg' | 'humPct' | 'tempC' | 'precipitationMmH' | 'cloudCoverPct', value: number) => {
    setWeatherTouched(true);
    setPreview(null);
    setValues((v) => ({ ...v, [key]: value }));
  };
  const weatherNum = (key: 'windKmh' | 'windFromDeg' | 'humPct' | 'tempC' | 'precipitationMmH' | 'cloudCoverPct') => (e: ChangeEvent<HTMLInputElement>) =>
    setWeather(key, e.target.value === '' ? 0 : +e.target.value);
  const baseForWindow = (start: string, duration: number) =>
    base && locationId && baseState.key === `${locationId}|${start}|${duration}` ? base : null;

  // when a scenario's run loads, reset the form to that scenario's values
  useEffect(() => {
    if (!run) return;
    const defaults = defaultFormValues(run);
    setValues(defaultFormValues(run, baseForWindow(defaults.start, defaults.duration)));
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

  // keep preset windows and ignition delays inside the run duration
  useEffect(() => {
    setValues((v) => ({ ...v, presetEvents: resizePresetEvents(v.presetEvents, v.duration) }));
    const clamped = ignitions.map((ig, i) => (i > 0 ? { ...ig, timeOffsetMinutes: Math.min(ig.timeOffsetMinutes ?? 0, values.duration) } : ig));
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

  const onPreview = async () => {
    if (!locationId || !requireBase()) return;
    try {
      setPreview((await weatherApi.resolve(buildPreviewRequest(values, locationId, base))).samples ?? []);
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

  const togglePreset = (id: PresetId) => {
    if (id === 'second_ignition') {
      addSecondIgnition();
      return;
    }
    setPreview(null);
    setValues((v) => ({
      ...v,
      presetEvents: v.presetEvents.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)),
    }));
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
            <input type="number" min={15} max={maxDuration} step={15} value={values.duration} onChange={num('duration')} />
          </label>
        </div>
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
            <small className={styles.warn}>Vento base nulo: usa-se vento absoluto; os presets de vento ficam indisponíveis.</small>
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
              Chuva (mm/h)
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
            Neblina / Nuvens (%)
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

        <div className={styles.presets}>
          {values.presetEvents.map((preset) => {
            const available = presetAvailable(preset.id, values.duration, values.mode === 'provider' ? base?.windKmh : undefined);
            const active = preset.id === 'second_ignition' ? ignitions.length > 1 : preset.enabled && available;
            return (
              <button
                key={preset.id}
                type="button"
                className={active ? styles.presetOn : styles.preset}
                disabled={!available || (preset.id === 'second_ignition' && ignitions.length >= maxIgnitions)}
                onClick={() => togglePreset(preset.id)}
                title={
                  preset.id === 'second_ignition'
                    ? 'Adicionar um segundo foco 45 min depois do início'
                    : !available
                      ? values.mode === 'provider' && base != null && base.windKmh <= 0.1
                        ? 'Sem vento base: os presets de vento não se aplicam'
                        : 'Duração insuficiente para este preset'
                      : undefined
                }
              >
                {preset.label}
              </button>
            );
          })}
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
                    onChange={(e) => updateIgnition(i, { timeOffsetMinutes: Math.max(0, Math.min(values.duration, +e.target.value || 0)) })}
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
          <button type="button" onClick={addSecondIgnition} disabled={ignitions.length >= maxIgnitions || !(data?.location.weatherPoint ?? data?.location.center)}>
            Adicionar 2.º foco
          </button>
        </div>

        <div className={styles.two}>
          <button onClick={onPreview}>Pré-visualizar</button>
          <button className="primary" onClick={onRun} disabled={busyByUser || !ignitions.length}>
            Simular
          </button>
        </div>

        {job && progress?.text ? (
          <div>
            <div className="note">{progress.text}</div>
            <ProgressBar percent={progress.percent} />
          </div>
        ) : null}
        {job ? <button onClick={() => void cancelJob()}>Cancelar simulação</button> : null}
        <button
          onClick={() => {
            const defaults = defaultFormValues(run);
            setValues(defaultFormValues(run, baseForWindow(defaults.start, defaults.duration)));
            setWeatherTouched(false);
            setPreview(null);
          }}
        >
          Repor os valores do cenário
        </button>

        {preview ? (
          <div>
            <h3>Meteorologia prevista</h3>
            <WeatherChart samples={preview} />
          </div>
        ) : null}
      </div>
    </>
  );
}
