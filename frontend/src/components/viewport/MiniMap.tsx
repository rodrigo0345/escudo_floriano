import { useEffect, useMemo, useRef, useState } from 'react';

import type { PlanAction } from '@/api';
import { actionWindows, phaseAt } from '@/domain/actionTiming';
import { lineStringCoordinates, polygonRings } from '@/domain/geojson';
import { useHouses } from '@/hooks/useHouses';
import { useEngine, useWorld } from '@/engine/EngineContext';
import { PLAN_KINDS } from '@/engine/layers/planLayer';
import { useAppStore } from '@/store/appStore';

import styles from './viewport.module.css';

type Size = 'hidden' | 'small' | 'large';
const SIZES: Record<Exclude<Size, 'hidden'>, number> = { small: 210, large: 440 };
const STORE_KEY = 'firetrace.miniMap.size';
const RES = 560; // the static layer is drawn once at this resolution and scaled to the shown size
const ZOOM_SHARE = 0.22; // the minimap shows this share of the location's width and height, centred on the camera (the camera's view box is drawn inside it)
const BURNING_MIN = 18;

function readSize(): Size {
  try {
    const v = window.localStorage.getItem(STORE_KEY);
    return v === 'hidden' || v === 'large' ? v : 'small';
  } catch {
    return 'small';
  }
}

/**
 * A map of the whole location in a corner of the screen, like a shooter's radar: **all** the roads and the houses (drawn once), the fire as it is at the playback
 * minute, what the plan is doing right now (crew zones, lines, drops, closures, checkpoints, evacuations), the vehicles, and where the camera is looking.
 * It can be hidden, small or large (remembered), and a click moves the camera there.
 */
export function MiniMap() {
  const world = useWorld();
  const engine = useEngine();
  const data = useAppStore((s) => s.data);
  const run = useAppStore((s) => s.run);
  const plan = useAppStore((s) => s.activePlan);
  const [size, setSize] = useState<Size>(readSize);
  const view = useRef<HTMLCanvasElement>(null);
  const base = useRef<HTMLCanvasElement | null>(null);
  const clock = useRef({ t: 0 });

  const geo = data?.geo;
  const houses = useHouses();
  const windows = useMemo(() => (plan ? actionWindows(plan) : null), [plan]);

  const remember = (next: Size) => {
    setSize(next);
    try {
      window.localStorage.setItem(STORE_KEY, next);
    } catch {
      /* not remembered */
    }
  };

  // the window of the location shown: centred on the camera, a fixed share of the map, so the square around the camera is what the minimap zooms into
  const view2d = useRef({ west: 0, north: 0, lonSpan: 1, latSpan: 1 });
  const zoomOnCamera = () => {
    if (!geo || !engine) return;
    const target = engine.controls.target;
    const [lat, lon] = geo.toLatLon(target.x, target.z);
    const lonSpan = (geo.dLon * geo.gridWidth) * ZOOM_SHARE;
    const latSpan = (geo.dLat * geo.gridHeight) * ZOOM_SHARE;
    view2d.current = { west: lon - lonSpan / 2, north: lat + latSpan / 2, lonSpan, latSpan };
  };
  const px = (lon: number, lat: number): [number, number] => {
    const w = view2d.current;
    return [((lon - w.west) / w.lonSpan) * RES, ((w.north - lat) / w.latSpan) * RES];
  };

  // the static layer: every road and every house
  useEffect(() => {
    if (!data || !geo) return;
    const canvas = base.current ?? document.createElement('canvas');
    base.current = canvas;
    canvas.width = canvas.height = RES;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#10161d';
    ctx.fillRect(0, 0, RES, RES);
    const major = new Set(['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link']);
    ctx.lineCap = 'round';
    for (const pass of [0, 1] as const) {
      ctx.strokeStyle = pass === 0 ? 'rgba(150,165,180,0.55)' : 'rgba(235,240,245,0.92)';
      ctx.lineWidth = pass === 0 ? 0.7 : 1.5;
      ctx.beginPath();
      for (const feature of data.roads.features) {
        const isMajor = major.has(String((feature.properties as { class?: string } | null)?.class ?? ''));
        if (isMajor !== (pass === 1)) continue;
        const pts = lineStringCoordinates(feature.geometry);
        if (pts.length < 2) continue;
        pts.forEach(([lon, lat], i) => {
          const [x, y] = px(lon, lat);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
      }
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(196,170,120,0.9)';
    for (const h of houses) {
      const [x, y] = px(h.lon, h.lat);
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }, [data, geo, houses]); // eslint-disable-line react-hooks/exhaustive-deps

  // the live layer, a few times a second
  useEffect(() => {
    if (size === 'hidden' || !geo || !world) return undefined;
    const draw = () => {
      const canvas = view.current;
      const layer = base.current;
      if (!canvas || !layer) return;
      const ctx = canvas.getContext('2d')!;
      const shown = canvas.width;
      zoomOnCamera();
      const w = view2d.current;
      const k = shown / RES;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      if (geo) {
        // the whole location is on the static layer: take the zoomed window out of it, scaled to the minimap
        const sx = ((w.west - geo.west) / (geo.dLon * geo.gridWidth)) * layer.width;
        const sy = ((geo.north - w.north) / (geo.dLat * geo.gridHeight)) * layer.height;
        const sw = (w.lonSpan / (geo.dLon * geo.gridWidth)) * layer.width;
        const sh = (w.latSpan / (geo.dLat * geo.gridHeight)) * layer.height;
        ctx.drawImage(layer, sx, sy, sw, sh, 0, 0, RES, RES);
      }
      const t = useAppStore.getState().t;
      clock.current.t = t;

      // the fire at this minute: burning cells bright, burned ground dark
      if (run) {
        const cell = RES / run.gridWidth;
        for (let i = 0; i < run.ign.length; i++) {
          const m = run.ign[i];
          if (m < 0 || m > t) continue;
          ctx.fillStyle = t - m < BURNING_MIN ? 'rgba(255,120,30,0.9)' : 'rgba(40,20,16,0.75)';
          ctx.fillRect((i % run.gridWidth) * cell, Math.floor(i / run.gridWidth) * cell, cell + 0.5, cell + 0.5);
        }
        ctx.fillStyle = 'rgba(255,60,60,0.95)';
        for (const h of houses) {
          if (h.cell >= 0 && run.ign[h.cell] >= 0 && run.ign[h.cell] <= t) {
            const [x, y] = px(h.lon, h.lat);
            ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
          }
        }
      }

      // what the plan is doing now
      if (plan && windows) {
        for (const action of plan.actions as PlanAction[]) {
          const w = windows.get(action.id as string);
          if (!w || (phaseAt(w, t) !== 'active' && phaseAt(w, t) !== 'en_route')) continue;
          drawAction(ctx, action, phaseAt(w, t) === 'active', px, data?.roads);
        }
      }

      // the vehicles
      for (const u of world.units.snapshot()) {
        const [x, y] = px(u.lon, u.lat);
        ctx.fillStyle = u.color;
        ctx.strokeStyle = '#0b0f14';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (u.air) {
          ctx.moveTo(x, y - 4);
          ctx.lineTo(x + 3.5, y + 3);
          ctx.lineTo(x - 3.5, y + 3);
          ctx.closePath();
        } else ctx.arc(x, y, 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      // where the camera is looking: a square at the centre of the minimap (the view), sized by how far the camera is from what it looks at
      if (engine) {
        const target = engine.controls.target;
        const [lat, lon] = geo.toLatLon(target.x, target.z);
        // the box is what the camera sees, as a share of the zoomed window (the window is centred on the camera target, so the box is in the middle)
        const share = Math.min(0.9, Math.max(0.12, (engine.camera.position.distanceTo(target) * geo.unit * 0.55) / (geo.dLon * geo.gridWidth * ZOOM_SHARE * 111_320 * Math.cos((lat * Math.PI) / 180))));
        const half = (share * RES) / 2;
        const [cx, cy] = px(lon, lat);
        const x0 = cx - half, y0 = cy - half, x1 = cx + half, y1 = cy + half;
        // px() gives the RES-space position; the transform set above scales it to the canvas
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 / k;
        ctx.setLineDash([6 / k, 4 / k]);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        ctx.setLineDash([]);
      }
    };
    draw();
    const timer = setInterval(draw, 250);
    return () => clearInterval(timer);
  }, [size, geo, world, engine, run, plan, windows, houses, data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!geo || !world) return null;
  if (size === 'hidden') {
    return (
      <button className={styles.miniChip} onClick={() => remember('small')} title="Mostrar o minimapa">
        Mapa
      </button>
    );
  }
  const shown = SIZES[size];
  const click = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;
    world.focusOnLatLon(geo.north - v * geo.dLat * geo.gridHeight, geo.west + u * geo.dLon * geo.gridWidth);
  };
  return (
    <div className={styles.mini} style={{ width: shown }}>
      <div className={styles.miniHead}>
        <b>Mapa</b>
        <small>{houses.length ? `${houses.length} povoados · ` : ''}{data?.roads.features.length ?? 0} estradas</small>
        <span>
          <button onClick={() => remember(size === 'large' ? 'small' : 'large')} title={size === 'large' ? 'Reduzir' : 'Aumentar'} aria-label={size === 'large' ? 'Reduzir o minimapa' : 'Aumentar o minimapa'}>
            {size === 'large' ? '⤡' : '⤢'}
          </button>
          <button onClick={() => remember('hidden')} title="Esconder" aria-label="Esconder o minimapa">
            –
          </button>
        </span>
      </div>
      <canvas ref={view} width={shown} height={shown} style={{ width: shown, height: shown }} onClick={click} />
    </div>
  );
}

type Px = (lon: number, lat: number) => [number, number];

/** One action of the plan on the minimap: its zone, line, closure, checkpoint or post, strong while it works and outlined while the unit is still on the road. */
function drawAction(ctx: CanvasRenderingContext2D, action: PlanAction, working: boolean, px: Px, roads: { features: { geometry: unknown; properties?: unknown }[] } | undefined): void {
  const a = action as unknown as Record<string, unknown> & { simulationEffects?: { type?: string; geometry?: Parameters<typeof lineStringCoordinates>[0] }[] };
  const alpha = working ? 0.95 : 0.45;
  const dot = (lat: number, lon: number, color: string, r = 3.2) => {
    const [x, y] = px(lon, lat);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.strokeStyle = '#0b0f14';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  const trace = (points: [number, number][], color: string, width: number, close = false, fill = false) => {
    if (points.length < 2) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    points.forEach(([lon, lat], i) => {
      const [x, y] = px(lon, lat);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (close) ctx.closePath();
    if (fill) {
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha * 0.3;
      ctx.fill();
      ctx.globalAlpha = alpha;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  const kindColor: Record<string, string> = {
    crew_deployment: PLAN_KINDS.crew_deployment.color,
    fire_line: PLAN_KINDS.fire_line.color,
    aerial_drop: PLAN_KINDS.aerial_drop.color,
    fuel_removal: PLAN_KINDS.fuel_break.color,
    structure_protection: PLAN_KINDS.structure_protection.color,
    evacuation: PLAN_KINDS.evacuation.color,
  };
  for (const effect of a.simulationEffects ?? []) {
    const color = kindColor[String(effect.type)] ?? '#ffffff';
    if (effect.geometry?.type === 'LineString') trace(lineStringCoordinates(effect.geometry) as [number, number][], color, 2.4);
    else for (const ring of polygonRings(effect.geometry)) trace(ring as [number, number][], color, 1.4, true, true);
  }
  const position = a.position as { lat: number; lon: number } | undefined;
  if (action.type === 'traffic_control_point' && position) dot(position.lat, position.lon, PLAN_KINDS.traffic_control.color, 3.6);
  if (action.type === 'road_closure') {
    for (const id of (a.roadIds as string[] | undefined) ?? []) {
      const road = roads?.features.find((f) => (f.properties as { id?: string } | null)?.id === id);
      if (road) trace(lineStringCoordinates(road.geometry as Parameters<typeof lineStringCoordinates>[0]) as [number, number][], '#ff3b3b', 2.6);
    }
  }
  if (action.type === 'evacuation') {
    const area = a.area as Parameters<typeof polygonRings>[0];
    for (const ring of polygonRings(area)) trace(ring as [number, number][], PLAN_KINDS.evacuation.color, 1.6, true, true);
  }
  if (action.type === 'medical_standby')
    for (const p of (a.positions as { position?: { lat: number; lon: number } }[] | undefined) ?? []) if (p.position) dot(p.position.lat, p.position.lon, PLAN_KINDS.support.color, 4);
  if (action.type === 'establish_command_post') {
    const at = (a.location as { position?: { lat: number; lon: number } } | undefined)?.position;
    if (at) dot(at.lat, at.lon, PLAN_KINDS.support.color, 4.4);
  }
}
