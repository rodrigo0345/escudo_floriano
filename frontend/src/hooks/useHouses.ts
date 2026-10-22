import { useEffect, useMemo, useState } from 'react';

import { locationsApi } from '@/api';
import type { House } from '@/engine/layers/peopleLayer';
import { useAppStore } from '@/store/appStore';

const cache = new Map<string, House[]>();

/** Every building of the location (one point per grid cell, from `GET /locations/{id}/buildings`), loaded once per location and kept. */
export function useHouses(): House[] {
  const locationId = useAppStore((s) => s.locationId);
  const geo = useAppStore((s) => s.data?.geo);
  const [houses, setHouses] = useState<House[]>(() => (locationId ? cache.get(locationId) ?? [] : []));
  const cellOf = useMemo(
    () => (lat: number, lon: number) => {
      if (!geo) return -1;
      const [col, row] = geo.cellAt(lat, lon);
      return row * geo.gridWidth + col;
    },
    [geo],
  );
  useEffect(() => {
    if (!locationId || !geo) return undefined;
    const known = cache.get(locationId);
    if (known) {
      setHouses(known);
      return undefined;
    }
    let cancelled = false;
    void locationsApi
      .buildings(locationId, { limit: 30000, minBuildings: 1 })
      .then((collection) => {
        const list: House[] = [];
        for (const f of (collection as unknown as { features?: { geometry?: { coordinates?: number[] } }[] }).features ?? []) {
          const c = f.geometry?.coordinates;
          if (c && c.length >= 2) list.push({ lon: c[0], lat: c[1], cell: cellOf(c[1], c[0]) });
        }
        cache.set(locationId, list);
        if (!cancelled) setHouses(list);
      })
      .catch(() => undefined); // the map works without houses
    return () => {
      cancelled = true;
    };
  }, [locationId, geo, cellOf]);
  return houses;
}
