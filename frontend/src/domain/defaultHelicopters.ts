import type { Organization, Station, Vehicle } from '@/api';

/**
 * Creates 2 default firefighting helicopters (HEBP 01 heavy water bomber + HEBL 02 light attack helicopter)
 * based on the Portuguese DECIR fleet specifications.
 */
export function createDefaultHelicopters(stations: Station[], organizations: Organization[]): Vehicle[] {
  const procivOrg = organizations.find((o) => o.type === 'civil_protection') ?? organizations[0];
  const bombeirosOrg = organizations.find((o) => o.type === 'fire_brigade') ?? organizations[0];
  const defaultStation = stations.find((s) => s.kind === 'helipad') ?? stations[0];

  const now = new Date().toISOString();

  const heli1: Vehicle = {
    id: 'v-hebp-01',
    createdAt: now,
    updatedAt: now,
    organizationId: procivOrg?.id ?? 'org-prociv',
    stationId: defaultStation?.id ?? null,
    callsign: 'HEBP 01',
    type: 'helicopter',
    typeCode: 'UH-60A',
    crewCapacity: 3,
    minimumCrew: 2,
    offRoad: true,
    cruiseSpeedKmh: 260,
    rangeKm: 580,
    fuelCapacityL: 1360,
    waterCapacityL: 3000,
    pumpFlowLpm: 6000,
    capabilities: ['aerial_water_drop', 'aerial_recon'],
    aerial: {
      bucketCapacityL: 3000,
      loadMinutes: 1.0,
      dropMinutes: 0.5,
      cruiseSpeedKmh: 260,
      maxWindKmh: 50,
      minVisibilityM: 2000,
      dayOnly: true,
    },
    inService: true,
    state: {
      status: 'available',
      position: defaultStation?.position,
      crewOnboard: 2,
      water: {
        capacityL: 3000,
        levelL: 3000,
      },
      fuelPct: 95,
      updatedAt: now,
    },
  };

  const heli2: Vehicle = {
    id: 'v-hebl-02',
    createdAt: now,
    updatedAt: now,
    organizationId: bombeirosOrg?.id ?? 'org-bombeiros',
    stationId: defaultStation?.id ?? null,
    callsign: 'HEBL 02',
    type: 'helicopter',
    typeCode: 'AS350B3',
    crewCapacity: 5,
    minimumCrew: 1,
    offRoad: true,
    cruiseSpeedKmh: 250,
    rangeKm: 650,
    fuelCapacityL: 540,
    waterCapacityL: 1000,
    pumpFlowLpm: 3000,
    capabilities: ['aerial_water_drop', 'aerial_recon'],
    aerial: {
      bucketCapacityL: 1000,
      loadMinutes: 0.7,
      dropMinutes: 0.3,
      cruiseSpeedKmh: 250,
      maxWindKmh: 45,
      minVisibilityM: 2000,
      dayOnly: true,
    },
    inService: true,
    state: {
      status: 'available',
      position: defaultStation?.position,
      crewOnboard: 2,
      water: {
        capacityL: 1000,
        levelL: 1000,
      },
      fuelPct: 90,
      updatedAt: now,
    },
  };

  return [heli1, heli2];
}
