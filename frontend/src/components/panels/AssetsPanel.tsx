import type { Facility, FacilityKind, WaterPoint, WaterPointKind } from '@/api';
import { Row } from '@/components/common/StatCard';
import { FACILITY_KIND_NAME } from '@/engine/layers/assetLayer';
import { WATER_KINDS } from '@/engine/layers/waterLayer';
import { useAppStore } from '@/store/appStore';

const ALWAYS_LISTED: FacilityKind[] = ['fire_station', 'gnr', 'civil_protection', 'inem', 'hospital'];
const formatArea = (m2: number) => (m2 >= 10000 ? `${(m2 / 10000).toFixed(1)} ha` : `${Math.round(m2)} m²`);

/** The "Meios" tab: facilities grouped by kind, then a water-points summary. */
export function AssetsPanel() {
  const facilities = useAppStore((s) => s.data?.facilities ?? []);
  const waterPoints = useAppStore((s) => s.data?.waterPoints ?? []);

  const byKind = new Map<FacilityKind, Facility[]>();
  facilities.forEach((f) => byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]));
  const order = (Object.keys(FACILITY_KIND_NAME) as FacilityKind[]).filter((k) => byKind.has(k) || ALWAYS_LISTED.includes(k));

  return (
    <>
      {order.map((kind) => {
        const list = byKind.get(kind) ?? [];
        return (
          <section key={kind}>
            <h3>
              {FACILITY_KIND_NAME[kind]} ({list.length})
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
      })}
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
