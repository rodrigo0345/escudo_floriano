/**
 * Escudo Floriano - Operational Multi-Agency Incident Scenario Example
 * 
 * Demonstrates how frontend applications, dashboards, or external emergency systems
 * consume the FireTrace Coordination API via the typed client (@see /frontend/src/api).
 * 
 * Flow demonstrated:
 * 1. Inspect System Status & Engine Capabilities
 * 2. Query Geospatial Context & Firebreaks
 * 3. Browse Operational Scenarios (e.g. Penha Wind Shift Exercise)
 * 4. Check Deployed Resources & Idle Vehicles
 * 5. Calculate Incident Routing with Active Road Cuts
 * 6. Review & Select Tactical Operational Plans (Plan A vs. Plan B)
 * 7. Dispatch Supporting Units (Firefighters, GNR, INEM)
 */

import { api } from '../index';
import type { 
  Plan, 
  Vehicle, 
  Route, 
  DeploymentOverview, 
  Scenario,
  Dispatch
} from '../types';

export interface IncidentExecutionReport {
  scenario: Scenario;
  initialDeployment: DeploymentOverview;
  activePlan: Plan;
  tacticalRoute: Route;
  emergencyDispatches: Dispatch[];
}

/**
 * Runs a complete operational response workflow for an active wildfire incident in Guimarães.
 */
export async function executeOperationalIncidentResponse(
  locationId = 'guimaraes-concelho',
  scenarioId = 'sc-penha-exercicio-rotacao-vento'
): Promise<IncidentExecutionReport> {
  // 1. Inspect API Capabilities and operational readiness
  const capabilities = await api.meta.capabilities();
  const hasRoadClosureSupport = capabilities.actionTypes?.some(
    (action) => action.name === 'road_closure' && action.supported
  );
  if (!hasRoadClosureSupport) {
    throw new Error('Backend does not support road_closure actions');
  }

  // 2. Fetch the tactical exercise scenario
  const scenario = await api.scenarios.get(scenarioId);

  // 3. Inspect live deployment in the concelho (who is on scene vs. idle)
  const initialDeployment = await api.locations.deployment(locationId);

  // 4. Find available high-capacity forest firefighting vehicles near Penha
  const availableVehicles = await api.vehicles.list({
    near: { lat: 41.4298, lon: -8.2686 },
    radiusM: 10000,
    capability: 'wildfire_attack',
    status: 'available',
  });

  // 5. Calculate realistic route for emergency vehicle avoiding active road closures
  const tacticalRoute = await api.routing.route({
    locationId,
    from: { lat: 41.4425, lon: -8.2918 }, // Guimarães Fire Station
    to: { lat: 41.4298, lon: -8.2686 },   // Incident command post at Penha
    emergencyVehicle: true,
    avoid: {
      activeClosures: true,
      predictedFire: true,
    },
  });

  // 6. Fetch operational plans proposed by planning agents (Plan A & Plan B)
  const plans = await api.plans.list({
    simulationId: scenario.id,
  });

  // Select Plan A (Direct Frontal Containment)
  const planId = plans.items[0]?.id || 'plan-penha-a';
  const activePlan = await api.plans.select(planId);

  // 7. Dispatch frontline emergency vehicle to hold the flank
  const primaryVehicle: Vehicle | undefined = availableVehicles.items[0];
  const dispatches: Dispatch[] = [];

  if (primaryVehicle) {
    const dispatchBatchResult = await api.dispatches.create({
      dispatches: [
        {
          resourceType: 'vehicle',
          resourceId: primaryVehicle.id,
          personnel: 5,
          responsibility: 'firefighting',
          target: {
            position: { lat: 41.4298, lon: -8.2686 },
            label: 'Penha - Flanco Sudoeste',
          },
          notes: 'Despacho prioritário para contenção perimétrica na Penha',
        },
      ],
      reason: 'Ativação inicial de combate perimétrico',
    });
    dispatches.push(...dispatchBatchResult.items);
  }

  return {
    scenario,
    initialDeployment,
    activePlan,
    tacticalRoute,
    emergencyDispatches: dispatches,
  };
}
