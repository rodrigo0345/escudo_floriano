import { fetchGrid } from '../binaryGrids';
import { http } from '../httpClient';
import { fetchAllPages } from '../pagination';
import type {
  Facility,
  GridLayerName,
  Location,
  Page,
  Place,
  RoadCollection,
  VegetationInfo,
  WaterPoint,
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

  landcover: getLandcover,

  /** A raw per-cell raster (`elevation`/`slope`/`aspect`/`vegetation`/`buildings`/`population`). */
  grid: (locationId: string, layer: GridLayerName) => fetchGrid(`/locations/${locationId}/grids/${layer}`),
};
