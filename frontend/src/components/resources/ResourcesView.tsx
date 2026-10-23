import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';

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
import { Icon } from '@/components/common/Icon';
import { CardGrid, StatCard } from '@/components/common/StatCard';
import {
  CAPABILITY_LABEL,
  EQUIPMENT_LABEL,
  ORG_COLOR,
  coreOrganizationIds,
  ORG_TYPE_LABEL,
  ROLE_LABEL,
  STATION_KIND_LABEL,
  VEHICLE_TYPE_LABEL,
  enumEntries,
} from '@/domain/resourceLabels';
import { OrgLogo } from '@/domain/organizationLogos';
import { VehicleIcon } from '@/domain/vehicleIcons';
import { VehicleModelPhoto } from '@/domain/vehicleModelImages';
import { VEHICLE_CATALOG, catalogFor, templateForVehicle, templateToInput, type VehicleTemplate } from '@/domain/vehicleCatalog';
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

/** An input with an attached unit badge (e.g. L, km/h, L/min, lugares, macas) */
function FieldWithUnit({
  label,
  unit,
  value,
  onChange,
  min = 0,
  step,
  wide,
}: {
  label: string;
  unit: string;
  value: number | undefined;
  onChange: (n: number | undefined) => void;
  min?: number;
  step?: number;
  wide?: boolean;
}) {
  return (
    <label className={`${styles.field} ${wide ? styles.wide : ''}`}>
      <span>{label}</span>
      <div className={styles.inputWithUnit}>
        <input
          type="number"
          min={min}
          step={step}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
        <span className={styles.unitBadge}>{unit}</span>
      </div>
    </label>
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
  // the concelho's four corporations always; reinforcement groups and other organizations behind "Reforços", open when asked or when one is selected
  const coreIds = useMemo(() => coreOrganizationIds(organizations), [organizations]);
  const core = organizations.filter((o) => coreIds.has(o.id as string));
  const extras = organizations.filter((o) => !coreIds.has(o.id as string));
  const [showExtras, setShowExtras] = useState(false);
  const extrasOpen = showExtras || (!!org && !coreIds.has(org.id as string));
  const extraVehicles = vehicles.filter((v) => extras.some((o) => o.id === v.organizationId)).length;
  const reinforcementsToggle = extras.length ? (
    <button type="button" className={styles.reinforcements} onClick={() => setShowExtras(!extrasOpen)} aria-expanded={extrasOpen}>
      <span>
        <b>Reforços</b>
        <small>
          {extras.length} {extras.length === 1 ? 'grupo' : 'grupos'} · {extraVehicles} veículos
        </small>
      </span>
      <span className={`${styles.reinforcementsChevron} ${extrasOpen ? styles.reinforcementsChevronOpen : ''}`} aria-hidden="true">
        <Icon name="chevron" size={14} />
      </span>
    </button>
  ) : null;
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
    evacPassengers: own.vehicles.reduce((a, v) => a + (v.passengerCapacity ?? 0), 0),
    stretchers: own.vehicles.reduce((a, v) => a + (v.stretcherCapacity ?? 0), 0),
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
        {[...core, ...(extrasOpen ? extras : [])].map((o, index) => {
          const vCount = vehicles.filter((v) => v.organizationId === o.id).length;
          const pCount = pools.filter((p) => p.organizationId === o.id).reduce((sum, p) => sum + p.available, 0);
          return (
            <Fragment key={o.id}>
            {index === core.length ? reinforcementsToggle : null}
            <button
              className={`${styles.org} ${o.id === orgId && !creatingOrg ? styles.on : ''}`}
              onClick={() => {
                setOrgId(o.id as string);
                setCreatingOrg(false);
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', width: '100%' }}>
                <OrgLogo org={o} size={36} />
                <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                  <div style={{ fontWeight: 600, fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {o.shortName ?? o.name}
                  </div>
                  <small style={{ color: 'var(--muted, #8a94a0)', display: 'block', marginTop: '2px', fontSize: '11px' }}>
                    {ORG_TYPE_LABEL[o.type]} · {vCount} veículos {pCount > 0 ? `· ${pCount} operacionais` : ''}
                  </small>
                </div>
              </div>
            </button>
            </Fragment>
          );
        })}
        {!extrasOpen ? reinforcementsToggle : null}
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
                <StatCard
                  label="Evacuação de Civis"
                  value={`${totals.evacPassengers} lugares`}
                  sub={totals.stretchers > 0 ? `+ ${totals.stretchers} macas de transporte` : 'capacidade de evacuação'}
                />
                <StatCard label="Água transportável" value={`${nf(totals.water)} L`} sub="combate ativo" />
                <StatCard label="Operacionais" value={`${totals.peopleFree}/${totals.people}`} sub="disponíveis agora" />
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
const blankVehicle = (organizationId: string): VehicleInput => ({
  organizationId,
  callsign: '',
  type: 'forest_firefighting_vehicle',
  crewCapacity: 2,
  inService: true,
  capabilities: ['wildfire_attack'],
});

interface CapabilityCategory {
  title: string;
  caps: { key: VehicleCapability; label: string; isEvac?: boolean }[];
}

const CAPABILITY_CATEGORIES: CapabilityCategory[] = [
  {
    title: 'Combate a Incêndios',
    caps: [
      { key: 'wildfire_attack', label: 'Combate a fogos florestais' },
      { key: 'structure_protection', label: 'Proteção de estruturas' },
      { key: 'water_supply', label: 'Abastecimento de água' },
      { key: 'firebreak_construction', label: 'Construção de faixas corta-fogo' },
    ],
  },
  {
    title: 'Evacuação & Salvamento',
    caps: [
      { key: 'evacuation_transport', label: 'Transporte de evacuação de civis', isEvac: true },
      { key: 'medical_transport', label: 'Transporte médico / socorro' },
      { key: 'advanced_life_support', label: 'Suporte avançado de vida' },
      { key: 'rescue', label: 'Busca e salvamento' },
      { key: 'extrication', label: 'Desencarceramento' },
    ],
  },
  {
    title: 'Comando & Controlo Rodoviário',
    caps: [
      { key: 'command_and_control', label: 'Comando e controlo' },
      { key: 'communications', label: 'Telecomunicações / SIRESP' },
      { key: 'reconnaissance', label: 'Reconhecimento terrestre' },
      { key: 'traffic_control', label: 'Corte e controlo de trânsito' },
      { key: 'perimeter_security', label: 'Segurança de perímetro' },
    ],
  },
  {
    title: 'Apoio, Logística & Meios Aéreos',
    caps: [
      { key: 'aerial_water_drop', label: 'Largada de água aérea' },
      { key: 'aerial_recon', label: 'Reconhecimento aéreo / drone' },
      { key: 'logistics', label: 'Apoio logístico' },
      { key: 'lighting', label: 'Torre de iluminação' },
      { key: 'heavy_earthmoving', label: 'Maquinaria pesada' },
      { key: 'hazmat', label: 'Matérias perigosas (hazmat)' },
    ],
  },
];

type VehicleFilterTab = 'all' | 'wildfire' | 'evacuation' | 'command' | 'aerial';

function VehiclesSection({ org, list, stations }: { org: Organization; list: Vehicle[]; stations: Station[] }) {
  const mutate = useResourcesStore((s) => s.mutate);
  const [editing, setEditing] = useState<{ id: string | null; draft: VehicleInput; tpl?: VehicleTemplate } | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<VehicleFilterTab>('all');

  const startNew = () => setEditing({ id: null, draft: blankVehicle(org.id as string) });
  const edit = (v: Vehicle) => {
    const { id, createdAt, updatedAt, state, ...input } = v as Vehicle & { state?: unknown };
    void id; void createdAt; void updatedAt; void state;
    setEditing({ id: v.id as string, draft: input as VehicleInput });
  };

  // Filter counters
  const counts = useMemo(() => {
    return {
      all: list.length,
      wildfire: list.filter((v) =>
        v.capabilities?.some((c) => ['wildfire_attack', 'structure_protection', 'water_supply'].includes(c)) ||
        ['forest_firefighting_vehicle', 'light_firefighting_vehicle', 'tanker_forest', 'tanker_urban', 'tanker_large'].includes(v.type),
      ).length,
      evacuation: list.filter((v) =>
        v.capabilities?.includes('evacuation_transport') ||
        (v.passengerCapacity && v.passengerCapacity > 4) ||
        (v.stretcherCapacity && v.stretcherCapacity > 0) ||
        ['bus', 'personnel_transport', 'ambulance'].includes(v.type),
      ).length,
      command: list.filter((v) =>
        v.capabilities?.some((c) => ['command_and_control', 'communications', 'reconnaissance', 'traffic_control'].includes(c)) ||
        ['command_vehicle', 'command_comms_vehicle', 'operations_vehicle', 'traffic_unit', 'patrol_car'].includes(v.type),
      ).length,
      aerial: list.filter((v) =>
        ['helicopter', 'airtanker', 'drone'].includes(v.type) ||
        v.capabilities?.some((c) => ['aerial_water_drop', 'aerial_recon'].includes(c)),
      ).length,
    };
  }, [list]);

  // Filtered vehicles
  const filtered = useMemo(() => {
    return list.filter((v) => {
      // Search term
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const matchCallsign = v.callsign?.toLowerCase().includes(q);
        const matchType = VEHICLE_TYPE_LABEL[v.type]?.toLowerCase().includes(q);
        const matchCode = v.typeCode?.toLowerCase().includes(q);
        const matchPlate = v.plate?.toLowerCase().includes(q);
        if (!matchCallsign && !matchType && !matchCode && !matchPlate) return false;
      }
      // Category tab
      if (filter === 'wildfire') {
        return (
          v.capabilities?.some((c) => ['wildfire_attack', 'structure_protection', 'water_supply'].includes(c)) ||
          ['forest_firefighting_vehicle', 'light_firefighting_vehicle', 'tanker_forest', 'tanker_urban', 'tanker_large'].includes(v.type)
        );
      }
      if (filter === 'evacuation') {
        return (
          v.capabilities?.includes('evacuation_transport') ||
          (v.passengerCapacity && v.passengerCapacity > 4) ||
          (v.stretcherCapacity && v.stretcherCapacity > 0) ||
          ['bus', 'personnel_transport', 'ambulance'].includes(v.type)
        );
      }
      if (filter === 'command') {
        return (
          v.capabilities?.some((c) => ['command_and_control', 'communications', 'reconnaissance', 'traffic_control'].includes(c)) ||
          ['command_vehicle', 'command_comms_vehicle', 'operations_vehicle', 'traffic_unit', 'patrol_car'].includes(v.type)
        );
      }
      if (filter === 'aerial') {
        return (
          ['helicopter', 'airtanker', 'drone'].includes(v.type) ||
          v.capabilities?.some((c) => ['aerial_water_drop', 'aerial_recon'].includes(c))
        );
      }
      return true;
    });
  }, [list, search, filter]);

  return (
    <>
      <div className={styles.searchBar}>
        <input
          className={styles.searchInput}
          placeholder="Pesquisar viatura por indicativo, tipo, sigla ou matrícula..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className={styles.filterPills}>
          <button
            className={`${styles.filterPill} ${filter === 'all' ? styles.filterPillActive : ''}`}
            onClick={() => setFilter('all')}
          >
            Todas ({counts.all})
          </button>
          <button
            className={`${styles.filterPill} ${filter === 'wildfire' ? styles.filterPillActive : ''}`}
            onClick={() => setFilter('wildfire')}
          >
            Combate ({counts.wildfire})
          </button>
          <button
            className={`${styles.filterPill} ${filter === 'evacuation' ? styles.filterPillActive : ''}`}
            onClick={() => setFilter('evacuation')}
            style={filter === 'evacuation' ? { background: '#229954', borderColor: '#229954' } : undefined}
          >
            Evacuação ({counts.evacuation})
          </button>
          <button
            className={`${styles.filterPill} ${filter === 'command' ? styles.filterPillActive : ''}`}
            onClick={() => setFilter('command')}
          >
            Comando ({counts.command})
          </button>
          <button
            className={`${styles.filterPill} ${filter === 'aerial' ? styles.filterPillActive : ''}`}
            onClick={() => setFilter('aerial')}
          >
            Aéreos ({counts.aerial})
          </button>
        </div>
        <button className="primary" onClick={startNew} style={{ marginLeft: 'auto' }}>
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

      <div className={styles.resourceGrid}>
        {filtered.map((v) => {
          const isEvac = v.capabilities?.includes('evacuation_transport') || (v.passengerCapacity && v.passengerCapacity > 8);
          const stationName = stations.find((s) => s.id === v.stationId)?.name ?? 'Sem estação fixa';
          const photoKey = v.typeCode?.toLowerCase() || v.type;
          return (
            <div key={v.id} className={styles.card}>
              <div className={styles.cardBanner}>
                <VehicleModelPhoto
                  type={v.type}
                  tplKey={photoKey}
                  size="fill"
                />
                <div className={styles.cardBannerBadge}>
                  {v.inService === false ? (
                    <span className={`${styles.badge} ${styles.badgeDanger}`}>Fora de serviço</span>
                  ) : v.state?.status === 'assigned' ? (
                    <span className={`${styles.badge} ${styles.badgeWarning}`}>Em missão</span>
                  ) : (
                    <span className={`${styles.badge} ${styles.badgeSuccess}`}>Operacional</span>
                  )}
                </div>
                <div className={styles.cardBannerType}>
                  <VehicleIcon type={v.type} size={14} color="currentColor" />
                  <span>{VEHICLE_TYPE_LABEL[v.type]}</span>
                </div>
              </div>

              <div className={styles.cardContent}>
                <div className={styles.cardHeaderRow}>
                  <div className={styles.cardTitle}>
                    <VehicleIcon type={v.type} size={18} color="currentColor" />
                    <span>{v.callsign}</span>
                  </div>
                  {v.plate ? (
                    <span className={styles.badge} style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--muted, #8a94a0)' }}>
                      {v.plate}
                    </span>
                  ) : v.typeCode ? (
                    <span className={styles.badge} style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--muted, #8a94a0)' }}>
                      {v.typeCode}
                    </span>
                  ) : null}
                </div>

                <div className={styles.cardSubtitle}>{stationName}</div>

                <div className={styles.cardMetricsGrid}>
                  <div className={styles.cardMetric}>
                    <span className={styles.cardMetricLabel}>Tripulação</span>
                    <span className={styles.cardMetricValue}>
                      {v.minimumCrew ?? 1}–{v.crewCapacity} op.
                    </span>
                  </div>

                  {v.passengerCapacity ? (
                    <div className={styles.cardMetric} style={{ borderColor: 'rgba(56, 193, 114, 0.3)', background: 'rgba(56, 193, 114, 0.06)' }}>
                      <span className={styles.cardMetricLabel} style={{ color: '#38c172' }}>Evacuação</span>
                      <span className={styles.cardMetricValue} style={{ color: '#38c172' }}>
                        {v.passengerCapacity} civis
                      </span>
                    </div>
                  ) : v.stretcherCapacity ? (
                    <div className={styles.cardMetric} style={{ borderColor: 'rgba(255, 187, 0, 0.3)', background: 'rgba(255, 187, 0, 0.06)' }}>
                      <span className={styles.cardMetricLabel} style={{ color: '#ffbb00' }}>Macas Socorro</span>
                      <span className={styles.cardMetricValue} style={{ color: '#ffbb00' }}>
                        {v.stretcherCapacity} macas
                      </span>
                    </div>
                  ) : v.waterCapacityL || v.aerial?.bucketCapacityL ? (
                    <div className={styles.cardMetric}>
                      <span className={styles.cardMetricLabel}>Água</span>
                      <span className={styles.cardMetricValue}>
                        {nf(v.aerial?.bucketCapacityL ?? v.waterCapacityL)} L
                      </span>
                    </div>
                  ) : (
                    <div className={styles.cardMetric}>
                      <span className={styles.cardMetricLabel}>Velocidade</span>
                      <span className={styles.cardMetricValue}>
                        {v.cruiseSpeedKmh ? `${v.cruiseSpeedKmh} km/h` : '—'}
                      </span>
                    </div>
                  )}

                  {v.waterCapacityL && (v.passengerCapacity || v.stretcherCapacity) ? (
                    <div className={styles.cardMetric}>
                      <span className={styles.cardMetricLabel}>Água</span>
                      <span className={styles.cardMetricValue}>{nf(v.waterCapacityL)} L</span>
                    </div>
                  ) : (
                    <div className={styles.cardMetric}>
                      <span className={styles.cardMetricLabel}>Velocidade</span>
                      <span className={styles.cardMetricValue}>
                        {v.cruiseSpeedKmh ? `${v.cruiseSpeedKmh} km/h` : '—'}
                      </span>
                    </div>
                  )}

                  <div className={styles.cardMetric}>
                    <span className={styles.cardMetricLabel}>Autonomia</span>
                    <span className={styles.cardMetricValue}>
                      {v.rangeKm ? `${nf(v.rangeKm)} km` : '—'}
                    </span>
                  </div>
                </div>

                <div className={styles.cardCapabilities}>
                  {v.capabilities?.slice(0, 3).map((cap) => (
                    <span key={cap} className={styles.cardCapPill}>
                      {CAPABILITY_LABEL[cap]}
                    </span>
                  ))}
                  {(v.capabilities?.length ?? 0) > 3 ? (
                    <span className={styles.cardCapPill}>+{(v.capabilities?.length ?? 0) - 3}</span>
                  ) : null}
                  {isEvac ? (
                    <span className={`${styles.badge} ${styles.badgeSuccess}`} style={{ fontSize: '10px' }}>
                      Evacuação
                    </span>
                  ) : null}
                </div>
              </div>

              <div className={styles.cardFooter}>
                <button onClick={() => edit(v)}>Editar</button>
                <button
                  onClick={() => {
                    if (window.confirm(`Apagar ${v.callsign}?`)) void mutate(() => vehiclesApi.delete(v.id as string));
                  }}
                >
                  Apagar
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {!filtered.length ? (
        <div style={{ textAlign: 'center', padding: '36px', color: 'var(--muted, #8a94a0)' }}>
          {search ? 'Nenhum veículo encontrado para a pesquisa.' : 'Sem veículos nesta categoria. Use «+ Novo veículo» para adicionar.'}
        </div>
      ) : null}
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
  const [d, setD] = useState<VehicleInput>(() => ({ ...initial.draft }));
  const initialTpl = useMemo(() => templateForVehicle(initial.draft), [initial.draft]);
  const [tpl, setTpl] = useState<VehicleTemplate | undefined>(initialTpl);
  const set = <K extends keyof VehicleInput>(k: K, v: VehicleInput[K]) => setD((p) => ({ ...p, [k]: v }));
  const options = catalogFor(org.type);
  const all = options.length ? options : VEHICLE_CATALOG;

  const applyTemplate = (key: string) => {
    const t = VEHICLE_CATALOG.find((x) => x.key === key);
    setTpl(t);
    if (!t) return;
    const spec = templateToInput(t);
    setD((p) => ({
      ...p,
      ...spec,
      callsign: p.callsign || t.typeCode,
      typeCode: t.typeCode,
      capabilities: t.capabilities,
    }));
  };

  const toggleCap = (c: VehicleCapability) => {
    const cur = new Set(d.capabilities ?? []);
    if (cur.has(c)) cur.delete(c);
    else cur.add(c);
    set('capabilities', [...cur]);
  };

  const aerialOn = d.type === 'helicopter' || d.type === 'airtanker';

  return (
    <div className={styles.modalOverlay} onClick={onCancel}>
      <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <div className={styles.modalHeaderTitle}>
            <VehicleIcon type={d.type} size={28} color="currentColor" />
            <div>
              <h3>{initial.id ? `Editar ${d.callsign || initial.draft.callsign}` : 'Novo Veículo'}</h3>
              <small style={{ color: 'var(--muted, #8a94a0)' }}>
                {org.shortName ?? org.name} · {VEHICLE_TYPE_LABEL[d.type]}
              </small>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <VehicleModelPhoto type={d.type} tplKey={tpl?.key ?? d.typeCode?.toLowerCase()} size={{ width: 84, height: 54 }} />
            <button className={styles.closeBtn} onClick={onCancel} title="Fechar (Esc)">✕</button>
          </div>
        </div>

        <div className={styles.modalBody}>
          {/* Template Pre-fill Section */}
          <div className={styles.formCard}>
            <div className={styles.formCardTitle}>
              Catálogo de Veículos Oficiais (Preenchimento Rápido)
            </div>
            <Field label="Modelo do catálogo" wide>
              <select value={tpl?.key ?? ''} onChange={(e) => applyTemplate(e.target.value)}>
                <option value="">— personalização manual —</option>
                {all.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            {tpl ? (
              <div className={styles.tplNote} style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <span className={`${styles.chip} ${styles[tpl.confidence]}`}>
                  {tpl.confidence === 'sourced' ? 'fonte oficial' : 'estimativa tática'}
                </span>
                <span style={{ flex: 1 }}>{tpl.note}</span>
              </div>
            ) : null}
          </div>

          {/* Card 1: Identificação & Base */}
          <div className={styles.formCard}>
            <div className={styles.formCardTitle}>
              1. Identificação & Localização
            </div>
            <div className={styles.grid}>
              <Field label="Indicativo (Callsign)">
                <input
                  required
                  placeholder="Ex: VFCI 01, AUTOCARRO 01"
                  value={d.callsign}
                  onChange={(e) => set('callsign', e.target.value)}
                />
              </Field>
              <Field label="Matrícula">
                <input
                  placeholder="Ex: 00-AA-00"
                  value={d.plate ?? ''}
                  onChange={(e) => set('plate', e.target.value || undefined)}
                />
              </Field>
              <Field label="Tipo de Veículo">
                <select value={d.type} onChange={(e) => set('type', e.target.value as VehicleInput['type'])}>
                  {enumEntries(VEHICLE_TYPE_LABEL).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Sigla Tática (typeCode)">
                <input
                  placeholder="Ex: VFCI, AUTOCARRO, PCO"
                  value={d.typeCode ?? ''}
                  onChange={(e) => set('typeCode', e.target.value || undefined)}
                />
              </Field>
              <Field label="Estação Base">
                <select value={d.stationId ?? ''} onChange={(e) => set('stationId', e.target.value || null)}>
                  <option value="">— Sem estação fixa —</option>
                  {stations.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', justifyContent: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
                  <input type="checkbox" checked={d.inService !== false} onChange={(e) => set('inService', e.target.checked)} />
                  <b>Em serviço ativo</b>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
                  <input type="checkbox" checked={!!d.offRoad} onChange={(e) => set('offRoad', e.target.checked)} />
                  <span>Todo-o-terreno (4×4 / Tração integral)</span>
                </label>
              </div>
            </div>
          </div>

          {/* Card 2: Capacidades Operacionais & Evacuação */}
          <div className={styles.formCard}>
            <div className={styles.formCardTitle}>
              2. Capacidades Operacionais & Especialidades
            </div>
            <div className={styles.capSection}>
              {CAPABILITY_CATEGORIES.map((cat) => (
                <div key={cat.title} className={styles.capGroup}>
                  <div className={styles.capGroupTitle}>{cat.title}</div>
                  <div className={styles.capPills}>
                    {cat.caps.map((cap) => {
                      const active = d.capabilities?.includes(cap.key) ?? false;
                      let pillClass = styles.capPill;
                      if (active) {
                        pillClass += cap.isEvac ? ` ${styles.capPillActiveEvac}` : ` ${styles.capPillActive}`;
                      }
                      return (
                        <button
                          key={cap.key}
                          type="button"
                          className={pillClass}
                          onClick={() => toggleCap(cap.key)}
                        >
                          {active ? '✓ ' : '+ '}
                          {cap.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Card 3: Lotação, Evacuação & Agentes Extintores */}
          <div className={styles.formCard}>
            <div className={styles.formCardTitle}>
              3. Lotação, Evacuação & Agentes Extintores
            </div>
            <div className={styles.grid}>
              <FieldWithUnit
                label="Lotação máxima de equipa"
                unit="operadores"
                value={d.crewCapacity}
                onChange={(n) => set('crewCapacity', n ?? 1)}
              />
              <FieldWithUnit
                label="Equipa mínima de saída"
                unit="operadores"
                value={d.minimumCrew}
                onChange={(n) => set('minimumCrew', n)}
              />
              <FieldWithUnit
                label="Evacuação de civis (passageiros)"
                unit="lugares civis"
                value={d.passengerCapacity}
                onChange={(n) => set('passengerCapacity', n)}
              />
              <FieldWithUnit
                label="Macas de transporte de feridos"
                unit="macas"
                value={d.stretcherCapacity}
                onChange={(n) => set('stretcherCapacity', n)}
              />
              <FieldWithUnit
                label="Capacidade de água"
                unit="L"
                value={d.waterCapacityL}
                onChange={(n) => set('waterCapacityL', n)}
              />
              <FieldWithUnit
                label="Capacidade de espuma"
                unit="L"
                value={d.foamCapacityL}
                onChange={(n) => set('foamCapacityL', n)}
              />
              <FieldWithUnit
                label="Caudal da bomba"
                unit="L/min"
                value={d.pumpFlowLpm}
                onChange={(n) => set('pumpFlowLpm', n)}
              />
            </div>
          </div>

          {/* Card 4: Mobilidade, Autonomia & Dimensões */}
          <div className={styles.formCard}>
            <div className={styles.formCardTitle}>
              4. Mobilidade, Autonomia & Dimensões
            </div>
            <div className={styles.grid}>
              <FieldWithUnit
                label="Velocidade de cruzeiro"
                unit="km/h"
                value={d.cruiseSpeedKmh}
                onChange={(n) => set('cruiseSpeedKmh', n)}
              />
              <FieldWithUnit
                label="Autonomia estimada"
                unit="km"
                value={d.rangeKm}
                onChange={(n) => set('rangeKm', n)}
              />
              <FieldWithUnit
                label="Depósito de combustível"
                unit="L"
                value={d.fuelCapacityL}
                onChange={(n) => set('fuelCapacityL', n)}
              />
              <FieldWithUnit
                label="Declive máx. transponível"
                unit="%"
                value={d.maxSlopePercent}
                onChange={(n) => set('maxSlopePercent', n)}
              />
              <FieldWithUnit
                label="Altura"
                unit="m"
                step={0.1}
                value={d.heightM}
                onChange={(n) => set('heightM', n)}
              />
              <FieldWithUnit
                label="Largura"
                unit="m"
                step={0.1}
                value={d.widthM}
                onChange={(n) => set('widthM', n)}
              />
              <FieldWithUnit
                label="Peso total"
                unit="t"
                step={0.1}
                value={d.weightT}
                onChange={(n) => set('weightT', n)}
              />
            </div>
          </div>

          {/* Card 5: Meios Aéreos (Conditional) */}
          {aerialOn ? (
            <div className={styles.formCard}>
              <div className={styles.formCardTitle}>
                5. Especificações de Ataque Aéreo
              </div>
              <div className={styles.grid}>
                <FieldWithUnit
                  label="Balde / Depósito de água"
                  unit="L"
                  value={d.aerial?.bucketCapacityL}
                  onChange={(n) => set('aerial', { ...d.aerial, bucketCapacityL: n ?? 0, cruiseSpeedKmh: d.cruiseSpeedKmh ?? 200, maxWindKmh: d.aerial?.maxWindKmh ?? 50, dayOnly: true, loadMinutes: 1, dropMinutes: 0.5 })}
                />
                <FieldWithUnit
                  label="Tempo de carga / reabastecimento"
                  unit="min"
                  step={0.1}
                  value={d.aerial?.loadMinutes}
                  onChange={(n) => set('aerial', { ...d.aerial, loadMinutes: n ?? 1, cruiseSpeedKmh: d.cruiseSpeedKmh ?? 200, maxWindKmh: d.aerial?.maxWindKmh ?? 50, dayOnly: true, bucketCapacityL: d.aerial?.bucketCapacityL ?? 1000, dropMinutes: 0.5 })}
                />
                <FieldWithUnit
                  label="Tempo de largada"
                  unit="min"
                  step={0.1}
                  value={d.aerial?.dropMinutes}
                  onChange={(n) => set('aerial', { ...d.aerial, dropMinutes: n ?? 0.5, cruiseSpeedKmh: d.cruiseSpeedKmh ?? 200, maxWindKmh: d.aerial?.maxWindKmh ?? 50, dayOnly: true, bucketCapacityL: d.aerial?.bucketCapacityL ?? 1000, loadMinutes: 1 })}
                />
                <FieldWithUnit
                  label="Vento máx. operacional"
                  unit="km/h"
                  value={d.aerial?.maxWindKmh}
                  onChange={(n) => set('aerial', { ...d.aerial, maxWindKmh: n ?? 50, cruiseSpeedKmh: d.cruiseSpeedKmh ?? 200, dayOnly: true, bucketCapacityL: d.aerial?.bucketCapacityL ?? 1000, loadMinutes: 1, dropMinutes: 0.5 })}
                />
              </div>
            </div>
          ) : null}
        </div>

        <div className={styles.modalFooter}>
          <div style={{ fontSize: '12px', color: 'var(--muted, #8a94a0)' }}>
            {!d.callsign.trim() ? <span style={{ color: 'var(--bad, #ff4444)' }}>O indicativo é obrigatório.</span> : null}
          </div>
          <div className={styles.btns}>
            <button onClick={onCancel}>Cancelar</button>
            <button
              className="primary"
              disabled={!d.callsign.trim()}
              onClick={() => {
                const out: VehicleInput = {
                  ...d,
                  organizationId: org.id as string,
                  callsign: d.callsign.trim(),
                  aerial: aerialOn && d.aerial
                    ? {
                        ...d.aerial,
                        bucketCapacityL: d.aerial.bucketCapacityL ?? 1000,
                        cruiseSpeedKmh: d.aerial.cruiseSpeedKmh ?? d.cruiseSpeedKmh ?? 200,
                        maxWindKmh: d.aerial.maxWindKmh ?? 50,
                        loadMinutes: d.aerial.loadMinutes ?? 1,
                        dropMinutes: d.aerial.dropMinutes ?? 0.5,
                        dayOnly: d.aerial.dayOnly ?? true,
                      }
                    : d.aerial,
                };
                void onSave(out);
              }}
            >
              {initial.id ? 'Guardar Alterações' : 'Criar Veículo'}
            </button>
          </div>
        </div>
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

      <div className={styles.resourceGrid}>
        {list.map((s) => (
          <div key={s.id} className={styles.card}>
            <div className={styles.cardContent}>
              <div className={styles.cardHeaderRow}>
                <div className={styles.cardTitle}>{s.name}</div>
                <span className={styles.chip}>{STATION_KIND_LABEL[s.kind]}</span>
              </div>
              <div className={styles.cardSubtitle}>
                {s.address ? s.address : `Coordenadas: ${s.position.lat.toFixed(4)}, ${s.position.lon.toFixed(4)}`}
              </div>
              <div className={styles.cardMetricsGrid}>
                <div className={styles.cardMetric}>
                  <span className={styles.cardMetricLabel}>Garagens</span>
                  <span className={styles.cardMetricValue}>{nf(s.vehicleBays)} viaturas</span>
                </div>
                <div className={styles.cardMetric}>
                  <span className={styles.cardMetricLabel}>Estado</span>
                  <span className={styles.cardMetricValue}>
                    {s.status === 'operational' ? 'Operacional' : s.status}
                  </span>
                </div>
              </div>
            </div>
            <div className={styles.cardFooter}>
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
            </div>
          </div>
        ))}
      </div>
      {!list.length ? (
        <div style={{ textAlign: 'center', padding: '36px', color: 'var(--muted, #8a94a0)' }}>
          Sem estações registadas. Use «+ Nova estação» para adicionar.
        </div>
      ) : null}
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

      <div className={styles.resourceGrid}>
        {list.map((p) => (
          <div key={p.id} className={styles.card}>
            <div className={styles.cardContent}>
              <div className={styles.cardHeaderRow}>
                <div className={styles.cardTitle}>{ROLE_LABEL[p.role]}</div>
                <span className={styles.chip} style={{ background: 'rgba(56, 193, 114, 0.15)', color: '#38c172', fontWeight: 600 }}>
                  {p.available} / {p.total} disp.
                </span>
              </div>
              <div className={styles.cardSubtitle}>
                {stations.find((s) => s.id === p.stationId)?.name ?? 'Todas as estações'}
              </div>
              {p.notes ? (
                <small style={{ color: 'var(--muted, #8a94a0)', lineHeight: '1.4', marginTop: '2px' }}>
                  {p.notes}
                </small>
              ) : null}
              <div className={styles.cardMetricsGrid}>
                <div className={styles.cardMetric}>
                  <span className={styles.cardMetricLabel}>Efetivo Total</span>
                  <span className={styles.cardMetricValue}>{p.total} operacionais</span>
                </div>
                <div className={styles.cardMetric}>
                  <span className={styles.cardMetricLabel}>Fadiga</span>
                  <span className={styles.cardMetricValue}>{p.fatiguePct != null ? `${p.fatiguePct}%` : 'Normal'}</span>
                </div>
              </div>
            </div>
            <div className={styles.cardFooter}>
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
            </div>
          </div>
        ))}
      </div>
      {!list.length ? (
        <div style={{ textAlign: 'center', padding: '36px', color: 'var(--muted, #8a94a0)' }}>
          Sem grupos de pessoal registados. Use «+ Novo grupo de pessoal» para adicionar.
        </div>
      ) : null}
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

      <div className={styles.resourceGrid}>
        {list.map((e) => {
          const isEvacEq = ['shelter_tent', 'stretcher', 'megaphone', 'road_barrier', 'medical_kit'].includes(e.kind);
          return (
            <div key={e.id} className={styles.card}>
              <div className={styles.cardContent}>
                <div className={styles.cardHeaderRow}>
                  <div className={styles.cardTitle} style={{ fontSize: '14px' }}>
                    {e.label ?? EQUIPMENT_LABEL[e.kind]}
                  </div>
                  {isEvacEq ? (
                    <span className={`${styles.badge} ${styles.badgeSuccess}`}>
                      Apoio à Evacuação
                    </span>
                  ) : null}
                </div>
                <div className={styles.cardSubtitle}>
                  {stations.find((s) => s.id === e.stationId)?.name ?? 'Todas as estações'} · {EQUIPMENT_LABEL[e.kind]}
                </div>
                {e.notes ? (
                  <small style={{ color: 'var(--muted, #8a94a0)', lineHeight: '1.4' }}>{e.notes}</small>
                ) : null}
                <div className={styles.cardMetricsGrid}>
                  <div className={styles.cardMetric}>
                    <span className={styles.cardMetricLabel}>Total em Stock</span>
                    <span className={styles.cardMetricValue}>{e.quantity} unid.</span>
                  </div>
                  <div className={styles.cardMetric} style={{ borderColor: 'rgba(56, 193, 114, 0.3)', background: 'rgba(56, 193, 114, 0.05)' }}>
                    <span className={styles.cardMetricLabel} style={{ color: '#38c172' }}>Disponível</span>
                    <span className={styles.cardMetricValue} style={{ color: '#38c172' }}>
                      {e.available} unid.
                    </span>
                  </div>
                </div>
              </div>
              <div className={styles.cardFooter}>
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
              </div>
            </div>
          );
        })}
      </div>
      {!list.length ? (
        <div style={{ textAlign: 'center', padding: '36px', color: 'var(--muted, #8a94a0)' }}>
          Sem equipamentos registados. Use «+ Novo equipamento» para adicionar.
        </div>
      ) : null}
    </>
  );
}
