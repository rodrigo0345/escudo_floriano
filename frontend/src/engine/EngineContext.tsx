import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import type { SceneEngine } from './sceneEngine';
import type { World } from './world';

interface EngineContextValue {
  engine: SceneEngine | null;
  world: World | null;
  setEngine: (engine: SceneEngine | null) => void;
  setWorld: (world: World | null) => void;
  /** Whether the ensemble's p10–p90 "cone of futures" band is drawn (the LayersPanel's switch). */
  ensembleEnabled: boolean;
  setEnsembleEnabled: (ensembleEnabled: boolean) => void;
}

const EngineContext = createContext<EngineContextValue | null>(null);

/**
 * Hands the imperative GPU objects (`SceneEngine`, `World`) to any component or hook that
 * needs them, without putting non-serializable three.js objects in the Zustand store. The
 * `Viewport` component creates the engine; `useWorldLoader` creates the world once data is in.
 */
export function EngineProvider({ children }: { children: ReactNode }) {
  const [engine, setEngine] = useState<SceneEngine | null>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [ensembleEnabled, setEnsembleEnabled] = useState(false); // "Melhor e pior cenário": off until the operator asks for it
  const value = useMemo(
    () => ({ engine, world, setEngine, setWorld, ensembleEnabled, setEnsembleEnabled }),
    [engine, world, ensembleEnabled],
  );
  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>;
}

export function useEngineContext(): EngineContextValue {
  const ctx = useContext(EngineContext);
  if (!ctx) throw new Error('useEngineContext must be used inside <EngineProvider>');
  return ctx;
}

export const useEngine = (): SceneEngine | null => useEngineContext().engine;
export const useWorld = (): World | null => useEngineContext().world;
