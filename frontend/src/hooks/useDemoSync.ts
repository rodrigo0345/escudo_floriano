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
  const { tracks, stage, dispatchIds, plan, exposures } = useDemoStore();
  const organizations = useResourcesStore((s) => s.organizations);
  const t = useAppStore((s) => s.t);
  const writer = useRef(createWriter());

  useEffect(() => {
    if (!world) return;
    const type = (id: string) => organizations.find((o) => o.id === id)?.type ?? 'other';
    const name = (id: string) => organizations.find((o) => o.id === id)?.shortName ?? id;
    world.units.setTracks(tracks, (id) => ORG_COLOR[type(id)] ?? '#9aa0a8', name, exposures);
  }, [world, tracks, organizations, exposures]);

  useEffect(() => {
    writer.current = createWriter();
  }, [plan?.id]);

  useEffect(() => {
    if (stage === 'executing') writer.current(t, tracks, dispatchIds, exposures);
  }, [t, stage, tracks, dispatchIds, exposures]);
}
