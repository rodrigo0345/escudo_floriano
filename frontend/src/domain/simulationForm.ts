import type { Capabilities, Ignition, SimulationRequest, WeatherEvent, WeatherKeyframe, WeatherResolveRequest, WeatherSample, WeatherSpec } from '@/api';

import { weatherMeans, type WeatherBaseStats } from './weather';

/** Weather edits to the real series also apply during the fuel warm-up window before the start. */
const WHOLE_RUN_PADDING_MIN = 720;

/** Minutes the fire's extent is marked on the map and listed in the incident panel (up to the 12 h maximum run). */
export const MILESTONE_MINUTES = [15, 30, 60, 120, 180, 360, 540, 720];

export type WeatherMode = 'provider' | 'manual';

/** @deprecated DEADCODE: Sistema legado de presets meteorológicos fixos; substituído por TimelineRangeEvent / customEvents */
export type PresetId = 'front' | 'breeze' | 'afternoon' | 'rain_shower' | 'storm' | 'fog' | 'second_ignition';

/** @deprecated DEADCODE: Estrutura legada de presets meteorológicos */
export interface PresetWeatherEvent {
  id: PresetId;
  label: string;
  enabled: boolean;
  events: WeatherEvent[];
}

export type CustomWeatherEventType =
  | 'rain'
  | 'storm'
  | 'clouds'
  | 'wind_shift'
  | 'wind_scale'
  | 'wind_set'
  | 'gust_burst'
  | 'front_passage'
  | 'temperature_shift'
  | 'humidity_shift'
  | 'heat_dry';

/**
 * Capability gating (G6): each UI event type maps to every backend weather event and base
 * variable `buildWeatherSpec` emits for it below — keep the two in step, or the buttons gate
 * on the wrong capabilities (a disabled event the engine supports, or an enabled one it rejects).
 */
const EVENT_REQUIRES: Record<CustomWeatherEventType, { events: string[]; variables: string[] }> = {
  rain: { events: ['precipitation'], variables: ['precipitationMmH'] },
  // a storm is rain + a fixed strong wind + a temperature drop (see `ce.type === 'storm'` below)
  storm: { events: ['precipitation', 'wind_set', 'temperature_shift'], variables: ['precipitationMmH', 'windKmh', 'tempC'] },
  // "clouds" lowers humidity/temperature; cloud cover itself is only a display keyframe, not a weather event
  clouds: { events: ['humidity_shift', 'temperature_shift'], variables: ['humidityPct', 'tempC'] },
  // `wind_shift` only turns the wind; when a speed is set it also emits `wind_set`
  wind_shift: { events: ['wind_shift', 'wind_set'], variables: ['windFromDeg', 'windKmh'] },
  wind_scale: { events: ['wind_scale'], variables: ['windKmh'] },
  wind_set: { events: ['wind_set'], variables: ['windKmh'] },
  gust_burst: { events: ['gust_burst'], variables: ['gustKmh'] },
  front_passage: { events: ['front_passage'], variables: ['windKmh'] },
  temperature_shift: { events: ['temperature_shift'], variables: ['tempC'] },
  humidity_shift: { events: ['humidity_shift'], variables: ['humidityPct'] },
  heat_dry: { events: ['temperature_shift', 'humidity_shift'], variables: ['tempC', 'humidityPct'] },
};

/** Why a UI event type is not addable with the backend's current capabilities (null = no problem). */
export function eventCapabilityNote(type: CustomWeatherEventType, capabilities: Capabilities | null): string | null {
  if (!capabilities) return null; // sem capabilities (backend antigo ou a arrancar), não bloqueamos
  const req = EVENT_REQUIRES[type];
  // An absent list means the server does not advertise that dimension (the spec only requires `apiVersion`),
  // not that it supports nothing: gate only on the lists that were actually reported.
  const missing = [
    ...(capabilities.weatherEvents ? req.events.filter((name) => !capabilities.weatherEvents!.some((e) => e.name === name && e.supported)) : []),
    ...(capabilities.weatherVariables ? req.variables.filter((name) => !capabilities.weatherVariables!.some((v) => v.name === name && v.supported)) : []),
  ];
  if (!missing.length) return null;
  const notes = [...(capabilities.weatherEvents ?? []), ...(capabilities.weatherVariables ?? [])]
    .filter((c) => missing.includes(c.name) && c.note)
    .map((c) => c.note);
  return `O motor ainda não suporta: ${missing.join(', ')}.${notes.length ? ` ${[...new Set(notes)].join(' ')}` : ''}`;
}

/**
 * Interactive range-based weather event (Requirement 1 & 1.1):
 * Controls weather changes over a specified interval [startMinute, endMinute].
 */
export interface TimelineRangeEvent {
  id: string;
  type: CustomWeatherEventType;
  label: string;
  enabled: boolean;
  startMinute: number;
  endMinute: number;
  // Spatial scope & dimension (Point 2)
  scope?: 'global' | 'local'; // 'global' = whole concelho map (default), 'local' = focused spot
  centerLat?: number;
  centerLon?: number;
  radiusKm?: number;          // radius in km (default 4 km)
  // Parâmetros de ciclo de vida atmosférico (construção prévia e dissipação posterior)
  buildupMinutes?: number;      // Antecedência de formação das nuvens antes de startMinute (default: 20-30 min)
  dissipationMinutes?: number;  // Tempo de dissipação das nuvens após endMinute (default: 20-25 min)
  // Specific parameters
  intensityMmH?: number;     // for rain (default 6.0 mm/h)
  cloudCoverPct?: number;    // for clouds / fog (default 80%)
  windKmh?: number;          // for wind shift / storm (default 38 km/h)
  windFromDeg?: number;      // for wind shift (default 270°)
  windFactor?: number;       // for wind scale (default 1.7)
  applyToGusts?: boolean;    // for wind scale (default true: scale gusts together with mean wind)
  tempDeltaC?: number;       // for temperature shift (-10 to +10 °C)
  humidityDeltaPct?: number; // for humidity shift (-30 to +30 %)
  rampMinutes?: number;      // transition for wind_set / temperature_shift / humidity_shift
  peakGustKmh?: number;      // for gust_burst
  periodMinutes?: number;    // for gust_burst (minutes between gusts)
  setMode?: boolean;         // temperature/humidity shift: fix the value instead of adding a delta
  setC?: number;             // absolute temperature when setMode
  setPct?: number;           // absolute humidity when setMode
  precipitationMmH?: number; // for front_passage
  pressureDeltaHpa?: number; // for front_passage
  deltaDeg?: number;         // for wind_shift without an absolute target
  holdMinutes?: number | null; // wind_shift: null preserves the contract's indefinite hold
  returnRampMinutes?: number;
  rotation?: 'shortest_arc' | 'clockwise' | 'counter_clockwise';
}

/**
 * A sparse point on the weather curve (`WeatherSpec.keyframes`): only the variables set here are
 * fixed at `minute`; the rest keep following the provider series or the previous point.
 */
export interface TimelineKeyframe {
  id: string;
  minute: number;
  label?: string;
  transition?: 'linear' | 'smooth' | 'step';
  windKmh?: number;
  windFromDeg?: number;
  gustKmh?: number;
  humidityPct?: number;
  tempC?: number;
  precipitationMmH?: number;
  cloudCoverPct?: number;
}

export interface SimulationFormValues {
  start: string; // datetime-local, interpreted as UTC
  duration: number;
  mode: WeatherMode;
  windKmh: number;
  windFromDeg: number;
  humPct: number;
  tempC: number;
  precipitationMmH: number;
  cloudCoverPct: number;
  members: number;
  /** @deprecated DEADCODE: Presets legados; substituídos por customEvents (TimelineRangeEvent) */
  presetEvents: PresetWeatherEvent[];
  customEvents: TimelineRangeEvent[];
  /** Sparse curve points drawn on the timeline (arbitrary keyframe curves). */
  keyframes: TimelineKeyframe[];
}

const DEFAULT_BASE: WeatherBaseStats = { windKmh: 20, dirDeg: 335, humPct: 25, tempC: 25 };

const round = (v: number, d = 0) => Math.round(v * 10 ** d) / 10 ** d;
const isoLocal = (d: string | number | Date) => new Date(d).toISOString().slice(0, 16);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const normalizeDeg = (deg: number) => ((deg % 360) + 360) % 360;

/** Shortest signed difference between two bearings, in degrees. */
export const bearingDelta = (to: number, from: number): number => ((((to - from + 540) % 360) + 360) % 360) - 180;

const wholeRunWindow = (duration: number) => ({
  start: { offsetMinutes: -WHOLE_RUN_PADDING_MIN },
  end: { offsetMinutes: duration + WHOLE_RUN_PADDING_MIN },
});

/** Factory to create a new interactive range-based weather event (Requirement 1 & 1.1) */
export function createTimelineRangeEvent(
  type: CustomWeatherEventType,
  startMinute: number,
  endMinute: number,
  duration = 180,
): TimelineRangeEvent {
  const safeStart = Math.max(0, Math.min(duration - 5, startMinute));
  const safeEnd = Math.max(safeStart + 5, Math.min(duration, endMinute));
  const id = `ev_${type}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  switch (type) {
    case 'rain':
      return {
        id,
        type: 'rain',
        label: `Chuva (T+${safeStart}–${safeEnd})`,
        enabled: true,
        startMinute: safeStart,
        endMinute: safeEnd,
        intensityMmH: 6.0,
        buildupMinutes: 20,
        dissipationMinutes: 20,
      };
    case 'storm':
      return {
        id,
        type: 'storm',
        label: `Trovoada (T+${safeStart}–${safeEnd})`,
        enabled: true,
        startMinute: safeStart,
        endMinute: safeEnd,
        intensityMmH: 15.0,
        windKmh: 42,
        windFromDeg: 240,
        tempDeltaC: -5,
        buildupMinutes: 30,
        dissipationMinutes: 25,
      };
    case 'clouds':
      return {
        id,
        type: 'clouds',
        label: `Neblina / Nuvens (T+${safeStart}–${safeEnd})`,
        enabled: true,
        startMinute: safeStart,
        endMinute: safeEnd,
        cloudCoverPct: 85,
        humidityDeltaPct: 25,
        tempDeltaC: -3,
        buildupMinutes: 15,
        dissipationMinutes: 20,
      };
    case 'wind_shift':
      return {
        id,
        type: 'wind_shift',
        label: `Rotação de Vento (T+${safeStart}–${safeEnd})`,
        enabled: true,
        startMinute: safeStart,
        endMinute: safeEnd,
        windFromDeg: 270,
        windKmh: 35,
      };
    case 'wind_scale':
      return {
        id,
        type: 'wind_scale',
        label: `Brisa Forte (T+${safeStart}–${safeEnd})`,
        enabled: true,
        startMinute: safeStart,
        endMinute: safeEnd,
        windFactor: 1.7,
      };
    case 'wind_set':
      return {
        id,
        type: 'wind_set',
        label: `Vento fixo (T+${safeStart}–${safeEnd})`,
        enabled: true,
        startMinute: safeStart,
        endMinute: safeEnd,
        windKmh: 30,
        windFromDeg: 270,
        rampMinutes: 15,
      };
    case 'gust_burst':
      return {
        id,
        type: 'gust_burst',
        label: `Rajada forte (T+${safeStart}–${safeEnd})`,
        enabled: true,
        startMinute: safeStart,
        endMinute: safeEnd,
        peakGustKmh: 70,
        periodMinutes: 5,
      };
    case 'front_passage':
      return {
        id,
        type: 'front_passage',
        label: `Passagem de frente (T+${safeStart}–${safeEnd})`,
        enabled: true,
        startMinute: safeStart,
        endMinute: safeEnd,
        windKmh: 42,
        windFromDeg: 240,
        tempDeltaC: -6,
        humidityDeltaPct: 30,
        precipitationMmH: 4,
        pressureDeltaHpa: -3,
      };
    case 'temperature_shift':
      return {
        id,
        type: 'temperature_shift',
        label: `Temperatura (T+${safeStart}–${safeEnd})`,
        enabled: true,
        startMinute: safeStart,
        endMinute: safeEnd,
        setMode: false,
        tempDeltaC: 5,
        rampMinutes: 15,
      };
    case 'humidity_shift':
      return {
        id,
        type: 'humidity_shift',
        label: `Humidade (T+${safeStart}–${safeEnd})`,
        enabled: true,
        startMinute: safeStart,
        endMinute: safeEnd,
        setMode: false,
        humidityDeltaPct: -15,
        rampMinutes: 15,
      };
    case 'heat_dry':
      return {
        id,
        type: 'heat_dry',
        label: `Calor e Seca (T+${safeStart}–${safeEnd})`,
        enabled: true,
        startMinute: safeStart,
        endMinute: safeEnd,
        tempDeltaC: 6,
        humidityDeltaPct: -20,
      };
  }
}

/** @deprecated DEADCODE: The one-click recipes for weather shifts, rain, storms, fog, and secondary ignitions (substituído por TimelineRangeEvent). */
export function createPresetEvents(duration: number): PresetWeatherEvent[] {
  return [
    {
      id: 'front',
      label: 'Frente de vento (T+60)',
      enabled: false,
      events: [{ type: 'wind_shift', enabled: true, start: { offsetMinutes: 60 }, deltaDeg: 90, rampMinutes: 30 }],
    },
    {
      id: 'breeze',
      label: 'Brisa forte (T+45–120)',
      enabled: false,
      events: [
        {
          type: 'wind_scale',
          enabled: true,
          applyToGusts: true,
          window: { start: { offsetMinutes: 45 }, end: { offsetMinutes: Math.min(120, duration) } },
          factor: 1.7,
        },
      ],
    },
    {
      id: 'afternoon',
      label: 'Tarde seca (T+90–fim)',
      enabled: false,
      events: [
        {
          type: 'humidity_shift',
          enabled: true,
          window: { start: { offsetMinutes: 90 }, end: { offsetMinutes: Math.max(91, duration) } },
          deltaPct: -20,
        },
        {
          type: 'temperature_shift',
          enabled: true,
          window: { start: { offsetMinutes: 90 }, end: { offsetMinutes: Math.max(91, duration) } },
          deltaC: 6,
        },
        {
          type: 'wind_scale',
          enabled: true,
          applyToGusts: true,
          window: { start: { offsetMinutes: 90 }, end: { offsetMinutes: Math.max(91, duration) } },
          factor: 0.85,
        },
      ],
    },
    {
      id: 'rain_shower',
      label: 'Aguaceiros (T+30–90)',
      enabled: false,
      events: [
        {
          type: 'precipitation',
          enabled: true,
          window: { start: { offsetMinutes: 30 }, end: { offsetMinutes: Math.min(90, duration) } },
          intensityMmH: 6.0,
          rampMinutes: 10,
        },
      ],
    },
    {
      id: 'storm',
      label: 'Trovoada / Frente (T+60)',
      enabled: false,
      events: [
        {
          type: 'precipitation',
          enabled: true,
          window: { start: { offsetMinutes: 60 }, end: { offsetMinutes: Math.min(120, duration) } },
          intensityMmH: 15.0,
          rampMinutes: 5,
        },
        {
          type: 'wind_scale',
          enabled: true,
          applyToGusts: true,
          window: { start: { offsetMinutes: 60 }, end: { offsetMinutes: Math.min(120, duration) } },
          factor: 1.8,
        },
        {
          type: 'temperature_shift',
          enabled: true,
          window: { start: { offsetMinutes: 60 }, end: { offsetMinutes: duration } },
          deltaC: -6,
        },
      ],
    },
    {
      id: 'fog',
      label: 'Neblina matinal (T+0–60)',
      enabled: false,
      events: [
        {
          type: 'humidity_shift',
          enabled: true,
          window: { start: { offsetMinutes: 0 }, end: { offsetMinutes: Math.min(60, duration) } },
          deltaPct: 35,
        },
        {
          type: 'temperature_shift',
          enabled: true,
          window: { start: { offsetMinutes: 0 }, end: { offsetMinutes: Math.min(60, duration) } },
          deltaC: -5,
        },
        {
          type: 'wind_scale',
          enabled: true,
          applyToGusts: true,
          window: { start: { offsetMinutes: 0 }, end: { offsetMinutes: Math.min(60, duration) } },
          factor: 0.5,
        },
      ],
    },
    { id: 'second_ignition', label: '2.º foco (T+45)', enabled: false, events: [] },
  ];
}

/** @deprecated DEADCODE: Rebuild preset windows after the duration changes, preserving which presets are enabled. */
export function resizePresetEvents(presets: PresetWeatherEvent[], duration: number): PresetWeatherEvent[] {
  const defaults = createPresetEvents(duration);
  return presets.map((p) => ({ ...p, events: defaults.find((d) => d.id === p.id)?.events ?? p.events }));
}

/** Keeps custom event intervals within scenario duration bounds. */
export function resizeCustomEvents(events: TimelineRangeEvent[], duration: number): TimelineRangeEvent[] {
  return events.map((e) => {
    const start = Math.min(e.startMinute, Math.max(0, duration - 10));
    const end = Math.min(duration, Math.max(start + 5, e.endMinute));
    return { ...e, startMinute: start, endMinute: end };
  });
}

/** Editing the visible interval also changes a finite wind hold; an indefinite hold stays indefinite. */
export function updateTimelineRangeEvent(event: TimelineRangeEvent, patch: Partial<TimelineRangeEvent>): TimelineRangeEvent {
  const next = { ...event, ...patch };
  if (next.type === 'wind_shift' && next.holdMinutes != null &&
      ['startMinute', 'endMinute', 'rampMinutes', 'returnRampMinutes'].some((key) => key in patch)) {
    const ramp = next.rampMinutes ?? 0;
    next.holdMinutes = Math.max(1, next.endMinute - next.startMinute - ramp - (next.returnRampMinutes ?? ramp));
  }
  return next;
}

/** @deprecated DEADCODE: Validação de disponibilidade de presets meteorológicos legados */
export const presetAvailable = (id: PresetId, duration: number, baseWindKmh?: number | null): boolean => {
  if (id === 'second_ignition') return true;
  if (id === 'fog') return duration >= 30;
  if (id === 'rain_shower') return duration >= 45;
  if (id === 'storm') return duration >= 75;
  if (baseWindKmh != null && baseWindKmh <= 0.1) return false;
  if (id === 'front') return duration >= 90;
  if (id === 'breeze') return duration >= 120;
  return duration >= 91;
};

/** Initial form values: the scenario's start and duration, with provider/base means when available. */
export function defaultFormValues(
  run?: { startMs: number; durationMinutes: number; weather?: WeatherSample[] } | null,
  base?: WeatherBaseStats | null,
): SimulationFormValues {
  const duration = run?.durationMinutes ?? 180;
  const start = run?.startMs != null ? isoLocal(run.startMs) : '2026-08-17T12:00';
  const currentSample = run?.weather?.[0];
  const stats = base ?? DEFAULT_BASE;
  return {
    start,
    duration,
    mode: 'provider',
    windKmh: round(stats.windKmh, 0),
    windFromDeg: round(stats.dirDeg, 0),
    humPct: round(stats.humPct, 1),
    tempC: round(stats.tempC, 1),
    precipitationMmH: round(currentSample?.precipitationMmH ?? 0, 1),
    cloudCoverPct: round(currentSample?.cloudCoverPct ?? 0, 0),
    members: 12,
    presetEvents: createPresetEvents(duration),
    customEvents: [],
    keyframes: [],
  };
}

/** A new sparse keyframe: only `minute` and the seeded variables are fixed, the rest stay on the base/previous curve. */
export function createTimelineKeyframe(
  minute: number,
  seed: Omit<TimelineKeyframe, 'id' | 'minute'> = {},
): TimelineKeyframe {
  return {
    id: `kf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    minute: Math.max(0, Math.round(minute)),
    transition: 'linear',
    ...seed,
  };
}

/** Absolute form weather, relative to the provider base, expressed as the contract's weather events. */
export function buildWeatherSpec(v: SimulationFormValues, base?: WeatherBaseStats | null): WeatherSpec {
  const events: WeatherEvent[] = [];
  const whole = wholeRunWindow(v.duration);

  if (v.mode === 'provider' && base) {
    if (base.windKmh > 0.1) {
      const factor = clamp(v.windKmh / base.windKmh, 0, 5);
      if (Math.abs(factor - 1) > 0.01) events.push({ type: 'wind_scale', enabled: true, applyToGusts: true, window: whole, factor });

      const dirDelta = bearingDelta(normalizeDeg(v.windFromDeg), base.dirDeg);
      if (Math.abs(dirDelta) > 0.5) {
        events.push({
          type: 'wind_shift',
          enabled: true,
          start: { offsetMinutes: -WHOLE_RUN_PADDING_MIN },
          deltaDeg: dirDelta,
        });
      }
    } else if (v.windKmh > 0) {
      events.push({
        type: 'wind_set',
        enabled: true,
        window: whole,
        windKmh: v.windKmh,
        windFromDeg: normalizeDeg(v.windFromDeg),
      });
    }
    if (Math.abs(v.humPct - base.humPct) > 0.5) {
      events.push({ type: 'humidity_shift', enabled: true, window: whole, deltaPct: v.humPct - base.humPct });
    }
    if (Math.abs(v.tempC - base.tempC) > 0.5) {
      events.push({ type: 'temperature_shift', enabled: true, window: whole, deltaC: v.tempC - base.tempC });
    }
    if (v.precipitationMmH > 0) {
      events.push({
        type: 'precipitation',
        enabled: true,
        window: whole,
        intensityMmH: v.precipitationMmH,
      });
    }
  }

  // DEADCODE: Process legacy presets (mantido apenas por compatibilidade com snapshots antigos)
  for (const preset of v.presetEvents ?? []) {
    if (!preset.enabled || !presetAvailable(preset.id, v.duration, v.mode === 'provider' ? base?.windKmh : undefined)) continue;
    events.push(...preset.events);
  }

  // Process dynamic range-based custom events (Requirement 1 & 1.1)
  for (const ce of v.customEvents ?? []) {
    if (!ce.enabled) continue;
    const dur = Math.max(5, ce.endMinute - ce.startMinute);
    const win = {
      start: { offsetMinutes: ce.startMinute },
      end: { offsetMinutes: ce.endMinute },
    };

    if (ce.type === 'rain') {
      const rainRamp = Math.min(8, Math.max(2, Math.round(dur * 0.15)));
      events.push({
        type: 'precipitation',
        enabled: true,
        window: win,
        intensityMmH: ce.intensityMmH ?? 6.0,
        rampMinutes: rainRamp,
      });
    } else if (ce.type === 'storm') {
      const rainRamp = Math.min(10, Math.max(3, Math.round(dur * 0.15)));
      events.push(
        {
          type: 'precipitation',
          enabled: true,
          window: win,
          intensityMmH: ce.intensityMmH ?? 15.0,
          rampMinutes: rainRamp,
        },
        {
          type: 'wind_set',
          enabled: true,
          window: win,
          windKmh: ce.windKmh ?? 42,
          rampMinutes: rainRamp,
        },
        {
          type: 'temperature_shift',
          enabled: true,
          window: win,
          deltaC: ce.tempDeltaC ?? -5,
        },
      );
    } else if (ce.type === 'clouds') {
      events.push(
        {
          type: 'humidity_shift',
          enabled: true,
          window: win,
          deltaPct: ce.humidityDeltaPct ?? 25,
        },
        {
          type: 'temperature_shift',
          enabled: true,
          window: win,
          deltaC: ce.tempDeltaC ?? -3,
        },
      );
    } else if (ce.type === 'wind_shift') {
      const dur = Math.max(5, ce.endMinute - ce.startMinute);
      const ramp = ce.rampMinutes ?? Math.min(15, Math.max(1, Math.floor((dur - 1) / 2)), Math.max(3, Math.round(dur * 0.2)));
      const back = ce.returnRampMinutes ?? ramp;
      const hold = ce.holdMinutes === null ? undefined : ce.holdMinutes ?? Math.max(1, dur - ramp - back);
      events.push({
        type: 'wind_shift',
        enabled: true,
        start: { offsetMinutes: ce.startMinute },
        toDeg: ce.windFromDeg != null ? normalizeDeg(ce.windFromDeg) : undefined,
        deltaDeg: ce.windFromDeg == null ? (ce.deltaDeg ?? 90) : undefined,
        rampMinutes: ramp,
        holdMinutes: hold,
        returnRampMinutes: hold == null ? ce.returnRampMinutes : back,
        ...(ce.rotation ? { rotation: ce.rotation } : {}),
      });
      // `wind_shift` changes direction only; the speed field of the same event needs its own `wind_set`.
      if (ce.windKmh != null) {
        events.push({ type: 'wind_set', enabled: true, window: win, windKmh: ce.windKmh, rampMinutes: ramp });
      }
    } else if (ce.type === 'wind_scale') {
      events.push({
        type: 'wind_scale',
        enabled: true,
        applyToGusts: ce.applyToGusts ?? false,
        window: win,
        factor: ce.windFactor ?? 1.7,
      });
    } else if (ce.type === 'wind_set') {
      events.push({
        type: 'wind_set',
        enabled: true,
        window: win,
        windKmh: ce.windKmh ?? 30,
        windFromDeg: ce.windFromDeg != null ? normalizeDeg(ce.windFromDeg) : undefined,
        rampMinutes: ce.rampMinutes ?? 15,
      });
    } else if (ce.type === 'gust_burst') {
      events.push({
        type: 'gust_burst',
        enabled: true,
        window: win,
        peakGustKmh: ce.peakGustKmh ?? 70,
        periodMinutes: ce.periodMinutes ?? 5,
      });
    } else if (ce.type === 'front_passage') {
      events.push({
        type: 'front_passage',
        enabled: true,
        at: { offsetMinutes: ce.startMinute },
        durationMinutes: Math.max(1, dur),
        windKmh: ce.windKmh,
        windFromDeg: ce.windFromDeg != null ? normalizeDeg(ce.windFromDeg) : undefined,
        tempDeltaC: ce.tempDeltaC,
        humidityDeltaPct: ce.humidityDeltaPct,
        pressureDeltaHpa: ce.pressureDeltaHpa,
        precipitationMmH: ce.precipitationMmH,
      });
    } else if (ce.type === 'temperature_shift') {
      events.push({
        type: 'temperature_shift',
        enabled: true,
        window: win,
        ...(ce.setMode ? { setC: ce.setC ?? 35 } : { deltaC: ce.tempDeltaC ?? 5 }),
        rampMinutes: ce.rampMinutes ?? 15,
      });
    } else if (ce.type === 'humidity_shift') {
      events.push({
        type: 'humidity_shift',
        enabled: true,
        window: win,
        ...(ce.setMode ? { setPct: ce.setPct ?? 20 } : { deltaPct: ce.humidityDeltaPct ?? -15 }),
        rampMinutes: ce.rampMinutes ?? 15,
      });
    } else if (ce.type === 'heat_dry') {
      events.push(
        {
          type: 'temperature_shift',
          enabled: true,
          window: win,
          deltaC: ce.tempDeltaC ?? 6,
        },
        {
          type: 'humidity_shift',
          enabled: true,
          window: win,
          deltaPct: ce.humidityDeltaPct ?? -20,
        },
      );
    }
  }

  // Arbitrary curve points: sparse keyframes fixed by the operator on the timeline.
  const curve: WeatherKeyframe[] = (v.keyframes ?? [])
    .filter((k) => k.minute >= 0)
    .sort((a, b) => a.minute - b.minute)
    .map((k) => ({
      at: { offsetMinutes: k.minute },
      ...(k.label ? { label: k.label } : {}),
      ...(k.transition ? { transition: k.transition } : {}),
      ...(k.windKmh != null ? { windKmh: k.windKmh } : {}),
      ...(k.windFromDeg != null ? { windFromDeg: normalizeDeg(k.windFromDeg) } : {}),
      ...(k.gustKmh != null ? { gustKmh: k.gustKmh } : {}),
      ...(k.humidityPct != null ? { humidityPct: k.humidityPct } : {}),
      ...(k.tempC != null ? { tempC: k.tempC } : {}),
      ...(k.precipitationMmH != null ? { precipitationMmH: k.precipitationMmH } : {}),
      ...(k.cloudCoverPct != null ? { cloudCoverPct: k.cloudCoverPct } : {}),
    }));

  const spec: WeatherSpec =
    v.mode === 'manual'
      ? {
          base: 'none',
          keyframes: [
            {
              at: { offsetMinutes: 0 },
              windKmh: v.windKmh,
              windFromDeg: normalizeDeg(v.windFromDeg),
              humidityPct: v.humPct,
              tempC: v.tempC,
              ...(v.precipitationMmH > 0 ? { precipitationMmH: v.precipitationMmH } : {}),
              ...(v.cloudCoverPct > 0 ? { cloudCoverPct: v.cloudCoverPct } : {}),
            },
            ...curve,
          ],
        }
      : { base: 'provider', ...(curve.length ? { keyframes: curve } : {}) };
  return events.length ? { ...spec, events } : spec;
}

export const formStartToIso = (local: string): string => new Date(`${local}:00Z`).toISOString();

/** The weather preview request (`POST /weather/resolve`). */
export function buildWeatherResolveRequest(
  v: SimulationFormValues,
  locationId: string,
  base?: WeatherBaseStats | null,
): WeatherResolveRequest {
  return {
    locationId,
    start: formStartToIso(v.start),
    durationMinutes: v.duration,
    weather: buildWeatherSpec(v, base),
    stepMinutes: 5,
  };
}

export const buildPreviewRequest = buildWeatherResolveRequest;

/**
 * Extracts custom events from a scenario snapshot's weather spec so they can be
 * visualized and edited interactively on the timeline and form.
 */
export function extractTimelineEventsFromSnapshot(
  snapshot?: { weather?: { events?: WeatherEvent[] } } | null,
  duration = 180,
  startMs?: number,
): TimelineRangeEvent[] {
  if (!snapshot?.weather?.events) return [];
  const result: TimelineRangeEvent[] = [];
  let idx = 1;

  const minutes = (spec: unknown): number | null => {
    if (!spec || typeof spec !== 'object') return null;
    const s = spec as { offsetMinutes?: number; time?: string };
    if (typeof s.offsetMinutes === 'number') return s.offsetMinutes;
    if (s.time && startMs != null) {
      const at = Date.parse(s.time);
      return Number.isFinite(at) ? (at - startMs) / 60_000 : null;
    }
    return null;
  };
  const windowOf = (e: Record<string, unknown>) => {
    const w = e.window as { start?: unknown; end?: unknown } | undefined;
    return { start: minutes(w?.start) ?? 0, end: minutes(w?.end) ?? duration };
  };
  /** Whole-run padding (e.g. the absolute base adjustment built by the form) is not an editable event. */
  const wholeRun = (start: number, end: number) => start < -10 || (start <= 0 && end >= duration + 30);

  for (const raw of snapshot.weather.events) {
    if (raw.enabled === false) continue;
    const e = raw as unknown as Record<string, any>;
    switch (raw.type) {
      case 'precipitation': {
        const { start, end } = windowOf(e);
        if (wholeRun(start, end)) continue;
        const safeStart = Math.max(0, start);
        const safeEnd = Math.min(duration, end);
        if (safeEnd <= safeStart) continue;
        result.push({
          id: `ev_rain_${idx++}`,
          type: 'rain',
          label: `Chuva (T+${safeStart}–${safeEnd})`,
          enabled: true,
          startMinute: safeStart,
          endMinute: safeEnd,
          intensityMmH: e.intensityMmH ?? 6.0,
        });
        break;
      }
      case 'wind_shift': {
        const start = minutes(e.start) ?? 0;
        if (start < -10) continue;
        const safeStart = Math.max(0, start);
        const ramp = typeof e.rampMinutes === 'number' ? e.rampMinutes : 0;
        // `holdMinutes` omitted means "until the end of the run".
        const hold = typeof e.holdMinutes === 'number' ? e.holdMinutes : null;
        const back = typeof e.returnRampMinutes === 'number' ? e.returnRampMinutes : hold == null ? 0 : ramp;
        result.push({
          id: `ev_wind_${idx++}`,
          type: 'wind_shift',
          label: `Rotação Vento (T+${safeStart})`,
          enabled: true,
          startMinute: safeStart,
          endMinute: hold == null ? duration : Math.min(duration, safeStart + ramp + hold + back),
          windFromDeg: typeof e.toDeg === 'number' ? e.toDeg : undefined,
          deltaDeg: typeof e.toDeg !== 'number' && typeof e.deltaDeg === 'number' ? e.deltaDeg : undefined,
          rampMinutes: ramp,
          holdMinutes: hold,
          returnRampMinutes: back,
          rotation: e.rotation,
        });
        break;
      }
      case 'wind_scale': {
        const { start, end } = windowOf(e);
        if (wholeRun(start, end)) continue;
        const safeStart = Math.max(0, start);
        const safeEnd = Math.min(duration, end);
        if (safeEnd <= safeStart) continue;
        result.push({
          id: `ev_windscale_${idx++}`,
          type: 'wind_scale',
          label: `Vento Forte (T+${safeStart}–${safeEnd})`,
          enabled: true,
          startMinute: safeStart,
          endMinute: safeEnd,
          windFactor: e.factor ?? 1.7,
          applyToGusts: e.applyToGusts ?? true,
        });
        break;
      }
      case 'wind_set': {
        const { start, end } = windowOf(e);
        if (wholeRun(start, end)) continue;
        const safeStart = Math.max(0, start);
        const safeEnd = Math.min(duration, end);
        if (safeEnd <= safeStart) continue;
        result.push({
          id: `ev_windset_${idx++}`,
          type: 'wind_set',
          label: `Vento fixo (T+${safeStart}–${safeEnd})`,
          enabled: true,
          startMinute: safeStart,
          endMinute: safeEnd,
          windKmh: e.windKmh,
          windFromDeg: e.windFromDeg,
          rampMinutes: e.rampMinutes ?? 0,
        });
        break;
      }
      case 'gust_burst': {
        const { start, end } = windowOf(e);
        const safeStart = Math.max(0, start);
        const safeEnd = Math.min(duration, end);
        if (safeEnd <= safeStart) continue;
        result.push({
          id: `ev_gust_${idx++}`,
          type: 'gust_burst',
          label: `Rajada ${e.peakGustKmh ?? 70} km/h (T+${safeStart}–${safeEnd})`,
          enabled: true,
          startMinute: safeStart,
          endMinute: safeEnd,
          peakGustKmh: e.peakGustKmh ?? 70,
          periodMinutes: e.periodMinutes ?? 5,
        });
        break;
      }
      case 'front_passage': {
        const start = Math.max(0, minutes(e.at) ?? 0);
        const dur = e.durationMinutes ?? 45;
        const safeEnd = Math.min(duration, start + dur);
        if (safeEnd <= start) continue;
        result.push({
          id: `ev_front_${idx++}`,
          type: 'front_passage',
          label: `Passagem de frente (T+${start}–${safeEnd})`,
          enabled: true,
          startMinute: start,
          endMinute: safeEnd,
          windKmh: e.windKmh,
          windFromDeg: e.windFromDeg,
          tempDeltaC: e.tempDeltaC,
          humidityDeltaPct: e.humidityDeltaPct,
          pressureDeltaHpa: e.pressureDeltaHpa,
          precipitationMmH: e.precipitationMmH,
        });
        break;
      }
      case 'temperature_shift': {
        const { start, end } = windowOf(e);
        if (wholeRun(start, end)) continue;
        const safeStart = Math.max(0, start);
        const safeEnd = Math.min(duration, end);
        if (safeEnd <= safeStart) continue;
        result.push({
          id: `ev_temp_${idx++}`,
          type: 'temperature_shift',
          label: `Temperatura (T+${safeStart}–${safeEnd})`,
          enabled: true,
          startMinute: safeStart,
          endMinute: safeEnd,
          setMode: typeof e.setC === 'number',
          setC: e.setC,
          tempDeltaC: e.deltaC,
          rampMinutes: e.rampMinutes ?? 0,
        });
        break;
      }
      case 'humidity_shift': {
        const { start, end } = windowOf(e);
        if (wholeRun(start, end)) continue;
        const safeStart = Math.max(0, start);
        const safeEnd = Math.min(duration, end);
        if (safeEnd <= safeStart) continue;
        result.push({
          id: `ev_hum_${idx++}`,
          type: 'humidity_shift',
          label: `Humidade (T+${safeStart}–${safeEnd})`,
          enabled: true,
          startMinute: safeStart,
          endMinute: safeEnd,
          setMode: typeof e.setPct === 'number',
          setPct: e.setPct,
          humidityDeltaPct: e.deltaPct,
          rampMinutes: e.rampMinutes ?? 0,
        });
        break;
      }
      // `custom_series` changes the underlying series rather than adding an editable event; the weather chart still shows its effect.
      default:
        break;
    }
  }
  return result;
}

/** The sparse curve points of a scenario snapshot, converted to minutes from the run start. */
export function extractTimelineKeyframesFromSnapshot(
  snapshot?: { weather?: { keyframes?: WeatherKeyframe[] } } | null,
  startMs = 0,
  duration = 180,
): TimelineKeyframe[] {
  if (!snapshot?.weather?.keyframes) return [];
  const result: TimelineKeyframe[] = [];
  let idx = 1;
  for (const k of snapshot.weather.keyframes) {
    const spec = k.at as unknown as { offsetMinutes?: number; time?: string };
    let minute = spec?.offsetMinutes;
    if (minute == null && spec?.time) {
      const at = Date.parse(spec.time);
      minute = Number.isFinite(at) ? (at - startMs) / 60_000 : undefined;
    }
    if (minute == null || minute < 0 || minute > duration + 0.5) continue;
    result.push({
      id: `kf_${idx++}`,
      minute: Math.round(minute),
      label: k.label,
      transition: (k.transition as TimelineKeyframe['transition']) ?? 'linear',
      windKmh: k.windKmh ?? undefined,
      windFromDeg: k.windFromDeg ?? undefined,
      gustKmh: k.gustKmh ?? undefined,
      humidityPct: k.humidityPct ?? undefined,
      tempC: k.tempC ?? undefined,
      precipitationMmH: k.precipitationMmH ?? undefined,
      cloudCoverPct: k.cloudCoverPct ?? undefined,
    });
  }
  return result.sort((a, b) => a.minute - b.minute);
}

/**
 * Builds the complete `SimulationRequest` from form values, ignitions and location.
 * Flexible signature to support both (values, locationId, ignitions, base) and
 * (values, ignitions, locationId, base).
 */
export function buildSimulationRequest(
  values: SimulationFormValues,
  firstArg: string | Ignition[],
  secondArg: string | Ignition[],
  base?: WeatherBaseStats | null,
): SimulationRequest {
  const locationId = typeof firstArg === 'string' ? firstArg : (secondArg as string);
  const ignitions = Array.isArray(firstArg) ? firstArg : (secondArg as Ignition[]);

  const clock = new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
  // the operator's name for the fire names the scenario; the generic "Foco 1" does not say anything, so it keeps the default
  const fireName = ignitions[0]?.label?.trim();
  return {
    scenario: {
      name: fireName && !/^Foco \d+$/.test(fireName) ? `${fireName} · ${clock}` : `Cenário personalizado ${clock}`,
      locationId,
      start: formStartToIso(values.start),
      durationMinutes: values.duration,
      ignitions: ignitions.map((ig, i) => ({
        position: ig.position,
        label: ig.label ?? `Foco ${i + 1}`,
        timeOffsetMinutes: ig.timeOffsetMinutes ?? 0,
      })),
      weather: buildWeatherSpec(values, base),
      engine: {
        ensemble: {
          members: values.members,
          windDirectionSigmaDeg: values.members > 1 ? 15 : 0,
        },
      },
    },
  };
}
