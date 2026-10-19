import type { PlaceAccessTimeline, RoadStatusTimeline } from '@/api';

interface Quantiles {
  p10?: number;
  p50?: number;
  p90?: number;
}

/** P(X <= t) from the p10/p50/p90 quantiles of an instant (linear interpolation between them). */
function cdfFromQuantiles(q: Quantiles | undefined): (t: number) => number {
  const p10 = q?.p10;
  const p50 = q?.p50;
  const p90 = q?.p90;
  if (p50 == null) return () => 0;
  return (t) => {
    if (t < (p10 ?? p50)) return 0;
    if (t >= (p90 ?? p50)) return 1;
    if (t < p50) return p10 == null || p50 === p10 ? 0.5 : 0.1 + (0.4 * (t - p10)) / (p50 - p10);
    return p90 == null || p90 === p50 ? 1 : 0.5 + (0.4 * (t - p50)) / (p90 - p50);
  };
}

export interface ImpactState {
  /** Layer indexes of roads cut (the ensemble median cuts them) at this minute. */
  cut: number[];
  /** `[roadIndex, probabilityPct]` for every road with a non-zero cut probability. */
  prob: [number, number][];
  /** Minutes for the fastest rescue vehicle to reach each place (aligned with `Impact.places`); `null` = isolated. */
  access: (number | null)[];
  isolatedPct: number[];
  /** Aligned with the place *layer* order, for painting the map. */
  layerStatus: ('ok' | 'slow' | 'cut')[];
  layerIsolated: number[];
}

interface RoadEntry {
  index: number;
  probability: number;
  cut: (t: number) => number;
  reopen: (t: number) => number;
}

type PlaceEntry = PlaceAccessTimeline['places'][number] & { index: number };

/** The simulation's effect on roads and places, minute by minute, derived from `road-status` and `place-access`. */
export class Impact {
  private readonly stepMin: number;
  private readonly times: number[];
  private readonly roads: RoadEntry[];
  readonly places: PlaceEntry[];
  private readonly placeCount: number;
  private readonly cache = new Map<number, ImpactState>();

  /**
   * @param roadIndex road id → index in the road layer
   * @param placeIndex place id → index in the place layer
   */
  constructor(roadStatus: RoadStatusTimeline, access: PlaceAccessTimeline, roadIndex: Map<string, number>, placeIndex: Map<string, number>) {
    this.stepMin = access.stepMin;
    this.times = access.times;
    this.roads = roadStatus.roads
      .filter((r) => roadIndex.has(r.roadId))
      .map((r) => ({
        index: roadIndex.get(r.roadId) as number,
        probability: r.cutProbability,
        cut: cdfFromQuantiles(r.cutAtMinute),
        reopen: cdfFromQuantiles(r.reopenAtMinute),
      }));
    this.places = access.places
      .filter((p) => placeIndex.has(p.placeId))
      .map((p) => ({ ...p, index: placeIndex.get(p.placeId) as number }));
    this.placeCount = placeIndex.size;
  }

  private roadsAt(t: number): Pick<ImpactState, 'cut' | 'prob'> {
    const cut: number[] = [];
    const prob: [number, number][] = [];
    for (const r of this.roads) {
      const p = r.probability * Math.max(0, r.cut(t) - r.reopen(t));
      if (p >= 0.5) cut.push(r.index);
      if (p > 0) prob.push([r.index, Math.round(p * 100)]);
    }
    return { cut, prob };
  }

  /** Full state at minute `t` (cached: the panel asks for it several times a second). */
  at(t: number): ImpactState {
    const k = Math.max(0, Math.min(Math.floor(t / this.stepMin), this.times.length - 1));
    let state = this.cache.get(k);
    if (!state) {
      const roads = this.roadsAt(k * this.stepMin);
      const layerStatus: ImpactState['layerStatus'] = Array(this.placeCount).fill('ok');
      const layerIsolated: number[] = Array(this.placeCount).fill(0);
      this.places.forEach((p) => {
        layerStatus[p.index] = p.status[k];
        layerIsolated[p.index] = p.isolatedProbability[k];
      });
      state = {
        ...roads,
        access: this.places.map((p) => p.accessMinutes[k]),
        isolatedPct: this.places.map((p) => Math.round(p.isolatedProbability[k] * 100)),
        layerStatus,
        layerIsolated,
      };
      this.cache.set(k, state);
    }
    return state;
  }

  /** Access time with no fire (the first instant), per place. */
  get baseline(): (number | null)[] {
    return this.places.map((p) => p.accessMinutes[0]);
  }
}
