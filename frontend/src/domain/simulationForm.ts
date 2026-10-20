import type { LatLon, SimulationRequest, WeatherEvent, WeatherResolveRequest, WeatherSample, WeatherSpec } from '@/api';

/** Weather edits to the real series also apply during the fuel warm-up window before the start. */
const WHOLE_RUN_PADDING_MIN = 720;

export type WeatherMode = 'provider' | 'manual';

export interface SimulationFormValues {
  start: string; // datetime-local, interpreted as UTC
  duration: number;
  mode: WeatherMode;
  wind: number;
  dir: number;
  hum: number;
  temp: number;
  windScale: number; // %
  dirShift: number;
  humShift: number;
  tempShift: number;
  shiftOn: boolean;
  shiftAt: number;
  shiftTo: number;
  members: number;
}

const round = (v: number, d = 0) => Math.round(v * 10 ** d) / 10 ** d;
const isoLocal = (d: string | number | Date) => new Date(d).toISOString().slice(0, 16);

/** Initial form values: those of the scenario in view (start, duration and the weather at the first instant). */
export function defaultFormValues(run?: { start: string; durationMinutes: number; weather?: WeatherSample[] } | null): SimulationFormValues {
  const w = run?.weather?.[0];
  const dir = round(w?.windFromDeg ?? 335);
  return {
    start: run ? isoLocal(run.start) : '2026-08-17T15:00',
    duration: run?.durationMinutes ?? 180,
    mode: 'manual',
    wind: round(w?.windKmh ?? 20),
    dir,
    hum: round(w?.humidityPct ?? 25),
    temp: round(w?.tempC ?? 25),
    windScale: 100,
    dirShift: 0,
    humShift: 0,
    tempShift: 0,
    shiftOn: false,
    shiftAt: 60,
    shiftTo: (dir + 90) % 360,
    members: 12,
  };
}

/** The weather recipe (`WeatherSpec`) that the form describes. */
export function buildWeatherSpec(v: SimulationFormValues): WeatherSpec {
  const events: WeatherEvent[] = [];
  const whole = { start: { offsetMinutes: -WHOLE_RUN_PADDING_MIN }, end: { offsetMinutes: v.duration + WHOLE_RUN_PADDING_MIN } };
  if (v.mode === 'provider') {
    if (v.windScale !== 100) events.push({ type: 'wind_scale', enabled: true, applyToGusts: true, window: whole, factor: v.windScale / 100 });
    if (v.dirShift !== 0) events.push({ type: 'wind_shift', enabled: true, start: { offsetMinutes: -WHOLE_RUN_PADDING_MIN }, deltaDeg: v.dirShift });
    if (v.humShift !== 0) events.push({ type: 'humidity_shift', enabled: true, window: whole, deltaPct: v.humShift });
    if (v.tempShift !== 0) events.push({ type: 'temperature_shift', enabled: true, window: whole, deltaC: v.tempShift });
  }
  if (v.shiftOn) events.push({ type: 'wind_shift', enabled: true, start: { offsetMinutes: v.shiftAt }, toDeg: v.shiftTo, rampMinutes: 30 });

  const base: WeatherSpec =
    v.mode === 'manual'
      ? { base: 'none', keyframes: [{ at: { offsetMinutes: 0 }, windKmh: v.wind, windFromDeg: v.dir, humidityPct: v.hum, tempC: v.temp }] }
      : { base: 'provider' };
  return events.length ? { ...base, events } : base;
}

const toIsoUtc = (local: string) => new Date(`${local}:00Z`).toISOString();

/** The simulation request (inline scenario) for the location, ignition and options chosen. */
export function buildSimulationRequest(v: SimulationFormValues, locationId: string, ignition: LatLon): SimulationRequest {
  return {
    scenario: {
      name: 'Cenário personalizado',
      locationId,
      start: toIsoUtc(v.start),
      durationMinutes: v.duration,
      ignitions: [{ position: ignition }],
      weather: buildWeatherSpec(v),
      engine: { ensemble: { members: v.members, windDirectionSigmaDeg: 15 } },
    },
  };
}

/** The weather preview request (`POST /weather/resolve`). */
export function buildPreviewRequest(v: SimulationFormValues, locationId: string): WeatherResolveRequest {
  return { locationId, start: toIsoUtc(v.start), durationMinutes: v.duration, weather: buildWeatherSpec(v) };
}
