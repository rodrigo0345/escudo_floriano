import { locationsApi, scenariosApi } from '@/api';
import { Georef } from '@/domain/georef';
import { loadHeightmap } from '@/engine/terrainMesh';
import type { LocationData } from '@/store/types';

/** Loads everything static about a location in parallel: map layers, vegetation legend, roads, assets, scenarios and the land-cover grid. */
export async function loadLocationData(locationId: string): Promise<LocationData> {
  const location = await locationsApi.get(locationId);
  const heightmap = location.layers?.find((l) => l.kind === 'heightmap');
  if (!heightmap) throw new Error(`O local ${locationId} não tem camada de relevo (heightmap).`);

  const [elevations, vegetation, roads, facilities, places, scenarios, landcover, waterPoints] = await Promise.all([
    loadHeightmap(heightmap.url),
    locationsApi.vegetation(locationId),
    locationsApi.roads(locationId),
    locationsApi.facilities(locationId),
    locationsApi.places(locationId),
    scenariosApi.listForLocation(locationId),
    locationsApi.landcover(locationId),
    locationsApi.waterPoints(locationId).catch(() => []),
  ]);

  const burnMinutesByClass: number[] = [];
  vegetation.classes.forEach((k) => (burnMinutesByClass[k.id] = k.burnMinutes ?? 10));
  const burnMinutes = Uint8Array.from(landcover, (c) => burnMinutesByClass[c] ?? 10);

  return {
    location,
    geo: new Georef(location, elevations),
    vegetation,
    roads,
    facilities,
    places,
    waterPoints,
    scenarios,
    landcover,
    burnMinutes,
  };
}
