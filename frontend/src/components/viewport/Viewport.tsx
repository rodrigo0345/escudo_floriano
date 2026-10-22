import { useEffect, useRef } from 'react';

import { useMapPointer } from '@/hooks/useMapPointer';
import { useEngineContext } from '@/engine/EngineContext';
import { SceneEngine } from '@/engine/sceneEngine';
import { useAppStore } from '@/store/appStore';

import { Compass } from './Compass';
import { LayersPanel } from './LayersPanel';
import { Banner, Hint, LoadingOverlay } from './Overlays';
import { ScaleBar } from './ScaleBar';
import { MiniMap } from './MiniMap';
import { WeatherHud } from './WeatherHud';
import styles from './viewport.module.css';

/**
 * The map pane. It owns exactly one thing imperatively — the `SceneEngine` (WebGL canvas) —
 * created on mount and disposed on unmount; everything else on screen is a normal React overlay.
 */
export function Viewport() {
  const host = useRef<HTMLDivElement>(null);
  const { setEngine, world } = useEngineContext();
  const { tooltip, readout } = useMapPointer();

  useEffect(() => {
    if (!host.current) return;
    const created = new SceneEngine(host.current);
    created.start();
    setEngine(created);
    return () => {
      setEngine(null);
      created.dispose();
    };
  }, [setEngine]);

  const cityEnabled = useAppStore((s) => s.cityEnabled);
  const attribution = world
    ? `${cityEnabled && world.city.attribution ? `Cidade 3D: Google Maps · ${world.city.attribution} · ` : ''}Imagem: ${world.terrain.attribution || '—'} · Relevo: AWS Terrain Tiles · Espécies: ESA WorldCover 2021, Copernicus HRL, Sentinel-2 · Estradas/instalações: © OpenStreetMap · Meteo: Open-Meteo`
    : '';

  return (
    <div className={styles.view}>
      <div ref={host} className={styles.canvasHost} />
      <LayersPanel />
      <Compass />
      <WeatherHud />
      <MiniMap />
      <ScaleBar />
      <Hint />
      <Banner />
      <LoadingOverlay />
      {readout ? (
        <div className={styles.readout}>
          {Math.round(readout.elevationM)} m · inclinação {readout.slopeDeg.toFixed(0)}° · virada a {readout.aspect}
          <br />
          {readout.vegetation}
          <br />
          {readout.lat.toFixed(4)}°N {Math.abs(readout.lon).toFixed(4)}°O
        </div>
      ) : null}
      {tooltip ? (
        <div className={styles.tip} style={{ left: tooltip.x, top: tooltip.y }}>
          {tooltip.text}
        </div>
      ) : null}
      <div className={styles.attrib}>{attribution}</div>
    </div>
  );
}
