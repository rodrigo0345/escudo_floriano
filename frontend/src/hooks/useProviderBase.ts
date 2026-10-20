import { useEffect, useMemo, useState } from 'react';

import { weatherApi } from '@/api';
import { formStartToIso } from '@/domain/simulationForm';
import { weatherBaseAtStart, weatherMeans, type WeatherBaseStats } from '@/domain/weather';
import type { RunData } from '@/store/types';

interface BaseState {
  key: string | null;
  base: WeatherBaseStats | null;
  loading: boolean;
  fallback: boolean;
  error: string | null;
}

const cache = new Map<string, WeatherBaseStats>();

/**
 * Provider-only weather base for the chosen location and window. The result is keyed by
 * location + start + duration (not by run id), so changing the window always refetches.
 * If the provider is unavailable, falls back to the effective run series and flags it.
 */
export function useProviderBase(
  run: RunData | null,
  locationId: string | null,
  start: string,
  durationMinutes: number,
): BaseState {
  const runWeather = run?.weather;
  const fallback = useMemo(() => weatherMeans(runWeather ?? []), [runWeather]);
  const [state, setState] = useState<BaseState>(() => ({
    key: null,
    base: null,
    loading: false,
    fallback: false,
    error: null,
  }));

  useEffect(() => {
    if (!locationId) {
      setState({ key: null, base: null, loading: false, fallback: false, error: null });
      return;
    }

    const key = `${locationId}|${start}|${durationMinutes}`;
    const cached = cache.get(key);
    if (cached) {
      setState({ key, base: cached, loading: false, fallback: false, error: null });
      return;
    }

    let startIso: string;
    try {
      startIso = formStartToIso(start);
    } catch {
      setState({ key, base: fallback, loading: false, fallback: true, error: 'Data de início inválida.' });
      return;
    }

    let cancelled = false;
    setState({ key, base: null, loading: true, fallback: false, error: null });

    weatherApi
      .resolve({
        locationId,
        start: startIso,
        durationMinutes,
        weather: { base: 'provider' },
      })
      .then((response) => {
        if (cancelled) return;
        const base = weatherBaseAtStart(response.samples ?? []);
        if (!base) {
          setState({ key, base: fallback, loading: false, fallback: true, error: 'Sem amostras meteorológicas do provedor.' });
          return;
        }
        cache.set(key, base);
        setState({ key, base, loading: false, fallback: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          key,
          base: fallback,
          loading: false,
          fallback: true,
          error: error instanceof Error ? error.message : 'Não foi possível obter a meteorologia do provedor.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [locationId, start, durationMinutes, fallback]);

  return state;
}
