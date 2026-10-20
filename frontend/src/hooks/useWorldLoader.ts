import { useEffect } from 'react';

import { useEngineContext } from '@/engine/EngineContext';
import { World } from '@/engine/world';
import { useAppStore } from '@/store/appStore';

/** Builds the GPU `World` (terrain, layers, smoke) once both the engine and the location data exist, and tears it down on change/unmount. */
export function useWorldLoader(): void {
  const { engine, setWorld } = useEngineContext();
  const data = useAppStore((s) => s.data);

  useEffect(() => {
    if (!engine || !data) return;
    const world = new World(engine, {
      location: data.location,
      geo: data.geo,
      vegetation: data.vegetation,
      roads: data.roads,
      facilities: data.facilities,
      places: data.places,
      waterPoints: data.waterPoints,
    });
    const { setHint, baseLayer } = useAppStore.getState();
    setHint('A carregar a ortofoto…');
    world.terrain.ready.then(() => setHint('')).catch((e: Error) => setHint(`Imagem: ${e.message}`));
    void world.terrain.setLayer(baseLayer);
    const center = data.location.weatherPoint ?? data.location.center;
    const initial = [{ position: { lat: center.lat, lon: center.lon }, label: 'Foco 1' }];
    world.fire.setIgnitions(initial);
    world.focusOnLatLon(center.lat, center.lon);
    useAppStore.getState().setIgnitions(initial);
    setWorld(world);
    return () => {
      setWorld(null);
      world.dispose();
    };
  }, [engine, data, setWorld]);
}
