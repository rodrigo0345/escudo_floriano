import * as THREE from 'three';

import { getOrgLogo } from '@/domain/organizationLogos';
import { ORG_COLOR } from '@/domain/resourceLabels';

const MARKER_LOGO_CACHE = new Map<string, HTMLImageElement>();

const CW = 72;
const CH = 84;
const LOGO_R = 27;

/**
 * Overhead marker of a vehicle on the map: just its organization's crest in a round badge ringed with the organization's colour (and a small dot for what it is
 * doing). Everything else about the vehicle (callsign, type, water, crew, activity) is in the detail tag that replaces the badge while the cursor is on it.
 * Constant screen size at every zoom (`sizeAttenuation: false`).
 */
export class VehicleMarker {
  readonly sprite: THREE.Sprite;
  private readonly canvas = document.createElement('canvas');
  private readonly texture: THREE.CanvasTexture;
  private key = '';
  private activity = '';
  private baseHeightM: number;
  private unit: number;
  private scaleFactor: number;

  constructor(
    private readonly _vehicleType: string,
    private readonly orgType: string,
    private readonly _callsign: string,
    heightM: number,
    unit: number,
    scaleFactor: number,
  ) {
    this.baseHeightM = heightM;
    this.unit = unit;
    this.scaleFactor = scaleFactor;

    this.canvas.width = CW;
    this.canvas.height = CH;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;

    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthTest: false, sizeAttenuation: false }));
    this.sprite.center.set(0.5, 0.0); // anchored at the pin's tip
    const screenWidth = 0.034;
    this.sprite.scale.set(screenWidth, (screenWidth * CH) / CW, 1);
    this.sprite.renderOrder = 26;

    this.draw(false);
  }

  setOwnerActor(actor: unknown): void {
    this.sprite.userData.actor = actor;
  }

  /** Places the marker directly above the vehicle roof/rotor. */
  updatePosition(vehiclePos: THREE.Vector3): void {
    const y = vehiclePos.y + (this.baseHeightM * this.scaleFactor + 2.2) / this.unit;
    this.sprite.position.set(vehiclePos.x, y, vehiclePos.z);
  }

  /** What the unit is doing, as a colour dot on the badge (`''`: none). */
  setActivityColor(color: string): void {
    if (color === this.activity) return;
    this.activity = color;
    this.key = '';
    this.draw(false);
  }

  /** The badge is hidden while the detail tag of the same vehicle is shown (the cursor is on the vehicle). */
  draw(isHovered: boolean): void {
    this.sprite.visible = !isHovered;
    const orgColor = ORG_COLOR[this.orgType] ?? '#38c172';
    const logoUrl = getOrgLogo(this.orgType);
    const key = `${this.orgType}:${logoUrl}:${this.activity}`;
    if (key === this.key) return;
    this.key = key;

    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, CW, CH);
    const cx = CW / 2;
    const cy = LOGO_R + 6;

    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = 'rgba(10, 14, 20, 0.92)';
    ctx.beginPath();
    ctx.arc(cx, cy, LOGO_R + 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    // pin
    ctx.fillStyle = orgColor;
    ctx.beginPath();
    ctx.moveTo(cx - 9, cy + LOGO_R);
    ctx.lineTo(cx + 9, cy + LOGO_R);
    ctx.lineTo(cx, CH - 3);
    ctx.closePath();
    ctx.fill();
    // ring
    ctx.strokeStyle = orgColor;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, LOGO_R + 1, 0, Math.PI * 2);
    ctx.stroke();

    // crest, clipped to the circle (the organization's initials when there is no crest)
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, LOGO_R - 3, 0, Math.PI * 2);
    ctx.clip();
    const cached = logoUrl ? MARKER_LOGO_CACHE.get(logoUrl) : undefined;
    if (cached && cached.complete && cached.naturalWidth > 0) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, CW, CH);
      ctx.drawImage(cached, cx - (LOGO_R - 3), cy - (LOGO_R - 3), (LOGO_R - 3) * 2, (LOGO_R - 3) * 2);
    } else {
      ctx.fillStyle = orgColor;
      ctx.fillRect(0, 0, CW, CH);
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 22px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((this.orgType === 'fire_brigade' ? 'CB' : this.orgType.slice(0, 3)).toUpperCase(), cx, cy + 1);
      if (logoUrl && !cached) {
        const img = new Image();
        img.src = logoUrl;
        img.onload = () => {
          MARKER_LOGO_CACHE.set(logoUrl, img);
          this.key = '';
          this.draw(false);
        };
      }
    }
    ctx.restore();

    if (this.activity) {
      ctx.fillStyle = this.activity;
      ctx.strokeStyle = 'rgba(10, 14, 20, 0.95)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx + LOGO_R - 4, cy - LOGO_R + 6, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.sprite.material.dispose();
  }
}
