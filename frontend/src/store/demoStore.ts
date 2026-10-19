import { create } from 'zustand';

import type { CrewExposure, Plan, Simulation } from '@/api';
import type { Assignment, LogEntry, UnitTrack } from '@/domain/dispatchPlanner';

export type DemoStage = 'idle' | 'planning' | 'planned' | 'executing' | 'closed';

/** What the operation costs, as the engine computed it for the plan's what-if run. */
export interface DemoResult {
  areaHa: number;
  buildings: number;
  /** People of the plan's crews caught by the fire (`stats.crewCasualties`). */
  casualties: number;
}

/** State of the dispatch rehearsal: everything real (plan, simulations, dispatches) lives in the API; this keeps the ids and the replay tracks. */
interface DemoState {
  stage: DemoStage;
  status: string;
  error: string | null;
  plan: Plan | null;
  baselineSim: Simulation | null;
  planSim: Simulation | null;
  tracks: UnitTrack[];
  assignments: Assignment[];
  log: LogEntry[];
  result: DemoResult | null;
  /** Where the fire catches crews (`simulation.crewExposures`) and the plan validator's warnings about it. */
  exposures: CrewExposure[];
  warnings: string[];
  /** resourceId → dispatchId, once the plan is active. */
  dispatchIds: Record<string, string>;
  selectedUnit: string | null;
  patch: (p: Partial<Omit<DemoState, 'patch' | 'reset'>>) => void;
  reset: () => void;
}

const initial = {
  stage: 'idle' as DemoStage,
  status: '',
  error: null,
  plan: null,
  baselineSim: null,
  planSim: null,
  tracks: [],
  assignments: [],
  log: [],
  result: null,
  exposures: [],
  warnings: [],
  dispatchIds: {},
  selectedUnit: null,
};

export const useDemoStore = create<DemoState>((set) => ({
  ...initial,
  patch: (p) => set(p),
  reset: () => set({ ...initial }),
}));
