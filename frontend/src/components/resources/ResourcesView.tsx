import { useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  equipmentApi,
  organizationsApi,
  personnelApi,
  stationsApi,
  vehiclesApi,
  type Equipment,
  type EquipmentInput,
  type Organization,
  type OrganizationInput,
  type PersonnelPool,
  type PersonnelPoolInput,
  type Station,
  type StationInput,
  type Vehicle,
  type VehicleCapability,
  type VehicleInput,
} from '@/api';
import { CardGrid, StatCard } from '@/components/common/StatCard';
import {
  CAPABILITY_LABEL,
  EQUIPMENT_LABEL,
  ORG_COLOR,
  ORG_TYPE_LABEL,
  ROLE_LABEL,
  STATION_KIND_LABEL,
  VEHICLE_TYPE_LABEL,
  enumEntries,
} from '@/domain/resourceLabels';
import { OrgLogo } from '@/domain/organizationLogos';
import { VehicleIcon } from '@/domain/vehicleIcons';
import { VEHICLE_CATALOG, catalogFor, templateToInput, type VehicleTemplate } from '@/domain/vehicleCatalog';
import { useAppStore } from '@/store/appStore';
import { useResourcesStore } from '@/store/resourcesStore';

import styles from './resources.module.css';

type Section = 'vehicles' | 'stations' | 'personnel' | 'equipment' | 'org';
const nf = (n: number | undefined | null) => (n == null ? '—' : n.toLocaleString('pt-PT'));

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`${styles.field} ${wide ? styles.wide : ''}`}>
      {label}
      {children}
    </label>
  );
}

/** A number input that maps an empty box to `undefined` (so the field is omitted rather than sent as 0). */
function NumInput({ value, onChange, min = 0, step }: { value: number | undefined; onChange: (n: number | undefined) => void; min?: number; step?: number }) {
  return (
    <input
      type="number"
      min={min}
      step={step}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    />
  );
}

/** Registry of everything each corporation owns: vehicles (with real specs from the catalogue), stations, people, equipment. */
export function ResourcesView() {
  const { organizations, stations, vehicles, pools, equipment, loading, error, loaded, load, mutate, completeFromCatalog } = useResourcesStore();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('vehicles');
  const [creatingOrg, setCreatingOrg] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  useEffect(() => {
    if (!orgId && organizations.length) setOrgId(organizations[0].id as string);
  }, [organizations, orgId]);

  const org = organizations.find((o) => o.id === orgId) ?? null;
  const own = useMemo(
    () => ({
      vehicles: vehicles.filter((v) => v.organizationId === orgId),
      stations: stations.filter((s) => s.organizationId === orgId),
      pools: pools.filter((p) => p.organizationId === orgId),
      equipment: equipment.filter((e) => e.organizationId === orgId),
    }),
    [vehicles, stations, pools, equipment, orgId],
  );

  const totals = {
    water: own.vehicles.reduce((a, v) => a + (v.waterCapacityL ?? 0), 0),
    crew: own.vehicles.reduce((a, v) => a + v.crewCapacity, 0),
    people: own.pools.reduce((a, p) => a + p.total, 0),
    peopleFree: own.pools.reduce((a, p) => a + p.available, 0),
  };

  const sections: [Section, string, number][] = [
    ['vehicles', 'Veículos', own.vehicles.length],
    ['stations', 'Estações', own.stations.length],
    ['personnel', 'Pessoal', own.pools.length],
    ['equipment', 'Equipamento', own.equipment.length],
    ['org', 'Corporação', 0],
  ];

  return (
    <div className={styles.view}>
      <div className={styles.side}>
        <h3>Corporações</h3>
        {organizations.map((o) => (
          <button
            key={o.id}
            className={`${styles.org} ${o.id === orgId && !creatingOrg ? styles.on : ''}`}
            onClick={() => {
              setOrgId(o.id as string);
              setCreatingOrg(false);
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <OrgLogo org={o} size={32} />
              <div style={{ minWidth: 0, overflow: 'hidden' }}>
                <b>{o.shortName ?? o.name}</b>
                <br />
                <small>
                  {ORG_TYPE_LABEL[o.type]} · {vehicles.filter((v) => v.organizationId === o.id).length} veículos
                </small>
              </div>
            </div>
          </button>
        ))}
        <button className="primary" onClick={() => setCreatingOrg(true)}>
          + Nova corporação
        </button>
        <hr style={{ width: '100%', borderColor: 'var(--line)' }} />
        <button
          disabled={!vehicles.length || loading}
          title="Preenche água, bomba, velocidade, combustível, lotação... de todos os veículos com as especificações reais do catálogo"
          onClick={async () => {
            if (!window.confirm(`Sobrescrever as especificações de ${vehicles.length} veículos com os valores do catálogo? (Indicativos/siglas, estação e estado não mudam.)`)) return;
            const n = await completeFromCatalog();
            window.alert(`${n} veículos atualizados.`);
          }}
        >
          Completar frota com especificações reais
        </button>
        <p className="note">Valores do catálogo: fontes públicas quando existem, estimativas assinaladas caso contrário.</p>
      </div>

      <div className={styles.body}>
        {error ? <div className={styles.err}>{error}</div> : null}
        {creatingOrg ? (
          <OrgEditor
            onDone={() => setCreatingOrg(false)}
            onSave={async (input) => {
              const ok = await mutate(() => organizationsApi.create(input));
              if (ok) setCreatingOrg(false);
            }}
          />
        ) : org ? (
          <>
            <div className={styles.head}>
              <OrgLogo org={org} size={44} style={{ marginRight: '14px' }} />
              <h2>{org.name}</h2>
              <span className={styles.chip}>{ORG_TYPE_LABEL[org.type]}</span>
              {loading ? <small>a atualizar…</small> : null}
            </div>
            <div className={styles.kpis}>
              <CardGrid>
                <StatCard label="Veículos" value={own.vehicles.length} sub={`${own.vehicles.filter((v) => v.inService !== false).length} em serviço`} />
                <StatCard label="Água transportável" value={`${nf(totals.water)} L`} />
                <StatCard label="Lotação de viaturas" value={totals.crew} sub="lugares de equipa" />
                <StatCard label="Pessoal" value={`${totals.peopleFree}/${totals.people}`} sub="disponível / total" />
              </CardGrid>
            </div>
            <div className={styles.tabs}>
              {sections.map(([key, label, n]) => (
                <button key={key} className={section === key ? 'on' : ''} onClick={() => setSection(key)}>
                  {label}
                  {key !== 'org' ? ` (${n})` : ''}
                </button>
              ))}
            </div>
            {section === 'vehicles' ? <VehiclesSection org={org} list={own.vehicles} stations={own.stations} /> : null}
            {section === 'stations' ? <StationsSection org={org} list={own.stations} /> : null}
            {section === 'personnel' ? <PersonnelSection org={org} list={own.pools} stations={own.stations} /> : null}
            {section === 'equipment' ? <EquipmentSection org={org} list={own.equipment} stations={own.stations} /> : null}
            {section === 'org' ? (
              <OrgEditor
                org={org}
                onDone={() => undefined}
                onSave={async (input) => {
                  await mutate(() => organizationsApi.patch(org.id as string, input));
                }}
                onDelete={async () => {
                  if (!window.confirm(`Apagar «${org.name}»?`)) return;
                  if (await mutate(() => organizationsApi.delete(org.id as string))) setOrgId(null);
                }}
              />
            ) : null}
          </>
        ) : (
          <p className="note">{loading ? 'A carregar recursos…' : 'Sem corporações registadas. Crie a primeira.'}</p>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ organization
function OrgEditor({
  org,
  onSave,
  onDone,
  onDelete,
}: {
  org?: Organization;
  onSave: (input: OrganizationInput) => Promise<void>;
  onDone: () => void;
  onDelete?: () => Promise<void>;
}) {
  const [d, setD] = useState<OrganizationInput>(() => (org ? { ...org } : { name: '', type: 'fire_brigade', active: true }));
  useEffect(() => {
    if (org) setD({ ...org });
  }, [org]);
  return (
    <div className={styles.editor}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <OrgLogo org={d} size={36} />
        <h3>{org ? 'Dados da corporação' : 'Nova corporação'}</h3>
      </div>
      <div className={styles.grid}>
        <Field label="Nome" wide>
          <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
        </Field>
        <Field label="Sigla">
          <input value={d.shortName ?? ''} onChange={(e) => setD({ ...d, shortName: e.target.value || undefined })} />
        </Field>
        <Field label="Tipo">
          <select value={d.type} onChange={(e) => setD({ ...d, type: e.target.value as Organization['type'] })}>
            {enumEntries(ORG_TYPE_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Centro de operações">
          <input
            value={d.operationsCenter?.name ?? ''}
            onChange={(e) => setD({ ...d, operationsCenter: { ...d.operationsCenter, name: e.target.value } })}
          />
        </Field>
        <Field label="Telefone CO">
          <input
            value={d.operationsCenter?.phone ?? ''}
            onChange={(e) => setD({ ...d, operationsCenter: { ...d.operationsCenter, phone: e.target.value } })}
          />
        </Field>
        <Field label="Canal rádio">
          <input
            value={d.operationsCenter?.radioChannel ?? ''}
            onChange={(e) => setD({ ...d, operationsCenter: { ...d.operationsCenter, radioChannel: e.target.value } })}
          />
        </Field>
      </div>
      <div className={styles.btns}>
        <button className="primary" disabled={!d.name.trim()} onClick={() => void onSave({ ...d, name: d.name.trim() })}>
          {org ? 'Guardar' : 'Criar corporação'}
        </button>
        {!org ? <button onClick={onDone}>Cancelar</button> : null}
        {onDelete ? <button onClick={() => void onDelete()}>Apagar corporação</button> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------- vehicles
const blankVehicle = (organizationId: string): VehicleInput => ({ organizationId, callsign: '', type: 'forest_firefighting_vehicle', crewCapacity: 2, inService: true });

function VehiclesSection({ org, list, stations }: { org: Organization; list: Vehicle[]; stations: Station[] }) {
  const mutate = useResourcesStore((s) => s.mutate);
  const [editing, setEditing] = useState<{ id: string | null; draft: VehicleInput; tpl?: VehicleTemplate } | null>(null);

  const startNew = () => setEditing({ id: null, draft: blankVehicle(org.id as string) });
  const edit = (v: Vehicle) => {
    const { id, createdAt, updatedAt, state, ...input } = v as Vehicle & { state?: unknown };
    void id; void createdAt; void updatedAt; void state;
    setEditing({ id: v.id as string, draft: input as VehicleInput });
  };

  return (
    <>
      <div className={styles.btns} style={{ marginBottom: 10 }}>
        <button className="primary" onClick={startNew}>
          + Novo veículo
        </button>
      </div>
      {editing ? (
        <VehicleEditor
          key={editing.id ?? 'new'}
          org={org}
          stations={stations}
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={async (draft) => {
            const ok = await mutate(() => (editing.id ? vehiclesApi.patch(editing.id, draft) : vehiclesApi.create(draft)));
            if (ok) setEditing(null);
          }}
        />
      ) : null}
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Indicativo</th>
            <th>Tipo</th>
            <th>Estação</th>
            <th>Equipa (min–máx)</th>
            <th>Pessoas</th>
            <th>Água (L)</th>
            <th>Bomba (L/min)</th>
            <th>Vel. (km/h)</th>
            <th>Combust. (L)</th>
            <th>Autonomia (km)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((v) => (
            <tr key={v.id}>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <VehicleIcon type={v.type} size={22} color={ORG_COLOR[org.type] ?? '#ff3b3b'} />
                  <div>
                    <b>{v.callsign}</b> {v.inService === false ? <span className={styles.chip}>fora de serviço</span> : null}
                  </div>
                </div>
              </td>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <VehicleIcon type={v.type} size={16} color="var(--muted, #8a94a0)" />
                  <span>{VEHICLE_TYPE_LABEL[v.type]}</span>
                </div>
              </td>
              <td>{stations.find((s) => s.id === v.stationId)?.name ?? '—'}</td>
              <td className={styles.num}>
                {v.minimumCrew ?? '—'}–{v.crewCapacity}
              </td>
              <td className={styles.num} title={v.state?.crew?.casualties ? `${v.state.crew.casualties} baixas` : undefined}>
                {v.state?.crewOnboard ?? '—'}/{v.crewCapacity}
                {v.state?.crew?.casualties ? ` (−${v.state.crew.casualties})` : ''}
              </td>
              <td className={styles.num}>{nf(v.aerial?.bucketCapacityL ?? v.waterCapacityL)}</td>
              <td className={styles.num}>{nf(v.pumpFlowLpm)}</td>
              <td className={styles.num}>{nf(v.cruiseSpeedKmh)}</td>
              <td className={styles.num}>{nf(v.fuelCapacityL)}</td>
              <td className={styles.num}>{nf(v.rangeKm)}</td>
              <td className={styles.actions}>
                <button onClick={() => edit(v)}>Editar</button>
                <button
                  onClick={() => {
                    if (window.confirm(`Apagar ${v.callsign}?`)) void mutate(() => vehiclesApi.delete(v.id as string));
                  }}
                >
                  Apagar
                </button>
              </td>
            </tr>
          ))}
          {!list.length ? (
            <tr>
              <td colSpan={11}>
                <small>Sem veículos. Use «Novo veículo» e escolha um modelo do catálogo.</small>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </>
  );
}

function VehicleEditor({
  org,
  stations,
  initial,
  onSave,
  onCancel,
}: {
  org: Organization;
  stations: Station[];
  initial: { id: string | null; draft: VehicleInput };
  onSave: (d: VehicleInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [d, setD] = useState<VehicleInput>(initial.draft);
  const [tpl, setTpl] = useState<VehicleTemplate | undefined>(undefined);
  const set = <K extends keyof VehicleInput>(k: K, v: VehicleInput[K]) => setD((p) => ({ ...p, [k]: v }));
  const options = catalogFor(org.type);
  const all = options.length ? options : VEHICLE_CATALOG;

  const applyTemplate = (key: string) => {
    const t = VEHICLE_CATALOG.find((x) => x.key === key);
    setTpl(t);
    if (!t) return;
    const spec = templateToInput(t);
    setD((p) => ({ ...p, ...spec, callsign: p.callsign || t.typeCode }));
  };

  const toggleCap = (c: VehicleCapability) => {
    const cur = new Set(d.capabilities ?? []);
    if (cur.has(c)) cur.delete(c);
    else cur.add(c);
    set('capabilities', [...cur]);
  };
  const aerialOn = d.type === 'helicopter' || d.type === 'airtanker';

  return (
    <div className={styles.editor}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
        <VehicleIcon type={d.type} size={28} color={ORG_COLOR[org.type] ?? '#ff3b3b'} />
        <h3 style={{ margin: 0 }}>{initial.id ? `Editar ${initial.draft.callsign}` : 'Novo veículo'}</h3>
      </div>
      <Field label="Modelo do catálogo (preenche as especificações)" wide>
        <select value={tpl?.key ?? ''} onChange={(e) => applyTemplate(e.target.value)}>
          <option value="">— manual —</option>
          {all.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
      </Field>
      {tpl ? (
        <div className={styles.tplNote}>
          <span className={`${styles.chip} ${styles[tpl.confidence]}`}>{tpl.confidence === 'sourced' ? 'com fonte pública' : 'estimativa'}</span> {tpl.note}
          {tpl.sources?.map((s) => (
            <span key={s.url}>
              {' '}
              ·{' '}
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.label}
              </a>
            </span>
          ))}
        </div>
      ) : null}
      <div className={styles.grid}>
        <Field label="Indicativo">
          <input value={d.callsign} onChange={(e) => set('callsign', e.target.value)} />
        </Field>
        <Field label="Matrícula">
          <input value={d.plate ?? ''} onChange={(e) => set('plate', e.target.value || undefined)} />
        </Field>
        <Field label="Tipo">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <VehicleIcon type={d.type} size={22} color={ORG_COLOR[org.type] ?? '#ff3b3b'} />
            <select style={{ flex: 1 }} value={d.type} onChange={(e) => set('type', e.target.value as VehicleInput['type'])}>
              {enumEntries(VEHICLE_TYPE_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </Field>
        <Field label="Sigla (typeCode)">
          <input value={d.typeCode ?? ''} onChange={(e) => set('typeCode', e.target.value || undefined)} />
        </Field>
        <Field label="Estação base">
          <select value={d.stationId ?? ''} onChange={(e) => set('stationId', e.target.value || null)}>
            <option value="">—</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Operadores (lotação máx.)">
          <NumInput value={d.crewCapacity} onChange={(n) => set('crewCapacity', n ?? 0)} />
        </Field>
        <Field label="Operadores mínimos">
          <NumInput value={d.minimumCrew} onChange={(n) => set('minimumCrew', n)} />
        </Field>
        <Field label="Água (L)">
          <NumInput value={d.waterCapacityL} onChange={(n) => set('waterCapacityL', n)} />
        </Field>
        <Field label="Espuma (L)">
          <NumInput value={d.foamCapacityL} onChange={(n) => set('foamCapacityL', n)} />
        </Field>
        <Field label="Caudal da bomba (L/min)">
          <NumInput value={d.pumpFlowLpm} onChange={(n) => set('pumpFlowLpm', n)} />
        </Field>
        <Field label="Combustível (L)">
          <NumInput value={d.fuelCapacityL} onChange={(n) => set('fuelCapacityL', n)} />
        </Field>
        <Field label="Autonomia (km)">
          <NumInput value={d.rangeKm} onChange={(n) => set('rangeKm', n)} />
        </Field>
        <Field label="Velocidade de cruzeiro (km/h)">
          <NumInput value={d.cruiseSpeedKmh} onChange={(n) => set('cruiseSpeedKmh', n)} />
        </Field>
        <Field label="Declive máx. (%)">
          <NumInput value={d.maxSlopePercent} onChange={(n) => set('maxSlopePercent', n)} />
        </Field>
        <Field label="Macas">
          <NumInput value={d.stretcherCapacity} onChange={(n) => set('stretcherCapacity', n)} />
        </Field>
        <Field label="Passageiros">
          <NumInput value={d.passengerCapacity} onChange={(n) => set('passengerCapacity', n)} />
        </Field>
        <Field label="Altura (m)">
          <NumInput value={d.heightM} step={0.1} onChange={(n) => set('heightM', n)} />
        </Field>
        <Field label="Largura (m)">
          <NumInput value={d.widthM} step={0.1} onChange={(n) => set('widthM', n)} />
        </Field>
        <Field label="Peso (t)">
          <NumInput value={d.weightT} step={0.1} onChange={(n) => set('weightT', n)} />
        </Field>
      </div>
      <div className={styles.caps}>
        <label>
          <input type="checkbox" checked={!!d.offRoad} onChange={(e) => set('offRoad', e.target.checked)} /> Todo-o-terreno
        </label>
        <label>
          <input type="checkbox" checked={d.inService !== false} onChange={(e) => set('inService', e.target.checked)} /> Em serviço
        </label>
      </div>
      <Field label="Capacidades" wide>
        <div className={styles.caps}>
          {enumEntries(CAPABILITY_LABEL).map(([k, l]) => (
            <label key={k}>
              <input type="checkbox" checked={d.capabilities?.includes(k) ?? false} onChange={() => toggleCap(k)} /> {l}
            </label>
          ))}
        </div>
      </Field>
      {aerialOn ? (
        <div className={styles.grid}>
          <Field label="Balde / depósito (L)">
            <NumInput value={d.aerial?.bucketCapacityL} onChange={(n) => set('aerial', { ...d.aerial, bucketCapacityL: n })} />
          </Field>
          <Field label="Tempo de carga (min)">
            <NumInput value={d.aerial?.loadMinutes} step={0.1} onChange={(n) => set('aerial', { ...d.aerial, loadMinutes: n })} />
          </Field>
          <Field label="Tempo de largada (min)">
            <NumInput value={d.aerial?.dropMinutes} step={0.1} onChange={(n) => set('aerial', { ...d.aerial, dropMinutes: n })} />
          </Field>
          <Field label="Vento máx. (km/h)">
            <NumInput value={d.aerial?.maxWindKmh} onChange={(n) => set('aerial', { ...d.aerial, maxWindKmh: n })} />
          </Field>
        </div>
      ) : null}
      <div className={styles.btns}>
        <button
          className="primary"
          disabled={!d.callsign.trim()}
          onClick={() => {
            const out: VehicleInput = {
              ...d,
              organizationId: org.id as string,
              callsign: d.callsign.trim(),
              aerial: aerialOn && d.aerial ? { ...d.aerial, cruiseSpeedKmh: d.aerial.cruiseSpeedKmh ?? d.cruiseSpeedKmh } : d.aerial,
            };
            void onSave(out);
          }}
        >
          Guardar
        </button>
        <button onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------- stations
function StationsSection({ org, list }: { org: Organization; list: Station[] }) {
  const mutate = useResourcesStore((s) => s.mutate);
  const locationId = useAppStore((s) => s.locationId);
  const center = useAppStore((s) => s.data?.location.center);
  const [ed, setEd] = useState<{ id: string | null; d: StationInput } | null>(null);
  const blank = (): StationInput => ({
    organizationId: org.id as string,
    name: '',
    kind: 'fire_station',
    locationId: locationId ?? '',
    position: center ?? { lat: 41.44, lon: -8.3 },
    vehicleBays: 4,
    status: 'operational',
  });
  return (
    <>
      <div className={styles.btns} style={{ marginBottom: 10 }}>
        <button className="primary" onClick={() => setEd({ id: null, d: blank() })}>
          + Nova estação
        </button>
      </div>
      {ed ? (
        <div className={styles.editor}>
          <h3>{ed.id ? 'Editar estação' : 'Nova estação'}</h3>
          <div className={styles.grid}>
            <Field label="Nome" wide>
              <input value={ed.d.name} onChange={(e) => setEd({ ...ed, d: { ...ed.d, name: e.target.value } })} />
            </Field>
            <Field label="Tipo">
              <select value={ed.d.kind} onChange={(e) => setEd({ ...ed, d: { ...ed.d, kind: e.target.value as StationInput['kind'] } })}>
                {enumEntries(STATION_KIND_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Latitude">
              <input type="number" step="0.0001" value={ed.d.position.lat} onChange={(e) => setEd({ ...ed, d: { ...ed.d, position: { ...ed.d.position, lat: Number(e.target.value) } } })} />
            </Field>
            <Field label="Longitude">
              <input type="number" step="0.0001" value={ed.d.position.lon} onChange={(e) => setEd({ ...ed, d: { ...ed.d, position: { ...ed.d.position, lon: Number(e.target.value) } } })} />
            </Field>
            <Field label="Garagens (viaturas)">
              <NumInput value={ed.d.vehicleBays} onChange={(n) => setEd({ ...ed, d: { ...ed.d, vehicleBays: n } })} />
            </Field>
            <Field label="Morada" wide>
              <input value={ed.d.address ?? ''} onChange={(e) => setEd({ ...ed, d: { ...ed.d, address: e.target.value || undefined } })} />
            </Field>
          </div>
          <div className={styles.btns}>
            <button
              className="primary"
              disabled={!ed.d.name.trim() || !ed.d.locationId}
              onClick={async () => {
                const ok = await mutate(() => (ed.id ? stationsApi.patch(ed.id, ed.d) : stationsApi.create(ed.d)));
                if (ok) setEd(null);
              }}
            >
              Guardar
            </button>
            <button onClick={() => setEd(null)}>Cancelar</button>
          </div>
        </div>
      ) : null}
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Nome</th>
            <th>Tipo</th>
            <th>Garagens</th>
            <th>Coordenadas</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{STATION_KIND_LABEL[s.kind]}</td>
              <td className={styles.num}>{nf(s.vehicleBays)}</td>
              <td>
                {s.position.lat.toFixed(4)}, {s.position.lon.toFixed(4)}
              </td>
              <td className={styles.actions}>
                <button
                  onClick={() => {
                    const { id, createdAt, updatedAt, ...input } = s;
                    void id; void createdAt; void updatedAt;
                    setEd({ id: s.id as string, d: input as StationInput });
                  }}
                >
                  Editar
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`Apagar ${s.name}?`)) void mutate(() => stationsApi.delete(s.id as string));
                  }}
                >
                  Apagar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ---------------------------------------------------------------------- personnel
function PersonnelSection({ org, list, stations }: { org: Organization; list: PersonnelPool[]; stations: Station[] }) {
  const mutate = useResourcesStore((s) => s.mutate);
  const [ed, setEd] = useState<{ id: string | null; d: PersonnelPoolInput } | null>(null);
  const blank = (): PersonnelPoolInput => ({ organizationId: org.id as string, role: 'firefighter', total: 10, available: 10 });
  return (
    <>
      <div className={styles.btns} style={{ marginBottom: 10 }}>
        <button className="primary" onClick={() => setEd({ id: null, d: blank() })}>
          + Novo grupo de pessoal
        </button>
      </div>
      {ed ? (
        <div className={styles.editor}>
          <h3>{ed.id ? 'Editar grupo' : 'Novo grupo de pessoal'}</h3>
          <div className={styles.grid}>
            <Field label="Função">
              <select value={ed.d.role} onChange={(e) => setEd({ ...ed, d: { ...ed.d, role: e.target.value as PersonnelPoolInput['role'] } })}>
                {enumEntries(ROLE_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Estação">
              <select value={ed.d.stationId ?? ''} onChange={(e) => setEd({ ...ed, d: { ...ed.d, stationId: e.target.value || null } })}>
                <option value="">— todas —</option>
                {stations.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Efetivo total">
              <NumInput value={ed.d.total} onChange={(n) => setEd({ ...ed, d: { ...ed.d, total: n ?? 0 } })} />
            </Field>
            <Field label="Disponíveis agora">
              <NumInput value={ed.d.available} onChange={(n) => setEd({ ...ed, d: { ...ed.d, available: n ?? 0 } })} />
            </Field>
            <Field label="Fadiga (%)">
              <NumInput value={ed.d.fatiguePct} onChange={(n) => setEd({ ...ed, d: { ...ed.d, fatiguePct: n } })} />
            </Field>
            <Field label="Notas" wide>
              <input value={ed.d.notes ?? ''} onChange={(e) => setEd({ ...ed, d: { ...ed.d, notes: e.target.value || undefined } })} />
            </Field>
          </div>
          <div className={styles.btns}>
            <button
              className="primary"
              disabled={ed.d.available > ed.d.total}
              onClick={async () => {
                const ok = await mutate(() => (ed.id ? personnelApi.patch(ed.id, ed.d) : personnelApi.create(ed.d)));
                if (ok) setEd(null);
              }}
            >
              Guardar
            </button>
            <button onClick={() => setEd(null)}>Cancelar</button>
            {ed.d.available > ed.d.total ? <small>Disponíveis não pode exceder o total.</small> : null}
          </div>
        </div>
      ) : null}
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Função</th>
            <th>Estação</th>
            <th>Total</th>
            <th>Disponíveis</th>
            <th>Fadiga</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((p) => (
            <tr key={p.id}>
              <td>{ROLE_LABEL[p.role]}</td>
              <td>{stations.find((s) => s.id === p.stationId)?.name ?? 'todas'}</td>
              <td className={styles.num}>{p.total}</td>
              <td className={styles.num}>{p.available}</td>
              <td className={styles.num}>{p.fatiguePct != null ? `${p.fatiguePct}%` : '—'}</td>
              <td className={styles.actions}>
                <button
                  onClick={() => {
                    const { id, createdAt, updatedAt, deployed, ...input } = p as PersonnelPool & { deployed?: number };
                    void id; void createdAt; void updatedAt; void deployed;
                    setEd({ id: p.id as string, d: input as PersonnelPoolInput });
                  }}
                >
                  Editar
                </button>
                <button
                  onClick={() => {
                    if (window.confirm('Apagar este grupo?')) void mutate(() => personnelApi.delete(p.id as string));
                  }}
                >
                  Apagar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// --------------------------------------------------------------------- equipment
function EquipmentSection({ org, list, stations }: { org: Organization; list: Equipment[]; stations: Station[] }) {
  const mutate = useResourcesStore((s) => s.mutate);
  const [ed, setEd] = useState<{ id: string | null; d: EquipmentInput } | null>(null);
  const blank = (): EquipmentInput => ({ organizationId: org.id as string, kind: 'portable_pump', quantity: 1, available: 1 });
  return (
    <>
      <div className={styles.btns} style={{ marginBottom: 10 }}>
        <button className="primary" onClick={() => setEd({ id: null, d: blank() })}>
          + Novo equipamento
        </button>
      </div>
      {ed ? (
        <div className={styles.editor}>
          <h3>{ed.id ? 'Editar equipamento' : 'Novo equipamento'}</h3>
          <div className={styles.grid}>
            <Field label="Tipo">
              <select value={ed.d.kind} onChange={(e) => setEd({ ...ed, d: { ...ed.d, kind: e.target.value as EquipmentInput['kind'] } })}>
                {enumEntries(EQUIPMENT_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Descrição">
              <input value={ed.d.label ?? ''} onChange={(e) => setEd({ ...ed, d: { ...ed.d, label: e.target.value || undefined } })} />
            </Field>
            <Field label="Estação">
              <select value={ed.d.stationId ?? ''} onChange={(e) => setEd({ ...ed, d: { ...ed.d, stationId: e.target.value || null } })}>
                <option value="">—</option>
                {stations.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quantidade">
              <NumInput value={ed.d.quantity} onChange={(n) => setEd({ ...ed, d: { ...ed.d, quantity: n ?? 0 } })} />
            </Field>
            <Field label="Disponível">
              <NumInput value={ed.d.available} onChange={(n) => setEd({ ...ed, d: { ...ed.d, available: n ?? 0 } })} />
            </Field>
          </div>
          <div className={styles.btns}>
            <button
              className="primary"
              disabled={ed.d.available > ed.d.quantity}
              onClick={async () => {
                const ok = await mutate(() => (ed.id ? equipmentApi.patch(ed.id, ed.d) : equipmentApi.create(ed.d)));
                if (ok) setEd(null);
              }}
            >
              Guardar
            </button>
            <button onClick={() => setEd(null)}>Cancelar</button>
          </div>
        </div>
      ) : null}
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Equipamento</th>
            <th>Estação</th>
            <th>Quantidade</th>
            <th>Disponível</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((e) => (
            <tr key={e.id}>
              <td>{e.label ?? EQUIPMENT_LABEL[e.kind]}</td>
              <td>{stations.find((s) => s.id === e.stationId)?.name ?? '—'}</td>
              <td className={styles.num}>{e.quantity}</td>
              <td className={styles.num}>{e.available}</td>
              <td className={styles.actions}>
                <button
                  onClick={() => {
                    const { id, createdAt, updatedAt, inUse, ...input } = e as Equipment & { inUse?: number };
                    void id; void createdAt; void updatedAt; void inUse;
                    setEd({ id: e.id as string, d: input as EquipmentInput });
                  }}
                >
                  Editar
                </button>
                <button
                  onClick={() => {
                    if (window.confirm('Apagar este equipamento?')) void mutate(() => equipmentApi.delete(e.id as string));
                  }}
                >
                  Apagar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
