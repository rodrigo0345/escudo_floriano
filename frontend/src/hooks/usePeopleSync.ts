import { useEffect } from 'react';

import { useWorld } from '@/engine/EngineContext';
import { useAppStore } from '@/store/appStore';

import { useHouses } from './useHouses';

/** Feeds the people layer: the houses of the location, the fire's arrival grid of the run on screen and the plan on screen. */
export function usePeopleSync(): void {
  const world = useWorld();
  const houses = useHouses();
  const run = useAppStore((s) => s.run);
  const plan = useAppStore((s) => s.activePlan);
  useEffect(() => world?.people.setHouses(houses), [world, houses]);
  useEffect(() => world?.people.setFire(run?.ign ?? null), [world, run]);
  useEffect(() => world?.people.setPlan(plan ?? null), [world, plan]);
}
