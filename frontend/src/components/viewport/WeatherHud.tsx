import { useEffect, useMemo, useRef } from 'react';

import { humidityColorVar, windColorCss } from '@/domain/colors';
import { compass } from '@/domain/georef';
import { fireRiskLevel, sampleWeatherAt } from '@/domain/weather';
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
  const arrow = useRef<SVGGElement>(null);
  const windToDeg = useRef(0);

  const weather = useMemo(() => (run ? sampleWeatherAt(run.weather, run.startMs, t) : null), [run, t]);
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
          {weather.cloudCoverPct != null && weather.cloudCoverPct > 25 ? ` · ☁️ ${Math.round(weather.cloudCoverPct)}% nuvens` : ''}
        </small>
      </div>
      {weather.precipitationMmH != null && weather.precipitationMmH > 0 ? (
        <div className={styles.hudPrecip}>
          🌧️ Chuva: <b>{weather.precipitationMmH.toFixed(1)} mm/h</b>
        </div>
      ) : null}
      {fireRiskLevel(weather) === 'extreme' ? (
        <div className={styles.extremeAlert} title="Condições meteorológicas extremas de propagação de incêndio rural">
          🚨 <b>RISCO EXTREMO · Regra 30-30-30</b> (T&gt;30°C · HR&lt;30% · V&gt;30 km/h)
        </div>
      ) : fireRiskLevel(weather) === 'high' ? (
        <div className={styles.highRiskAlert} title="Calor excessivo e ar seco aumentam significativamente a combustibilidade dos combustíveis finos">
          ⚠️ <b>Risco Elevado · Calor e Seca</b> ({Math.round(weather.tempC)}°C · {Math.round(weather.humidityPct)}% HR)
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
