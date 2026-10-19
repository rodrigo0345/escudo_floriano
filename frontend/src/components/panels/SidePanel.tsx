import { useAppStore } from '@/store/appStore';

import { DemoPanel } from '@/components/demo/DemoPanel';
import { AssetsPanel } from './AssetsPanel';
import { IncidentPanel } from './IncidentPanel';
import { RoadsPanel } from './RoadsPanel';
import { WeatherPanel } from './WeatherPanel';
import styles from './panels.module.css';

/** The right-hand column: renders whichever tab is active. */
export function SidePanel() {
  const tab = useAppStore((s) => s.tab);
  return (
    <aside className={styles.panel}>
      {tab === 'incident' ? <IncidentPanel /> : null}
      {tab === 'roads' ? <RoadsPanel /> : null}
      {tab === 'assets' ? <AssetsPanel /> : null}
      {tab === 'weather' ? <WeatherPanel /> : null}
      {tab === 'demo' ? <DemoPanel /> : null}
    </aside>
  );
}
