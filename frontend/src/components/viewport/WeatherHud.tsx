import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '@/components/common/Icon';
import { humidityColorVar, windColorCss } from '@/domain/colors';
import { compass } from '@/domain/georef';
import { fireRiskLevel, findUpcomingWeatherShift, groundVisibilityFromSmoke, sampleWeatherAt } from '@/domain/weather';
import { useEngine } from '@/engine/EngineContext';
import { useAppStore } from '@/store/appStore';

import styles from './viewport.module.css';

const OPEN_KEY = 'firetrace.weatherHud.open';

/** Open or closed is a per-viewer convenience: closed by default, remembered when the browser lets it, and the card works without it. */
function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Weather card over the map. Closed (the default) it is one line: wind arrow, speed, where it blows from, air temperature and
 * humidity, and a dot when the fire risk is high. Open, it adds the alerts (rain, a coming wind shift, smoke, risk), gusts,
 * fine-fuel moisture and the source. Values follow the playback minute.
 *
 * The arrow is the WIND: it points where the wind blows ON THE SCREEN, turning with the camera like the compass rose, so it always
 * matches the wind particles and smoke drifting across the map. The dial has no N of its own: the compass rose shows north.
 */
export function WeatherHud() {
  const engine = useEngine();
  const rose = useRef<SVGGElement>(null);
  useEffect(() => {
    if (!engine) return;
    let shown = Number.NaN;
    let shownOn: SVGGElement | null = null;
    return engine.onFrame((_ts, azimuth) => {
      const el = rose.current;
      const deg = Math.round(((-azimuth * 180) / Math.PI) * 2) / 2; // half-degree steps: no DOM write while the camera is still
      if (!el || (el === shownOn && deg === shown)) return;
      shown = deg;
      shownOn = el; // the card unmounts while there is no run: a new element needs the angle again
      el.setAttribute('transform', `rotate(${deg})`);
    });
  }, [engine]);
  const [open, setOpen] = useState(readOpen);
  const toggle = () =>
    setOpen((was) => {
      try {
        window.localStorage.setItem(OPEN_KEY, was ? '0' : '1');
      } catch {
        /* not remembered */
      }
      return !was;
    });
  const run = useAppStore((s) => s.run);
  const t = useAppStore((s) => s.t);
  const scenarioId = useAppStore((s) => s.scenarioId);
  const smokeInfo = useAppStore((s) => s.smokeInfo);

  const weather = useMemo(() => (run ? sampleWeatherAt(run.weather, run.startMs, t) : null), [run, t]);
  const upcomingShift = useMemo(() => (run ? findUpcomingWeatherShift(run.weather, run.startMs, t) : null), [run, t]);
  const visibilityM = useMemo(() => groundVisibilityFromSmoke(smokeInfo), [smokeInfo]);

  if (!weather) return null;
  const to = (weather.windFromDeg + 180) % 360;
  const color = windColorCss(weather.windKmh);
  const risk = fireRiskLevel(weather);
  const riskLabel = risk === 'extreme' ? 'Risco extremo' : risk === 'high' ? 'Risco elevado' : null;
  const label = open ? 'Esconder detalhes da meteorologia' : 'Mostrar detalhes da meteorologia';

  return (
    <div className={`${styles.hud} ${open ? styles.hudOpen : ''}`}>
      <button type="button" className={styles.hudHead} onClick={toggle} aria-expanded={open} aria-label={label} title={label}>
        <svg className={styles.dial} viewBox="-32 -32 64 64" role="img" aria-label={`Vento de ${compass(weather.windFromDeg)}, a soprar para ${compass(to)}`}>
          <title>{`Seta: para onde o vento sopra no mapa, tal como o vê. Sopra para ${compass(to)} (vem de ${compass(weather.windFromDeg)}); roda com a câmara.`}</title>
          <circle r="29" fill="none" stroke="currentColor" strokeOpacity=".22" />
          <g ref={rose}>
            <g transform={`rotate(${to})`} style={{ color }}>
              <path d="M0 -22 L9 -4 L3 -4 L3 20 L-3 20 L-3 -4 L-9 -4 Z" fill="currentColor" />
            </g>
          </g>
        </svg>
        <span className={styles.hudWind}>
          <b style={{ color }}>
            {Math.round(weather.windKmh)}
            <small> km/h</small>
          </b>
          <small>
            de {compass(weather.windFromDeg)} → {compass(to)}
          </small>
        </span>
        <span className={styles.hudQuick}>
          <span title="Temperatura do ar">
            <Icon name="thermometer" size={12} /> {Math.round(weather.tempC)}°
          </span>
          <span title="Humidade do ar">
            <Icon name="humidity" size={12} /> {Math.round(weather.humidityPct)}%
          </span>
        </span>
        {riskLabel && !open ? <i className={`${styles.riskDot} ${risk === 'extreme' ? styles.riskDotExtreme : ''}`} title={riskLabel} /> : null}
        <span className={styles.hudChevron} aria-hidden="true">
          <Icon name="chevron" size={14} />
        </span>
      </button>

      {open ? (
        <div className={styles.hudBody}>
          {risk === 'extreme' ? (
            <div className={`${styles.hudAlert} ${styles.alertExtreme}`} title="Regra dos 30-30-30: temperatura ≥ 30 °C, humidade ≤ 30 %, vento ou rajadas ≥ 30 km/h">
              <Icon name="alert" size={12} /> <b>Risco extremo</b> · regra 30-30-30
            </div>
          ) : risk === 'high' ? (
            <div className={`${styles.hudAlert} ${styles.alertHigh}`} title="Calor e ar seco: os combustíveis finos ardem com mais facilidade (T ≥ 30 °C · HR ≤ 30 %)">
              <Icon name="alert" size={12} /> <b>Risco elevado</b> · calor e seca
            </div>
          ) : null}
          {upcomingShift ? (
            <div
              className={`${styles.hudAlert} ${styles.alertShift}`}
              title={`Rotação prevista de ${upcomingShift.dirChangeDeg}° e ${upcomingShift.speedDeltaKmh > 0 ? '+' : ''}${upcomingShift.speedDeltaKmh} km/h ao minuto ${upcomingShift.atMinute}`}
            >
              <Icon name="clock" size={12} /> {upcomingShift.label}
            </div>
          ) : null}
          {weather.precipitationMmH != null && weather.precipitationMmH > 0 ? (
            <div className={`${styles.hudAlert} ${styles.alertRain}`}>
              <Icon name="rain" size={12} /> Chuva <b>{weather.precipitationMmH.toFixed(1)} mm/h</b>
            </div>
          ) : null}
          {visibilityM != null && visibilityM < 4000 ? (
            <div className={`${styles.hudAlert} ${styles.alertSmoke}`} title="Visibilidade ao nível do solo reduzida pelo fumo">
              <Icon name="cloud" size={12} /> Visibilidade <b>{(visibilityM / 1000).toFixed(1)} km</b> · fumo
            </div>
          ) : null}

          <dl className={styles.hudRows}>
            <dt>Vento</dt>
            <dd>
              {Math.round(weather.windFromDeg)}° · sopra para {compass(to)}
            </dd>
            {weather.gustKmh ? (
              <>
                <dt>Rajadas</dt>
                <dd>{Math.round(weather.gustKmh)} km/h</dd>
              </>
            ) : null}
            <dt title="Temperatura do ar do modelo meteorológico; não é a temperatura do fogo">Temp. do ar</dt>
            <dd>{Math.round(weather.tempC)} °C</dd>
            <dt>Humidade do ar</dt>
            <dd>
              <i className={styles.bar}>
                <i style={{ width: `${Math.min(weather.humidityPct, 100)}%`, background: humidityColorVar(weather.humidityPct) }} />
              </i>
              {Math.round(weather.humidityPct)} %
            </dd>
            <dt title="Humidade do combustível morto fino em equilíbrio com o ar: quanto mais baixa, mais depressa arde">Comb. fino</dt>
            <dd>{weather.fineFuelMoisturePct != null ? `${weather.fineFuelMoisturePct.toFixed(1)} %` : '—'}</dd>
            {weather.cloudCoverPct != null && weather.cloudCoverPct > 25 ? (
              <>
                <dt>Nuvens</dt>
                <dd>{Math.round(weather.cloudCoverPct)} %</dd>
              </>
            ) : null}
          </dl>
          <small className={styles.hudSource}>
            {scenarioId === 'custom' ? 'Definida no cenário' : 'ERA5 / Open-Meteo'}
            {weather.isDay != null ? ` · ${weather.isDay ? 'dia' : 'noite'}` : ''}
          </small>
        </div>
      ) : null}
    </div>
  );
}
