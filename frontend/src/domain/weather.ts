import type { Smoke, WeatherSample } from '@/api';

import { lerp, lerpDeg } from './colors';
import { compass } from './georef';

const MS_PER_MIN = 60_000;

/** A `WeatherSample` interpolated to a fractional minute — same shape, narrowed to the fields the HUD actually shows. */
export interface InterpolatedWeather {
  windKmh: number;
  windFromDeg: number;
  gustKmh: number | null;
  tempC: number;
  humidityPct: number;
  fineFuelMoisturePct: number | null;
  precipitationMmH: number | null;
  cloudCoverPct: number | null;
  solarRadiationWm2: number | null;
}

export type FireRiskLevel = 'normal' | 'high' | 'extreme';

/**
 * Evaluates Portuguese rural fire risk:
 * - 'extreme': "Regra dos 30-30-30" (T >= 30 °C, HR <= 30 %, Wind or gusts >= 30 km/h).
 * - 'high': Severe heat and dry air (T >= 30 °C, HR <= 30 %).
 * - 'normal': Standard risk.
 */
export function fireRiskLevel(w: InterpolatedWeather | null | undefined): FireRiskLevel {
  if (!w) return 'normal';
  const wind30 = w.windKmh >= 30 || (w.gustKmh != null && w.gustKmh >= 30);
  if (w.tempC >= 30 && w.humidityPct <= 30 && wind30) return 'extreme';
  if (w.tempC >= 30 && w.humidityPct <= 30) return 'high';
  return 'normal';
}

/** Portuguese operational fire-weather indicator: "Regra dos 30-30-30" (T >= 30 °C, HR <= 30 %, Wind >= 30 km/h). */
export function isExtremeFireWeather(w: InterpolatedWeather | null | undefined): boolean {
  return fireRiskLevel(w) === 'extreme';
}

export interface UpcomingWeatherShift {
  inMinutes: number;
  atMinute: number;
  dirChangeDeg: number;
  toDeg: number;
  toSpeedKmh: number;
  speedDeltaKmh: number;
  label: string;
}

/**
 * Scans `run.weather` ahead for a significant wind shift within `lookaheadMinutes` (default 60).
 * Flags a direction change >= 30° or speed change >= 15 km/h.
 */
export function findUpcomingWeatherShift(
  series: WeatherSample[] | null | undefined,
  startMs: number,
  currentMinute: number,
  lookaheadMinutes = 60,
): UpcomingWeatherShift | null {
  if (!series || series.length < 2) return null;
  const current = sampleWeatherAt(series, startMs, currentMinute);
  if (!current) return null;

  for (let m = 1; m <= lookaheadMinutes; m++) {
    const futureMin = currentMinute + m;
    const future = sampleWeatherAt(series, startMs, futureMin);
    if (!future) break;

    // Angular difference on the circle: -180..+180
    const rawDiff = ((future.windFromDeg - current.windFromDeg + 540) % 360) - 180;
    const absAngle = Math.abs(rawDiff);
    const speedDelta = future.windKmh - current.windKmh;

    const isDirShift = absAngle >= 30;
    const isSpeedShift = Math.abs(speedDelta) >= 15;

    if (isDirShift || isSpeedShift) {
      let label = '';
      if (isDirShift && speedDelta >= 10) {
        label = `Vento roda para ${compass(future.windFromDeg)} e acelera (+${Math.round(speedDelta)} km/h) em ${m} min`;
      } else if (isDirShift) {
        label = `Vento roda para ${compass(future.windFromDeg)} (${Math.round(future.windFromDeg)}°) em ${m} min`;
      } else if (speedDelta >= 15) {
        label = `Vento acelera para ${Math.round(future.windKmh)} km/h em ${m} min`;
      } else {
        label = `Vento abranda para ${Math.round(future.windKmh)} km/h em ${m} min`;
      }

      return {
        inMinutes: m,
        atMinute: futureMin,
        dirChangeDeg: Math.round(absAngle),
        toDeg: Math.round(future.windFromDeg),
        toSpeedKmh: Math.round(future.windKmh),
        speedDeltaKmh: Math.round(speedDelta),
        label,
      };
    }
  }
  return null;
}

/** Evaluates typical ground visibility (meters) from the active smoke field and affected roads. */
export function groundVisibilityFromSmoke(smoke: Smoke | null | undefined): number | null {
  if (!smoke) return null;
  const cutCount = smoke.affectedRoadIds?.length ?? 0;
  if (cutCount >= 10) return 800;
  if (cutCount >= 4) return 1500;
  if (cutCount >= 1) return 2500;
  if (smoke.plumeHeightM?.max && smoke.plumeHeightM.max > 800) return 3500;
  return null;
}

/** Mean conditions of a weather series, with wind direction averaged on the circle. */
export interface WeatherBaseStats {
  windKmh: number;
  dirDeg: number;
  humPct: number;
  tempC: number;
}

/** Mean weather over a series; `null` when there is nothing to average. */
export function weatherMeans(samples: WeatherSample[]): WeatherBaseStats | null {
  const usable = samples.filter((s) => Number.isFinite(s.windKmh) || Number.isFinite(s.humidityPct) || Number.isFinite(s.tempC));
  if (!usable.length) return null;
  let windSum = 0;
  let windN = 0;
  let humSum = 0;
  let humN = 0;
  let tempSum = 0;
  let tempN = 0;
  let sin = 0;
  let cos = 0;
  for (const s of usable) {
    if (Number.isFinite(s.windKmh)) {
      windSum += s.windKmh!;
      windN++;
    }
    if (Number.isFinite(s.humidityPct)) {
      humSum += s.humidityPct!;
      humN++;
    }
    if (Number.isFinite(s.tempC)) {
      tempSum += s.tempC!;
      tempN++;
    }
    if (Number.isFinite(s.windFromDeg)) {
      const rad = (s.windFromDeg! * Math.PI) / 180;
      sin += Math.sin(rad);
      cos += Math.cos(rad);
    }
  }
  const dir = Math.atan2(sin, cos) * (180 / Math.PI);
  return {
    windKmh: windN ? windSum / windN : 0,
    dirDeg: (dir + 360) % 360,
    humPct: humN ? humSum / humN : 0,
    tempC: tempN ? tempSum / tempN : 0,
  };
}


/** Provider base at the scenario start: the first sample, with means as a fallback for missing fields. */
export function weatherBaseAtStart(samples: WeatherSample[]): WeatherBaseStats | null {
  const means = weatherMeans(samples);
  const first = samples[0];
  if (!first || !means) return means;
  return {
    windKmh: Number.isFinite(first.windKmh) ? first.windKmh! : means.windKmh,
    dirDeg: Number.isFinite(first.windFromDeg) ? first.windFromDeg! : means.dirDeg,
    humPct: Number.isFinite(first.humidityPct) ? first.humidityPct! : means.humPct,
    tempC: Number.isFinite(first.tempC) ? first.tempC! : means.tempC,
  };
}

/**
 * Interpolates `series` (sorted by time) to `startMs + minute * 60000`. Used by the HUD and
 * the sim form preview chart, which both need "the weather at a specific instant" rather than
 * the whole series.
 */
export function sampleWeatherAt(series: WeatherSample[], startMs: number, minute: number): InterpolatedWeather | null {
  if (!series.length) return null;
  const t = startMs + minute * MS_PER_MIN;
  const times = series.map((s) => +new Date(s.time));
  const hi = times.findIndex((x) => x >= t);
  if (hi <= 0) {
    const sample = series[Math.max(hi, 0)] ?? series[series.length - 1];
    return toInterpolated(sample, sample);
  }
  const a = series[hi - 1];
  const b = series[hi];
  const f = (t - times[hi - 1]) / (times[hi] - times[hi - 1]);
  return {
    windKmh: lerp(a.windKmh ?? 0, b.windKmh ?? 0, f),
    windFromDeg: lerpDeg(a.windFromDeg ?? 0, b.windFromDeg ?? 0, f),
    gustKmh: a.gustKmh != null && b.gustKmh != null ? lerp(a.gustKmh, b.gustKmh, f) : null,
    tempC: lerp(a.tempC ?? 0, b.tempC ?? 0, f),
    humidityPct: lerp(a.humidityPct ?? 0, b.humidityPct ?? 0, f),
    fineFuelMoisturePct:
      a.fuelMoisture?.dead1hPct != null && b.fuelMoisture?.dead1hPct != null
        ? lerp(a.fuelMoisture.dead1hPct, b.fuelMoisture.dead1hPct, f)
        : null,
    precipitationMmH: a.precipitationMmH != null && b.precipitationMmH != null ? lerp(a.precipitationMmH, b.precipitationMmH, f) : a.precipitationMmH ?? b.precipitationMmH ?? null,
    cloudCoverPct: a.cloudCoverPct != null && b.cloudCoverPct != null ? lerp(a.cloudCoverPct, b.cloudCoverPct, f) : a.cloudCoverPct ?? b.cloudCoverPct ?? null,
    solarRadiationWm2: a.solarRadiationWm2 != null && b.solarRadiationWm2 != null ? lerp(a.solarRadiationWm2, b.solarRadiationWm2, f) : a.solarRadiationWm2 ?? b.solarRadiationWm2 ?? null,
  };
}

function toInterpolated(a: WeatherSample, _b: WeatherSample): InterpolatedWeather {
  return {
    windKmh: a.windKmh ?? 0,
    windFromDeg: a.windFromDeg ?? 0,
    gustKmh: a.gustKmh ?? null,
    tempC: a.tempC ?? 0,
    humidityPct: a.humidityPct ?? 0,
    fineFuelMoisturePct: a.fuelMoisture?.dead1hPct ?? null,
    precipitationMmH: a.precipitationMmH ?? null,
    cloudCoverPct: a.cloudCoverPct ?? null,
    solarRadiationWm2: a.solarRadiationWm2 ?? null,
  };
}

/** `dd mmm, HH:mm` in Portuguese, used throughout the UI for simulation timestamps. */
export function formatDateTime(value: string | number | Date): string {
  return new Date(value).toLocaleString('pt-PT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function formatTime(value: string | number | Date): string {
  return new Date(value).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
}
