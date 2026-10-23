/** Simulated minutes per real second, slowest first. 0.5 (30 s/s) is the cinematic one: crews and engines can be followed by eye. */
export const PLAYBACK_SPEEDS = [0.5, 1, 5, 10, 30, 60, 120, 240];

/** "30 s/s" below one minute per second, else "10 min/s". */
export const speedLabel = (speed: number): string => (speed < 1 ? `${Math.round(speed * 60)} s/s` : `${speed} min/s`);

/** The index of the listed speed nearest to `speed` (a speed set elsewhere still lands on a step). */
export const speedIndex = (speed: number): number =>
  PLAYBACK_SPEEDS.reduce((best, s, i) => (Math.abs(s - speed) < Math.abs(PLAYBACK_SPEEDS[best] - speed) ? i : best), 0);

/** One step slower (`-1`) or faster (`+1`), stopping at the ends. */
export const stepSpeed = (speed: number, direction: -1 | 1): number =>
  PLAYBACK_SPEEDS[Math.max(0, Math.min(PLAYBACK_SPEEDS.length - 1, speedIndex(speed) + direction))];
