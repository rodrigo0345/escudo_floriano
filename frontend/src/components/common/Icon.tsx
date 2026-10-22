import type { CSSProperties } from 'react';

/** Line icons drawn with `currentColor`, so they take the text colour around them. The console uses these instead of emoji. */
export type IconName =
  | 'close'
  | 'rain'
  | 'storm'
  | 'cloud'
  | 'wind'
  | 'gust'
  | 'front'
  | 'thermometer'
  | 'humidity'
  | 'sun'
  | 'globe'
  | 'pin'
  | 'target'
  | 'check'
  | 'alert'
  | 'clock'
  | 'flame'
  | 'info'
  | 'keyboard';

const PATHS: Record<IconName, string> = {
  close: 'M6 6l12 12M18 6L6 18',
  rain: 'M7 15a4 4 0 0 1 .5-8A5 5 0 0 1 17 8a3.5 3.5 0 0 1 0 7H7zM9 18l-1 2M13 18l-1 2M17 18l-1 2',
  storm: 'M7 14a4 4 0 0 1 .5-8A5 5 0 0 1 17 7a3.5 3.5 0 0 1 0 7M12 12l-2 4h4l-2 4',
  cloud: 'M7 18a4 4 0 0 1 .5-8A5 5 0 0 1 17 11a3.5 3.5 0 0 1 0 7H7z',
  wind: 'M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3',
  gust: 'M3 8h9a2.5 2.5 0 1 0-2.5-2.5M3 12h15a3 3 0 1 0-3-3M3 16h8a2.5 2.5 0 1 1-2.5 2.5',
  front: 'M3 7h10a3 3 0 1 0-3-3M3 12h16M3 17h9a3 3 0 1 1-3 3',
  thermometer: 'M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z',
  humidity: 'M12 3s6 6.3 6 10.2A6 6 0 0 1 6 13.2C6 9.3 12 3 12 3z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z',
  pin: 'M12 21s-6-5.3-6-11a6 6 0 0 1 12 0c0 5.7-6 11-6 11zM12 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 11.5v1',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 4l9 16H3l9-16zM12 10v4M12 17v.5',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  flame: 'M12 21c-3.9 0-6.5-2.6-6.5-6 0-3.6 3-5.4 3.8-9 2.2 1.4 3.2 3.6 3.2 5.5 1-.6 1.7-1.8 1.9-3 2 1.6 4.1 4 4.1 6.5 0 3.4-2.6 6-6.5 6z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5V8',
  keyboard: 'M3 7h18v10H3zM7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 14h8',
};

export function Icon({ name, size = 14, style, title }: { name: IconName; size?: number; style?: CSSProperties; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      style={{ flex: 'none', verticalAlign: '-0.15em', ...style }}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Icon per timeline weather-event type. */
export const WEATHER_EVENT_ICON: Record<string, IconName> = {
  rain: 'rain',
  storm: 'storm',
  clouds: 'cloud',
  wind_shift: 'wind',
  wind_scale: 'gust',
  wind_set: 'wind',
  gust_burst: 'gust',
  front_passage: 'front',
  temperature_shift: 'thermometer',
  humidity_shift: 'humidity',
  heat_dry: 'sun',
};
