import type { Smoke, WeatherSample } from '@/api';

import { lerp, lerpDeg } from './colors';
import { compass } from './georef';

const MS_PER_MIN = 60_000;

/** A `WeatherSample` interpolated to a fractional minute — same shape, narrowed to the fields the HUD and panels show. */
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

/**
 * Estimates 1-hour fine dead fuel moisture equilibrium (EMC %) using the Simard / Rothermel formulation.
 * When fine fuel moisture drops below 6%, fuels ignite almost instantaneously and propagation is explosive.
 */
export function estimateDeadFuelMoisture(tempC: number, humidityPct: number): number {
  const h = Math.max(1, Math.min(100, humidityPct));
  const t = tempC;
  if (h < 10) {
    return Math.max(2, Math.min(30, 0.03229 + 0.281073 * h - 0.000578 * h * t));
  } else if (h <= 50) {
    return Math.max(2, Math.min(30, 2.22749 + 0.160107 * h - 0.014784 * t));
  } else {
    return Math.max(2, Math.min(30, 21.0606 + 0.005565 * h * h - 0.00035 * h * t - 0.483199 * h));
  }
}

export interface FuelMoistureInfo {
  pct: number;
  label: string;
  color: string;
  level: 'extreme' | 'critical' | 'moderate' | 'damp';
  description: string;
}

export function getFuelMoistureInfo(pct: number): FuelMoistureInfo {
  if (pct <= 6) {
    return {
      pct,
      label: 'Extremamente Crítico (<6%)',
      color: '#ef4444',
      level: 'extreme',
      description: 'Ignição imediata e propagação explosiva em folhas e caruma.',
    };
  }
  if (pct <= 10) {
    return {
      pct,
      label: 'Crítico (6–10%)',
      color: '#f97316',
      level: 'critical',
      description: 'Fácil ignição e rápida transmissão na manta morta.',
    };
  }
  if (pct <= 15) {
    return {
      pct,
      label: 'Moderado (10–15%)',
      color: '#eab308',
      level: 'moderate',
      description: 'Propagação sustentada apenas sob declive ou vento forte.',
    };
  }
  return {
    pct,
    label: 'Húmido (>15%)',
    color: '#22c55e',
    level: 'damp',
    description: 'Resistência elevada à ignição por humidade nos combustíveis.',
  };
}

export interface DangerRatingInfo {
  rating: 'maximo' | 'muito_elevado' | 'elevado' | 'moderado' | 'reduzido';
  label: string;
  color: string;
  description: string;
}

export function operationalDangerRating(w: InterpolatedWeather | null | undefined): DangerRatingInfo {
  if (!w) {
    return { rating: 'moderado', label: 'Moderado', color: '#eab308', description: 'Condições meteorológicas nominais.' };
  }
  if (w.precipitationMmH != null && w.precipitationMmH >= 1.5) {
    return { rating: 'reduzido', label: 'Reduzido (Chuva)', color: '#38bdf8', description: 'Precipitação ativa arrefece o combustível e inibe a combustão.' };
  }
  const wind30 = w.windKmh >= 30 || (w.gustKmh != null && w.gustKmh >= 30);
  if (w.tempC >= 30 && w.humidityPct <= 30 && wind30) {
    return { rating: 'maximo', label: 'Máximo (30-30-30)', color: '#ef4444', description: 'Regra dos 30-30-30 ativa: propagação violenta com risco de projeções múltiplas.' };
  }
  if ((w.tempC >= 32 && w.humidityPct <= 35) || (wind30 && w.humidityPct <= 35)) {
    return { rating: 'muito_elevado', label: 'Muito Elevado', color: '#f97316', description: 'Forte dessecação e vento intenso favorecem frentes ativas.' };
  }
  if (w.tempC >= 26 && (w.humidityPct <= 45 || w.windKmh >= 20)) {
    return { rating: 'elevado', label: 'Elevado', color: '#f59f00', description: 'Propagação contínua nas encostas expostas ao vento.' };
  }
  if (w.tempC < 18 || w.humidityPct > 70) {
    return { rating: 'reduzido', label: 'Reduzido', color: '#22c55e', description: 'Humidade atmosférica favorável e temperaturas amenas.' };
  }
  return { rating: 'moderado', label: 'Moderado', color: '#eab308', description: 'Condições típicas sem agravamento crítico iminente.' };
}

export interface TimelineWeatherEvent {
  minute: number;
  timeStr: string;
  type: 'wind_shift' | 'wind_speed' | 'rain_start' | 'rain_stop' | 'storm' | 'rule30';
  title: string;
  detail: string;
  badgeColor: string;
}

export function detectWeatherEvents(series: WeatherSample[], startMs: number): TimelineWeatherEvent[] {
  if (!series || series.length < 2) return [];
  const events: TimelineWeatherEvent[] = [];
  const start = +new Date(series[0].time);
  const end = +new Date(series[series.length - 1].time);
  const durationMin = Math.round((end - start) / MS_PER_MIN);

  let prevDir = series[0].windFromDeg ?? 0;
  let prevSpeed = series[0].windKmh ?? 0;
  let prevRaining = (series[0].precipitationMmH ?? 0) > 0.2;
  let prevRule30 = false;

  for (let m = 5; m <= durationMin; m += 5) {
    const w = sampleWeatherAt(series, startMs, m);
    if (!w) continue;
    const timeStr = formatTime(startMs + m * MS_PER_MIN);

    // Wind direction shift >= 30°
    const dirDiff = Math.abs(((w.windFromDeg - prevDir + 540) % 360) - 180);
    if (dirDiff >= 30) {
      events.push({
        minute: m,
        timeStr,
        type: 'wind_shift',
        title: `Rotação de vento (+${Math.round(dirDiff)}°)`,
        detail: `Vento vira para ${compass(w.windFromDeg)} (${Math.round(w.windFromDeg)}°) a ${Math.round(w.windKmh)} km/h`,
        badgeColor: '#f59f00',
      });
      prevDir = w.windFromDeg;
    }

    // Wind speed surge >= 15 km/h
    const speedDelta = w.windKmh - prevSpeed;
    if (Math.abs(speedDelta) >= 15) {
      events.push({
        minute: m,
        timeStr,
        type: 'wind_speed',
        title: speedDelta > 0 ? `Aceleração do vento (+${Math.round(speedDelta)} km/h)` : `Abrandamento do vento (${Math.round(speedDelta)} km/h)`,
        detail: `Velocidade atinge ${Math.round(w.windKmh)} km/h`,
        badgeColor: speedDelta > 0 ? '#ff6a1a' : '#8fa4b8',
      });
      prevSpeed = w.windKmh;
    }

    // Rain start / stop
    const isRaining = (w.precipitationMmH ?? 0) > 0.2;
    if (isRaining && !prevRaining) {
      const isStorm = (w.precipitationMmH ?? 0) >= 7.5;
      events.push({
        minute: m,
        timeStr,
        type: isStorm ? 'storm' : 'rain_start',
        title: isStorm ? `Início de trovoada (${w.precipitationMmH?.toFixed(1)} mm/h)` : `Início de chuva (${w.precipitationMmH?.toFixed(1)} mm/h)`,
        detail: isStorm ? 'Relâmpagos e rajadas convectivas fortes' : 'Precipitação com redução da intensidade de queima',
        badgeColor: '#38bdf8',
      });
      prevRaining = true;
    } else if (!isRaining && prevRaining) {
      events.push({
        minute: m,
        timeStr,
        type: 'rain_stop',
        title: 'Cessação da chuva',
        detail: 'Fim da precipitação; retoma da secagem de combustíveis finos',
        badgeColor: '#94a3b8',
      });
      prevRaining = false;
    }

    // 30-30-30 rule entry
    const isRule30 = isExtremeFireWeather(w);
    if (isRule30 && !prevRule30) {
      events.push({
        minute: m,
        timeStr,
        type: 'rule30',
        title: 'Entrada na Regra 30-30-30',
        detail: `T: ${Math.round(w.tempC)}°C · HR: ${Math.round(w.humidityPct)}% · V: ${Math.round(w.windKmh)} km/h`,
        badgeColor: '#ef4444',
      });
      prevRule30 = true;
    } else if (!isRule30 && prevRule30) {
      prevRule30 = false;
    }
  }

  return events;
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
 * Physics-based pre-rain cloud buildup and post-rain dissipation (Requirement 1.2):
 * In nature, rain doesn't fall from clear blue skies. Clouds progressively form, gather
 * and thicken overhead in the ~40 minutes leading up to rain onset, and dissipate gradually
 * over ~25 minutes once rain stops.
 */
export function computePreAndPostRainCloudCover(
  series: WeatherSample[],
  times: number[],
  t: number,
  baseCloud: number,
  currentPrecip: number,
): number {
  if (currentPrecip > 0.1) {
    // Rain actively falling: dense cloud deck (80-98%)
    return Math.max(baseCloud, Math.min(100, Math.max(80, Math.round(72 + currentPrecip * 3.5))));
  }

  let effectiveCloud = baseCloud;

  // 1. Scan ahead for upcoming rain within 45 minutes (Pre-Rain Cloud Buildup)
  for (let j = 0; j < series.length; j++) {
    const dtMs = times[j] - t;
    if (dtMs <= 0) continue;
    if (dtMs > 45 * MS_PER_MIN) break;
    const precip = series[j].precipitationMmH ?? 0;
    if (precip > 0.2) {
      const dtMin = dtMs / MS_PER_MIN;
      if (dtMin <= 40) {
        // Natural condensation easing curve: clouds thicken as rain approaches
        const progress = Math.max(0, Math.min(1, 1 - (dtMin / 40)));
        const ease = progress * progress * (3 - 2 * progress);
        const targetCloud = Math.min(100, Math.max(78, 62 + precip * 3.5));
        const formingCloud = Math.round(targetCloud * ease);
        effectiveCloud = Math.max(effectiveCloud, formingCloud);
      }
      break;
    }
  }

  // 2. Scan behind for recent rain within past 25 minutes (Post-Rain Dissipation)
  for (let j = series.length - 1; j >= 0; j--) {
    const dtMs = t - times[j];
    if (dtMs <= 0) continue;
    if (dtMs > 30 * MS_PER_MIN) continue;
    const precip = series[j].precipitationMmH ?? 0;
    if (precip > 0.2) {
      const dtMin = dtMs / MS_PER_MIN;
      if (dtMin <= 25) {
        const progress = Math.max(0, Math.min(1, 1 - (dtMin / 25)));
        const dissipatingCloud = Math.round(75 * progress * progress);
        effectiveCloud = Math.max(effectiveCloud, dissipatingCloud);
      }
      break;
    }
  }

  return effectiveCloud;
}

/**
 * Interpolates `series` (sorted by time) to `startMs + minute * 60000`. Used by the HUD and
 * panels, which both need "the weather at a specific instant" rather than
 * the whole series.
 */
export function sampleWeatherAt(series: WeatherSample[], startMs: number, minute: number): InterpolatedWeather | null {
  if (!series.length) return null;
  const t = startMs + minute * MS_PER_MIN;
  const times = series.map((s) => +new Date(s.time));
  const hi = times.findIndex((x) => x >= t);
  if (hi <= 0) {
    const sample = series[Math.max(hi, 0)] ?? series[series.length - 1];
    return toInterpolated(sample, series, times, t);
  }
  const a = series[hi - 1];
  const b = series[hi];
  const f = (t - times[hi - 1]) / (times[hi] - times[hi - 1]);
  const temp = lerp(a.tempC ?? 0, b.tempC ?? 0, f);
  const humidity = lerp(a.humidityPct ?? 0, b.humidityPct ?? 0, f);
  const precip =
    a.precipitationMmH != null && b.precipitationMmH != null
      ? lerp(a.precipitationMmH, b.precipitationMmH, f)
      : a.precipitationMmH ?? b.precipitationMmH ?? null;
  const rawCloud =
    a.cloudCoverPct != null && b.cloudCoverPct != null
      ? lerp(a.cloudCoverPct, b.cloudCoverPct, f)
      : a.cloudCoverPct ?? b.cloudCoverPct ?? 0;
  const dynamicCloud = computePreAndPostRainCloudCover(series, times, t, rawCloud, precip ?? 0);

  return {
    windKmh: lerp(a.windKmh ?? 0, b.windKmh ?? 0, f),
    windFromDeg: lerpDeg(a.windFromDeg ?? 0, b.windFromDeg ?? 0, f),
    gustKmh: a.gustKmh != null && b.gustKmh != null ? lerp(a.gustKmh, b.gustKmh, f) : a.gustKmh ?? b.gustKmh ?? null,
    tempC: temp,
    humidityPct: humidity,
    fineFuelMoisturePct:
      a.fuelMoisture?.dead1hPct != null && b.fuelMoisture?.dead1hPct != null
        ? lerp(a.fuelMoisture.dead1hPct, b.fuelMoisture.dead1hPct, f)
        : a.fuelMoisture?.dead1hPct ?? estimateDeadFuelMoisture(temp, humidity),
    precipitationMmH: precip,
    cloudCoverPct: dynamicCloud > 0 ? dynamicCloud : null,
    solarRadiationWm2: a.solarRadiationWm2 != null && b.solarRadiationWm2 != null ? lerp(a.solarRadiationWm2, b.solarRadiationWm2, f) : a.solarRadiationWm2 ?? b.solarRadiationWm2 ?? null,
  };
}

function toInterpolated(a: WeatherSample, series?: WeatherSample[], times?: number[], t?: number): InterpolatedWeather {
  const temp = a.tempC ?? 0;
  const humidity = a.humidityPct ?? 0;
  const precip = a.precipitationMmH ?? 0;
  const baseCloud = a.cloudCoverPct ?? 0;
  const dynamicCloud = series && times && t != null ? computePreAndPostRainCloudCover(series, times, t, baseCloud, precip) : baseCloud;

  return {
    windKmh: a.windKmh ?? 0,
    windFromDeg: a.windFromDeg ?? 0,
    gustKmh: a.gustKmh ?? null,
    tempC: temp,
    humidityPct: humidity,
    fineFuelMoisturePct: a.fuelMoisture?.dead1hPct ?? estimateDeadFuelMoisture(temp, humidity),
    precipitationMmH: a.precipitationMmH ?? null,
    cloudCoverPct: dynamicCloud > 0 ? dynamicCloud : null,
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
