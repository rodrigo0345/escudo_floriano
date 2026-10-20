export { ApiError, http, BASE_URL } from './httpClient';
export { fetchAllPages } from './pagination';
export { fetchGrid } from './binaryGrids';
export * from './types';

export { capabilitiesApi } from './services/capabilities';
export { locationsApi, getLandcover } from './services/locations';
export { scenariosApi } from './services/scenarios';
export { simulationsApi } from './services/simulations';
export { weatherApi } from './services/weather';
export { organizationsApi } from './services/organizations';
export { stationsApi } from './services/stations';
export { vehiclesApi } from './services/vehicles';
export { equipmentApi } from './services/equipment';
export { personnelApi } from './services/personnel';
export { dispatchesApi } from './services/dispatches';
export { plansApi } from './services/plans';
export { actionsApi } from './services/actions';
export { roadClosuresApi } from './services/roadClosures';
export { routingApi } from './services/routing';
export { metaApi } from './services/meta';

import { capabilitiesApi } from './services/capabilities';
import { locationsApi } from './services/locations';
import { scenariosApi } from './services/scenarios';
import { simulationsApi } from './services/simulations';
import { weatherApi } from './services/weather';
import { organizationsApi } from './services/organizations';
import { stationsApi } from './services/stations';
import { vehiclesApi } from './services/vehicles';
import { equipmentApi } from './services/equipment';
import { personnelApi } from './services/personnel';
import { dispatchesApi } from './services/dispatches';
import { plansApi } from './services/plans';
import { actionsApi } from './services/actions';
import { roadClosuresApi } from './services/roadClosures';
import { routingApi } from './services/routing';
import { metaApi } from './services/meta';

/**
 * Unified, strongly-typed client for the FireTrace Coordination API.
 * Adheres strictly to `api-spec/openapi.json`.
 */
export const api = {
  capabilities: capabilitiesApi,
  locations: locationsApi,
  scenarios: scenariosApi,
  simulations: simulationsApi,
  weather: weatherApi,
  organizations: organizationsApi,
  stations: stationsApi,
  vehicles: vehiclesApi,
  equipment: equipmentApi,
  personnel: personnelApi,
  dispatches: dispatchesApi,
  plans: plansApi,
  actions: actionsApi,
  roadClosures: roadClosuresApi,
  routing: routingApi,
  meta: metaApi,
} as const;
