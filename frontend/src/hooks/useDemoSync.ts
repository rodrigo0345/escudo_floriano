import { useEffect, useRef } from 'react';

import { ORG_COLOR } from '@/domain/resourceLabels';
import { useWorld } from '@/engine/EngineContext';
import { useAppStore } from '@/store/appStore';
import { useDemoStore } from '@/store/demoStore';
import { useResourcesStore } from '@/store/resourcesStore';
import { createWriter } from '@/usecases/dispatchDemo';

/**
 * Keeps the 3D map and the API in step with the dispatch rehearsal: the replayed units are drawn only while the plan's
 * fire is shown, and while an activated plan plays, each unit's progress is reported to the API.
 */
export function useDemoSync(): void {
  const world = useWorld();
  const { tracks, stage, dispatchIds, plan, exposures, assignments } = useDemoStore();
  const organizations = useResourcesStore((s) => s.organizations);
  const vehicles = useResourcesStore((s) => s.vehicles);
  const stations = useResourcesStore((s) => s.stations);
  const loaded = useResourcesStore((s) => s.loaded);
  const t = useAppStore((s) => s.t);
  const writer = useRef(createWriter());

  useEffect(() => {
    if (!world) return;
    const type = (id: string) => organizations.find((o) => o.id === id)?.type ?? 'other';
    const name = (id: string) => organizations.find((o) => o.id === id)?.shortName ?? id;
    const targets = new Map(assignments.map((a) => [a.unit.id, { lat: a.target.lat, lon: a.target.lon, label: a.target.label }]));
    world.units.setTracks(tracks, { colorOf: (id) => ORG_COLOR[type(id)] ?? '#9aa0a8', orgName: name, orgType: type, exposures, targets });
    // the fleet layer draws every other registered vehicle, so it has to know which ones the replay now owns
    const { vehicles, stations } = useResourcesStore.getState();
    world.fleet.setVehicles(vehicles, stations, organizations, world.units.unitIds);
  }, [world, tracks, organizations, exposures, assignments]);

  // the registered fleet is on the map from the start (parked at the stations), not only once an operation is planned
  useEffect(() => {
    if (!loaded) void useResourcesStore.getState().load();
  }, [loaded]);

  useEffect(() => {
    if (world) world.fleet.setVehicles(vehicles, stations, organizations, world.units.unitIds);
  }, [world, vehicles, stations, organizations]);

  useEffect(() => {
    writer.current = createWriter();
  }, [plan?.id]);

  useEffect(() => {
    if (stage === 'executing') writer.current(t, tracks, dispatchIds, exposures);
  }, [t, stage, tracks, dispatchIds, exposures]);
}
