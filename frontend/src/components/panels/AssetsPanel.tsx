import { useState } from 'react';

import type { Facility, FacilityKind, WaterPoint, WaterPointKind } from '@/api';
import { Icon } from '@/components/common/Icon';
import { Row } from '@/components/common/StatCard';
import { OrgLogo } from '@/domain/organizationLogos';
import { FACILITY_KIND_NAME } from '@/engine/layers/assetLayer';
import { WATER_KINDS } from '@/engine/layers/waterLayer';
import { useAppStore } from '@/store/appStore';

import styles from './panels.module.css';

/** The concelho's four corporations: always listed (with a note when there is no data); every other kind of facility waits behind "Outras instalações". */
const CORE_KINDS: FacilityKind[] = ['fire_station', 'gnr', 'inem', 'civil_protection'];
const formatArea = (m2: number) => (m2 >= 10000 ? `${(m2 / 10000).toFixed(1)} ha` : `${Math.round(m2)} m²`);

/** The "Meios" tab: the four corporations' facilities, the other kinds behind one closed row, then a water-points summary. */
export function AssetsPanel() {
  const facilities = useAppStore((s) => s.data?.facilities ?? []);
  const waterPoints = useAppStore((s) => s.data?.waterPoints ?? []);
  const [showOthers, setShowOthers] = useState(false);

  const byKind = new Map<FacilityKind, Facility[]>();
  facilities.forEach((f) => byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]));
  const kinds = Object.keys(FACILITY_KIND_NAME) as FacilityKind[];
  const core = kinds.filter((k) => CORE_KINDS.includes(k));
  const others = kinds.filter((k) => !CORE_KINDS.includes(k) && byKind.has(k));
  const otherCount = others.reduce((sum, k) => sum + (byKind.get(k)?.length ?? 0), 0);

  const section = (kind: FacilityKind) => {
    const list = byKind.get(kind) ?? [];
    return (
      <section key={kind}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <OrgLogo kind={kind} size={20} inline />
          <span>
            {FACILITY_KIND_NAME[kind]} ({list.length})
          </span>
        </h3>
        {list.length ? (
          list.map((f) => (
            <Row key={f.id}>
              <span>{f.name}</span>
              <small>
                {f.source}
                {f.confidence && f.confidence !== 'high' ? ` · confiança ${f.confidence}` : ''}
              </small>
            </Row>
          ))
        ) : (
          <p className="note">
            Sem dados. Pode acrescentar em <code>curatedFacilities</code> no ficheiro do local (o OSM cobre mal esta categoria).
          </p>
        )}
      </section>
    );
  };

  return (
    <>
      {core.map(section)}
      {others.length ? (
        <button type="button" className={styles.reinforcementsHead} onClick={() => setShowOthers(!showOthers)} aria-expanded={showOthers}>
          <b>Outras instalações</b>
          <small className="note">
            {others.length} tipos · {otherCount}
          </small>
          <span className={`${styles.reinforcementsChevron} ${showOthers ? styles.reinforcementsChevronOpen : ''}`} aria-hidden="true">
            <Icon name="chevron" size={14} />
          </span>
        </button>
      ) : null}
      {showOthers ? others.map(section) : null}
      <WaterSummary list={waterPoints} />
    </>
  );
}

function WaterSummary({ list }: { list: WaterPoint[] }) {
  if (!list.length) {
    return (
      <>
        <h3>Pontos de água</h3>
        <p className="note">
          Sem dados. Corra o ingest com o passo <code>water</code>.
        </p>
      </>
    );
  }
  const byKind = new Map<WaterPointKind, WaterPoint[]>();
  list.forEach((p) => byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p]));
  const big = [...(byKind.get('reservoir') ?? []), ...(byKind.get('pond') ?? [])]
    .filter((p) => p.areaM2)
    .sort((a, b) => (b.areaM2 ?? 0) - (a.areaM2 ?? 0))
    .slice(0, 8);

  return (
    <>
      <h3>Pontos de água ({list.length})</h3>
      {(Object.keys(WATER_KINDS) as WaterPointKind[])
        .filter((k) => byKind.has(k))
        .map((k) => {
          const items = byKind.get(k) ?? [];
          const truck = items.filter((p) => p.truckAccessible).length;
          const heli = items.filter((p) => p.helicopterAccessible).length;
          return (
            <Row key={k}>
              <span>
                {WATER_KINDS[k].label} ({items.length})
              </span>
              <small>
                {truck} autotanque{heli ? ` · ${heli} helicóptero` : ''}
              </small>
            </Row>
          );
        })}
      {big.length ? (
        <>
          <h3>Maiores massas de água</h3>
          {big.map((p) => (
            <Row key={p.id}>
              <span>{p.name ?? '—'}</span>
              <small>
                {formatArea(p.areaM2 ?? 0)}
                {p.helicopterAccessible ? ' · helicóptero' : ''}
              </small>
            </Row>
          ))}
        </>
      ) : null}
      <p className="note">Fonte: OpenStreetMap. Áreas e capacidades das massas de água são estimativas geométricas; «autotanque» = a ≤ 60 m de uma via.</p>
    </>
  );
}
