import { StatCard } from '@/components/common/StatCard';
import { compass } from '@/domain/georef';
import { useWorld } from '@/engine/EngineContext';
import { useAppStore } from '@/store/appStore';

import styles from './MetricsBar.module.css';

const nf = (n: number) => n.toLocaleString('pt-PT');

function intensityNote(kwm: number): string {
  if (kwm > 4000) return 'muito intensa';
  if (kwm > 1700) return 'intensa';
  return 'controlável';
}

export function MetricsBar() {
  const tab = useAppStore((s) => s.tab);
  const run = useAppStore((s) => s.run);
  const t = useAppStore((s) => s.t);
  const scenarioId = useAppStore((s) => s.scenarioId);
  const smokeInfo = useAppStore((s) => s.smokeInfo);
  const smokeEnabled = useAppStore((s) => s.smokeEnabled);
  const world = useWorld();

  if (tab !== 'incident') return null;

  const current = run?.summary.length ? run.summary.reduce((a, r) => (Math.abs(r.tMin - t) < Math.abs(a.tMin - t) ? r : a)) : null;
  const smoke = run && world && smokeEnabled ? world.smoke.describe(t) : null;
  const wind = current?.wind;
  const cutRoads = run?.impact?.at(t).cut.length;

  return (
    <section className={styles.strip} aria-label="Métricas do incêndio">
      <div className={styles.lead}>
        <span>Incidente</span>
        <small>{current ? `T+${t} min` : 'sem simulação'}</small>
      </div>
      <div className={styles.grid}>
        {current ? (
          <>
            <StatCard className={styles.card} label="Área ardida" value={`${nf(current.areaHa)} ha`} sub={`T+${t} min`} />
            <StatCard
              className={styles.card}
              label="Velocidade da frente"
              value={current.headSpeedMmin ? `${current.headSpeedMmin} m/min` : '—'}
              sub="média das setas"
            />
            <StatCard
              className={styles.card}
              label="Direção da frente"
              value={current.headBearingDeg != null ? `${compass(current.headBearingDeg)} · ${current.headBearingDeg}°` : '—'}
              sub="para onde avança"
            />
            {wind?.windKmh != null && wind.windFromDeg != null ? (
              <StatCard
                className={styles.card}
                label="Vento"
                value={`${Math.round(wind.windKmh)} km/h ${compass(wind.windFromDeg + 180)}`}
                sub={`de ${compass(wind.windFromDeg)} · ${Math.round(wind.windFromDeg)}°`}
              />
            ) : null}
            {wind?.humidityPct != null && wind.tempC != null ? (
              <StatCard
                className={styles.card}
                label="Humidade / Temp."
                value={`${Math.round(wind.humidityPct)}% · ${Math.round(wind.tempC)}°C`}
                sub={scenarioId === 'custom' ? 'definida por si' : 'ERA5 / Open-Meteo'}
              />
            ) : null}
            <StatCard className={styles.card} label="Estradas cortadas" value={cutRoads ?? '—'} sub="troços da rede OSM" />
            <StatCard
              className={styles.card}
              label="Intensidade máx."
              value={current.maxIntensityKwm ? `${nf(current.maxIntensityKwm)} kW/m` : '—'}
              sub={current.maxIntensityKwm ? intensityNote(current.maxIntensityKwm) : ''}
            />
            <StatCard className={styles.card} label="Fogo de copas" value={`${nf(current.crownHa ?? 0)} ha`} sub="copas a arder" />
            <StatCard className={styles.card} label="Edifícios atingidos" value={nf(current.buildingsAffected ?? 0)} sub="na área ardida (OSM)" />
            {smoke ? (
              <StatCard
                className={styles.card}
                label="Fumo"
                value={`${compass(smoke.bearingDeg)} · ${smoke.speedKmh.toFixed(0)} km/h`}
                sub={`~${smokeInfo?.plumeHeightM?.p50 ?? smoke.plumeHeightM} m${smokeInfo?.affectedRoadIds ? ` · ${smokeInfo.affectedRoadIds.length} estradas` : ''}`}
                title="Pluma indicativa gerada por partículas GPU (aproximação visual sem peso físico nem impacto no alastre do fogo)"
              />
            ) : null}
          </>
        ) : (
          <p className={styles.empty}>Escolha um cenário ou crie um personalizado.</p>
        )}
      </div>
    </section>
  );
}
