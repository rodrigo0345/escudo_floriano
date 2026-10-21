import { useEffect, useState } from 'react';

import { simulationsApi } from '@/api';
import { ORG_COLOR } from '@/domain/resourceLabels';
import { useWorld } from '@/engine/EngineContext';
import type { MapUnit } from '@/engine/layers/unitLayer';
import { useAppStore } from '@/store/appStore';
import { useResourcesStore } from '@/store/resourcesStore';

const REINFORCEMENT_COLOR = '#ff9f1a';

/**
 * Draws the units of a plan's what-if from the backend: `GET /units` gives the metadata, and
 * `GET /units/{unitId}/track` gives the one-minute positions the 3D layer interpolates.
 */
export function useUnitsSync(): void {
  const world = useWorld();
  const run = useAppStore((s) => s.run);
  const organizations = useResourcesStore((s) => s.organizations);
  const vehicles = useResourcesStore((s) => s.vehicles);
  const stations = useResourcesStore((s) => s.stations);
  const loaded = useResourcesStore((s) => s.loaded);
  const [units, setUnits] = useState<MapUnit[]>([]);

  const simulationId = run?.simulation.kind === 'what_if' ? run.simulation.id : null;

  useEffect(() => {
    setUnits([]);
    if (!simulationId) return undefined;

    let cancelled = false;
    void (async () => {
      try {
        const states = await simulationsApi.units(simulationId, 0);
        const tracks = await Promise.all(
          states.items.map(async (state) => {
            try {
              return { state, track: await simulationsApi.unitTrack(simulationId, state.unitId, 1) };
            } catch {
              return null;
            }
          }),
        );
        if (!cancelled) setUnits(tracks.filter((u): u is MapUnit => u !== null));
      } catch (e) {
        if (!cancelled) console.warn('Meios do plano no mapa:', (e as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [simulationId]);

  // the registered fleet is on the map from the start (parked at the stations), not only once a plan's what-if is shown
  useEffect(() => {
    if (!loaded) void useResourcesStore.getState().load();
  }, [loaded]);

  useEffect(() => {
    if (!world) return;
    const orgOf = (id: string) => organizations.find((o) => o.id === id);
    const type = (id: string) => orgOf(id)?.type ?? 'other';
    const name = (id: string) => orgOf(id)?.shortName ?? id;
    world.units.setUnits(units, {
      // reinforcements from other districts (tag `reinforcement`, see agents/scripts/seed_reinforcements.py) stand out from the local brigades
      colorOf: (id) => ((orgOf(id)?.tags ?? []).includes('reinforcement') ? REINFORCEMENT_COLOR : ORG_COLOR[type(id)] ?? '#9aa0a8'),
      orgName: name,
      orgType: type,
      vehicleOf: (unitId) => vehicles.find((v) => v.id === unitId),
    });
    // every other registered vehicle: the plan's units are drawn by the unit layer, so the fleet leaves them out
    world.fleet.setVehicles(vehicles, stations, organizations, world.units.unitIds);
  }, [world, units, organizations, vehicles, stations]);
}
