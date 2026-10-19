import { Row } from '@/components/common/StatCard';
import { compass } from '@/domain/georef';
import { formatDateTime } from '@/domain/weather';
import { useAppStore } from '@/store/appStore';

import { WeatherChart } from './WeatherChart';

/** The "Meteo" tab: the weather series driving the simulation, with a cursor at the current minute. */
export function WeatherPanel() {
  const run = useAppStore((s) => s.run);
  const t = useAppStore((s) => s.t);
  const point = useAppStore((s) => s.data?.location.weatherPoint);
  const scenarioId = useAppStore((s) => s.scenarioId);

  if (!run?.weather.length) return <p className="note">Sem simulação.</p>;

  return (
    <>
      <h3>Meteorologia{point ? ` · ${point.lat.toFixed(3)}, ${point.lon.toFixed(3)}` : ''}</h3>
      <WeatherChart samples={run.weather} cursorMs={run.startMs + t * 60000} />
      <h3>Série</h3>
      {run.weather
        .filter((_, i) => i % 6 === 0)
        .slice(0, 48)
        .map((x) => (
          <Row key={x.time}>
            <span>{formatDateTime(x.time)}</span>
            <small>
              {Math.round(x.windKmh ?? 0)} km/h de {compass(x.windFromDeg ?? 0)} · {Math.round(x.humidityPct ?? 0)}% · {Math.round(x.tempC ?? 0)}°C
            </small>
          </Row>
        ))}
      <p className="note">
        {scenarioId === 'custom'
          ? 'Meteorologia definida no formulário de simulação.'
          : 'Fonte: Open-Meteo (ERA5 para datas passadas, previsão para as recentes), guardada em cache no PostGIS.'}
      </p>
    </>
  );
}
