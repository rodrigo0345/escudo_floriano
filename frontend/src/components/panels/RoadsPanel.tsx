import { useMemo } from 'react';

import { CardGrid, Row, StatCard, Tag } from '@/components/common/StatCard';
import { useSimulationActions } from '@/hooks/useSimulationActions';
import { useWorld } from '@/engine/EngineContext';
import { useAppStore } from '@/store/appStore';
import type { RescueOrigin } from '@/store/types';

const MAJOR = /primary|secondary|trunk|motorway/;
const MAX_ROWS = 14;
const ORIGINS: { value: RescueOrigin; label: string }[] = [
  { value: 'fire_brigade', label: 'Bombeiros' },
  { value: 'gnr', label: 'GNR' },
  { value: 'inem', label: 'INEM / hospitais' },
  { value: 'any', label: 'Qualquer meio' },
];

/** Which roads are cut at the current minute, and which places lost (or lost time on) rescue access. */
export function RoadsPanel() {
  const world = useWorld();
  const run = useAppStore((s) => s.run);
  const t = useAppStore((s) => s.t);
  const origin = useAppStore((s) => s.origin);
  const setOrigin = useAppStore((s) => s.setOrigin);
  const { reloadImpact } = useSimulationActions();

  const view = useMemo(() => {
    if (!world || !run?.impact) return null;
    const state = run.impact.at(t);
    const features = world.roads.features;
    const groups = new Map<string, { count: number; highway: string; prob: number }>();
    state.cut.forEach((i) => {
      const props = features[i].properties;
      const name = props?.name ?? 'sem nome';
      const g = groups.get(name) ?? { count: 0, highway: props?.class ?? '', prob: 0 };
      g.count++;
      groups.set(name, g);
    });
    state.prob.forEach(([i, p]) => {
      const g = groups.get(features[i].properties?.name ?? 'sem nome');
      if (g) g.prob = Math.max(g.prob, p);
    });
    const rows = [...groups.entries()].sort((a, b) => Number(MAJOR.test(b[1].highway)) - Number(MAJOR.test(a[1].highway)) || b[1].count - a[1].count);
    const baseline = run.impact.baseline;
    const places = run.impact.places
      .map((pl, i) => ({ ...pl, a: state.access[i], b: baseline[i], iso: state.isolatedPct[i] }))
      .filter((x) => x.a === null || (x.b != null && x.a - x.b >= 3))
      .sort((x, y) => Number(y.a === null) - Number(x.a === null) || (y.population ?? 0) - (x.population ?? 0));
    return { state, features, rows, places, noAccess: places.filter((x) => x.a === null) };
  }, [world, run, t]);

  if (!view) return <p className="note">Sem simulação.</p>;
  const { state, features, rows, places, noAccess } = view;

  return (
    <>
      <h3>Origem dos meios</h3>
      <select
        value={origin}
        onChange={async (e) => {
          setOrigin(e.target.value as RescueOrigin);
          await reloadImpact();
        }}
      >
        {ORIGINS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <div style={{ marginTop: 10 }}>
        <CardGrid>
          <StatCard label="Troços cortados" value={state.cut.length} sub={`de ${features.length}`} />
          <StatCard label="Sem acesso" value={noAccess.length} sub={`${noAccess.reduce((s, x) => s + (x.population ?? 0), 0).toLocaleString('pt-PT')} hab.`} />
        </CardGrid>
      </div>

      <h3>Estradas cortadas · T+{t} min</h3>
      {rows.length ? (
        rows.slice(0, MAX_ROWS).map(([name, g]) => (
          <Row key={name}>
            <span>
              {name} <small>{g.highway}{g.count > 1 ? ` · ${g.count} troços` : ''}</small>
            </span>
            <Tag kind="bad">cortada{g.prob ? ` · ${g.prob}%` : ''}</Tag>
          </Row>
        ))
      ) : (
        <p className="note">Nenhuma estrada cortada.</p>
      )}
      {rows.length > MAX_ROWS ? <p className="note">+ {rows.length - MAX_ROWS} vias</p> : null}

      <h3>Acesso das localidades</h3>
      {places.length ? (
        places.slice(0, MAX_ROWS).map((x) => (
          <Row key={x.placeId}>
            <span>
              {x.name} <small>{x.population} hab.</small>
            </span>
            <span>
              <Tag kind={x.a === null ? 'bad' : 'warn'}>{x.a === null ? 'SEM ACESSO' : `${x.a} min (+${(x.a - (x.b ?? 0)).toFixed(0)})`}</Tag> <small>{x.iso}%</small>
            </span>
          </Row>
        ))
      ) : (
        <p className="note">Todas as localidades acessíveis sem atraso relevante.</p>
      )}
      <p className="note">A percentagem é a probabilidade, no conjunto de simulações com meteorologia perturbada (ensemble).</p>
    </>
  );
}
