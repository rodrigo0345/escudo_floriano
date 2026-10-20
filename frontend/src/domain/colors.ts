export type Rgb = [number, number, number];

export const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;

/** Interpolates a bearing (degrees) the short way around the circle. */
export const lerpDeg = (a: number, b: number, f: number): number => {
  const d = ((((b - a + 540) % 360) + 360) % 360) - 180;
  return (a + d * f + 360) % 360;
};

function rampAt(stops: ReadonlyArray<readonly [number, Rgb]>, x: number): Rgb {
  for (let i = 1; i < stops.length; i++) {
    const [k1, c1] = stops[i];
    if (x <= k1) {
      const [k0, c0] = stops[i - 1];
      const f = (x - k0) / (k1 - k0);
      return [lerp(c0[0], c1[0], f), lerp(c0[1], c1[1], f), lerp(c0[2], c1[2], f)];
    }
  }
  return stops[stops.length - 1][1];
}

const WIND_STOPS: ReadonlyArray<readonly [number, Rgb]> = [
  [0, [56, 189, 248]],   // #38bdf8 - Calm Electric Cyan
  [15, [14, 165, 233]],  // #0ea5e9 - Light Breeze Sky Blue
  [30, [2, 132, 199]],   // #0284c7 - Moderate Deep Azure
  [45, [245, 158, 11]],  // #f59e0b - Strong / Accelerated Amber Gold
  [60, [234, 88, 12]],   // #ea580c - Severe / Intense Indraft Flame Orange
];

/** Wind speed → color: pale steel (calm) → blue → deep blue → amber (dangerous for fire spread). */
export const windColor = (kmh: number): Rgb => rampAt(WIND_STOPS, kmh).map(Math.round) as Rgb;

export const windColorCss = (kmh: number): string => `rgb(${windColor(kmh).join(',')})`;

/** Relative humidity → a CSS variable name: below 20% fine dead fuel ignites easily. */
export const humidityColorVar = (rhPct: number): string => (rhPct < 20 ? 'var(--bad)' : rhPct < 35 ? 'var(--warn)' : 'var(--ok)');

const ELEVATION_STOPS: ReadonlyArray<readonly [number, Rgb]> = [
  [120, [102, 158, 102]],
  [200, [158, 194, 115]],
  [300, [219, 214, 140]],
  [420, [204, 166, 115]],
  [520, [173, 140, 115]],
  [620, [235, 230, 224]],
];

/** Hypsometric color ramp for the topographic base layer. */
export const elevationColor = (elevationM: number): Rgb => rampAt(ELEVATION_STOPS, elevationM);

export const hexToRgb = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
