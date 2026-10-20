import type { Ignition, SimulationRequest, WeatherEvent, WeatherResolveRequest, WeatherSample, WeatherSpec } from '@/api';

import { weatherMeans, type WeatherBaseStats } from './weather';

/** Weather edits to the real series also apply during the fuel warm-up window before the start. */
const WHOLE_RUN_PADDING_MIN = 720;

export type WeatherMode = 'provider' | 'manual';

export type PresetId = 'front' | 'breeze' | 'afternoon' | 'second_ignition';

export interface PresetWeatherEvent {
  id: PresetId;
  label: string;
  enabled: boolean;
  events: WeatherEvent[];
}

export interface SimulationFormValues {
  start: string; // datetime-local, interpreted as UTC
  duration: number;
  mode: WeatherMode;
  windKmh: number;
  windFromDeg: number;
  humPct: number;
  tempC: number;
  members: number;
  presetEvents: PresetWeatherEvent[];
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

/** The four one-click recipes; the fourth adds an ignition and has no weather event. */
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
          window: { start: { offsetMinutes: 45 }, end: { offsetMinutes: 120 } },
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
    { id: 'second_ignition', label: '2.º foco (T+45)', enabled: false, events: [] },
  ];
}

/** Rebuild preset windows after the duration changes, preserving which presets are enabled. */
export function resizePresetEvents(presets: PresetWeatherEvent[], duration: number): PresetWeatherEvent[] {
  const defaults = createPresetEvents(duration);
  return presets.map((p) => ({ ...p, events: defaults.find((d) => d.id === p.id)?.events ?? p.events }));
}

export const presetAvailable = (id: PresetId, duration: number, baseWindKmh?: number | null): boolean => {
  if (id === 'second_ignition') return true;
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
  const stats = base ?? weatherMeans(run?.weather ?? []) ?? DEFAULT_BASE;
  return {
    start: run ? isoLocal(run.startMs) : '2026-08-17T15:00',
    duration,
    mode: 'provider',
    windKmh: round(stats.windKmh, 1),
    windFromDeg: normalizeDeg(round(stats.dirDeg)),
    humPct: round(stats.humPct, 1),
    tempC: round(stats.tempC, 1),
    members: 12,
    presetEvents: createPresetEvents(duration),
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
  }

  for (const preset of v.presetEvents) {
    if (!preset.enabled || !presetAvailable(preset.id, v.duration, v.mode === 'provider' ? base?.windKmh : undefined)) continue;
    events.push(...preset.events);
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
            },
          ],
        }
      : { base: 'provider' };
  return events.length ? { ...spec, events } : spec;
}

export const formStartToIso = (local: string): string => new Date(`${local}:00Z`).toISOString();

/** The weather preview request (`POST /weather/resolve`). */
export function buildPreviewRequest(v: SimulationFormValues, locationId: string, base?: WeatherBaseStats | null): WeatherResolveRequest {
  return { locationId, start: formStartToIso(v.start), durationMinutes: v.duration, weather: buildWeatherSpec(v, base) };
}

/** The simulation request (inline scenario) for the location, ignitions and options chosen. */
export function buildSimulationRequest(
  v: SimulationFormValues,
  locationId: string,
  ignitions: Ignition[],
  base?: WeatherBaseStats | null,
): SimulationRequest {
  return {
    scenario: {
      name: 'Cenário personalizado',
      locationId,
      start: formStartToIso(v.start),
      durationMinutes: v.duration,
      ignitions: ignitions.map((ig, i) => ({
        position: ig.position,
        label: ig.label ?? `Foco ${i + 1}`,
        ...(ig.timeOffsetMinutes != null ? { timeOffsetMinutes: ig.timeOffsetMinutes } : {}),
      })),
      weather: buildWeatherSpec(v, base),
      engine: { ensemble: { members: v.members, windDirectionSigmaDeg: 15 } },
    },
  };
}
