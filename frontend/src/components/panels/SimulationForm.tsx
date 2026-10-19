import { useEffect, useState, type ChangeEvent } from 'react';

import { weatherApi, type WeatherSample } from '@/api';
import { ProgressBar } from '@/components/common/StatCard';
import { compass } from '@/domain/georef';
import { buildPreviewRequest, buildSimulationRequest, defaultFormValues, type SimulationFormValues } from '@/domain/simulationForm';
import { useSimulationActions } from '@/hooks/useSimulationActions';
import { useAppStore } from '@/store/appStore';

import styles from './panels.module.css';
import { WeatherChart } from './WeatherChart';

const MEMBER_OPTIONS = [
  { value: 3, label: '3 · rápido' },
  { value: 6, label: '6' },
  { value: 12, label: '12 · normal' },
];

/** "Simulate with other weather": edit wind/humidity/temperature (and a mid-fire wind shift), preview the series, run. */
export function SimulationForm() {
  const run = useAppStore((s) => s.run);
  const locationId = useAppStore((s) => s.locationId);
  const ignition = useAppStore((s) => s.ignition);
  const pickIgnition = useAppStore((s) => s.pickIgnition);
  const job = useAppStore((s) => s.job);
  const progress = useAppStore((s) => s.progress);
  const limits = useAppStore((s) => s.capabilities?.limits);
  const { setPickIgnition, setHint, setScenario } = useAppStore.getState();
  const { runSimulation, cancelJob } = useSimulationActions();

  const [values, setValues] = useState<SimulationFormValues>(() => defaultFormValues());
  const [preview, setPreview] = useState<WeatherSample[] | null>(null);
  const set = <K extends keyof SimulationFormValues>(key: K, value: SimulationFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const num = (key: keyof SimulationFormValues) => (e: ChangeEvent<HTMLInputElement>) =>
    set(key, (e.target.value === '' ? 0 : +e.target.value) as never);

  // when a scenario's run loads, reset the form to that scenario's values
  const scenarioSnapshot = run?.simulation.scenarioSnapshot;
  useEffect(() => {
    if (!run || !scenarioSnapshot) return;
    setValues(defaultFormValues({ start: scenarioSnapshot.start, durationMinutes: run.durationMinutes, weather: run.weather }));
    setPreview(null);
  }, [run?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const busyByUser = !!job && !job.auto;
  const maxMembers = limits?.maxEnsembleMembers;
  const memberOptions = MEMBER_OPTIONS.filter((o) => !maxMembers || o.value <= maxMembers);
  const maxDuration = limits?.maxDurationMinutes ?? 720;

  const onPreview = async () => {
    if (!locationId) return;
    try {
      setPreview((await weatherApi.resolve(buildPreviewRequest(values, locationId))).samples ?? []);
    } catch (e) {
      setHint(`Meteorologia: ${(e as Error).message}`);
    }
  };

  const onRun = () => {
    if (!locationId || !ignition) return;
    setScenario('custom');
    void runSimulation(buildSimulationRequest(values, locationId, ignition));
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

        {values.mode === 'provider' ? (
          <div className={styles.group}>
            <label>
              Vento: <b>{values.windScale}%</b>
              <input type="range" min={25} max={300} step={5} value={values.windScale} onChange={num('windScale')} />
            </label>
            <label>
              Rodar o vento: <b>{`${values.dirShift > 0 ? '+' : ''}${values.dirShift}°`}</b>
              <input type="range" min={-180} max={180} step={5} value={values.dirShift} onChange={num('dirShift')} />
            </label>
            <div className={styles.two}>
              <label>
                Humidade (± pontos %)
                <input type="number" step={1} value={values.humShift} onChange={num('humShift')} />
              </label>
              <label>
                Temperatura (± °C)
                <input type="number" step={1} value={values.tempShift} onChange={num('tempShift')} />
              </label>
            </div>
          </div>
        ) : (
          <div className={styles.group}>
            <div className={styles.two}>
              <label>
                Vento (km/h)
                <input type="number" min={0} max={150} value={values.wind} onChange={num('wind')} />
              </label>
              <label>
                Vento de (°) <b>{compass(values.dir)}</b>
                <input type="number" min={0} max={360} value={values.dir} onChange={num('dir')} />
              </label>
            </div>
            <div className={styles.two}>
              <label>
                Humidade (%)
                <input type="number" min={1} max={100} value={values.hum} onChange={num('hum')} />
              </label>
              <label>
                Temperatura (°C)
                <input type="number" value={values.temp} onChange={num('temp')} />
              </label>
            </div>
          </div>
        )}

        <label className={styles.check}>
          <input type="checkbox" checked={values.shiftOn} onChange={(e) => set('shiftOn', e.target.checked)} /> Mudança de vento durante o incêndio
        </label>
        {values.shiftOn ? (
          <div className={`${styles.two} ${styles.group}`}>
            <label>
              Aos (min desde o início)
              <input type="number" min={0} value={values.shiftAt} onChange={num('shiftAt')} />
            </label>
            <label>
              Passa a soprar de (°) <b>{compass(values.shiftTo)}</b>
              <input type="number" min={0} max={360} value={values.shiftTo} onChange={num('shiftTo')} />
            </label>
          </div>
        ) : null}

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

        <button onClick={() => { const next = !pickIgnition; setPickIgnition(next); setHint(next ? 'Clique no terreno para definir a ignição' : ''); }}>
          {pickIgnition ? 'Clique no terreno…' : 'Escolher ignição no mapa'}
        </button>
        <small className="mut">Ignição: {ignition ? `${ignition.lat.toFixed(4)}, ${ignition.lon.toFixed(4)}` : '—'}</small>

        <div className={styles.two}>
          <button onClick={onPreview}>Pré-visualizar</button>
          <button className="primary" onClick={onRun} disabled={busyByUser || !ignition}>
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
            if (run && scenarioSnapshot) setValues(defaultFormValues({ start: scenarioSnapshot.start, durationMinutes: run.durationMinutes, weather: run.weather }));
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
