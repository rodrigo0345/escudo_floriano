/**
 * Small, honest helpers over the OpenAPI `Geometry` union (`Position = number[]`, i.e.
 * `[lon, lat, ...]`). The spec doesn't encode "this feature is always a LineString" in types
 * (GeoJSON's `Geometry` is inherently a union), so callers that know better from the field's
 * description (e.g. `RoadFeature`'s geometry is always a `LineString`) narrow explicitly here
 * instead of sprinkling `as` casts through the engine layer.
 */
import type { components } from '@/api/schema';

type Geometry = components['schemas']['Geometry'];

export type LonLat = [lon: number, lat: number];

export function lineStringCoordinates(geometry: Geometry | null | undefined): LonLat[] {
  if (!geometry || geometry.type !== 'LineString') return [];
  return geometry.coordinates as LonLat[];
}

/** Polygon or MultiPolygon rings, as used by fire perimeters (`coordinates` of a `MultiPolygon`). */
export function polygonRings(geometry: Geometry | null | undefined): LonLat[][] {
  return polygonParts(geometry).flat();
}

/**
 * The polygons of a `Polygon`/`MultiPolygon`, each as its rings `[outer, ...holes]`.
 * Unlike {@link polygonRings}, this keeps the polygon grouping: a fire perimeter is a `MultiPolygon`
 * with several disjoint fronts, and a fill must not treat the second front's outer ring as a hole of the first.
 */
export function polygonParts(geometry: Geometry | null | undefined): LonLat[][][] {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates as LonLat[][]];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates as LonLat[][][];
  return [];
}

export function pointCoordinates(geometry: Geometry | null | undefined): LonLat | null {
  if (!geometry || geometry.type !== 'Point') return null;
  return geometry.coordinates as LonLat;
}
