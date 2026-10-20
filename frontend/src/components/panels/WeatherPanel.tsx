import { useMemo } from 'react';

import { Row } from '@/components/common/StatCard';
import { humidityColorVar, windColorCss } from '@/domain/colors';
import { compass } from '@/domain/georef';
import {
  detectWeatherEvents,
  formatDateTime,
  formatTime,
  getFuelMoistureInfo,
  isExtremeFireWeather,
  operationalDangerRating,
  sampleWeatherAt,
} from '@/domain/weather';
import { useAppStore } from '@/store/appStore';

import { WeatherChart } from './WeatherChart';
import styles from './panels.module.css';

/**
 * The "Meteo" tab (Epic E7):
 * - Current conditions card at minute `t` (wind, gusts, bearing, temp, humidity, fine-fuel moisture, rain, clouds).
 * - Fire-weather indicators: Portuguese "Regra dos 30-30-30" status & operational danger rating.
 * - Full interactive weather chart with gusts, rain, cloud cover, and shaded 30-30-30 danger bands.
 * - Timeline of significant upcoming weather events (wind rotations, rain passages, storm fronts).
 * - Full chronological weather series.
 */
export function WeatherPanel() {
  const run = useAppStore((s) => s.run);
  const t = useAppStore((s) => s.t);
  const point = useAppStore((s) => s.data?.location.weatherPoint);
  const scenarioId = useAppStore((s) => s.scenarioId);

  const weather = useMemo(() => (run ? sampleWeatherAt(run.weather, run.startMs, t) : null), [run, t]);
  const danger = useMemo(() => operationalDangerRating(weather), [weather]);
  const fuelInfo = useMemo(() => getFuelMoistureInfo(weather?.fineFuelMoisturePct ?? 10), [weather?.fineFuelMoisturePct]);
  const events = useMemo(() => (run ? detectWeatherEvents(run.weather, run.startMs) : []), [run]);
  const is30 = useMemo(() => isExtremeFireWeather(weather), [weather]);

  if (!run?.weather.length || !weather) {
    return <p className="note">Sem simulação carregada.</p>;
  }

  const currentMs = run.startMs + t * 60_000;
  const windTo = (weather.windFromDeg + 180) % 360;
  const windColor = windColorCss(weather.windKmh);

  const tMet = weather.tempC >= 30;
  const hMet = weather.humidityPct <= 30;
  const wMet = weather.windKmh >= 30 || (weather.gustKmh != null && weather.gustKmh >= 30);

  return (
    <>
      <div className={styles.baseLine} style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Meteorologia</h3>
        {point ? <small>· {point.lat.toFixed(3)}°N, {Math.abs(point.lon).toFixed(3)}°W</small> : null}
      </div>

      {/* Card de Condições Atuais ao Minuto T */}
      <div className={styles.weatherCard}>
        <div className={styles.weatherCardHeader}>
          <div>
            <div className={styles.weatherCardTitle}>
              <span>Condições ao Minuto T+{t}</span>
            </div>
            <span className={styles.weatherCardSub}>{formatDateTime(currentMs)}</span>
          </div>
          <span className={styles.dangerBadge} style={{ background: danger.color }} title={danger.description}>
            {danger.label}
          </span>
        </div>

        <div className={styles.conditionsGrid}>
          {/* Vento */}
          <div className={styles.metricTile}>
            <span>Vento Sustentado</span>
            <b style={{ color: windColor }}>{Math.round(weather.windKmh)} km/h</b>
            <small>
              de {compass(weather.windFromDeg)} ({Math.round(weather.windFromDeg)}°) · para {compass(windTo)}
            </small>
            {weather.gustKmh ? (
              <small style={{ color: '#fdba74' }}>rajadas até {Math.round(weather.gustKmh)} km/h</small>
            ) : null}
          </div>

          {/* Temperatura */}
          <div className={styles.metricTile}>
            <span>Temperatura do Ar</span>
            <b style={{ color: weather.tempC >= 30 ? '#ef4444' : 'var(--fg)' }}>{Math.round(weather.tempC)} °C</b>
            <small>{weather.tempC >= 30 ? 'Calor extremo' : weather.tempC >= 25 ? 'Temperatura elevada' : 'Moderada'}</small>
          </div>

          {/* Humidade Relativa */}
          <div className={styles.metricTile}>
            <span>Humidade Relativa</span>
            <b style={{ color: weather.humidityPct <= 30 ? '#f97316' : 'var(--fg)' }}>{Math.round(weather.humidityPct)} %</b>
            <div style={{ height: 4, background: 'var(--line)', borderRadius: 2, overflow: 'hidden', marginTop: 4 }}>
              <div style={{ height: '100%', width: `${Math.min(weather.humidityPct, 100)}%`, background: humidityColorVar(weather.humidityPct) }} />
            </div>
          </div>

          {/* Combustíveis Finos Mortos (1h dead fuel moisture) */}
          <div className={styles.metricTile} title={fuelInfo.description}>
            <span>Combustíveis Finos (1h)</span>
            <b style={{ color: fuelInfo.color }}>{weather.fineFuelMoisturePct?.toFixed(1) ?? '—'} %</b>
            <small style={{ color: fuelInfo.color, fontWeight: 600 }}>{fuelInfo.label}</small>
          </div>

          {/* Chuva */}
          <div className={styles.metricTile}>
            <span>Precipitação</span>
            <b>{weather.precipitationMmH != null && weather.precipitationMmH > 0 ? `${weather.precipitationMmH.toFixed(1)} mm/h` : '0.0 mm/h'}</b>
            <small>
              {weather.precipitationMmH != null && weather.precipitationMmH >= 7.5
                ? '⚡ Trovoada ativa'
                : weather.precipitationMmH != null && weather.precipitationMmH > 0
                  ? '🌧️ Chuva ativa'
                  : 'Sem precipitação'}
            </small>
          </div>

          {/* Nuvens */}
          <div className={styles.metricTile}>
            <span>Nebulosidade</span>
            <b>{Math.round(weather.cloudCoverPct ?? 0)} %</b>
            <small>
              {(weather.cloudCoverPct ?? 0) >= 80
                ? 'Encoberto'
                : (weather.cloudCoverPct ?? 0) >= 30
                  ? 'Parcialmente nublado'
                  : 'Céu limpo'}
            </small>
          </div>
        </div>
      </div>

      {/* Indicador Operacional: Regra dos 30-30-30 */}
      <div className={is30 ? styles.rule30Active : styles.rule30Normal}>
        <div className={styles.rule30Header}>
          <span style={{ color: is30 ? '#ef4444' : 'var(--fg)' }}>
            {is30 ? '🚨 ALERTA 30-30-30 ATIVO' : '📐 Regra dos 30-30-30'}
          </span>
          <small style={{ color: is30 ? '#ef4444' : 'var(--mut)', fontWeight: 600 }}>
            {is30 ? 'RISCO EXTREMO' : `${[tMet, hMet, wMet].filter(Boolean).length}/3 critérios`}
          </small>
        </div>
        <div className={styles.rule30Desc}>
          {is30
            ? 'Condições propícias a propagação violenta com taxa extrema e múltiplos focos secundários ("spotting").'
            : 'Critério de perigo extremo: Temp ≥ 30 °C, Humidade ≤ 30 % e Vento ≥ 30 km/h.'}
        </div>
        <div className={styles.rule30Criteria}>
          <div className={`${styles.criteriaChip} ${tMet ? styles.criteriaMet : styles.criteriaUnmet}`}>
            <span>Temp ≥ 30°C</span>
            <b>{Math.round(weather.tempC)}°C {tMet ? '✔' : ''}</b>
          </div>
          <div className={`${styles.criteriaChip} ${hMet ? styles.criteriaMet : styles.criteriaUnmet}`}>
            <span>HR ≤ 30%</span>
            <b>{Math.round(weather.humidityPct)}% {hMet ? '✔' : ''}</b>
          </div>
          <div className={`${styles.criteriaChip} ${wMet ? styles.criteriaMet : styles.criteriaUnmet}`}>
            <span>Vento ≥ 30</span>
            <b>{Math.round(weather.windKmh)} km/h {wMet ? '✔' : ''}</b>
          </div>
        </div>
      </div>

      {/* Gráfico Meteorológico Completo */}
      <h3 style={{ marginTop: 14 }}>Evolução Meteorológica</h3>
      <WeatherChart samples={run.weather} cursorMs={currentMs} />

      {/* Linha Temporal de Eventos Previstos */}
      {events.length > 0 ? (
        <>
          <h3 style={{ marginTop: 14 }}>Eventos na Linha Temporal</h3>
          <div className={styles.eventList}>
            {events.map((ev, idx) => {
              const deltaMin = ev.minute - t;
              const isPast = deltaMin < 0;
              const isCurrent = Math.abs(deltaMin) <= 2;
              return (
                <div key={idx} className={styles.eventRow} style={{ opacity: isPast ? 0.6 : 1 }}>
                  <span className={styles.eventTag} style={{ background: ev.badgeColor }}>
                    T+{ev.minute} min
                  </span>
                  <div>
                    <b style={{ color: 'var(--fg)' }}>{ev.title}</b>
                    <div style={{ color: 'var(--mut)', fontSize: 10.5 }}>{ev.detail}</div>
                  </div>
                  <small style={{ color: isCurrent ? 'var(--acc)' : 'var(--mut)', fontWeight: isCurrent ? 700 : 400 }}>
                    {isCurrent ? 'AGORA' : isPast ? 'decorrido' : `em ${deltaMin} min`}
                  </small>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      {/* Tabela de Amostras da Série */}
      <h3 style={{ marginTop: 14 }}>Série Temporal (Open-Meteo)</h3>
      {run.weather
        .filter((_, i) => i % 4 === 0)
        .slice(0, 36)
        .map((x) => {
          const sampleMs = +new Date(x.time);
          const sampleMin = Math.round((sampleMs - run.startMs) / 60_000);
          const isActive = Math.abs(sampleMin - t) <= 7;
          return (
            <Row key={x.time} className={isActive ? styles.seriesActiveRow : undefined}>
              <span>
                {formatTime(x.time)} <small style={{ color: 'var(--mut)' }}>(T+{sampleMin}m)</small>
              </span>
              <small>
                {Math.round(x.windKmh ?? 0)} km/h {compass(x.windFromDeg ?? 0)} · {Math.round(x.humidityPct ?? 0)}% · {Math.round(x.tempC ?? 0)}°C
                {(x.precipitationMmH ?? 0) > 0 ? ` · 🌧️ ${x.precipitationMmH?.toFixed(1)}mm` : ''}
              </small>
            </Row>
          );
        })}

      <p className="note" style={{ marginTop: 10 }}>
        {scenarioId === 'custom'
          ? 'Meteorologia definida no formulário de simulação.'
          : 'Fonte: Open-Meteo (ERA5 para datas passadas, previsão para as recentes), guardada em cache no PostGIS.'}
      </p>
    </>
  );
}
