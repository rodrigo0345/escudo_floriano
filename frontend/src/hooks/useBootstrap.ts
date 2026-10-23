import { useEffect } from 'react';

import { capabilitiesApi, locationsApi } from '@/api';
import { useAppStore } from '@/store/appStore';
import { loadLocationData } from '@/usecases/loadLocation';

const OFFERED_LOCATIONS = ['guimaraes-concelho'];

/** Loads the location catalog and the chosen location's static map data once, at startup (location chosen by `?loc=`). */
export function useBootstrap(): void {
  useEffect(() => {
    let cancelled = false;
    const { setCatalog, setLocationData, setBootError, setCapabilities } = useAppStore.getState();

    (async () => {
      try {
        // non-fatal: an older backend may not implement /capabilities yet
        capabilitiesApi.get().then((c) => !cancelled && setCapabilities(c)).catch(() => undefined);

        const all = await locationsApi.list();
        // the operator works on the whole concelho: other locations the backend holds (the Penha pilot) are not offered; a backend without it shows them all
        const offered = all.filter((l) => OFFERED_LOCATIONS.includes(l.id as string));
        const locations = offered.length ? offered : all;
        if (!locations.length) throw new Error('Sem locais configurados no backend.');
        const wanted = new URLSearchParams(window.location.search).get('loc');
        const chosen = locations.find((l) => l.id === wanted) ?? locations[0];
        setCatalog(locations, chosen.id as string);
        const data = await loadLocationData(chosen.id as string);
        if (!cancelled) setLocationData(data);
      } catch (e) {
        if (!cancelled) setBootError((e as Error).message);
        console.error(e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}
