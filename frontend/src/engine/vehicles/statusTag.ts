import * as THREE from 'three';

import { getOrgLogo } from '@/domain/organizationLogos';
import { drawVehicleIconOnCanvas } from '@/domain/vehicleIcons';

/** What a unit is doing, for its tag: one of a small set of activities, each with its own colour so the map reads at a glance. */
export type Activity =
  | 'parked'
  | 'ordered'
  | 'en_route'
  | 'attacking'
  | 'air_drop'
  | 'traffic'
  | 'medical'
  | 'command'
  | 'to_water'
  | 'filling'
  | 'returning'
  | 'refueling'
  | 'resting'
  | 'grounded'
  | 'out_of_service';

const ACTIVITY: Record<Activity, { text: string; color: string }> = {
  parked: { text: 'No quartel', color: '#9aa4ae' },
  ordered: { text: 'Ordem recebida', color: '#ffd166' },
  en_route: { text: 'A caminho', color: '#4cc3ff' },
  attacking: { text: 'Em combate', color: '#ff6b3d' },
  air_drop: { text: 'Largada de água', color: '#5ab8ff' },
  traffic: { text: 'Controlo de trânsito', color: '#ffd166' },
  medical: { text: 'Assistência médica', color: '#ff5d73' },
  command: { text: 'Posto de comando', color: '#c39bff' },
  to_water: { text: 'A caminho da água', color: '#5ab8ff' },
  filling: { text: 'A carregar água', color: '#5ab8ff' },
  returning: { text: 'A regressar', color: '#9aa4ae' },
  refueling: { text: 'A abastecer', color: '#ffd166' },
  resting: { text: 'Equipa a descansar', color: '#9aa4ae' },
  grounded: { text: 'Em terra (vento, fumo ou noite)', color: '#ffb347' },
  out_of_service: { text: 'Fora de serviço', color: '#7a838c' },
};

/** The colour of an activity (the badge's dot on the map uses it too). */
export const activityColor = (activity: Activity): string => ACTIVITY[activity].color;

/** The activity's status dot (in place of an icon), centred at (x, y). */
function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

export interface TagState {
  callsign: string;
  org: string;
  orgColor: string;
  activity: Activity;
  vehicleType?: string;
  /** Free detail after the activity (e.g. the target's name). */
  detail?: string;
  /** 0..1, or undefined when the unit carries none. */
  water?: number;
  fuel?: number;
  people?: string;
  casualties?: number;
}

const W = 560;
const H = 150;
const TAG_LOGO_CACHE = new Map<string, HTMLImageElement>();

/**
 * The floating tag over a unit: callsign and organization, what it is doing now (status dot + words, coloured by activity), crew, water and fuel, and casualties in red.
 * It keeps the same size on screen at any zoom and is only redrawn when its content changes.
 */
export class StatusTag {
  readonly sprite: THREE.Sprite;
  private readonly canvas = document.createElement('canvas');
  private readonly texture: THREE.CanvasTexture;
  private key = '';

  /** Compact = one line (callsign + activity), smaller: for parked vehicles, so a full yard stays readable. */
  private compact = false;

  setCompact(on: boolean): void {
    if (on === this.compact) return;
    this.compact = on;
    this.key = '';
    const width = on ? 0.13 : 0.2;
    this.sprite.scale.set(width, on ? (width * 64) / W : (width * H) / W, 1);
  }

  constructor(alwaysOnTop: boolean) {
    this.canvas.width = W;
    this.canvas.height = H;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthTest: !alwaysOnTop, sizeAttenuation: false }));
    this.sprite.center.set(0.5, 0);
    this.sprite.scale.set(0.2, (0.2 * H) / W, 1);
    this.sprite.renderOrder = alwaysOnTop ? 30 : 25;
  }

  set(state: TagState): void {
    const key = JSON.stringify(state);
    if (key === this.key) return;
    this.key = key;
    const a = ACTIVITY[state.activity];
    const ctx = this.canvas.getContext('2d')!;
    if (this.compact) {
      this.canvas.height = 64;
      ctx.clearRect(0, 0, W, 64);
      ctx.fillStyle = 'rgba(10, 14, 19, 0.82)';
      ctx.beginPath();
      ctx.roundRect(4, 4, W - 8, 56, 12);
      ctx.fill();
      ctx.fillStyle = state.orgColor;
      ctx.beginPath();
      ctx.roundRect(4, 4, 12, 56, [12, 0, 0, 12]);
      ctx.fill();

      let textX = 26;
      if (state.vehicleType) {
        drawVehicleIconOnCanvas(ctx, state.vehicleType, 24, 18, 28, '#ffffff');
        textX = 58;
      }

      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 28px system-ui, sans-serif';
      ctx.fillText(state.callsign, textX, 33);
      const cw = ctx.measureText(state.callsign).width;
      dot(ctx, textX + cw + 18, 33, 7, a.color);
      ctx.fillStyle = a.color;
      ctx.font = '600 26px system-ui, sans-serif';
      ctx.fillText(a.text, textX + cw + 32, 33);

      const logoUrl = getOrgLogo(state.org);
      if (logoUrl) {
        const cached = TAG_LOGO_CACHE.get(logoUrl);
        if (cached && cached.complete) {
          ctx.drawImage(cached, W - 52, 12, 40, 40);
        } else if (!cached) {
          const img = new Image();
          img.src = logoUrl;
          img.onload = () => {
            TAG_LOGO_CACHE.set(logoUrl, img);
            this.key = '';
          };
        }
      }

      this.texture.needsUpdate = true;
      return;
    }
    if (this.canvas.height !== H) this.canvas.height = H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(10, 14, 19, 0.86)';
    ctx.beginPath();
    ctx.roundRect(4, 4, W - 8, H - 30, 14);
    ctx.fill();
    // pointer down to the vehicle
    ctx.beginPath();
    ctx.moveTo(W / 2 - 14, H - 27);
    ctx.lineTo(W / 2 + 14, H - 27);
    ctx.lineTo(W / 2, H - 4);
    ctx.fill();
    ctx.fillStyle = state.orgColor;
    ctx.beginPath();
    ctx.roundRect(4, 4, 14, H - 30, [14, 0, 0, 14]);
    ctx.fill();

    let textX = 32;
    if (state.vehicleType) {
      drawVehicleIconOnCanvas(ctx, state.vehicleType, 28, 14, 32, '#ffffff');
      textX = 66;
    }

    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 30px system-ui, sans-serif';
    ctx.fillText(state.callsign, textX, 30);
    const cw = ctx.measureText(state.callsign).width;
    ctx.fillStyle = '#a9b4bf';
    ctx.font = '500 24px system-ui, sans-serif';
    ctx.fillText(` · ${state.org}${state.people ? ` · ${state.people}` : ''}`, textX + cw, 31);

    const logoUrl = getOrgLogo(state.org);
    if (logoUrl) {
      const cached = TAG_LOGO_CACHE.get(logoUrl);
      if (cached && cached.complete) {
        ctx.drawImage(cached, W - 60, 14, 44, 44);
      } else if (!cached) {
        const img = new Image();
        img.src = logoUrl;
        img.onload = () => {
          TAG_LOGO_CACHE.set(logoUrl, img);
          this.key = '';
        };
      }
    }

    dot(ctx, 41, 72, 9, a.color);
    ctx.fillStyle = a.color;
    ctx.font = '700 30px system-ui, sans-serif';
    const line = `${a.text}${state.detail ? ` · ${state.detail}` : ''}`;
    ctx.fillText(line.length > 32 ? `${line.slice(0, 31)}…` : line, 60, 72);

    let x = 32;
    const bar = (value: number, color: string, label: string) => {
      ctx.fillStyle = '#a9b4bf';
      ctx.font = '600 18px system-ui, sans-serif';
      ctx.fillText(label, x, 104);
      x += ctx.measureText(label).width + 6;
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(x, 98, 90, 12);
      ctx.fillStyle = color;
      ctx.fillRect(x, 98, 90 * Math.max(0, Math.min(1, value)), 12);
      x += 104;
    };
    if (state.water !== undefined) bar(state.water, '#3fa9ff', 'água');
    if (state.fuel !== undefined) bar(state.fuel, state.fuel < 0.25 ? '#ff5d5d' : '#f0b429', 'comb.');
    if (state.casualties) {
      // a red pill: "N baixas"
      const text = `${state.casualties} baixa${state.casualties > 1 ? 's' : ''}`;
      ctx.font = '800 18px system-ui, sans-serif';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = '#d4504c';
      ctx.beginPath();
      ctx.roundRect(x, 92, tw + 18, 24, 12);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, x + 9, 105);
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.sprite.material.dispose();
  }
}
