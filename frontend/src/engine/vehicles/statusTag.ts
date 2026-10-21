import * as THREE from 'three';

/** What a unit is doing, for its tag: one of a small set of activities, each with its own icon and colour so the map reads at a glance. */
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
  | 'out_of_service';

const ACTIVITY: Record<Activity, { icon: string; text: string; color: string }> = {
  parked: { icon: '🏠', text: 'No quartel', color: '#9aa4ae' },
  ordered: { icon: '📟', text: 'Ordem recebida', color: '#ffd166' },
  en_route: { icon: '🚨', text: 'A caminho', color: '#4cc3ff' },
  attacking: { icon: '🔥', text: 'Em combate', color: '#ff6b3d' },
  air_drop: { icon: '💧', text: 'Largada de água', color: '#5ab8ff' },
  traffic: { icon: '🚧', text: 'Controlo de trânsito', color: '#ffd166' },
  medical: { icon: '✚', text: 'Assistência médica', color: '#ff5d73' },
  command: { icon: '📡', text: 'Posto de comando', color: '#c39bff' },
  to_water: { icon: '💧', text: 'A caminho da água', color: '#5ab8ff' },
  filling: { icon: '🚰', text: 'A carregar água', color: '#5ab8ff' },
  returning: { icon: '↩', text: 'A regressar', color: '#9aa4ae' },
  refueling: { icon: '⛽', text: 'A abastecer', color: '#ffd166' },
  out_of_service: { icon: '⛔', text: 'Fora de serviço', color: '#7a838c' },
};

export interface TagState {
  callsign: string;
  org: string;
  orgColor: string;
  activity: Activity;
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

/**
 * The floating tag over a unit: callsign and organization, what it is doing now (icon + words, coloured by activity), crew, water and fuel, and casualties in red.
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
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 28px system-ui, sans-serif';
      ctx.fillText(state.callsign, 28, 33);
      const cw = ctx.measureText(state.callsign).width;
      ctx.fillStyle = a.color;
      ctx.font = '600 26px system-ui, "Segoe UI Emoji", sans-serif';
      ctx.fillText(`  ${a.icon} ${a.text}`, 28 + cw, 33);
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

    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 30px system-ui, sans-serif';
    ctx.fillText(state.callsign, 32, 30);
    const cw = ctx.measureText(state.callsign).width;
    ctx.fillStyle = '#a9b4bf';
    ctx.font = '500 24px system-ui, sans-serif';
    ctx.fillText(` · ${state.org}${state.people ? ` · ${state.people}` : ''}`, 32 + cw, 31);

    ctx.fillStyle = a.color;
    ctx.font = '700 30px system-ui, "Segoe UI Emoji", sans-serif';
    const line = `${a.icon} ${a.text}${state.detail ? ` · ${state.detail}` : ''}`;
    ctx.fillText(line.length > 34 ? `${line.slice(0, 33)}…` : line, 32, 72);

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
      ctx.fillStyle = '#ff4d4d';
      ctx.font = '800 20px system-ui, sans-serif';
      ctx.fillText(`⚠ ${state.casualties} baixa${state.casualties > 1 ? 's' : ''}`, x, 104);
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.sprite.material.dispose();
  }
}
