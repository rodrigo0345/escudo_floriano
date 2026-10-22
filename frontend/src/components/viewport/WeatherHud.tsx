import { useEffect, useMemo, useRef } from 'react';

import { Icon } from '@/components/common/Icon';
import { humidityColorVar, windColorCss } from '@/domain/colors';
import { compass } from '@/domain/georef';
import { fireRiskLevel, findUpcomingWeatherShift, groundVisibilityFromSmoke, sampleWeatherAt } from '@/domain/weather';
import { useEngine } from '@/engine/EngineContext';
import { useAppStore } from '@/store/appStore';

import styles from './viewport.module.css';

/**
 * Weather card over the map: wind arrow (rotates with the camera), speed and gust, bearing,
 * temperature, air humidity and fine-fuel moisture. Values follow the playback minute; only
 * the arrow rotation is driven per frame (straight on the DOM, no React re-render).
 */
export function WeatherHud() {
  const engine = useEngine();
  const run = useAppStore((s) => s.run);
  const t = useAppStore((s) => s.t);
  const scenarioId = useAppStore((s) => s.scenarioId);
  const smokeInfo = useAppStore((s) => s.smokeInfo);
  const arrow = useRef<SVGGElement>(null);
  const windToDeg = useRef(0);

  const weather = useMemo(() => (run ? sampleWeatherAt(run.weather, run.startMs, t) : null), [run, t]);
  const upcomingShift = useMemo(
    () => (run ? findUpcomingWeatherShift(run.weather, run.startMs, t) : null),
    [run, t],
  );
  const visibilityM = useMemo(() => groundVisibilityFromSmoke(smokeInfo), [smokeInfo]);
  windToDeg.current = weather ? (weather.windFromDeg + 180) % 360 : 0;

  useEffect(() => {
    if (!engine) return;
    return engine.onFrame((_ts, azimuth) => {
      arrow.current?.setAttribute('transform', `rotate(${windToDeg.current - (azimuth * 180) / Math.PI})`);
    });
  }, [engine]);

  if (!weather) return null;
  const to = (weather.windFromDeg + 180) % 360;
  const color = windColorCss(weather.windKmh);

  return (
    <div className={styles.hud}>
      <svg className={styles.dial} viewBox="-32 -32 64 64" aria-hidden="true">
        <circle r="29" fill="none" stroke="currentColor" strokeOpacity=".25" />
        <text y="-19" textAnchor="middle" fontSize="8" fill="currentColor" opacity=".7">
          N
        </text>
        <g ref={arrow} style={{ color }}>
          <path d="M0 -22 L9 -4 L3 -4 L3 20 L-3 20 L-3 -4 L-9 -4 Z" fill="currentColor" />
        </g>
      </svg>
      <div className={styles.hudMain}>
        <b style={{ color }}>{Math.round(weather.windKmh)} km/h</b>
        <small>
          de {compass(weather.windFromDeg)} · {Math.round(weather.windFromDeg)}° (sopra para {compass(to)})
        </small>
        <small>
          {weather.gustKmh ? `rajadas ${Math.round(weather.gustKmh)} km/h` : ''}
          {weather.cloudCoverPct != null && weather.cloudCoverPct > 25 ? ` · ${Math.round(weather.cloudCoverPct)}% nuvens` : ''}
          {weather.isDay != null ? ` · ${weather.isDay ? 'dia' : 'noite'}` : ''}
        </small>
      </div>
      {weather.precipitationMmH != null && weather.precipitationMmH > 0 ? (
        <div className={styles.hudPrecip}>
          <Icon name="rain" /> Chuva: <b>{weather.precipitationMmH.toFixed(1)} mm/h</b>
        </div>
      ) : null}
      {upcomingShift && (
        <div
          className={styles.upcomingShift}
          title={`Prevista rotação de ${upcomingShift.dirChangeDeg}° e variação de ${upcomingShift.speedDeltaKmh > 0 ? '+' : ''}${upcomingShift.speedDeltaKmh} km/h ao minuto ${upcomingShift.atMinute}`}
        >
          <span className={styles.shiftIcon}>
            <Icon name="clock" />
          </span>
          <span>{upcomingShift.label}</span>
        </div>
      )}
      {visibilityM != null && visibilityM < 4000 ? (
        <div className={styles.hudVisibility} title="Visibilidade reduzida ao nível do solo devido à propagação de fumo">
          <Icon name="cloud" /> Visibilidade: <b>{(visibilityM / 1000).toFixed(1)} km</b> (fumo)
        </div>
      ) : null}
      {fireRiskLevel(weather) === 'extreme' ? (
        <div className={styles.extremeAlert} title="Condições meteorológicas extremas de propagação de incêndio rural (Regra dos 30-30-30: Temp ≥ 30°C, Humidade ≤ 30%, Vento/Rajadas ≥ 30 km/h)">
          <Icon name="alert" /> <b>RISCO EXTREMO · Regra 30-30-30</b> (T≥30°C · HR≤30% · V≥30 km/h)
        </div>
      ) : fireRiskLevel(weather) === 'high' ? (
        <div className={styles.highRiskChip} title="Calor excessivo e ar seco aumentam a combustibilidade dos combustíveis finos (T ≥ 30°C · HR ≤ 30%)">
          <Icon name="alert" /> <span>Risco Elevado · Calor e Seca</span>
        </div>
      ) : null}
      <div className={styles.hudRows}>
        <span title="Temperatura do ar do modelo meteorológico; não é a temperatura do fogo">Temp. do ar</span>
        <b>{Math.round(weather.tempC)} °C</b>
        <span>Humidade do ar</span>
        <b>{Math.round(weather.humidityPct)} %</b>
        <i className={styles.bar}>
          <i style={{ width: `${Math.min(weather.humidityPct, 100)}%`, background: humidityColorVar(weather.humidityPct) }} />
        </i>
        <span title="Humidade do combustível morto fino em equilíbrio com o ar: quanto mais baixa, mais depressa arde">Comb. fino</span>
        <b>{weather.fineFuelMoisturePct != null ? `${weather.fineFuelMoisturePct.toFixed(1)} %` : '—'}</b>
      </div>
      <small className={styles.hudSource}>{scenarioId === 'custom' ? 'temperatura do ar definida no cenário' : 'temperatura do ar · ERA5 / Open-Meteo'}</small>
    </div>
  );
}
