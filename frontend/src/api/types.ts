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

// Operational Resources
export type Organization = Schemas['Organization'];
export type OrganizationInput = Schemas['OrganizationInput'];
export type OrganizationPatch = Schemas['OrganizationPatch'];
export type OrganizationType = Schemas['OrganizationType'];

export type Station = Schemas['Station'];
export type StationInput = Schemas['StationInput'];
export type StationPatch = Schemas['StationPatch'];
export type StationKind = Schemas['StationKind'];
export type StationStatus = Schemas['StationStatus'];

export type Vehicle = Schemas['Vehicle'];
export type VehicleInput = Schemas['VehicleInput'];
export type VehiclePatch = Schemas['VehiclePatch'];
export type VehicleType = Schemas['VehicleType'];
export type VehicleCapability = Schemas['VehicleCapability'];
export type VehicleStatus = Schemas['VehicleStatus'];
export type VehicleState = Schemas['VehicleState'];
export type VehicleStatePatch = Schemas['VehicleStatePatch'];
export type WaterStatus = Schemas['WaterStatus'];

export type Equipment = Schemas['Equipment'];
export type EquipmentInput = Schemas['EquipmentInput'];
export type EquipmentPatch = Schemas['EquipmentPatch'];
export type EquipmentKind = Schemas['EquipmentKind'];

export type PersonnelPool = Schemas['PersonnelPool'];
export type PersonnelPoolInput = Schemas['PersonnelPoolInput'];
export type PersonnelPoolPatch = Schemas['PersonnelPoolPatch'];
export type PersonnelRole = Schemas['PersonnelRole'];

export type Dispatch = Schemas['Dispatch'];
export type DispatchInput = Schemas['DispatchInput'];
export type DispatchBatchInput = Schemas['DispatchBatchInput'];
export type DispatchValidation = Schemas['DispatchValidation'];
export type DispatchPatch = Schemas['DispatchPatch'];
export type DispatchRecall = Schemas['DispatchRecall'];
export type DispatchStatus = Schemas['DispatchStatus'];
export type Responsibility = Schemas['Responsibility'];
export type DispatchResourceType = Schemas['DispatchResourceType'];
export type DispatchResult = Schemas['DispatchResult'];

export type DeploymentOverview = Schemas['DeploymentOverview'];
export type DeploymentGroup = Schemas['DeploymentGroup'];
export type ResourceSummary = Schemas['ResourceSummary'];

// Plans & Actions
export type Plan = Schemas['Plan'];
export type PlanSummary = Schemas['PlanSummary'];
export type PlanInput = Schemas['PlanInput'];
export type PlanPatch = Schemas['PlanPatch'];
export type PlanStatus = Schemas['PlanStatus'];
export type PlanValidation = Schemas['PlanValidation'];
export type PlanSimulationRequest = Schemas['PlanSimulationRequest'];
export type PlanRisk = Schemas['PlanRisk'];
export type PlanBasis = Schemas['PlanBasis'];
export type PlanHorizon = Schemas['PlanHorizon'];

export type Action = Schemas['Action'];
export type ActionPriority = Schemas['ActionPriority'];
export type ActionStatus = Schemas['ActionStatus'];
export type ActionPatch = Schemas['ActionPatch'];
export type CrewExposure = Schemas['CrewExposure'];
export type CrewStatus = Schemas['CrewStatus'];
export type ActionDispatchUnits = Schemas['ActionDispatchUnits'];
export type InterventionAerialDrop = Schemas['InterventionAerialDrop'];
export type ValidationIssue = Schemas['ValidationIssue'];
export type LineString = Schemas['LineString'];
export type TaskItem = Schemas['TaskItem'];

// Road Closures
export type RoadClosure = Schemas['RoadClosure'];
export type RoadClosureInput = Schemas['RoadClosureInput'];
export type RoadClosurePatch = Schemas['RoadClosurePatch'];
export type ClosureStatus = Schemas['ClosureStatus'];
export type ClosureKind = Schemas['ClosureKind'];
export type ClosureReason = Schemas['ClosureReason'];

// Routing
export type RouteRequest = Schemas['RouteRequest'];
export type Route = Schemas['Route'];
export type AccessRequest = Schemas['AccessRequest'];
export type AccessMatrix = Schemas['AccessMatrix'];

// Terrain & Geospatial
export type AreaStats = Schemas['AreaStats'];
export type AreaStatsRequest = Schemas['AreaStatsRequest'];
export type BuildingCollection = Schemas['BuildingCollection'];
export type TerrainPoint = Schemas['TerrainPoint'];
export type FirebreakCollection = Schemas['FirebreakCollection'];
export type FirebreakFeature = Schemas['FirebreakFeature'];
export type FirebreakKind = Schemas['FirebreakKind'];
export type WaterPointNear = Schemas['WaterPointNear'];
export type WaterPointNearList = Schemas['WaterPointNearList'];

// Meta & Rules
export type Health = Schemas['Health'];
export type Rules = Schemas['Rules'];
export type Target = Schemas['Target'];

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
