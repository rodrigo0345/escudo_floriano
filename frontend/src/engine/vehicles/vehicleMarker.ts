import * as THREE from 'three';

import { getOrgLogo } from '@/domain/organizationLogos';
import { ORG_COLOR } from '@/domain/resourceLabels';
import { drawVehicleIconOnCanvas } from '@/domain/vehicleIcons';

const MARKER_LOGO_CACHE = new Map<string, HTMLImageElement>();

const CW = 210;
const CH = 92;
/** Where the callsign starts inside the badge (after logo and type icon); the badge widens from here. */
const CALLSIGN_X = 118;
/** On-screen width of the narrowest badge, as a share of the viewport height (sizeAttenuation is off). */
const SCREEN_WIDTH = 0.075;

/**
 * Overhead marker sprite for each vehicle on the map.
 * Replaces the generic Sims plumbob with a dual-identifier badge:
 * 1. Official Organization crest/logo & color (Bombeiros, GNR, INEM, ANEPC)
 * 2. Vector Vehicle Type icon (truck, tanker, ambulance, patrol car, helicopter, SUV, etc.) + Callsign
 * Uses sizeAttenuation: false for constant comfortable screen dimension at all zooms.
 */
export class VehicleMarker {
  readonly sprite: THREE.Sprite;
  private readonly canvas = document.createElement('canvas');
  private readonly texture: THREE.CanvasTexture;
  private key = '';
  private baseHeightM: number;
  private unit: number;
  private scaleFactor: number;

  constructor(
    private readonly vehicleType: string,
    private readonly orgType: string,
    private readonly callsign: string,
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

    this.sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.texture,
        transparent: true,
        depthTest: false,
        sizeAttenuation: false,
      }),
    );
    // Anchor at bottom tip of pointer pin
    this.sprite.center.set(0.5, 0.0);
    this.sprite.scale.set(SCREEN_WIDTH, (SCREEN_WIDTH * CH) / CW, 1);
    this.sprite.renderOrder = 26;

    this.draw(false);
  }

  setOwnerActor(actor: unknown): void {
    this.sprite.userData.actor = actor;
  }

  /**
   * Places the marker directly above the vehicle roof/rotor.
   */
  updatePosition(vehiclePos: THREE.Vector3): void {
    const y = vehiclePos.y + ((this.baseHeightM * this.scaleFactor) + 2.2) / this.unit;
    this.sprite.position.set(vehiclePos.x, y, vehiclePos.z);
  }

  draw(isHovered: boolean): void {
    const orgColor = ORG_COLOR[this.orgType] ?? '#38c172';
    const logoUrl = getOrgLogo(this.orgType);
    const key = `${this.vehicleType}:${this.orgType}:${this.callsign}:${isHovered}:${logoUrl}`;
    if (key === this.key) return;
    this.key = key;

    const ctx = this.canvas.getContext('2d')!;
    // The badge always fits the whole callsign ("GNR-BT 171", never "GNR-BT…"): the map is read at a glance, and a truncated
    // identifier makes two vehicles indistinguishable. The pill widens from the callsign's start; the pin stays centred.
    const callsign = this.callsign;
    ctx.font = '700 21px system-ui, sans-serif';
    const badgeWidth = Math.max(CW, CALLSIGN_X + Math.ceil(ctx.measureText(callsign).width) + 12);
    if (this.canvas.width !== badgeWidth) this.canvas.width = badgeWidth;
    this.sprite.scale.x = (SCREEN_WIDTH * badgeWidth) / CW;
    const W = badgeWidth;

    ctx.clearRect(0, 0, W, CH);

    // Drop shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = isHovered ? 12 : 8;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 3;

    // Outer rounded badge
    ctx.fillStyle = isHovered ? 'rgba(16, 22, 30, 0.95)' : 'rgba(10, 14, 20, 0.88)';
    ctx.beginPath();
    ctx.roundRect(4, 4, W - 8, CH - 22, 16);
    ctx.fill();

    // Border with organization color
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = orgColor;
    ctx.lineWidth = isHovered ? 4 : 2.5;
    ctx.stroke();

    // Pointer pin at bottom center
    ctx.fillStyle = isHovered ? orgColor : 'rgba(10, 14, 20, 0.9)';
    ctx.beginPath();
    ctx.moveTo(W / 2 - 10, CH - 22);
    ctx.lineTo(W / 2 + 10, CH - 22);
    ctx.lineTo(W / 2, CH - 6);
    ctx.closePath();
    ctx.fill();

    if (!isHovered) {
      ctx.strokeStyle = orgColor;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(W / 2 - 10, CH - 22);
      ctx.lineTo(W / 2, CH - 6);
      ctx.lineTo(W / 2 + 10, CH - 22);
      ctx.stroke();
    }

    // 1. Organization Logo on the left
    let logoDrawn = false;
    if (logoUrl) {
      const cached = MARKER_LOGO_CACHE.get(logoUrl);
      if (cached && cached.complete && cached.naturalWidth > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(10, 10, 48, 48, 10);
        ctx.clip();
        ctx.drawImage(cached, 10, 10, 48, 48);
        ctx.restore();
        logoDrawn = true;
      } else if (!cached) {
        const img = new Image();
        img.src = logoUrl;
        img.onload = () => {
          MARKER_LOGO_CACHE.set(logoUrl, img);
          this.key = '';
          this.draw(isHovered);
        };
      }
    }

    if (!logoDrawn) {
      // Fallback colored crest badge with org initials
      ctx.fillStyle = orgColor;
      ctx.beginPath();
      ctx.roundRect(10, 10, 48, 48, 10);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 20px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const initials = (this.orgType === 'fire_brigade' ? 'CB' : this.orgType.slice(0, 3)).toUpperCase();
      ctx.fillText(initials, 34, 34);
    }

    // Vertical separator
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(66, 12);
    ctx.lineTo(66, 56);
    ctx.stroke();

    // 2. Vector Vehicle Type Icon
    drawVehicleIconOnCanvas(ctx, this.vehicleType, 74, 15, 38, '#ffffff');

    // 3. Callsign text
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 21px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(callsign, CALLSIGN_X, 34);

    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.sprite.material.dispose();
  }
}
