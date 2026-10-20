import type { Ignition, SimulationRequest, WeatherEvent, WeatherResolveRequest, WeatherSample, WeatherSpec } from '@/api';

import { weatherMeans, type WeatherBaseStats } from './weather';

/** Weather edits to the real series also apply during the fuel warm-up window before the start. */
const WHOLE_RUN_PADDING_MIN = 720;

export type WeatherMode = 'provider' | 'manual';

export type PresetId = 'front' | 'breeze' | 'afternoon' | 'rain_shower' | 'storm' | 'fog' | 'second_ignition';

export interface PresetWeatherEvent {
  id: PresetId;
  label: string;
  enabled: boolean;
  events: WeatherEvent[];
}

export type CustomWeatherEventType = 'rain' | 'storm' | 'clouds' | 'wind_shift' | 'wind_scale' | 'heat_dry';

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
  // Specific parameters
  intensityMmH?: number;     // for rain (default 6.0 mm/h)
  cloudCoverPct?: number;    // for clouds / fog (default 80%)
  windKmh?: number;          // for wind shift / storm (default 38 km/h)
  windFromDeg?: number;      // for wind shift (default 270°)
  windFactor?: number;       // for wind scale (default 1.7)
  tempDeltaC?: number;       // for temperature shift (-10 to +10 °C)
  humidityDeltaPct?: number; // for humidity shift (-30 to +30 %)
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
  presetEvents: PresetWeatherEvent[];
  customEvents: TimelineRangeEvent[];
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

/** The one-click recipes for weather shifts, rain, storms, fog, and secondary ignitions. */
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

/** Rebuild preset windows after the duration changes, preserving which presets are enabled. */
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

  // Process legacy presets
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
      events.push({
        type: 'precipitation',
        enabled: true,
        window: win,
        intensityMmH: ce.intensityMmH ?? 6.0,
        rampMinutes: Math.min(10, Math.round(dur * 0.2)),
      });
    } else if (ce.type === 'storm') {
      events.push(
        {
          type: 'precipitation',
          enabled: true,
          window: win,
          intensityMmH: ce.intensityMmH ?? 15.0,
          rampMinutes: 5,
        },
        {
          type: 'wind_scale',
          enabled: true,
          applyToGusts: true,
          window: win,
          factor: 1.8,
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
      const dirDelta = bearingDelta(ce.windFromDeg ?? 270, base?.dirDeg ?? 335);
      events.push({
        type: 'wind_shift',
        enabled: true,
        start: { offsetMinutes: ce.startMinute },
        deltaDeg: dirDelta,
        rampMinutes: Math.min(30, dur),
      });
    } else if (ce.type === 'wind_scale') {
      events.push({
        type: 'wind_scale',
        enabled: true,
        applyToGusts: true,
        window: win,
        factor: ce.windFactor ?? 1.7,
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
              precipitationMmH: v.precipitationMmH > 0 ? v.precipitationMmH : undefined,
              cloudCoverPct: v.cloudCoverPct > 0 ? v.cloudCoverPct : undefined,
            },
          ],
        }
      : { base: 'provider' };
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
): TimelineRangeEvent[] {
  if (!snapshot?.weather?.events) return [];
  const result: TimelineRangeEvent[] = [];
  let idx = 1;

  for (const e of snapshot.weather.events) {
    if (e.enabled === false) continue;
    if (e.type === 'precipitation') {
      const win = 'window' in e ? e.window : null;
      const start = win?.start && 'offsetMinutes' in win.start ? win.start.offsetMinutes ?? 0 : 0;
      const end = win?.end && 'offsetMinutes' in win.end ? win.end.offsetMinutes ?? duration : duration;
      // Skip whole-run background weather padding (e.g. -720 to 810 min)
      if (start < -10 || (start <= 0 && end >= duration + 30)) continue;
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
    } else if (e.type === 'wind_shift') {
      const start = 'start' in e && typeof e.start === 'object' && 'offsetMinutes' in e.start ? e.start.offsetMinutes ?? 0 : 0;
      if (start < -10) continue;
      const safeStart = Math.max(0, start);
      result.push({
        id: `ev_wind_${idx++}`,
        type: 'wind_shift',
        label: `Rotação Vento (T+${safeStart})`,
        enabled: true,
        startMinute: safeStart,
        endMinute: Math.min(duration, safeStart + 30),
        windFromDeg: 270,
      });
    } else if (e.type === 'wind_scale') {
      const win = 'window' in e ? e.window : null;
      const start = win?.start && 'offsetMinutes' in win.start ? win.start.offsetMinutes ?? 0 : 0;
      const end = win?.end && 'offsetMinutes' in win.end ? win.end.offsetMinutes ?? duration : duration;
      if (start < -10 || (start <= 0 && end >= duration + 30)) continue;
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
      });
    } else if (e.type === 'front_passage') {
      const at = 'at' in e && typeof e.at === 'object' && 'offsetMinutes' in e.at ? e.at.offsetMinutes ?? 0 : 0;
      const dur = e.durationMinutes ?? 45;
      const safeStart = Math.max(0, at);
      const safeEnd = Math.min(duration, safeStart + dur);
      result.push({
        id: `ev_storm_${idx++}`,
        type: 'storm',
        label: `Trovoada (T+${safeStart}–${safeEnd})`,
        enabled: true,
        startMinute: safeStart,
        endMinute: safeEnd,
        intensityMmH: e.precipitationMmH ?? 15.0,
        windKmh: e.windKmh ?? 42,
        tempDeltaC: e.tempDeltaC ?? -5,
      });
    }
  }
  return result;
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

  return {
    scenario: {
      name: `Cenário personalizado ${new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })}`,
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
