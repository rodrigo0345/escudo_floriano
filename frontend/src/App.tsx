import { useEffect } from 'react';

import { GuidedTour } from '@/components/layout/GuidedTour';
import { KeyboardShortcuts } from '@/components/layout/KeyboardShortcuts';
import { PlaybackBar } from '@/components/layout/PlaybackBar';
import { TopBar } from '@/components/layout/TopBar';
import { WelcomeDialog } from '@/components/layout/WelcomeDialog';
import styles from '@/components/layout/layout.module.css';
import { ResourcesView } from '@/components/resources/ResourcesView';
import { SidePanel } from '@/components/panels/SidePanel';
import { Viewport } from '@/components/viewport/Viewport';
import { EngineProvider, useWorld } from '@/engine/EngineContext';
import { usePeopleSync } from '@/hooks/usePeopleSync';
import { useUnitsSync } from '@/hooks/useUnitsSync';
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
  const { selectScenario, showSimulationById } = useSimulationActions();

  useBootstrap();
  useWorldLoader();
  useFrameLoop();
  useWorldSync();
  useUnitsSync();
  usePeopleSync();

  // once the map is up, show the simulation named by `?sim=<id>` (a baseline or a plan's what-if), else the first built-in scenario
  useEffect(() => {
    if (!world || !scenarios?.length) return;
    const wanted = new URLSearchParams(window.location.search).get('sim');
    if (wanted) void showSimulationById(wanted);
    else void selectScenario(scenarios[0].id as string);
  }, [world, scenarios]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

function Workspace() {
  const tab = useAppStore((s) => s.tab);
  if (tab === 'resources') return <ResourcesView />;
  return null;
}

export function App() {
  const cleanView = useAppStore((s) => s.cleanView);
  return (
    <EngineProvider>
      <div className={`${styles.app} ${cleanView ? styles.cleanView : ''}`}>
        <TopBar />
        <div className={styles.main}>
          <Viewport />
          <SidePanel />
          <Workspace />
        </div>
        <PlaybackBar />
      </div>
      <Controllers />
      <KeyboardShortcuts />
      <WelcomeDialog />
      <GuidedTour />
    </EngineProvider>
  );
}
