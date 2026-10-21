import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { compass } from '@/domain/georef';
import {
  buildSimulationRequest,
  defaultFormValues,
  type CustomWeatherEventType,
  type TimelineRangeEvent,
} from '@/domain/simulationForm';
import { formatDateTime } from '@/domain/weather';
import { useSimulationActions } from '@/hooks/useSimulationActions';
import { useAppStore } from '@/store/appStore';

import styles from './layout.module.css';

const JUMPS = [15, 30, 60, 120, 180, 360];
const SPEEDS = [1, 5, 10, 30, 60];

const EVENT_LABEL: Record<string, string> = {
  wind_shift: 'Vento roda',
  wind_scale: 'Vento muda',
  wind_set: 'Vento fixo',
  humidity_shift: 'Humidade muda',
  temperature_shift: 'Temperatura muda',
  front_passage: 'Frente passa',
  precipitation: 'Chuva',
};

type TimeSpec = { offsetMinutes?: number; time?: string };

const offsetOf = (spec: TimeSpec | null | undefined, startMs: number): number | null => {
  if (!spec) return null;
  if ('offsetMinutes' in spec && typeof spec.offsetMinutes === 'number') return spec.offsetMinutes;
  if ('time' in spec && spec.time) {
    const at = Date.parse(spec.time);
    return Number.isFinite(at) ? (at - startMs) / 60_000 : null;
  }
  return null;
};

interface SelectionState {
  startMin: number;
  endMin: number;
  editingEventId?: string;
}

/**
 * Play/pause, clock, quick jumps, scrubber and interactive timeline weather events (Requirements 1, 1.1 & 1.2).
 */
export function PlaybackBar() {
  const run = useAppStore((s) => s.run);
  const t = useAppStore((s) => s.t);
  const playing = useAppStore((s) => s.playing);
  const speed = useAppStore((s) => s.speed);
  const locationId = useAppStore((s) => s.locationId);
  const ignitions = useAppStore((s) => s.ignitions);
  const customEvents = useAppStore((s) => s.customEvents);
  const setPlaying = useAppStore((s) => s.setPlaying);
  const setSpeed = useAppStore((s) => s.setSpeed);
  const setTime = useAppStore((s) => s.setTime);
  const setCustomEvents = useAppStore((s) => s.setCustomEvents);
  const setScenario = useAppStore((s) => s.setScenario);
  const { runSimulation } = useSimulationActions();

  const duration = run?.durationMinutes ?? 180;
  const trackRef = useRef<HTMLDivElement>(null);

  // Timeline range selection & popover state (Requirement 1.1)
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [dragState, setDragState] = useState<{ startMin: number; currentMin: number; isDragging: boolean } | null>(null);

  // Popover form values
  const [popoverType, setPopoverType] = useState<CustomWeatherEventType>('rain');
  const [popoverRainMmH, setPopoverRainMmH] = useState(6.0);
  const [popoverCloudPct, setPopoverCloudPct] = useState(85);
  const [popoverWindKmh, setPopoverWindKmh] = useState(38);
  const [popoverWindDeg, setPopoverWindDeg] = useState(270);
  const [popoverWindFactor, setPopoverWindFactor] = useState(1.7);
  const [popoverTempDelta, setPopoverTempDelta] = useState(6);
  const [popoverHumDelta, setPopoverHumDelta] = useState(-20);

  const flags = useMemo(() => {
    if (!run) return [];
    const snapshot = run.simulation.scenarioSnapshot;
    const list: { at: number; label: string; kind: 'weather' | 'ignition' }[] = [];
    for (const event of snapshot.weather?.events ?? []) {
      if (event.enabled === false) continue;
      const start = 'start' in event ? event.start : 'at' in event ? event.at : 'window' in event ? event.window?.start : null;
      const at = offsetOf(start, run.startMs);
      if (at == null || at < 0 || at > duration) continue;
      list.push({ at, label: EVENT_LABEL[event.type] ?? 'Meteorologia muda', kind: 'weather' });
    }
    for (const ignition of snapshot.ignitions ?? []) {
      const at = ignition.timeOffsetMinutes ?? 0;
      if (at < 0 || at > duration) continue;
      list.push({ at, label: ignition.label ?? `Foco a T+${at} min`, kind: 'ignition' });
    }
    return list;
  }, [run, duration]);

  const togglePlay = () => {
    if (!run) return;
    if (t >= run.durationMinutes) setTime(0);
    setPlaying(!playing);
    if (!playing) setSelection(null);
  };

  // Convert clientX on event track to simulation minute
  const getMinuteFromClientX = (clientX: number): number => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(ratio * duration);
  };

  // Track pointerdown: start dragging range when paused (Requirement 1.1)
  const handleTrackPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (playing) setPlaying(false);
    const min = getMinuteFromClientX(e.clientX);
    setDragState({ startMin: min, currentMin: min, isDragging: true });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleTrackPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragState?.isDragging) return;
    const currentMin = getMinuteFromClientX(e.clientX);
    setDragState((prev) => (prev ? { ...prev, currentMin } : null));
  };

  const handleTrackPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragState) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    let s = Math.min(dragState.startMin, dragState.currentMin);
    let end = Math.max(dragState.startMin, dragState.currentMin);
    if (end - s < 5) {
      end = Math.min(duration, s + 45);
      if (end - s < 15) s = Math.max(0, end - 45);
    }
    setSelection({ startMin: s, endMin: end });
    setDragState(null);
  };

  // Open popover to edit an existing custom event
  const handleOpenEditEvent = (ev: TimelineRangeEvent, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelection({
      startMin: ev.startMinute,
      endMin: ev.endMinute,
      editingEventId: ev.id,
    });
    setPopoverType(ev.type);
    if (ev.intensityMmH != null) setPopoverRainMmH(ev.intensityMmH);
    if (ev.cloudCoverPct != null) setPopoverCloudPct(ev.cloudCoverPct);
    if (ev.windKmh != null) setPopoverWindKmh(ev.windKmh);
    if (ev.windFromDeg != null) setPopoverWindDeg(ev.windFromDeg);
    if (ev.windFactor != null) setPopoverWindFactor(ev.windFactor);
    if (ev.tempDeltaC != null) setPopoverTempDelta(ev.tempDeltaC);
    if (ev.humidityDeltaPct != null) setPopoverHumDelta(ev.humidityDeltaPct);
  };

  // Quick "+ Evento" button: opens popover for current minute
  const handleQuickAddAtCurrentTime = () => {
    setPlaying(false);
    const start = Math.min(duration - 15, t);
    const end = Math.min(duration, start + 45);
    setSelection({ startMin: start, endMin: end });
  };

  // Construct TimelineRangeEvent from popover state
  const buildCurrentEvent = (): TimelineRangeEvent | null => {
    if (!selection) return null;
    const { startMin, endMin, editingEventId } = selection;
    const id = editingEventId ?? `ev_${popoverType}_${Date.now()}`;
    const dur = endMin - startMin;

    let label = '';
    switch (popoverType) {
      case 'rain':
        label = `Chuva ${popoverRainMmH} mm/h (T+${startMin}–${endMin})`;
        break;
      case 'storm':
        label = `Trovoada ${popoverRainMmH} mm/h (T+${startMin}–${endMin})`;
        break;
      case 'clouds':
        label = `Neblina ${popoverCloudPct}% (T+${startMin}–${endMin})`;
        break;
      case 'wind_shift':
        label = `Vento ${compass(popoverWindDeg)} ${popoverWindKmh} km/h (T+${startMin}–${endMin})`;
        break;
      case 'wind_scale':
        label = `Vento ${popoverWindFactor}x (T+${startMin}–${endMin})`;
        break;
      case 'heat_dry':
        label = `Calor +${popoverTempDelta}°C (T+${startMin}–${endMin})`;
        break;
    }

    return {
      id,
      type: popoverType,
      label,
      enabled: true,
      startMinute: startMin,
      endMinute: endMin,
      intensityMmH: popoverType === 'rain' || popoverType === 'storm' ? popoverRainMmH : undefined,
      cloudCoverPct: popoverType === 'clouds' ? popoverCloudPct : undefined,
      windKmh: popoverType === 'wind_shift' || popoverType === 'storm' ? popoverWindKmh : undefined,
      windFromDeg: popoverType === 'wind_shift' ? popoverWindDeg : undefined,
      windFactor: popoverType === 'wind_scale' ? popoverWindFactor : undefined,
      tempDeltaC: popoverType === 'heat_dry' || popoverType === 'storm' ? popoverTempDelta : undefined,
      humidityDeltaPct: popoverType === 'heat_dry' || popoverType === 'clouds' ? popoverHumDelta : undefined,
    };
  };

  // Save event to store without immediately launching simulation
  const handleSaveEvent = () => {
    const ev = buildCurrentEvent();
    if (!ev) return;
    const next = [...customEvents.filter((x) => x.id !== ev.id), ev];
    setCustomEvents(next);
    setSelection(null);
  };

  // Delete event
  const handleDeleteEvent = () => {
    if (!selection?.editingEventId) return;
    setCustomEvents(customEvents.filter((x) => x.id !== selection.editingEventId));
    setSelection(null);
  };

  // Run simulation with this custom weather event immediately (Requirement 1.1)
  const handleSimulateWithEvent = () => {
    const ev = buildCurrentEvent();
    if (!ev || !run || !locationId || !ignitions.length) return;

    const nextEvents = [...customEvents.filter((x) => x.id !== ev.id), ev];
    setCustomEvents(nextEvents);

    const values = defaultFormValues(run);
    values.customEvents = nextEvents;
    const req = buildSimulationRequest(values, locationId, ignitions);

    setScenario('custom');
    setSelection(null);
    void runSimulation(req);
  };

  // Highlight interval for drag or selection
  const activeStart = dragState ? Math.min(dragState.startMin, dragState.currentMin) : selection?.startMin;
  const activeEnd = dragState ? Math.max(dragState.startMin, dragState.currentMin) : selection?.endMin;
  const highlightLeftPct = activeStart != null ? (activeStart / duration) * 100 : 0;
  const highlightWidthPct = activeStart != null && activeEnd != null ? Math.max(1, ((activeEnd - activeStart) / duration) * 100) : 0;

  return (
    <footer className={styles.bar}>
      <button className={styles.play} title="Reproduzir / pausar" onClick={togglePlay}>
        {playing ? 'Pausar' : 'Reproduzir'}
      </button>

      <div className={styles.clock}>
        <b>{run ? formatDateTime(run.startMs + t * 60000) : '—'}</b>
        <small>{run ? `T+${Math.floor(t / 60)} h ${String(t % 60).padStart(2, '0')} min` : ''}</small>
      </div>

      <div className={styles.jumps}>
        {JUMPS.filter((m) => m <= duration).map((m) => (
          <button key={m} onClick={() => setTime(m)}>
            {m >= 60 ? `${m / 60} h` : `${m} min`}
          </button>
        ))}
        <button
          className={styles.addEventBtn}
          title="Adicionar evento meteorológico na timeline a partir do minuto atual"
          onClick={handleQuickAddAtCurrentTime}
        >
          + Evento T+{t}
        </button>
      </div>

      <div className={styles.timelineColumn}>
        {/* Interactive Event Track (Requirement 1.1) */}
        <div
          ref={trackRef}
          className={styles.eventTrack}
          onPointerDown={handleTrackPointerDown}
          onPointerMove={handleTrackPointerMove}
          onPointerUp={handleTrackPointerUp}
          title="Clique ou arraste quando em pausa para agendar eventos meteorológicos (chuva, vento, neblina)"
        >
          {/* Active Range Events rendered on the timeline */}
          {customEvents.map((ev) => {
            const left = Math.min(100, Math.max(0, (ev.startMinute / duration) * 100));
            const width = Math.min(100 - left, Math.max(3, ((ev.endMinute - ev.startMinute) / duration) * 100));
            return (
              <div
                key={ev.id}
                className={`${styles.eventChip} ${styles[`ev_${ev.type}`]}`}
                style={{ left: `${left}%`, width: `${width}%`, opacity: ev.enabled ? 1 : 0.45 }}
                onClick={(e) => handleOpenEditEvent(ev, e)}
                title={`Clique para editar: ${ev.label} (T+${ev.startMinute}–${ev.endMinute} min)`}
              >
                {ev.type === 'rain' && '🌧️'}
                {ev.type === 'storm' && '⛈️'}
                {ev.type === 'clouds' && '🌫️'}
                {ev.type === 'wind_shift' && '💨'}
                {ev.type === 'wind_scale' && '🌪️'}
                {ev.type === 'heat_dry' && '☀️'}{' '}
                {ev.label}
              </div>
            );
          })}

          {/* Selection Highlight (drag or active selection) */}
          {(dragState?.isDragging || selection) && (
            <div
              className={styles.selectionHighlight}
              style={{
                left: `${highlightLeftPct}%`,
                width: `${highlightWidthPct}%`,
              }}
            />
          )}
        </div>

        {/* Scrubber slider track */}
        <div className={styles.scrubWrap}>
          <input
            className={styles.scrub}
            type="range"
            min={0}
            max={duration}
            step={1}
            value={t}
            onChange={(e) => {
              setPlaying(false);
              setTime(+e.target.value);
            }}
          />
          <div className={styles.flags} aria-hidden="true">
            {flags.map((flag, i) => (
              <i
                key={`${flag.kind}-${flag.at}-${i}`}
                className={flag.kind === 'ignition' ? styles.flagIgnition : styles.flagWeather}
                style={{ left: `${Math.min(100, Math.max(0, (flag.at / duration) * 100))}%` }}
                title={flag.label}
              />
            ))}
          </div>
        </div>

        {/* Floating Timeline Event Popover (Requirement 1.1) */}
        {selection && (
          <div
            className={styles.eventPopover}
            style={{
              left: `${Math.max(20, Math.min(80, highlightLeftPct + highlightWidthPct / 2))}%`,
            }}
          >
            <div className={styles.popoverHead}>
              <span>
                ⏱️ {selection.editingEventId ? 'Editar Evento' : 'Novo Evento'} (T+{selection.startMin}–{selection.endMin} min)
              </span>
              <button className={styles.popoverClose} onClick={() => setSelection(null)} title="Fechar">
                ✕
              </button>
            </div>

            {/* Event Type selector pills */}
            <div className={styles.typePills}>
              <button
                type="button"
                className={`${styles.typePill} ${popoverType === 'rain' ? styles.typePillActive : ''}`}
                onClick={() => setPopoverType('rain')}
              >
                🌧️ Chuva
              </button>
              <button
                type="button"
                className={`${styles.typePill} ${popoverType === 'storm' ? styles.typePillActive : ''}`}
                onClick={() => setPopoverType('storm')}
              >
                ⛈️ Trovoada
              </button>
              <button
                type="button"
                className={`${styles.typePill} ${popoverType === 'clouds' ? styles.typePillActive : ''}`}
                onClick={() => setPopoverType('clouds')}
              >
                🌫️ Nuvens
              </button>
              <button
                type="button"
                className={`${styles.typePill} ${popoverType === 'wind_shift' ? styles.typePillActive : ''}`}
                onClick={() => setPopoverType('wind_shift')}
              >
                💨 Vento
              </button>
              <button
                type="button"
                className={`${styles.typePill} ${popoverType === 'wind_scale' ? styles.typePillActive : ''}`}
                onClick={() => setPopoverType('wind_scale')}
              >
                🌪️ Rajada
              </button>
              <button
                type="button"
                className={`${styles.typePill} ${popoverType === 'heat_dry' ? styles.typePillActive : ''}`}
                onClick={() => setPopoverType('heat_dry')}
              >
                ☀️ Calor
              </button>
            </div>

            {/* Specific parameter controls depending on event type */}
            {popoverType === 'rain' && (
              <>
                <label className={styles.popoverField}>
                  <span>
                    Intensidade da Chuva: <b>{popoverRainMmH} mm/h</b>
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={30}
                    step={0.5}
                    value={popoverRainMmH}
                    onChange={(e) => setPopoverRainMmH(+e.target.value)}
                  />
                </label>
                <div className={styles.popoverNote}>
                  ☁️ <b>Formação realista:</b> As nuvens de chuva acumulam-se no céu 40 min antes de T+{selection.startMin} min (a partir de T+{Math.max(0, selection.startMin - 40)} min).
                </div>
              </>
            )}

            {popoverType === 'storm' && (
              <>
                <label className={styles.popoverField}>
                  <span>
                    Chuva Forte: <b>{popoverRainMmH} mm/h</b>
                  </span>
                  <input
                    type="range"
                    min={5}
                    max={50}
                    step={1}
                    value={popoverRainMmH}
                    onChange={(e) => setPopoverRainMmH(+e.target.value)}
                  />
                </label>
                <label className={styles.popoverField}>
                  <span>
                    Vento com Rajadas: <b>{popoverWindKmh} km/h</b>
                  </span>
                  <input
                    type="range"
                    min={20}
                    max={90}
                    step={2}
                    value={popoverWindKmh}
                    onChange={(e) => setPopoverWindKmh(+e.target.value)}
                  />
                </label>
                <div className={styles.popoverNote}>
                  ⚡ <b>Trovoada:</b> Nuvens escuras, relâmpagos ativos e rajadas intensas durante o intervalo.
                </div>
              </>
            )}

            {popoverType === 'clouds' && (
              <>
                <label className={styles.popoverField}>
                  <span>
                    Neblina / Cobertura: <b>{popoverCloudPct}%</b>
                  </span>
                  <input
                    type="range"
                    min={20}
                    max={100}
                    step={5}
                    value={popoverCloudPct}
                    onChange={(e) => setPopoverCloudPct(+e.target.value)}
                  />
                </label>
                <div className={styles.popoverNote}>
                  🌫️ Aumenta a humidade relativa e cobre o vale com nevoeiro orográfico denso.
                </div>
              </>
            )}

            {popoverType === 'wind_shift' && (
              <>
                <label className={styles.popoverField}>
                  <span>
                    Vento de (origem): <b>{popoverWindDeg}° ({compass(popoverWindDeg)})</b>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={360}
                    step={15}
                    value={popoverWindDeg}
                    onChange={(e) => setPopoverWindDeg(+e.target.value)}
                  />
                </label>
                <label className={styles.popoverField}>
                  <span>
                    Velocidade: <b>{popoverWindKmh} km/h</b>
                  </span>
                  <input
                    type="range"
                    min={5}
                    max={100}
                    step={1}
                    value={popoverWindKmh}
                    onChange={(e) => setPopoverWindKmh(+e.target.value)}
                  />
                </label>
              </>
            )}

            {popoverType === 'wind_scale' && (
              <label className={styles.popoverField}>
                <span>
                  Multiplicador de Rajada: <b>{popoverWindFactor}x</b>
                </span>
                <input
                  type="range"
                  min={1.1}
                  max={3.0}
                  step={0.1}
                  value={popoverWindFactor}
                  onChange={(e) => setPopoverWindFactor(+e.target.value)}
                />
              </label>
            )}

            {popoverType === 'heat_dry' && (
              <>
                <label className={styles.popoverField}>
                  <span>
                    Aumento Temp: <b>+{popoverTempDelta} °C</b>
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={12}
                    step={1}
                    value={popoverTempDelta}
                    onChange={(e) => setPopoverTempDelta(+e.target.value)}
                  />
                </label>
                <label className={styles.popoverField}>
                  <span>
                    Queda Humidade: <b>{popoverHumDelta} %</b>
                  </span>
                  <input
                    type="range"
                    min={-40}
                    max={-5}
                    step={5}
                    value={popoverHumDelta}
                    onChange={(e) => setPopoverHumDelta(+e.target.value)}
                  />
                </label>
              </>
            )}

            {/* Range adjustments */}
            <div className={styles.rangeInputs}>
              <label>
                Início: T+
                <input
                  type="number"
                  min={0}
                  max={selection.endMin - 5}
                  step={5}
                  value={selection.startMin}
                  onChange={(e) => {
                    const val = Math.max(0, Math.min(selection.endMin - 5, +e.target.value || 0));
                    setSelection((s) => (s ? { ...s, startMin: val } : null));
                  }}
                />
                min
              </label>
              <label>
                Fim: T+
                <input
                  type="number"
                  min={selection.startMin + 5}
                  max={duration}
                  step={5}
                  value={selection.endMin}
                  onChange={(e) => {
                    const val = Math.min(duration, Math.max(selection.startMin + 5, +e.target.value || 0));
                    setSelection((s) => (s ? { ...s, endMin: val } : null));
                  }}
                />
                min
              </label>
            </div>

            {/* Action buttons */}
            <div className={styles.popoverActions}>
              {selection.editingEventId && (
                <button type="button" className={styles.btnDelete} onClick={handleDeleteEvent} title="Remover este evento">
                  Remover
                </button>
              )}
              <button type="button" className={styles.btnSave} onClick={handleSaveEvent} title="Guardar evento no cenário sem simular logo">
                Guardar
              </button>
              <button
                type="button"
                className={styles.btnSimulate}
                onClick={handleSimulateWithEvent}
                title="Executar simulação com este evento meteorológico"
              >
                Simular com este Evento
              </button>
            </div>
          </div>
        )}
      </div>

      <label className="mut">
        Velocidade{' '}
        <select value={speed} onChange={(e) => setSpeed(+e.target.value)}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s} min/s
            </option>
          ))}
        </select>
      </label>
    </footer>
  );
}
