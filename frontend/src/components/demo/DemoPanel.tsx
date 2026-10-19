import { useEffect, useMemo, useState } from 'react';

import { Row } from '@/components/common/StatCard';
import { crewAt, PHASE_CODE } from '@/domain/dispatchPlanner';
import { ORG_COLOR, UNIT_PHASE_LABEL } from '@/domain/resourceLabels';
import { useWorld } from '@/engine/EngineContext';
import { useSimulationActions } from '@/hooks/useSimulationActions';
import { useAppStore } from '@/store/appStore';
import { useDemoStore } from '@/store/demoStore';
import { useResourcesStore } from '@/store/resourcesStore';
import { closePlan, executePlan, planOperation } from '@/usecases/dispatchDemo';

import styles from './demo.module.css';

const nf = (n: number, d = 0) => n.toLocaleString('pt-PT', { maximumFractionDigits: d });

const STAGE_LABEL = { idle: 'Sem plano', planning: 'A planear', planned: 'Plano publicado', executing: 'Plano ativo', closed: 'Plano encerrado' } as const;

/** "Operação" tab: plan a dispatch with the registered fleet, see how the fight goes in the shared 3D map, run it through the API. */
export function DemoPanel() {
  const demo = useDemoStore();
  const world = useWorld();
  const run = useAppStore((s) => s.run);
  const t = useAppStore((s) => s.t);
  const { vehicles, organizations, loaded, load } = useResourcesStore();
  const { showSimulation } = useSimulationActions();
  const [alarm, setAlarm] = useState(5);
  const [airLimits, setAirLimits] = useState(true);

  const busy = demo.stage === 'planning' || !!demo.status;
  const orgOf = (id: string) => organizations.find((o) => o.id === id);
  const available = useMemo(() => vehicles.filter((v) => v.inService !== false && (v.state?.status ?? 'available') === 'available').length, [vehicles]);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const track = (id: string) => demo.tracks.find((k) => k.unit.id === id);
  const minute = Math.min(Math.max(0, t), (demo.tracks[0]?.phase.length ?? 1) - 1);

  return (
    <>
      <h3>Operação</h3>
      <p className="note">
        Planeia o despacho dos {available} veículos disponíveis ({vehicles.length} registados) contra o fogo do cenário. O plano é publicado na API, o motor calcula
        o combate ao longo do tempo (chegada, água, reabastecimento, cansaço) e, ao ativar, os despachos e o estado das viaturas são escritos na API.
      </p>
      <div className={styles.opts}>
        <label>
          Alarme aos T+
          <input type="number" min={0} max={120} value={alarm} onChange={(e) => setAlarm(Math.max(0, Number(e.target.value)))} /> min
        </label>
        <label>
          <input type="checkbox" checked={airLimits} onChange={(e) => setAirLimits(e.target.checked)} /> Meios aéreos só de dia e abaixo do limite de vento
        </label>
      </div>
      <div className={styles.btnRow} style={{ marginTop: 10 }}>
        <button
          className="primary"
          disabled={busy || !run || demo.stage === 'executing'}
          onClick={() => planOperation({ alarmMinute: alarm, respectAirLimits: airLimits }, async (sim) => showSimulation(async () => sim))}
        >
          {demo.stage === 'idle' || demo.stage === 'closed' ? 'Planear despacho' : 'Replanear'}
        </button>
        {demo.stage === 'planned' ? (
          <button disabled={busy} onClick={() => void executePlan()}>
            Ativar plano
          </button>
        ) : null}
        {demo.stage === 'executing' ? <button onClick={() => void closePlan()}>Encerrar plano</button> : null}
      </div>
      {demo.status ? <p className="note">{demo.status}</p> : null}
      {demo.error ? <div className={styles.err}>{demo.error}</div> : null}

      <h3>Estado</h3>
      <Row>
        <span>Plano</span>
        <b>{STAGE_LABEL[demo.stage]}</b>
      </Row>
      {demo.stage === 'executing' ? (
        <p className="note">
          {Object.keys(demo.dispatchIds).length} despachos criados. Reproduza a linha de tempo: o estado de cada viatura é enviado à API à medida que avança.
        </p>
      ) : null}
      {demo.stage === 'closed' ? <p className="note">Despachos cancelados e viaturas de volta aos quartéis.</p> : null}

      {demo.result ? (
        <>
          <h3>Resultado da operação</h3>
          <Row>
            <span>Área ardida</span>
            <b>{nf(demo.result.areaHa)} ha</b>
          </Row>
          <Row>
            <span>Edifícios atingidos</span>
            <b>{nf(demo.result.buildings)}</b>
          </Row>
          <Row>
            <span>Baixas nas equipas</span>
            <b>{nf(demo.result.casualties)}</b>
          </Row>
          <Row>
            <span>Equipas apanhadas pelo fogo</span>
            <b>{demo.exposures.length}</b>
          </Row>
          <Row>
            <span>Meios despachados</span>
            <b>{demo.tracks.length}</b>
          </Row>
          {demo.warnings.length ? (
            <p className="note">
              <b>Avisos do plano</b>
              <br />
              {demo.warnings.slice(0, 6).map((w, i) => (
                <span key={i}>
                  {w}
                  <br />
                </span>
              ))}
            </p>
          ) : null}
        </>
      ) : null}

      {demo.tracks.length ? (
        <>
          <h3>Meios despachados ({demo.tracks.length})</h3>
          {demo.assignments.map((a) => {
            const k = track(a.unit.id);
            if (!k) return null;
            const phase = PHASE_CODE[k.phase[minute]];
            const cap = a.unit.air ? a.unit.bucketL : a.unit.waterL;
            const type = orgOf(a.unit.orgId)?.type ?? 'other';
            const crew = crewAt(k, demo.exposures.find((e) => e.vehicleId === a.unit.id), t);
            return (
              <div
                key={a.unit.id}
                className={`${styles.unit} ${demo.selectedUnit === a.unit.id ? styles.sel : ''}`}
                onClick={() => {
                  demo.patch({ selectedUnit: a.unit.id });
                  if (world) world.focusOnLatLon(k.lat[minute], k.lon[minute]);
                }}
                title={`${a.unit.orgName} · ${a.target.label}`}
              >
                <span className={styles.dot} style={{ background: ORG_COLOR[type] ?? '#7d8997' }} />
                <span>
                  <b>{a.unit.callsign}</b> <small>{a.unit.typeCode}</small>
                  <br />
                  <small>
                    {a.target.label} · {crew.people}/{a.unit.crew} pessoas
                    {crew.casualties ? ` (${crew.casualties} baixas)` : ''}
                  </small>
                </span>
                <span className={styles.phase}>{minute < k.from ? 'À espera' : UNIT_PHASE_LABEL[phase]}</span>
                <span className={styles.bar} title="água / combustível">
                  {cap ? <i style={{ width: `${(k.waterL[minute] / cap) * 50}%`, background: 'var(--blue)' }} /> : null}
                  <i style={{ width: `${k.fuelPct[minute] / 2}%`, background: k.fuelPct[minute] < 25 ? 'var(--bad)' : 'var(--warn)' }} />
                </span>
              </div>
            );
          })}
        </>
      ) : null}

      {demo.log.length ? (
        <>
          <h3>Diário de operações</h3>
          <div className={styles.log}>
            {demo.log.map((l, i) => (
              <div key={i} className={styles[l.kind]}>
                <time>T+{Math.floor(l.t)}</time>
                {l.text}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
