import { create } from 'zustand';

import type { Capabilities, Location, Plan, Smoke } from '@/api';
import { extractTimelineEventsFromSnapshot, extractTimelineKeyframesFromSnapshot, updateTimelineRangeEvent } from '@/domain/simulationForm';

import type { CitySource } from '@/engine/layers/photorealLayer';
import type {
  BaseLayer,
  Banner,
  BannerKind,
  IgnitionPoint,
  Job,
  LocationData,
  PanelTab,
  Progress,
  RescueOrigin,
  RunData,
  TimelineKeyframe,
  TimelineRangeEvent,
} from './types';

/**
 * The one client-side state container. State here is plain data; side effects (API calls,
 * driving the GPU engine) live in hooks under `src/hooks`, which read and write this store.
 * Components subscribe to the narrow slice they need via selectors, so a 60 fps playback tick
 * only re-renders the few components that show the current minute.
 */
export interface AppState {
  // ---- catalog / location
  locations: Location[];
  locationId: string | null;
  data: LocationData | null;
  bootError: string | null;
  /** What the backend actually implements (`GET /capabilities`); `null` until fetched or if it couldn't be. */
  capabilities: Capabilities | null;

  // ---- scenario / simulation
  scenarioId: string | null;
  ignitions: IgnitionPoint[];
  run: RunData | null;
  /** Custom range-based weather events active on the timeline and simulation form (Requirement 1 & 1.1). */
  customEvents: TimelineRangeEvent[];
  /** Sparse points of the weather curve (`WeatherSpec.keyframes`), edited on the timeline. */
  weatherKeyframes: TimelineKeyframe[];
  /** The agents' plan drawn on the map (the one whose what-if run is on screen); `null` = nothing drawn. */
  activePlan: Plan | null;
  /** The plan action picked in the combat timeline: outlined on the map with its unit's road. */
  focusedActionId: string | null;
  /** The baseline (no-response) simulation the plans panel lists plans for: the last baseline shown, kept while a plan's what-if is on screen. */
  baseSimulationId: string | null;
  job: Job | null;
  progress: Progress | null;
  /** The smoke resource at the current minute (plume height, roads without visibility). */
  smokeInfo: Smoke | null;

  // ---- playback
  /** Whole minute the panels show; `tf` is the fractional minute the GPU draws. */
  t: number;
  tf: number;
  playing: boolean;
  speed: number;

  // ---- view / ui
  tab: PanelTab;
  baseLayer: BaseLayer;
  probMode: boolean;
  smokeEnabled: boolean;
  /** Smoke wisps, embers and ash over the burned ground after the flames pass (on by default). */
  aftermathEnabled: boolean;
  windEnabled: boolean;
  /** The photoreal 3D city (local tiles). Off by default: nothing is loaded until the operator turns it on. */
  cityEnabled: boolean;
  /** Where the 3D city comes from, and (live only) the Google key the operator typed: memory only, never persisted. */
  citySource: CitySource;
  cityKey: string;
  cloudsEnabled: boolean;
  /** Thunder synthesised from the lightning of a storm cell (Epic E6); browsers only allow it after a gesture. */
  thunderEnabled: boolean;
  windDensity: number;
  pickIgnitionSlot: 0 | 1 | null;
  helpOpen: boolean;
  origin: RescueOrigin;
  hint: string;
  banner: Banner | null;

  // ---- actions
  setCatalog: (locations: Location[], locationId: string) => void;
  setLocationData: (data: LocationData | null) => void;
  setBootError: (message: string | null) => void;
  setCapabilities: (capabilities: Capabilities | null) => void;
  setScenario: (scenarioId: string | null) => void;
  setIgnitions: (ignitions: IgnitionPoint[]) => void;
  updateIgnition: (index: number, patch: Partial<IgnitionPoint>) => void;
  addIgnition: (ignition: IgnitionPoint) => void;
  removeIgnition: (index: number) => void;
  setRun: (run: RunData | null) => void;
  setCustomEvents: (events: TimelineRangeEvent[]) => void;
  addCustomEvent: (event: TimelineRangeEvent) => void;
  updateCustomEvent: (id: string, patch: Partial<TimelineRangeEvent>) => void;
  removeCustomEvent: (id: string) => void;
  setWeatherKeyframes: (keyframes: TimelineKeyframe[]) => void;
  addWeatherKeyframe: (keyframe: TimelineKeyframe) => void;
  updateWeatherKeyframe: (id: string, patch: Partial<TimelineKeyframe>) => void;
  removeWeatherKeyframe: (id: string) => void;
  setBaseSimulationId: (simulationId: string | null) => void;
  setActivePlan: (plan: Plan | null) => void;
  setFocusedAction: (actionId: string | null) => void;
  setImpact: (impact: RunData['impact']) => void;
  setJob: (job: Job | null) => void;
  setProgress: (progress: Progress | null) => void;
  setSmokeInfo: (smoke: Smoke | null) => void;
  setTime: (t: number, tf?: number) => void;
  setFractionalTime: (tf: number) => void;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: number) => void;
  setTab: (tab: PanelTab) => void;
  setBaseLayer: (layer: BaseLayer) => void;
  setProbMode: (on: boolean) => void;
  setSmokeEnabled: (on: boolean) => void;
  setAftermathEnabled: (on: boolean) => void;
  setCityEnabled: (on: boolean) => void;
  setCitySource: (source: CitySource) => void;
  setCityKey: (key: string) => void;
  setWindEnabled: (on: boolean) => void;
  setCloudsEnabled: (on: boolean) => void;
  setThunderEnabled: (on: boolean) => void;
  setWindDensity: (density: number) => void;
  setPickIgnitionSlot: (slot: 0 | 1 | null) => void;
  setHelpOpen: (open: boolean) => void;
  setOrigin: (origin: RescueOrigin) => void;
  setHint: (hint: string) => void;
  showBanner: (text: string, kind?: BannerKind) => void;
  dismissBanner: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  locations: [],
  locationId: null,
  data: null,
  bootError: null,
  capabilities: null,

  scenarioId: null,
  ignitions: [],
  run: null,
  customEvents: [],
  weatherKeyframes: [],
  baseSimulationId: null,
  activePlan: null,
  focusedActionId: null,
  job: null,
  progress: null,
  smokeInfo: null,

  t: 0,
  tf: 0,
  playing: false,
  speed: 10,

  tab: 'incident',
  baseLayer: 'satellite',
  probMode: false,
  smokeEnabled: true,
  aftermathEnabled: true,
  windEnabled: false,
  cityEnabled: false,
  citySource: 'live',
  cityKey: '',
  cloudsEnabled: true,
  thunderEnabled: true,
  windDensity: 50,
  pickIgnitionSlot: null,
  helpOpen: false,
  origin: 'fire_brigade',
  hint: '',
  banner: null,

  setCatalog: (locations, locationId) => set({ locations, locationId }),
  setLocationData: (data) => set({ data }),
  setBootError: (bootError) => set({ bootError }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setScenario: (scenarioId) => set({ scenarioId }),
  setIgnitions: (ignitions) => set({ ignitions }),
  updateIgnition: (index, patch) =>
    set((s) => ({ ignitions: s.ignitions.map((ig, i) => (i === index ? { ...ig, ...patch } : ig)) })),
  addIgnition: (ignition) => set((s) => (s.ignitions.length >= 2 ? {} : { ignitions: [...s.ignitions, ignition] })),
  removeIgnition: (index) => set((s) => ({ ignitions: s.ignitions.filter((_, i) => i !== index), pickIgnitionSlot: null })),
  setRun: (run) =>
    set((s) => {
      const parsed = run
        ? extractTimelineEventsFromSnapshot(run.simulation.scenarioSnapshot, run.durationMinutes, run.startMs)
        : [];
      const parsedKeyframes = run
        ? extractTimelineKeyframesFromSnapshot(run.simulation.scenarioSnapshot, run.startMs, run.durationMinutes)
        : [];
      return {
        run,
        // If the incoming run snapshot has explicit events, keep or seed them
        customEvents: parsed.length > 0 ? parsed : s.customEvents,
        // Keyframes belong to the scenario that was just loaded: an empty snapshot must clear the previous curve.
        weatherKeyframes: parsedKeyframes,
      };
    }),
  setCustomEvents: (customEvents) => set({ customEvents }),
  addCustomEvent: (event) =>
    set((s) => ({
      customEvents: [...s.customEvents.filter((e) => e.id !== event.id), event],
    })),
  updateCustomEvent: (id, patch) =>
    set((s) => ({
      customEvents: s.customEvents.map((e) => (e.id === id ? updateTimelineRangeEvent(e, patch) : e)),
    })),
  removeCustomEvent: (id) =>
    set((s) => ({
      customEvents: s.customEvents.filter((e) => e.id !== id),
    })),
  setWeatherKeyframes: (weatherKeyframes) => set({ weatherKeyframes }),
  addWeatherKeyframe: (keyframe) =>
    set((s) => ({
      weatherKeyframes: [...s.weatherKeyframes.filter((k) => k.id !== keyframe.id), keyframe].sort((a, b) => a.minute - b.minute),
    })),
  updateWeatherKeyframe: (id, patch) =>
    set((s) => ({
      // Keep the array order stable while a marker is being dragged (the spec builder sorts by minute).
      weatherKeyframes: s.weatherKeyframes.map((k) => (k.id === id ? { ...k, ...patch } : k)),
    })),
  removeWeatherKeyframe: (id) =>
    set((s) => ({
      weatherKeyframes: s.weatherKeyframes.filter((k) => k.id !== id),
    })),
  setBaseSimulationId: (baseSimulationId) => set({ baseSimulationId }),
  setActivePlan: (activePlan) => set({ activePlan }),
  setFocusedAction: (focusedActionId) => set({ focusedActionId }),
  setImpact: (impact) => set((s) => (s.run ? { run: { ...s.run, impact } } : {})),
  setJob: (job) => set({ job }),
  setProgress: (progress) => set({ progress }),
  setSmokeInfo: (smokeInfo) => set({ smokeInfo }),
  setTime: (t, tf) => set({ t, tf: tf ?? t }),
  setFractionalTime: (tf) => set({ tf }),
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  setTab: (tab) => set({ tab }),
  setBaseLayer: (baseLayer) => set({ baseLayer }),
  setProbMode: (probMode) => set({ probMode }),
  setSmokeEnabled: (smokeEnabled) => set({ smokeEnabled }),
  setAftermathEnabled: (aftermathEnabled) => set({ aftermathEnabled }),
  setCityEnabled: (cityEnabled) => set({ cityEnabled }),
  setCitySource: (citySource) => set({ citySource }),
  setCityKey: (cityKey) => set({ cityKey }),
  setWindEnabled: (windEnabled) => set({ windEnabled }),
  setCloudsEnabled: (cloudsEnabled) => set({ cloudsEnabled }),
  setThunderEnabled: (thunderEnabled) => set({ thunderEnabled }),
  setWindDensity: (windDensity: number) => set({ windDensity }),
  setPickIgnitionSlot: (pickIgnitionSlot) => set({ pickIgnitionSlot }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  setOrigin: (origin) => set({ origin }),
  setHint: (hint) => set({ hint }),
  showBanner: (text, kind = 'error') => set({ banner: { text, kind } }),
  dismissBanner: () => set({ banner: null }),
}));

if (typeof window !== 'undefined') {
  (window as any).__APP_STORE__ = useAppStore;
}
