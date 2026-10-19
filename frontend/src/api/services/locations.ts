import { fetchGrid } from '../binaryGrids';
import { http } from '../httpClient';
import { fetchAllPages } from '../pagination';
import type {
  AreaStats,
  AreaStatsRequest,
  BuildingCollection,
  DeploymentOverview,
  Facility,
  FirebreakCollection,
  FirebreakKind,
  GridLayerName,
  LatLon,
  Location,
  Page,
  Place,
  ResourceSummary,
  RoadCollection,
  TerrainPoint,
  VegetationInfo,
  WaterPoint,
  WaterPointNear,
  WaterPointNearList,
} from '../types';

/** `GET /locations/{id}/grids/vegetation` — one land-cover class id per cell (uint8, row 0 = north). */
export async function getLandcover(locationId: string): Promise<Uint8Array> {
  const grid = await fetchGrid(`/locations/${locationId}/grids/vegetation`);
  return grid.data as Uint8Array;
}

export const locationsApi = {
  list: async (): Promise<Location[]> => {
    const { data } = await http.get<Page<Location>>('/locations', { params: { limit: 200 } });
    return data.items;
  },

  get: async (locationId: string): Promise<Location> => {
    const { data } = await http.get<Location>(`/locations/${locationId}`);
    return data;
  },

  vegetation: async (locationId: string): Promise<VegetationInfo> => {
    const { data } = await http.get<VegetationInfo>(`/locations/${locationId}/vegetation`);
    return data;
  },

  roads: async (locationId: string): Promise<RoadCollection> => {
    const { data } = await http.get<RoadCollection>(`/locations/${locationId}/roads`);
    return data;
  },

  facilities: (locationId: string): Promise<Facility[]> => fetchAllPages<Facility>(`/locations/${locationId}/facilities`),

  places: (locationId: string): Promise<Place[]> => fetchAllPages<Place>(`/locations/${locationId}/places`),

  waterPoints: (locationId: string): Promise<WaterPoint[]> => fetchAllPages<WaterPoint>(`/locations/${locationId}/water-points`),

  waterPointsNear: async (
    locationId: string,
    params: {
      lat: number;
      lon: number;
      radiusM?: number;
      limit?: number;
      routeFrom?: LatLon;
      truckOnly?: boolean;
      helicopterOnly?: boolean;
    },
  ): Promise<WaterPointNear[]> => {
    const q: Record<string, unknown> = { ...params };
    if (params.routeFrom) {
      q.routeFrom = `${params.routeFrom.lat},${params.routeFrom.lon}`;
    }
    const { data } = await http.get<WaterPointNearList>(`/locations/${locationId}/water-points/near`, { params: q });
    return data.items;
  },

  firebreaks: async (
    locationId: string,
    params: { bbox?: string; kind?: FirebreakKind; maintainedOnly?: boolean } = {},
  ): Promise<FirebreakCollection> => {
    const { data } = await http.get<FirebreakCollection>(`/locations/${locationId}/firebreaks`, { params });
    return data;
  },

  buildings: async (
    locationId: string,
    params: { bbox?: string; minBuildings?: number; limit?: number } = {},
  ): Promise<BuildingCollection> => {
    const { data } = await http.get<BuildingCollection>(`/locations/${locationId}/buildings`, { params });
    return data;
  },

  terrainAt: async (locationId: string, lat: number, lon: number): Promise<TerrainPoint> => {
    const { data } = await http.get<TerrainPoint>(`/locations/${locationId}/terrain-at`, { params: { lat, lon } });
    return data;
  },

  areaStats: async (locationId: string, geometry: AreaStatsRequest['geometry']): Promise<AreaStats> => {
    const { data } = await http.post<AreaStats>(`/locations/${locationId}/area-stats`, { geometry });
    return data;
  },

  summary: async (locationId: string): Promise<ResourceSummary> => {
    const { data } = await http.get<ResourceSummary>(`/locations/${locationId}/resources/summary`);
    return data;
  },

  deployment: async (locationId: string): Promise<DeploymentOverview> => {
    const { data } = await http.get<DeploymentOverview>(`/locations/${locationId}/deployment`);
    return data;
  },

  landcover: getLandcover,

  /** A raw per-cell raster (`elevation`/`slope`/`aspect`/`vegetation`/`buildings`/`population`). */
  grid: (locationId: string, layer: GridLayerName) => fetchGrid(`/locations/${locationId}/grids/${layer}`),
};
