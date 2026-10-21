import type {
  Facility,
  Ignition,
  Location,
  Place,
  RoadCollection,
  Scenario,
  Simulation,
  SummaryMilestone,
  VegetationInfo,
  WaterPoint,
  WeatherSample,
} from '@/api';
import type { Georef } from '@/domain/georef';
import type { Impact } from '@/domain/impact';
import type { TimelineRangeEvent } from '@/domain/simulationForm';

export type { TimelineRangeEvent };

/** Everything loaded once per location (static map data). */
export interface LocationData {
  location: Location;
  geo: Georef;
  vegetation: VegetationInfo;
  roads: RoadCollection;
  facilities: Facility[];
  places: Place[];
  waterPoints: WaterPoint[];
  scenarios: Scenario[];
  landcover: Uint8Array;
  /** How many minutes each land-cover cell burns, per cell (from the vegetation class table). */
  burnMinutes: Uint8Array;
}

/** Everything loaded once per simulation result. */
export interface RunData {
  simulation: Simulation;
  id: string;
  startMs: number;
  durationMinutes: number;
  weather: WeatherSample[];
  summary: SummaryMilestone[];
  ign: Int16Array;
  inten: Uint16Array;
  flags: Uint8Array;
  gridWidth: number;
  gridHeight: number;
  impact: Impact | null;
}

export type PanelTab = 'incident' | 'plans' | 'roads' | 'assets' | 'weather' | 'resources';
export type BaseLayer = 'satellite' | 'topo' | 'species';
export type RescueOrigin = 'fire_brigade' | 'gnr' | 'inem' | 'any';
export type BannerKind = 'error' | 'warn';

export interface Job {
  id: string | null;
  /** Started automatically for the first scenario (a user request may replace it) vs. started by the user (never silently cancelled). */
  auto: boolean;
  cancelled: boolean;
}

export interface Progress {
  text: string;
  percent: number;
}

export interface Banner {
  text: string;
  kind: BannerKind;
}

export type IgnitionPoint = Ignition;
