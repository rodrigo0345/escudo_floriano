import { CardGrid, Row, StatCard } from '@/components/common/StatCard';
import { compass } from '@/domain/georef';
import { formatTime } from '@/domain/weather';
import { useWorld } from '@/engine/EngineContext';
import { useAppStore } from '@/store/appStore';

import { SimulationForm } from './SimulationForm';

const MILESTONE_MINUTES = [15, 30, 60, 120, 180];
const nf = (n: number) => n.toLocaleString('pt-PT');
const minutesLabel = (m: number) => (m >= 60 ? `${m / 60} h` : `${m} min`);

function intensityNote(kwm: number): string {
  if (kwm > 4000) return 'muito intensa: supressão direta impossível';
  if (kwm > 1700) return 'intensa';
  return 'controlável';
}

/** Live numbers for the current minute (area, head speed/direction, wind, intensity, crown fire, roads cut, smoke) + milestones. */
function LiveSection() {
  const run = useAppStore((s) => s.run);
  const t = useAppStore((s) => s.t);
  const scenarioId = useAppStore((s) => s.scenarioId);
  const scenarios = useAppStore((s) => s.data?.scenarios ?? []);
  const smokeInfo = useAppStore((s) => s.smokeInfo);
  const smokeEnabled = useAppStore((s) => s.smokeEnabled);
  const world = useWorld();

  const scenario = scenarios.find((x) => x.id === scenarioId);
  const current = run?.summary.length ? run.summary.reduce((a, r) => (Math.abs(r.tMin - t) < Math.abs(a.tMin - t) ? r : a)) : null;
  const smoke = run && world && smokeEnabled ? world.smoke.describe(t) : null;
  const wind = current?.wind;
  const cutRoads = run?.impact?.at(t).cut.length;

  return (
    <>
      <h3>{scenario ? scenario.name : 'Incidente'}</h3>
      {scenario?.description ? (
        <p className="note">
          {scenario.description}
          {scenario.purpose === 'historical_replay' ? '' : <b> Cenário hipotético, não um incêndio real.</b>}
        </p>
      ) : null}

      {current ? (
        <CardGrid>
          <StatCard label="Área ardida" value={`${nf(current.areaHa)} ha`} sub={`T+${t} min`} />
          <StatCard label="Velocidade da frente" value={current.headSpeedMmin ? `${current.headSpeedMmin} m/min` : '—'} sub="média das setas mais rápidas" />
          <StatCard
            label="Direção da frente"
            value={current.headBearingDeg != null ? `${compass(current.headBearingDeg)} · ${current.headBearingDeg}°` : '—'}
            sub="para onde avança"
          />
          {wind?.windKmh != null && wind.windFromDeg != null ? (
            <StatCard label="Vento" value={`${Math.round(wind.windKmh)} km/h ${compass(wind.windFromDeg + 180)}`} sub={`de ${compass(wind.windFromDeg)} · ${Math.round(wind.windFromDeg)}°`} />
          ) : null}
          {wind?.humidityPct != null && wind.tempC != null ? (
            <StatCard label="Humidade / Temp." value={`${Math.round(wind.humidityPct)}% · ${Math.round(wind.tempC)}°C`} sub={scenarioId === 'custom' ? 'definida por si' : 'ERA5 / Open-Meteo'} />
          ) : null}
          <StatCard label="Estradas cortadas" value={cutRoads ?? '—'} sub="troços da rede OSM" />
          <StatCard
            label="Intensidade máx."
            value={current.maxIntensityKwm ? `${nf(current.maxIntensityKwm)} kW/m` : '—'}
            sub={current.maxIntensityKwm ? intensityNote(current.maxIntensityKwm) : ''}
          />
          <StatCard label="Fogo de copas" value={`${nf(current.crownHa ?? 0)} ha`} sub="copas a arder" />
          <StatCard label="Edifícios atingidos" value={nf(current.buildingsAffected ?? 0)} sub="dentro da área ardida (OSM)" />
          {smoke ? (
            <StatCard
              label="Fumo"
              value={`${compass(smoke.bearingDeg)} · ${smoke.speedKmh.toFixed(0)} km/h`}
              sub={`coluna ~${smokeInfo?.plumeHeightM?.p50 ?? smoke.plumeHeightM} m${smokeInfo?.affectedRoadIds ? ` · ${smokeInfo.affectedRoadIds.length} estradas sem visibilidade` : ''}`}
            />
          ) : null}
        </CardGrid>
      ) : (
        <p className="note">Escolha um cenário ou crie um personalizado.</p>
      )}

      {run ? (
        <>
          <h3>Marcos</h3>
          {run.summary
            .filter((r) => MILESTONE_MINUTES.includes(r.tMin))
            .map((r) => (
              <Row key={r.tMin}>
                <span>
                  {minutesLabel(r.tMin)} <small>{formatTime(r.time ?? run.startMs + r.tMin * 60000)}</small>
                </span>
                <span>
                  {nf(r.areaHa)} ha · {r.headSpeedMmin ?? '—'} m/min
                </span>
              </Row>
            ))}
        </>
      ) : null}
    </>
  );
}

export function IncidentPanel() {
  const probMode = useAppStore((s) => s.probMode);
  const setProbMode = useAppStore((s) => s.setProbMode);
  return (
    <>
      <LiveSection />
      <SimulationForm />
      <h3>Vista</h3>
      <label className="note">
        <input type="checkbox" checked={probMode} onChange={(e) => setProbMode(e.target.checked)} /> Mostrar probabilidade de corte/isolamento (ensemble)
      </label>
    </>
  );
}
