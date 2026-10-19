/**
 * Thin, friendly names over the generated OpenAPI schema (`schema.ts`, produced by
 * `npm run generate:api-types` from `../api-spec/openapi.json`). Application code imports
 * from here, never from `schema.ts` directly — that keeps `components["schemas"][...]`
 * noise out of every file that touches the API and gives us one place to re-point if the
 * generator's output shape ever changes.
 *
 * `api-spec/openapi.json` is the source of truth for all of this (see AGENTS.md at the repo
 * root): if a field is missing here, the fix is to regenerate `schema.ts`, not to guess.
 */
import type { components } from './schema';

type Schemas = components['schemas'];

export type Id = Schemas['Id'];
export type LatLon = Schemas['LatLon'];
export type Problem = Schemas['Problem'];
export type Capabilities = Schemas['Capabilities'];

export type Location = Schemas['Location'];
export type LayerInfo = Schemas['LayerInfo'];
export type VegetationClass = Schemas['VegetationClass'];
export type VegetationInfo = Schemas['VegetationInfo'];
export type RoadFeature = Schemas['RoadFeature'];
export type RoadCollection = Schemas['RoadCollection'];
export type Place = Schemas['Place'];
export type Facility = Schemas['Facility'];
export type WaterPoint = Schemas['WaterPoint'];
export type WaterPointKind = Schemas['WaterPointKind'];
export type FacilityKind = Schemas['FacilityKind'];
export type GridLayerName = Schemas['GridLayerName'];

export type Scenario = Schemas['Scenario'];
export type ScenarioInput = Schemas['ScenarioInput'];
export type Ignition = Schemas['Ignition'];
export type EngineOptions = Schemas['EngineOptions'];
export type EnsembleSpec = Schemas['EnsembleSpec'];

export type WeatherCore = Schemas['WeatherCore'];
export type WeatherSample = Schemas['WeatherSample'];
export type WeatherSeries = Schemas['WeatherSeries'];
export type WeatherSpec = Schemas['WeatherSpec'];
export type WeatherEvent = Schemas['WeatherEvent'];
export type WeatherKeyframe = Schemas['WeatherKeyframe'];
export type WeatherResolveRequest = Schemas['WeatherResolveRequest'];
export type WeatherResolveResponse = Schemas['WeatherResolveResponse'];

export type SimulationRequest = Schemas['SimulationRequest'];
export type Simulation = Schemas['Simulation'];
export type SimulationStatus = Schemas['SimulationStatus'];
export type SimulationProgress = Schemas['SimulationProgress'];
export type SummaryMilestone = Schemas['SummaryMilestone'];
export type SimulationSummary = Schemas['SimulationSummary'];
export type PerimeterCollection = Schemas['PerimeterCollection'];
export type SpreadVectorCollection = Schemas['SpreadVectorCollection'];
export type SpreadVectorFeature = Schemas['SpreadVectorFeature'];
export type RoadStatusTimeline = Schemas['RoadStatusTimeline'];
export type RoadStatusEntry = Schemas['RoadStatusEntry'];
export type PlaceAccessTimeline = Schemas['PlaceAccessTimeline'];
export type Smoke = Schemas['Smoke'];

/** A page of a cursor-paginated list (`{items, nextCursor}`, per AGENTS.md's pagination convention). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

/** The three binary grids a simulation result exposes (`GET /simulations/{id}/grids/{grid}`). */
export type SimulationGridName = 'ignition' | 'intensity' | 'flags';

/** One raster layer's element type, reported by the server in the `X-Grid-Dtype` header. */
export type GridDtype = 'int16' | 'uint16' | 'uint8' | 'float32';

/** A binary grid plus the geometry needed to interpret it, read from the `X-Grid-*` response headers. */
export interface GridData<T extends ArrayBufferView = ArrayBufferView> {
  width: number;
  height: number;
  cellM: number;
  dtype: GridDtype;
  data: T;
}
