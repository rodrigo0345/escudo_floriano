import { create } from 'zustand';

import type { Capabilities, Location, Plan, Smoke } from '@/api';

import type { BaseLayer, Banner, BannerKind, Ignition, Job, LocationData, PanelTab, Progress, RescueOrigin, RunData } from './types';

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
  ignition: Ignition | null;
  run: RunData | null;
  /** The agents' plan drawn on the map (the one whose what-if run is on screen); `null` = nothing drawn. */
  activePlan: Plan | null;
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
  pickIgnition: boolean;
  origin: RescueOrigin;
  hint: string;
  banner: Banner | null;

  // ---- actions
  setCatalog: (locations: Location[], locationId: string) => void;
  setLocationData: (data: LocationData | null) => void;
  setBootError: (message: string | null) => void;
  setCapabilities: (capabilities: Capabilities | null) => void;
  setScenario: (scenarioId: string | null) => void;
  setIgnition: (ignition: Ignition | null) => void;
  setRun: (run: RunData | null) => void;
  setBaseSimulationId: (simulationId: string | null) => void;
  setActivePlan: (plan: Plan | null) => void;
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
  setPickIgnition: (on: boolean) => void;
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
  ignition: null,
  run: null,
  baseSimulationId: null,
  activePlan: null,
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
  pickIgnition: false,
  origin: 'fire_brigade',
  hint: '',
  banner: null,

  setCatalog: (locations, locationId) => set({ locations, locationId }),
  setLocationData: (data) => set({ data }),
  setBootError: (bootError) => set({ bootError }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setScenario: (scenarioId) => set({ scenarioId }),
  setIgnition: (ignition) => set({ ignition }),
  setRun: (run) => set({ run }),
  setBaseSimulationId: (baseSimulationId) => set({ baseSimulationId }),
  setActivePlan: (activePlan) => set({ activePlan }),
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
  setPickIgnition: (pickIgnition) => set({ pickIgnition }),
  setOrigin: (origin) => set({ origin }),
  setHint: (hint) => set({ hint }),
  showBanner: (text, kind = 'error') => set({ banner: { text, kind } }),
  dismissBanner: () => set({ banner: null }),
}));
