import { useEffect } from 'react';

import { PlaybackBar } from '@/components/layout/PlaybackBar';
import { TopBar } from '@/components/layout/TopBar';
import styles from '@/components/layout/layout.module.css';
import { SidePanel } from '@/components/panels/SidePanel';
import { Viewport } from '@/components/viewport/Viewport';
import { EngineProvider, useWorld } from '@/engine/EngineContext';
import { useBootstrap } from '@/hooks/useBootstrap';
import { useFrameLoop } from '@/hooks/useFrameLoop';
import { useSimulationActions } from '@/hooks/useSimulationActions';
import { useWorldLoader } from '@/hooks/useWorldLoader';
import { useWorldSync } from '@/hooks/useWorldSync';
import { useAppStore } from '@/store/appStore';

/** Wires the non-visual behaviors (data loading, GPU world lifecycle, frame loop, store→GPU sync) and kicks off the first scenario. */
function Controllers() {
  const world = useWorld();
  const scenarios = useAppStore((s) => s.data?.scenarios);
  const { selectScenario } = useSimulationActions();

  useBootstrap();
  useWorldLoader();
  useFrameLoop();
  useWorldSync();

  // once the map is up, show the first built-in scenario (a cached result if one exists)
  useEffect(() => {
    if (!world || !scenarios?.length) return;
    void selectScenario(scenarios[0].id as string);
  }, [world, scenarios]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

export function App() {
  return (
    <EngineProvider>
      <div className={styles.app}>
        <TopBar />
        <div className={styles.main}>
          <Viewport />
          <SidePanel />
        </div>
        <PlaybackBar />
      </div>
      <Controllers />
    </EngineProvider>
  );
}
