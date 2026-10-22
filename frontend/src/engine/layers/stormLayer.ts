import * as THREE from 'three';

/** 1 world unit = 10 m, the same scale as the terrain and the cloud layer. */
const PUFF_COUNT = 96;
/** The storm cell sits above the fair-weather deck (which tops out at 210), so the tactical camera is under its dark base rather
 * than inside the cloud. 1 unit = 10 m: base 2150 m, anvil 3000 m. */
const CLOUD_BASE_Y = 215;
const ANVIL_TOP_Y = 300;
/** Longest thunder delay we bother with: beyond ~8 km it is just a low roll under the cells. */
const MAX_THUNDER_DELAY_S = 6;

export interface StormCell {
  /** Centre of the cell on the ground plane (world units). */
  x: number;
  z: number;
  /** Radius of the base (world units). */
  radiusUnits: number;
  /** 0 = gone, 1 = mature cell. */
  intensity: number;
  /** Terrain height at the centre, so the outflow rings sit on the ground and not inside a hill. */
  groundY: number;
}

/**
 * A moving cumulonimbus cell (Epic E6): a dark, towering cloud column with a flat anvil, two cold-pool outflow rings spreading on the
 * ground, the lightning bolt that belongs to the flash the scene light is doing, and the thunder that follows it.
 *
 * The path itself is not invented here: the caller derives the centre from the storm event (and, once D3 exists, from its explicit
 * `path`). This layer only draws where it is told to be, so it can also be used by the offline storm-cell tests.
 */
export class StormLayer {
  readonly group = new THREE.Group();
  private readonly puffs: THREE.InstancedMesh;
  private readonly puffMaterial: THREE.MeshBasicMaterial;
  private readonly anvil: THREE.Mesh;
  private readonly anvilMaterial: THREE.MeshBasicMaterial;
  private readonly dummy = new THREE.Object3D();
  private readonly centres: Float32Array;
  private readonly sizes: Float32Array;
  private readonly phases: Float32Array;
  private readonly rings: THREE.Mesh[] = [];
  private readonly ringMaterial: THREE.MeshBasicMaterial[] = [];
  private readonly ringPhases = [0, 0.5];
  private readonly bolt: THREE.LineSegments;
  private readonly boltMaterial: THREE.LineBasicMaterial;
  private boltPoints = 14;
  private boltLife = 0;
  private boltCapacity = 0;
  private lastFlash = false;
  private active = false;
  private clock = 0;
  private thunder = new Thunder();
  private thunderEnabled = true;

  constructor() {
    const texture = stormTexture();
    this.puffMaterial = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    this.puffs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.puffMaterial, PUFF_COUNT);
    this.puffs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.puffs.frustumCulled = false;
    this.puffs.renderOrder = 23;
    this.group.add(this.puffs);

    // A flat anvil cap, separate from the billboard tower: from a top-down tactical camera the tower's puffs turn into a thin band,
    // and this wide, soft disc is what makes the top of the cumulonimbus read as an anvil instead.
    this.anvilMaterial = new THREE.MeshBasicMaterial({
      map: anvilTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      color: 0x2f3a4c,
    });
    this.anvil = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.anvilMaterial);
    this.anvil.rotation.x = -Math.PI / 2;
    this.anvil.renderOrder = 23;
    this.group.add(this.anvil);

    this.centres = new Float32Array(PUFF_COUNT * 3);
    this.sizes = new Float32Array(PUFF_COUNT * 2);
    this.phases = new Float32Array(PUFF_COUNT);
    this.placePuffs();

    const ringTexture = outflowTexture();
    for (let i = 0; i < 2; i++) {
      const material = new THREE.MeshBasicMaterial({
        map: ringTexture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false, // a gust front is read across the relief; a flat ring at one elevation would be buried by the next hill
        side: THREE.DoubleSide,
        color: 0xe6d8bd,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 21;
      this.rings.push(mesh);
      this.ringMaterial.push(material);
      this.group.add(mesh);
    }

    this.boltMaterial = new THREE.LineBasicMaterial({ color: 0xeef6ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.bolt = new THREE.LineSegments(new THREE.BufferGeometry(), this.boltMaterial);
    this.bolt.frustumCulled = false;
    this.bolt.renderOrder = 26;
    this.group.add(this.bolt);

    this.group.visible = false;
  }

  /** Deterministic, camera-independent structure: a wide base shelf, a leaning tower, and a flat anvil on top. */
  private placePuffs(): void {
    for (let i = 0; i < PUFF_COUNT; i++) {
      const r1 = rand(i * 3.17 + 1.1);
      const r2 = rand(i * 5.71 + 2.3);
      const r3 = rand(i * 9.13 + 0.7);
      const r4 = rand(i * 1.97 + 4.9);
      const tier = i / PUFF_COUNT;
      this.phases[i] = r4 * Math.PI * 2;

      if (tier < 0.34) {
        // base shelf: wide, low and ragged
        const angle = r1 * Math.PI * 2;
        const radius = Math.sqrt(r2) * 0.76;
        this.centres[i * 3] = Math.cos(angle) * radius;
        this.centres[i * 3 + 1] = CLOUD_BASE_Y + r3 * 5;
        this.centres[i * 3 + 2] = Math.sin(angle) * radius;
        this.sizes[i * 2] = 0.30 + r3 * 0.16;
        this.sizes[i * 2 + 1] = 0.14 + r4 * 0.08;
      } else if (tier < 0.78) {
        // tower: rises and tapers while leaning downwind
        const up = (tier - 0.34) / 0.44;
        const angle = r1 * Math.PI * 2 + up * 1.8;
        const radius = 0.34 * (1 - up * 0.58) * Math.sqrt(r2);
        this.centres[i * 3] = Math.cos(angle) * radius;
        this.centres[i * 3 + 1] = CLOUD_BASE_Y + 8 + up * (ANVIL_TOP_Y - CLOUD_BASE_Y - 34) + r3 * 7;
        this.centres[i * 3 + 2] = Math.sin(angle) * radius;
        this.sizes[i * 2] = 0.22 + r3 * 0.13;
        this.sizes[i * 2 + 1] = 0.17 + r4 * 0.10;
      } else {
        // anvil: a flat, wide cap that overhangs the tower
        const angle = r1 * Math.PI * 2;
        const radius = Math.sqrt(r2) * 0.95;
        this.centres[i * 3] = Math.cos(angle) * radius;
        this.centres[i * 3 + 1] = ANVIL_TOP_Y - r3 * 10;
        this.centres[i * 3 + 2] = Math.sin(angle) * radius;
        this.sizes[i * 2] = 0.36 + r3 * 0.22;
        this.sizes[i * 2 + 1] = 0.08 + r4 * 0.05;
      }
    }
  }

  setThunderEnabled(enabled: boolean): void {
    this.thunderEnabled = enabled;
  }

  /**
   * Per frame. `flash` is the scene's lightning pulse (the one that lights the terrain): the bolt is emitted on its rising edge, so the
   * visual and the light always belong to the same strike.
   */
  update(dt: number, cell: StormCell | null, camera: THREE.Camera, flash: boolean): void {
    this.clock += dt;
    if (!cell || cell.intensity <= 0.02) {
      if (this.active) {
        this.group.visible = false;
        this.active = false;
        this.boltMaterial.opacity = 0;
      }
      this.lastFlash = flash;
      return;
    }
    if (!this.active) {
      this.group.visible = true;
      this.active = true;
    }

    const { x, z, radiusUnits, intensity, groundY } = cell;
    this.puffMaterial.opacity = Math.min(0.82, 0.18 + intensity * 0.6);
    this.puffMaterial.color.setHex(0x39465a).lerp(this.tmp.setHex(0x232b39), Math.min(1, intensity));
    this.anvil.position.set(x, ANVIL_TOP_Y - 2, z);
    this.anvil.scale.set(radiusUnits * 1.5, radiusUnits * 1.5, 1);
    this.anvilMaterial.opacity = intensity * 0.34;
    this.group.position.set(0, 0, 0);

    // one column: the same silhouette at every zoom; puffs breathe slightly so the cell looks alive, not like a static decal
    for (let i = 0; i < PUFF_COUNT; i++) {
      const sway = Math.sin(this.clock * 0.23 + this.phases[i]) * 0.012;
      const px = x + this.centres[i * 3] * radiusUnits * (1 + sway);
      const pz = z + this.centres[i * 3 + 2] * radiusUnits * (1 + sway);
      const py = this.centres[i * 3 + 1];
      this.dummy.position.set(px, py, pz);
      this.dummy.scale.set(this.sizes[i * 2] * radiusUnits, this.sizes[i * 2 + 1] * radiusUnits, 1);
      this.dummy.quaternion.copy(camera.quaternion); // billboard, upright: the tower keeps its vertical shape
      this.dummy.updateMatrix();
      this.puffs.setMatrixAt(i, this.dummy.matrix);
    }
    this.puffs.instanceMatrix.needsUpdate = true;

    // cold-pool outflow: rings of displaced dust spreading out from under the base, resetting as they fade
    for (let i = 0; i < this.rings.length; i++) {
      const phase = (this.clock * 0.055 + this.ringPhases[i]) % 1;
      const ring = this.rings[i];
      ring.position.set(x, groundY + 0.8, z);
      ring.scale.set(radiusUnits * (0.35 + phase * 1.5), radiusUnits * (0.35 + phase * 1.5), 1);
      this.ringMaterial[i].opacity = intensity * Math.sin(phase * Math.PI) ** 1.3 * 0.34;
    }

    // lightning: a jagged bolt from the cloud base to the ground, repositioned on each pulse
    if (flash && !this.lastFlash) this.strike(x, z, radiusUnits, groundY);
    this.lastFlash = flash;
    if (this.boltLife > 0) {
      this.boltLife = Math.max(0, this.boltLife - dt);
      this.boltMaterial.opacity = (this.boltLife / 0.35) * 0.95;
    } else if (this.boltMaterial.opacity !== 0) {
      this.boltMaterial.opacity = 0;
    }
  }

  private strike(x: number, z: number, radiusUnits: number, groundY: number): void {
    const r = rand(this.clock * 13.7 + 2.1);
    const startX = x + (r - 0.5) * radiusUnits * 0.55;
    const startZ = z + (rand(this.clock * 7.3 + 4.2) - 0.5) * radiusUnits * 0.55;
    if (!this.boltCapacity) {
      this.boltCapacity = this.boltPoints * 2 * 3;
      this.bolt.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.boltCapacity), 3));
    }
    const attr = this.bolt.geometry.getAttribute('position') as THREE.BufferAttribute;
    const array = attr.array as Float32Array;
    let px = startX, pz = startZ;
    for (let i = 0; i < this.boltPoints; i++) {
      const f = i / (this.boltPoints - 1);
      const fade = Math.sin(f * Math.PI); // the middle of the bolt wanders; the ends stay at cloud and ground
      const nx = startX + (rand(i * 3.1 + 0.4) - 0.5) * radiusUnits * 0.16 * fade;
      const nz = startZ + (rand(i * 8.9 + 1.7) - 0.5) * radiusUnits * 0.16 * fade;
      const ny = CLOUD_BASE_Y + (groundY - CLOUD_BASE_Y) * f + (rand(i * 5.3 + 2.8) - 0.5) * 8 * fade;
      array[i * 6] = px; array[i * 6 + 1] = ny; array[i * 6 + 2] = pz;
      array[i * 6 + 3] = nx; array[i * 6 + 4] = ny; array[i * 6 + 5] = nz;
      px = nx; pz = nz;
    }
    attr.needsUpdate = true;
    this.boltLife = 0.35;

    const centre = new THREE.Vector3(x, groundY, z);
    const distanceM = centre.distanceTo(this.thunder.listener ?? centre) * 10; // 1 unit = 10 m
    if (this.thunderEnabled) this.thunder.play(Math.min(MAX_THUNDER_DELAY_S, distanceM / 343), intensityForStrike(distanceM));
  }

  /** Tell the thunder where the camera is, so the sound arrives after the light by the right delay (one allocated vector). */
  setListener(position: THREE.Vector3 | null): void {
    if (position) this.thunder.listener = this.listener.copy(position);
    else this.thunder.listener = null;
  }

  dispose(): void {
    this.puffs.geometry.dispose();
    this.puffMaterial.map?.dispose();
    this.puffMaterial.dispose();
    this.puffs.dispose();
    this.anvil.geometry.dispose();
    this.anvilMaterial.map?.dispose();
    this.anvilMaterial.dispose();
    for (const ring of this.rings) {
      ring.geometry.dispose();
      (ring.material as THREE.MeshBasicMaterial).map?.dispose();
      (ring.material as THREE.MeshBasicMaterial).dispose();
    }
    this.bolt.geometry.dispose();
    this.boltMaterial.dispose();
    this.thunder.dispose();
  }

  private readonly tmp = new THREE.Color();
  private readonly listener = new THREE.Vector3();
}

/** Distance (m) → how loud the thunder is; a strike 8 km away is a soft roll, a 500 m one is a crack. */
function intensityForStrike(distanceM: number): number {
  return Math.max(0.15, Math.min(1, 1 - distanceM / 9000));
}

/** Stable [0,1) pseudo-random so the cell has the same shape every reload. */
function rand(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function stormTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);
  const puff = (cx: number, cy: number, r: number, alpha: number, top: number) => {
    const grad = ctx.createRadialGradient(cx, cy - r * 0.2, r * 0.05, cx, cy, r);
    grad.addColorStop(0, `rgba(${top}, ${top}, ${top}, ${alpha})`);
    grad.addColorStop(0.45, `rgba(${top - 22}, ${top - 22}, ${top - 20}, ${alpha * 0.86})`);
    grad.addColorStop(0.8, 'rgba(150, 158, 172, 0.34)');
    grad.addColorStop(1, 'rgba(120, 130, 148, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };
  // an irregular, turbulent cumulonimbus face: dark underside, lit crests
  puff(128, 152, 92, 0.72, 118);
  puff(78, 158, 62, 0.6, 112);
  puff(178, 156, 66, 0.6, 112);
  puff(128, 124, 76, 0.8, 164);
  puff(86, 128, 56, 0.7, 150);
  puff(170, 128, 58, 0.7, 150);
  puff(128, 96, 54, 0.84, 196);
  puff(104, 108, 44, 0.75, 178);
  puff(152, 108, 46, 0.75, 178);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

function anvilTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);
  const grad = ctx.createRadialGradient(128, 128, 8, 128, 128, 128);
  grad.addColorStop(0, 'rgba(222, 229, 240, 0.72)');
  grad.addColorStop(0.46, 'rgba(198, 207, 222, 0.52)');
  grad.addColorStop(0.74, 'rgba(166, 177, 196, 0.24)');
  grad.addColorStop(0.9, 'rgba(140, 152, 174, 0.08)');
  grad.addColorStop(1, 'rgba(130, 143, 166, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  // a few lobes on the rim so the anvil is not a perfect circle
  for (let i = 0; i < 14; i++) {
    const angle = (i / 14) * Math.PI * 2 + rand(i * 7.7) * 0.35;
    const r = 74 + rand(i * 3.3 + 1.2) * 30;
    const x = 128 + Math.cos(angle) * r;
    const y = 128 + Math.sin(angle) * r;
    const radius = 22 + rand(i * 5.1 + 2.4) * 26;
    const lobe = ctx.createRadialGradient(x, y, 1, x, y, radius);
    lobe.addColorStop(0, 'rgba(196, 205, 220, 0.16)');
    lobe.addColorStop(1, 'rgba(166, 177, 196, 0)');
    ctx.fillStyle = lobe;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

function outflowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);
  const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
  grad.addColorStop(0.52, 'rgba(255, 255, 255, 0)');
  grad.addColorStop(0.63, 'rgba(255, 244, 220, 0.16)');
  grad.addColorStop(0.74, 'rgba(255, 240, 208, 0.5)');
  grad.addColorStop(0.88, 'rgba(232, 220, 196, 0.18)');
  grad.addColorStop(1, 'rgba(232, 220, 196, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

/**
 * Thunder, synthesised (no asset): filtered brown noise with a slow decay, delayed by the distance to the strike. It only works after
 * the operator has interacted with the page (browser autoplay policy); until then it stays silent instead of throwing.
 */
class Thunder {
  listener: THREE.Vector3 | null = null;
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private armed = false;
  private disposed = false;

  constructor() {
    if (typeof window === 'undefined') return;
    const unlock = () => {
      this.armed = true;
      this.ensure();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    this.cleanup = () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }

  private cleanup: () => void = () => {};

  private ensure(): void {
    if (this.ctx || this.disposed) return;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    try {
      this.ctx = new Ctx();
      this.buffer = this.makeBuffer(this.ctx);
    } catch {
      this.ctx = null;
    }
  }

  play(delayS: number, volume: number): void {
    if (!this.armed) return;
    this.ensure();
    if (!this.ctx || !this.buffer) return;
    void this.ctx.resume().catch(() => undefined);
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.setValueAtTime(420, ctx.currentTime);
    low.frequency.exponentialRampToValueAtTime(90, ctx.currentTime + 2.2);
    const gain = ctx.createGain();
    const now = ctx.currentTime + Math.max(0.03, delayS);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.02, volume * 0.5), now + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 3.2);
    src.connect(low).connect(gain).connect(ctx.destination);
    src.start(now);
    src.stop(now + 3.4);
  }

  private makeBuffer(ctx: AudioContext): AudioBuffer {
    const seconds = 3.4;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.025 * white) / 1.025;
      const envelope = Math.pow(1 - t, 1.8) * Math.min(1, t * 90);
      data[i] = brown * 3.2 * envelope;
    }
    return buffer;
  }

  dispose(): void {
    this.disposed = true;
    this.cleanup();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
