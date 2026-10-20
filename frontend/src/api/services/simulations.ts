import { fetchGrid } from '../binaryGrids';
import { http } from '../httpClient';
import type {
  GridData,
  PerimeterCollection,
  PlaceAccessTimeline,
  RoadStatusTimeline,
  Simulation,
  SimulationRequest,
  SimulationSummary,
  Smoke,
  SpreadVectorCollection,
  WeatherSeries,
} from '../types';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isDone = (status: Simulation['status']) => status === 'queued' || status === 'running' ? false : true;

export interface RunCallbacks {
  /** Fires once, as soon as the server has assigned an id (so a cancel button has something to call). */
  onStart?: (sim: Simulation) => void;
  onProgress?: (sim: Simulation) => void;
  /** Polling interval while the simulation is `queued`/`running`. Large concelho-scale runs can take minutes. */
  pollMs?: number;
}

export const simulationsApi = {
  create: async (request: SimulationRequest): Promise<Simulation> => {
    const { data } = await http.post<Simulation>('/simulations', request);
    return data;
  },

  get: async (simulationId: string): Promise<Simulation> => {
    const { data } = await http.get<Simulation>(`/simulations/${simulationId}`);
    return data;
  },

  cancel: async (simulationId: string): Promise<void> => {
    await http.post(`/simulations/${simulationId}/cancel`, {});
  },

  /** The most recent successfully-finished baseline simulation of a scenario (what-if runs of plans are excluded), if any — reused instead of re-running a built-in scenario every time it's selected. */
  latestSucceeded: async (scenarioId: string): Promise<Simulation | null> => {
    const { data } = await http.get<{ items: Simulation[] }>('/simulations', {
      params: { scenarioId, status: 'succeeded', kind: 'baseline', limit: 1 },
    });
    return data.items[0] ?? null;
  },

  /**
   * Creates a simulation and polls until it leaves `queued`/`running`, surfacing progress
   * along the way. Throws `ApiError`-shaped errors (via httpClient's interceptor) if the run
   * itself fails or is cancelled server-side.
   */
  run: async (request: SimulationRequest, callbacks: RunCallbacks = {}): Promise<Simulation> => {
    const { onStart, onProgress, pollMs = 1500 } = callbacks;
    let sim = await simulationsApi.create(request);
    onStart?.(sim);
    while (!isDone(sim.status)) {
      onProgress?.(sim);
      await sleep(pollMs);
      sim = await simulationsApi.get(sim.id as string);
    }
    if (sim.status !== 'succeeded') {
      throw new Error(sim.error?.detail ?? sim.error?.title ?? `Simulação ${sim.status}`);
    }
    return sim;
  },

  grid: (simulationId: string, grid: 'ignition' | 'intensity' | 'flags'): Promise<GridData> =>
    fetchGrid(`/simulations/${simulationId}/grids/${grid}`),

  summary: async (simulationId: string, stepMinutes = 5): Promise<SimulationSummary> => {
    const { data } = await http.get<SimulationSummary>(`/simulations/${simulationId}/summary`, {
      params: { step: stepMinutes },
    });
    return data;
  },

  weather: async (simulationId: string): Promise<WeatherSeries['samples']> => {
    const { data } = await http.get<WeatherSeries>(`/simulations/${simulationId}/weather`);
    return data.samples;
  },

  perimeter: async (simulationId: string, tMin: number): Promise<PerimeterCollection> => {
    const { data } = await http.get<PerimeterCollection>(`/simulations/${simulationId}/perimeters`, {
      params: { tMin },
    });
    return data;
  },

  vectors: async (simulationId: string, tMin: number): Promise<SpreadVectorCollection> => {
    const { data } = await http.get<SpreadVectorCollection>(`/simulations/${simulationId}/vectors`, {
      params: { tMin },
    });
    return data;
  },

  roadStatus: async (simulationId: string, minProbability = 0.05): Promise<RoadStatusTimeline> => {
    const { data } = await http.get<RoadStatusTimeline>(`/simulations/${simulationId}/road-status`, {
      params: { minProbability },
    });
    return data;
  },

  placeAccess: async (simulationId: string, origin: string, stepMin: number): Promise<PlaceAccessTimeline> => {
    const { data } = await http.get<PlaceAccessTimeline>(`/simulations/${simulationId}/place-access`, {
      params: { origin, stepMin },
    });
    return data;
  },

  smoke: async (simulationId: string, tMin: number): Promise<Smoke> => {
    const { data } = await http.get<Smoke>(`/simulations/${simulationId}/smoke`, { params: { tMin } });
    return data;
  },
};
