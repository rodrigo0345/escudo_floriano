import { Row } from '@/components/common/StatCard';
import { formatTime } from '@/domain/weather';
import { useAppStore } from '@/store/appStore';

import { SimulationForm } from './SimulationForm';

const MILESTONE_MINUTES = [15, 30, 60, 120, 180];
const nf = (n: number) => n.toLocaleString('pt-PT');
const minutesLabel = (m: number) => (m >= 60 ? `${m / 60} h` : `${m} min`);

/** Scenario milestones, plus the form used to launch a custom simulation. */
function IncidentSummary() {
  const run = useAppStore((s) => s.run);
  const scenarioId = useAppStore((s) => s.scenarioId);
  const scenarios = useAppStore((s) => s.data?.scenarios ?? []);

  const scenario = scenarios.find((x) => x.id === scenarioId);

  return (
    <>
      <h3>{scenario ? scenario.name : 'Incidente'}</h3>
      {!run ? <p className="note">Escolha um cenário ou crie um personalizado.</p> : null}

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
      <IncidentSummary />
      <SimulationForm />
      <h3>Vista</h3>
      <label className="note">
        <input type="checkbox" checked={probMode} onChange={(e) => setProbMode(e.target.checked)} /> Mostrar probabilidade de corte/isolamento (ensemble)
      </label>
    </>
  );
}
