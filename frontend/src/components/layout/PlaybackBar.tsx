import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { planRequestsApi } from '@/api/services/planRequests';
import { Icon, WEATHER_EVENT_ICON, type IconName } from '@/components/common/Icon';
import { compass } from '@/domain/georef';
import {
  buildSimulationRequest,
  defaultFormValues,
  eventCapabilityNote,
  type CustomWeatherEventType,
  type TimelineRangeEvent,
} from '@/domain/simulationForm';
import { formatDateTime } from '@/domain/weather';
import { useSimulationActions } from '@/hooks/useSimulationActions';
import { useAppStore } from '@/store/appStore';

import styles from './layout.module.css';
import { SpeedControl } from './SpeedControl';

const JUMPS = [15, 30, 60, 120, 180, 360, 540, 720];
/** Hour ticks under the scrubber: every hour on short runs, every two on long ones. */
const tickStepMin = (duration: number) => (duration > 360 ? 120 : 60);

const EVENT_LABEL: Record<string, string> = {
  wind_shift: 'Vento roda',
  wind_scale: 'Vento muda',
  wind_set: 'Vento fixo',
  gust_burst: 'Rajada forte',
  humidity_shift: 'Humidade muda',
  temperature_shift: 'Temperatura muda',
  front_passage: 'Vento muda',
  precipitation: 'Chuva',
  custom_series: 'Série própria',
};

/** The popover's event-type pills, in display order — also the G6 capability-gating list. Wind is set through the front ("Vento": wind, temperature,
 * humidity and rain together); the separate rotation, multiplier and fixed-wind events are not offered (existing ones still show and can be removed). */
const TYPE_PILLS: { type: CustomWeatherEventType; icon: IconName; label: string }[] = [
  { type: 'rain', icon: 'rain', label: 'Chuva' },
  { type: 'storm', icon: 'storm', label: 'Trovoada' },
  { type: 'clouds', icon: 'cloud', label: 'Nuvens' },
  { type: 'gust_burst', icon: 'gust', label: 'Rajada' },
  { type: 'front_passage', icon: 'wind', label: 'Vento' },
  { type: 'temperature_shift', icon: 'thermometer', label: 'Temp.' },
  { type: 'humidity_shift', icon: 'humidity', label: 'Humidade' },
  { type: 'heat_dry', icon: 'sun', label: 'Calor' },
];

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
  const locationId = useAppStore((s) => s.locationId);
  const ignitions = useAppStore((s) => s.ignitions);
  const customEvents = useAppStore((s) => s.customEvents);
  const keyframes = useAppStore((s) => s.weatherKeyframes);
  const capabilities = useAppStore((s) => s.capabilities);
  const setPlaying = useAppStore((s) => s.setPlaying);
  const setTime = useAppStore((s) => s.setTime);
  const setCustomEvents = useAppStore((s) => s.setCustomEvents);
  const setScenario = useAppStore((s) => s.setScenario);
  const busy = useAppStore((s) => !!s.job && !s.job.auto);
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
  const [popoverTempDelta, setPopoverTempDelta] = useState(6);
  const [popoverHumDelta, setPopoverHumDelta] = useState(-20);
  const [popoverBuildupMin, setPopoverBuildupMin] = useState(20);
  const [popoverDissipationMin, setPopoverDissipationMin] = useState(20);
  const [popoverRampMin, setPopoverRampMin] = useState(15);
  const [popoverPeakGustKmh, setPopoverPeakGustKmh] = useState(70);
  const [popoverGustPeriodMin, setPopoverGustPeriodMin] = useState(5);
  const [popoverSetMode, setPopoverSetMode] = useState(false);
  const [popoverSetC, setPopoverSetC] = useState(35);
  const [popoverSetPct, setPopoverSetPct] = useState(20);
  const [popoverPressureDelta, setPopoverPressureDelta] = useState(-3);

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
    if (!TYPE_PILLS.some((pill) => pill.type === ev.type)) return; // a kind no longer offered: it shows and can be removed, not edited
    setSelection({
      startMin: ev.startMinute,
      endMin: ev.endMinute,
      editingEventId: ev.id,
    });
    setPopoverType(ev.type);
    setPopoverRainMmH(ev.type === 'front_passage' ? ev.precipitationMmH ?? 0 : ev.intensityMmH ?? 6);
    if (ev.cloudCoverPct != null) setPopoverCloudPct(ev.cloudCoverPct);
    if (ev.windKmh != null) setPopoverWindKmh(ev.windKmh);
    if (ev.windFromDeg != null) setPopoverWindDeg(ev.windFromDeg);
    if (ev.tempDeltaC != null) setPopoverTempDelta(ev.tempDeltaC);
    if (ev.humidityDeltaPct != null) setPopoverHumDelta(ev.humidityDeltaPct);
    setPopoverBuildupMin(ev.buildupMinutes ?? (ev.type === 'storm' ? 30 : ev.type === 'clouds' ? 15 : 20));
    setPopoverDissipationMin(ev.dissipationMinutes ?? 20);
    setPopoverRampMin(ev.rampMinutes ?? 15);
    setPopoverPeakGustKmh(ev.peakGustKmh ?? 70);
    setPopoverGustPeriodMin(ev.periodMinutes ?? 5);
    setPopoverSetMode(ev.setMode ?? false);
    setPopoverSetC(ev.setC ?? 35);
    setPopoverSetPct(ev.setPct ?? 20);
    setPopoverPressureDelta(ev.pressureDeltaHpa ?? -3);
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
      case 'gust_burst':
        label = `Rajada ${popoverPeakGustKmh} km/h (T+${startMin}–${endMin})`;
        break;
      case 'front_passage':
        label = `Vento ${compass(popoverWindDeg)} ${popoverWindKmh} km/h · ${popoverRainMmH} mm/h (T+${startMin}–${endMin})`;
        break;
      case 'temperature_shift':
        label = popoverSetMode
          ? `Temperatura = ${popoverSetC}°C (T+${startMin}–${endMin})`
          : `Temperatura ${popoverTempDelta > 0 ? '+' : ''}${popoverTempDelta}°C (T+${startMin}–${endMin})`;
        break;
      case 'humidity_shift':
        label = popoverSetMode
          ? `Humidade = ${popoverSetPct}% (T+${startMin}–${endMin})`
          : `Humidade ${popoverHumDelta > 0 ? '+' : ''}${popoverHumDelta}% (T+${startMin}–${endMin})`;
        break;
      case 'heat_dry':
        label = `Calor +${popoverTempDelta}°C (T+${startMin}–${endMin})`;
        break;
    }

    const hasRain = popoverType === 'rain' || popoverType === 'storm' || popoverType === 'front_passage';
    const hasWind = popoverType === 'storm' || popoverType === 'front_passage';
    const hasDir = popoverType === 'front_passage';
    const isInstantShift = popoverType === 'temperature_shift' || popoverType === 'humidity_shift';
    return {
      id,
      type: popoverType,
      label,
      enabled: true,
      startMinute: startMin,
      endMinute: endMin,
      intensityMmH: hasRain && popoverType !== 'front_passage' ? popoverRainMmH : undefined,
      precipitationMmH: popoverType === 'front_passage' ? popoverRainMmH : undefined,
      cloudCoverPct: popoverType === 'clouds' ? popoverCloudPct : undefined,
      windKmh: hasWind ? popoverWindKmh : undefined,
      windFromDeg: hasDir ? popoverWindDeg : undefined,
      rampMinutes: isInstantShift ? popoverRampMin : undefined,
      peakGustKmh: popoverType === 'gust_burst' ? popoverPeakGustKmh : undefined,
      periodMinutes: popoverType === 'gust_burst' ? popoverGustPeriodMin : undefined,
      setMode: isInstantShift ? popoverSetMode : undefined,
      setC: popoverType === 'temperature_shift' && popoverSetMode ? popoverSetC : undefined,
      setPct: popoverType === 'humidity_shift' && popoverSetMode ? popoverSetPct : undefined,
      pressureDeltaHpa: popoverType === 'front_passage' ? popoverPressureDelta : undefined,
      tempDeltaC:
        popoverType === 'heat_dry' || popoverType === 'storm' || popoverType === 'front_passage' || (popoverType === 'temperature_shift' && !popoverSetMode)
          ? popoverTempDelta
          : undefined,
      humidityDeltaPct:
        popoverType === 'heat_dry' || popoverType === 'clouds' || popoverType === 'front_passage' || (popoverType === 'humidity_shift' && !popoverSetMode)
          ? popoverHumDelta
          : undefined,
      buildupMinutes: (popoverType === 'rain' || popoverType === 'storm' || popoverType === 'clouds') ? popoverBuildupMin : undefined,
      dissipationMinutes: (popoverType === 'rain' || popoverType === 'storm' || popoverType === 'clouds') ? popoverDissipationMin : undefined,
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

  /** Stores `events` as the scenario's weather changes and runs the simulation again with them (the current run's start, duration and base weather). Returns the run's promise, or null when it could not start. */
  const rerunWith = (events: TimelineRangeEvent[]) => {
    setCustomEvents(events);
    setSelection(null);
    if (!run || !locationId || !ignitions.length || busy) return null;
    const values = defaultFormValues(run);
    values.customEvents = events;
    values.keyframes = keyframes;
    setScenario('custom');
    return runSimulation(buildSimulationRequest(values, locationId, ignitions));
  };

  // Remove a weather change from the timeline and simulate without it
  const removeEvent = (id: string) => rerunWith(customEvents.filter((x) => x.id !== id));

  const handleDeleteEvent = () => {
    if (selection?.editingEventId) removeEvent(selection.editingEventId);
  };

  // Run simulation with this custom weather event immediately (Requirement 1.1)
  const handleSimulateWithEvent = () => {
    const ev = buildCurrentEvent();
    if (ev) rerunWith([...customEvents.filter((x) => x.id !== ev.id), ev]);
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
            const width = Math.min(100 - left, ((ev.endMinute - ev.startMinute) / duration) * 100);
            return (
              <div
                key={ev.id}
                className={`${styles.eventChip} ${styles[`ev_${ev.type}`]}`}
                style={{ left: `${left}%`, width: `${width}%`, opacity: ev.enabled ? 1 : 0.45 }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => handleOpenEditEvent(ev, e)}
                title={`Clique para editar: ${ev.label} (T+${ev.startMinute}–${ev.endMinute} min)`}
              >
                <Icon name={WEATHER_EVENT_ICON[ev.type] ?? 'cloud'} size={12} />
                <span className={styles.eventChipLabel}>{ev.label}</span>
                <button
                  type="button"
                  className={styles.eventChipRemove}
                  disabled={busy}
                  aria-label={`Remover ${ev.label}`}
                  title={busy ? 'Aguarde o fim da simulação em curso' : 'Remover e simular sem este evento'}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeEvent(ev.id);
                  }}
                >
                  <Icon name="close" size={11} />
                </button>
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
          <div className={styles.hourTicks} aria-hidden="true">
            {Array.from({ length: Math.floor(duration / tickStepMin(duration)) + 1 }, (_, i) => i * tickStepMin(duration)).map((m) => (
              <span key={m} style={{ left: `${(m / duration) * 100}%` }}>
                {m / 60} h
              </span>
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
                {selection.editingEventId ? 'Editar evento' : 'Novo evento'} (T+{selection.startMin}–{selection.endMin} min)
              </span>
              <button className={styles.popoverClose} onClick={() => setSelection(null)} title="Fechar" aria-label="Fechar">
                <Icon name="close" />
              </button>
            </div>

            {/* Event Type selector pills (G6: disabled with the backend's reason when it doesn't support the event) */}
            <div className={styles.typePills}>
              {TYPE_PILLS.map((pill) => {
                const note = eventCapabilityNote(pill.type, capabilities);
                return (
                  <button
                    key={pill.type}
                    type="button"
                    className={`${styles.typePill} ${popoverType === pill.type ? styles.typePillActive : ''}`}
                    disabled={note != null}
                    title={note ?? undefined}
                    onClick={() => setPopoverType(pill.type)}
                  >
                    <Icon name={pill.icon} /> {pill.label}
                  </button>
                );
              })}
            </div>

            {/* Specific parameter controls depending on event type */}
            {popoverType === 'rain' && (
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
              </>
            )}

            {popoverType === 'clouds' && (
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
            )}

            {(popoverType === 'rain' || popoverType === 'storm' || popoverType === 'clouds') && (
              <>
                <label className={styles.popoverField}>
                  <span>
                    Construção Prévia: <b>{popoverBuildupMin} min</b>
                  </span>
                  <input
                    type="range"
                    min={5}
                    max={45}
                    step={5}
                    value={popoverBuildupMin}
                    onChange={(e) => setPopoverBuildupMin(+e.target.value)}
                  />
                </label>
                <label className={styles.popoverField}>
                  <span>
                    Dissipação Posterior: <b>{popoverDissipationMin} min</b>
                  </span>
                  <input
                    type="range"
                    min={5}
                    max={45}
                    step={5}
                    value={popoverDissipationMin}
                    onChange={(e) => setPopoverDissipationMin(+e.target.value)}
                  />
                </label>
                <div className={styles.popoverNote}>
                  <b>Ciclo realista:</b> As nuvens armam-se a partir de T+{Math.max(0, selection.startMin - popoverBuildupMin)} min ({popoverBuildupMin} min antes); a chuva cessa às T+{selection.endMin} min e as nuvens dissipam até T+{selection.endMin + popoverDissipationMin} min.
                </div>
              </>
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

            {popoverType === 'gust_burst' && (
              <>
                <label className={styles.popoverField}>
                  <span>
                    Rajada de pico: <b>{popoverPeakGustKmh} km/h</b>
                  </span>
                  <input type="range" min={30} max={150} step={5} value={popoverPeakGustKmh} onChange={(e) => setPopoverPeakGustKmh(+e.target.value)} />
                </label>
                <label className={styles.popoverField}>
                  <span>
                    Intervalo entre rajadas: <b>{popoverGustPeriodMin} min</b>
                  </span>
                  <input type="range" min={0.5} max={30} step={0.5} value={popoverGustPeriodMin} onChange={(e) => setPopoverGustPeriodMin(+e.target.value)} />
                </label>
              </>
            )}

            {popoverType === 'front_passage' && (
              <>
                <label className={styles.popoverField}>
                  <span>
                    Vento da frente: <b>{compass(popoverWindDeg)} {popoverWindKmh} km/h</b>
                  </span>
                  <input type="range" min={0} max={120} step={1} value={popoverWindKmh} onChange={(e) => setPopoverWindKmh(+e.target.value)} />
                </label>
                <label className={styles.popoverField}>
                  <span>
                    De (°): <b>{popoverWindDeg}° ({compass(popoverWindDeg)})</b>
                  </span>
                  <input type="range" min={0} max={360} step={15} value={popoverWindDeg} onChange={(e) => setPopoverWindDeg(+e.target.value)} />
                </label>
                <label className={styles.popoverField}>
                  <span>
                    Variação de temperatura: <b>{popoverTempDelta > 0 ? '+' : ''}{popoverTempDelta} °C</b>
                  </span>
                  <input type="range" min={-12} max={12} step={1} value={popoverTempDelta} onChange={(e) => setPopoverTempDelta(+e.target.value)} />
                </label>
                <label className={styles.popoverField}>
                  <span>
                    Variação de humidade: <b>{popoverHumDelta > 0 ? '+' : ''}{popoverHumDelta} %</b>
                  </span>
                  <input type="range" min={-40} max={40} step={5} value={popoverHumDelta} onChange={(e) => setPopoverHumDelta(+e.target.value)} />
                </label>
                <label className={styles.popoverField}>
                  <span>
                    Chuva: <b>{popoverRainMmH} mm/h</b>
                  </span>
                  <input type="range" min={0} max={50} step={0.5} value={popoverRainMmH} onChange={(e) => setPopoverRainMmH(+e.target.value)} />
                </label>
                <label className={styles.popoverField}>
                  <span>
                    Pressão: <b>{popoverPressureDelta > 0 ? '+' : ''}{popoverPressureDelta} hPa</b>
                  </span>
                  <input type="range" min={-20} max={20} step={1} value={popoverPressureDelta} onChange={(e) => setPopoverPressureDelta(+e.target.value)} />
                </label>
              </>
            )}

            {popoverType === 'temperature_shift' && (
              <>
                <label className={styles.popoverField} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={popoverSetMode} onChange={(e) => setPopoverSetMode(e.target.checked)} />
                  <span>Fixar valor absoluto (em vez de somar)</span>
                </label>
                {popoverSetMode ? (
                  <label className={styles.popoverField}>
                    <span>
                      Temperatura: <b>{popoverSetC} °C</b>
                    </span>
                    <input type="range" min={-10} max={50} step={1} value={popoverSetC} onChange={(e) => setPopoverSetC(+e.target.value)} />
                  </label>
                ) : (
                  <label className={styles.popoverField}>
                    <span>
                      Variação: <b>{popoverTempDelta > 0 ? '+' : ''}{popoverTempDelta} °C</b>
                    </span>
                    <input type="range" min={-12} max={12} step={1} value={popoverTempDelta} onChange={(e) => setPopoverTempDelta(+e.target.value)} />
                  </label>
                )}
                <label className={styles.popoverField}>
                  <span>
                    Transição: <b>{popoverRampMin} min</b>
                  </span>
                  <input type="range" min={0} max={60} step={5} value={popoverRampMin} onChange={(e) => setPopoverRampMin(+e.target.value)} />
                </label>
              </>
            )}

            {popoverType === 'humidity_shift' && (
              <>
                <label className={styles.popoverField} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={popoverSetMode} onChange={(e) => setPopoverSetMode(e.target.checked)} />
                  <span>Fixar valor absoluto (em vez de somar)</span>
                </label>
                {popoverSetMode ? (
                  <label className={styles.popoverField}>
                    <span>
                      Humidade: <b>{popoverSetPct} %</b>
                    </span>
                    <input type="range" min={1} max={100} step={1} value={popoverSetPct} onChange={(e) => setPopoverSetPct(+e.target.value)} />
                  </label>
                ) : (
                  <label className={styles.popoverField}>
                    <span>
                      Variação: <b>{popoverHumDelta > 0 ? '+' : ''}{popoverHumDelta} %</b>
                    </span>
                    <input type="range" min={-40} max={40} step={5} value={popoverHumDelta} onChange={(e) => setPopoverHumDelta(+e.target.value)} />
                  </label>
                )}
                <label className={styles.popoverField}>
                  <span>
                    Transição: <b>{popoverRampMin} min</b>
                  </span>
                  <input type="range" min={0} max={60} step={5} value={popoverRampMin} onChange={(e) => setPopoverRampMin(+e.target.value)} />
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
                <button type="button" className={styles.btnDelete} onClick={handleDeleteEvent} disabled={busy} title="Remover este evento e simular sem ele">
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

      <SpeedControl />
    </footer>
  );
}
