import { simulationsApi, type Simulation } from '@/api';
import type { RunData } from '@/store/types';

/** Loads a finished simulation's result grids, summary and weather in parallel (impact is loaded separately because it depends on the map layers). */
export async function loadRunData(simulation: Simulation): Promise<RunData> {
  const id = simulation.id as string;
  const [ignGrid, intenGrid, flagsGrid, summary, weather] = await Promise.all([
    simulationsApi.grid(id, 'ignition'),
    simulationsApi.grid(id, 'intensity'),
    simulationsApi.grid(id, 'flags'),
    simulationsApi.summary(id, 5),
    simulationsApi.weather(id),
  ]);
  const snapshot = simulation.scenarioSnapshot;
  return {
    simulation,
    id,
    startMs: +new Date(snapshot.start),
    durationMinutes: snapshot.durationMinutes,
    weather,
    summary: summary.milestones,
    ign: ignGrid.data as Int16Array,
    inten: intenGrid.data as Uint16Array,
    flags: flagsGrid.data as Uint8Array,
    gridWidth: ignGrid.width,
    gridHeight: ignGrid.height,
    impact: null,
  };
}
