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

  useEffect(() => {
    if (!world) return;
    const orgOf = (id: string) => organizations.find((o) => o.id === id);
    const name = (id: string) => orgOf(id)?.shortName ?? id;
    // reinforcements from other districts (tag `reinforcement`, see agents/scripts/seed_reinforcements.py) stand out from the local brigades
    const color = (id: string) => ((orgOf(id)?.tags ?? []).includes('reinforcement') ? REINFORCEMENT_COLOR : ORG_COLOR[orgOf(id)?.type ?? 'other'] ?? '#9aa0a8');
    world.units.setUnits(units, color, name);
  }, [world, units, organizations]);
}
