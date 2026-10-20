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
    const sampleOffsetMin = Math.round((+new Date(s.time) - +new Date(snapshot.start)) / 60_000);

    // 1. Enrich from keyframes if present
    if (keyframes && keyframes.length) {
      const kf = keyframes.find((k) => ('offsetMinutes' in k.at ? k.at.offsetMinutes === sampleOffsetMin : false)) ?? keyframes[0];
      if (cloudCoverPct == null && kf.cloudCoverPct != null) {
        cloudCoverPct = kf.cloudCoverPct;
      }
      if (precipitationMmH == null && kf.precipitationMmH != null) {
        precipitationMmH = kf.precipitationMmH;
      }
    }

    // 2. Enrich from scenario events (Requirements 1, 1.1 & 1.2)
    for (const ev of snapshot.weather?.events ?? []) {
      if (ev.enabled === false) continue;
      if (ev.type === 'precipitation') {
        const win = 'window' in ev ? ev.window : null;
        const start = win?.start && 'offsetMinutes' in win.start ? win.start.offsetMinutes ?? 0 : 0;
        const end = win?.end && 'offsetMinutes' in win.end ? win.end.offsetMinutes ?? 0 : 0;
        if (sampleOffsetMin >= start && sampleOffsetMin <= end) {
          precipitationMmH = Math.max(precipitationMmH ?? 0, ev.intensityMmH ?? 6.0);
          cloudCoverPct = Math.max(cloudCoverPct ?? 0, Math.min(100, Math.max(80, Math.round(72 + (ev.intensityMmH ?? 6) * 3.5))));
        }
      } else if (ev.type === 'front_passage') {
        const at = 'at' in ev && typeof ev.at === 'object' && 'offsetMinutes' in ev.at ? ev.at.offsetMinutes ?? 0 : 0;
        const dur = ev.durationMinutes ?? 45;
        if (sampleOffsetMin >= at && sampleOffsetMin <= at + dur) {
          if (ev.precipitationMmH != null && ev.precipitationMmH > 0) {
            precipitationMmH = Math.max(precipitationMmH ?? 0, ev.precipitationMmH);
          }
          cloudCoverPct = Math.max(cloudCoverPct ?? 0, 92);
        }
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
