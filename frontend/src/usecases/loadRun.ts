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
  const keyframes = snapshot.weather && 'keyframes' in snapshot.weather ? snapshot.weather.keyframes : null;
  const enrichedWeather = weather.map((s) => {
    let cloudCoverPct = s.cloudCoverPct;
    let precipitationMmH = s.precipitationMmH;

    if (keyframes && keyframes.length) {
      const sampleOffsetMin = Math.round((+new Date(s.time) - +new Date(snapshot.start)) / 60_000);
      const kf = keyframes.find((k) => ('offsetMinutes' in k.at ? k.at.offsetMinutes === sampleOffsetMin : false)) ?? keyframes[0];
      if (cloudCoverPct == null && kf.cloudCoverPct != null) {
        cloudCoverPct = kf.cloudCoverPct;
      }
      if (precipitationMmH == null && kf.precipitationMmH != null) {
        precipitationMmH = kf.precipitationMmH;
      }
    }

    if (cloudCoverPct == null && precipitationMmH != null && precipitationMmH > 0.1) {
      cloudCoverPct = Math.min(100, Math.max(70, Math.round(65 + precipitationMmH * 4)));
    }

    return {
      ...s,
      cloudCoverPct: cloudCoverPct ?? undefined,
      precipitationMmH: precipitationMmH ?? undefined,
    };
  });

  return {
    simulation,
    id,
    startMs: +new Date(snapshot.start),
    durationMinutes: snapshot.durationMinutes,
    weather: enrichedWeather,
    summary: summary.milestones,
    ign: ignGrid.data as Int16Array,
    inten: intenGrid.data as Uint16Array,
    flags: flagsGrid.data as Uint8Array,
    gridWidth: ignGrid.width,
    gridHeight: ignGrid.height,
    impact: null,
  };
}
