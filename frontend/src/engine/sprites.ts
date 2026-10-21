import * as THREE from 'three';

/**
 * Shared canvas → sprite helpers used by the facility, place, fire-milestone and water-point layers. Labels and badges keep a constant size on screen
 * (`sizeAttenuation: false`): readable from far away, and never a giant board in front of the camera close up. Scales are in screen units (≈ 1.2 × viewport height).
 */
const LABEL_HEIGHT = 0.02;
const BADGE_SIZE = 0.022;

export interface TextSpriteOptions {
  color?: string;
  bg?: string;
  size?: number;
  maxWidth?: number;
}

/** A rounded label sprite with text drawn on a canvas texture (facility names, milestone labels, ignition label). */
export function textSprite(text: string, options: TextSpriteOptions = {}): THREE.Sprite {
  const { color = '#fff', bg = 'rgba(0,0,0,.65)', size = 28, maxWidth = 360 } = options;
  const measure = document.createElement('canvas');
  const measureCtx = measure.getContext('2d')!;
  measureCtx.font = `600 ${size}px system-ui`;
  const textWidth = Math.min(measureCtx.measureText(text).width + 28, maxWidth);

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(textWidth);
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = `600 ${size}px system-ui`;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(0, 6, textWidth, 52, 14);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 14, 33);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
  sprite.scale.set((textWidth / 64) * LABEL_HEIGHT, LABEL_HEIGHT, 1);
  sprite.renderOrder = 20;
  return sprite;
}

/** A square code badge (one to three letters on a colored plate) for facilities and vehicles: legible at a glance, no pictograms. */
export function badgeSprite(code: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(8, 8, 112, 112, 12);
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#0b0e12';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${code.length > 2 ? 44 : 58}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(code, 64, 68);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
  sprite.scale.set(BADGE_SIZE, BADGE_SIZE, 1);
  sprite.renderOrder = 21;
  return sprite;
}

/** A round glyph badge for water-point markers, rendered as a `THREE.Points` texture (cheap at thousands of points). */
export function pointBadgeTexture(glyph: string, color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(32, 32, 28, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = '700 32px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, 32, 35);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
