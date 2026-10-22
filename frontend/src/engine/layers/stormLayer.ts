import * as THREE from 'three';

/**
 * A cumulonimbus cell (Epic E6), drawn to be *read* from a tactical camera:
 *
 * - The cloud is one dense cluster of ~160 camera-facing puffs whose colour is shaded per instance (dark rainy base, lit
 *   cauliflower tower, pale anvil), so it reads as a towering storm cell instead of a pile of flat grey discs. The tower column
 *   stays narrow relative to its height — the classic cumulonimbus silhouette — while the base shelf and the anvil carry the
 *   cell's real footprint.
 * - Lightning is a ribbon rebuilt every frame (view-aligned quads, core + wide glow pass, branches, restrike flicker, ground
 *   flash) — never `LineSegments`, which from above collapse into a few disconnected dashes.
 * - Thunder is synthesised brown noise delayed by the distance to the strike (the browser allows audio after one gesture).
 *
 * The caller derives the cell's centre and footprint radius (from the storm event; D3 will hand over an explicit path). This
 * layer only draws what it is told, so it never invents weather.
 */

/** 1 world unit = 10 m, the same scale as the terrain and the cloud layers. */
const PUFF_COUNT = 160;
/** The fair-weather deck tops out at 210; the cell's dark base sits just above it. */
const BASE_Y = 218;
/** The tower's top above the base, and the anvil above that — capped so the cell stays inside the visible sky. */
const TOWER_TOP_LOCAL = 102;
const ANVIL_LOCAL = 116;
const MAX_TOP_Y = 340;
/** Longest thunder delay we bother with: beyond ~6 s it is just a low roll under the cells. */
const MAX_THUNDER_DELAY_S = 6;

// Lightning ribbon budget: main channel + branches, each segment emitting a core quad and a wider glow quad (2 triangles each).
// The fractal generator doubles the point count per level: 5 levels → 33 points on the main channel.
const BOLT_LEVELS = 5;
const MAIN_POINTS = (1 << BOLT_LEVELS) + 1;
const MAX_BRANCHES = 3;
const BRANCH_POINTS = (1 << 3) + 1; // 9
const BOLT_SEGMENTS = MAIN_POINTS - 1 + MAX_BRANCHES * (BRANCH_POINTS - 1);
const BOLT_FLOATS = BOLT_SEGMENTS * 12 * 3; // per segment: core 6 verts + glow 6 verts, xyz each
const BOLT_LIFE_S = 0.42;

/** Brightness of the two ribbon passes (premultiplied into vertex colours each frame). */
const CORE = new THREE.Color(1.0, 0.98, 0.93);
const GLOW = new THREE.Color(0.16, 0.25, 0.62);

/** The return stroke sweeps from the ground back up to the cloud during the first ~120 ms: brightness follows it. */
function returnStroke(f: number, t: number): number {
  if (t >= 0.12) return 1;
  const front = 1 - t / 0.12; // bright zone position: 1 (ground) → 0 (cloud)
  return 0.45 + 0.65 * Math.max(0, 1 - Math.abs(f - front) * 2.5);
}

export interface StormCell {
  /** Centre of the cell on the ground plane (world units). */
  x: number;
  z: number;
  /** Radius of the cell's ground footprint (world units). */
  radiusUnits: number;
  /** 0 = gone, 1 = mature cell. */
  intensity: number;
  /** Terrain height at the centre, so the outflow rings sit on the ground and not inside a hill. */
  groundY: number;
}

/** One pre-placed puff: offset relative to the centre (×footprint radius), size (×radius), colour and a sway phase. */
interface PuffSpec {
  ox: number;
  oy: number;
  oz: number;
  size: number;
  colour: THREE.Color;
  phase: number;
}

export class StormLayer {
  readonly group = new THREE.Group();
  private readonly puffs: THREE.InstancedMesh;
  private readonly puffMaterial: THREE.MeshBasicMaterial;
  private readonly anvil: THREE.Mesh;
  private readonly anvilMaterial: THREE.MeshBasicMaterial;
  private readonly dummy = new THREE.Object3D();
  private readonly spec: PuffSpec[] = [];
  private readonly rings: THREE.Mesh[] = [];
  private readonly ringMaterial: THREE.MeshBasicMaterial[] = [];
  private readonly ringPhases = [0, 0.5];

  // ---- lightning
  private readonly boltMesh: THREE.Mesh;
  private readonly boltMaterial: THREE.MeshBasicMaterial;
  private readonly boltPositions = new Float32Array(BOLT_FLOATS);
  private readonly boltColours = new Float32Array(BOLT_FLOATS);
  private channel: THREE.Vector3[] = [];
  private branches: THREE.Vector3[][] = [];
  private boltLife = 0;
  private readonly boltSeed = Math.random() * 100;
  /** 'ground' = channel down to the terrain; 'cloud' = intra-cloud flash, only a glow inside the base. */
  private boltMode: 'ground' | 'cloud' = 'ground';
  private readonly groundFlash: THREE.Sprite;
  private readonly cloudFlash: THREE.Sprite;
  private lastFlash = false;

  private active = false;
  private clock = 0;
  private thunder = new Thunder();
  private thunderEnabled = true;
  /** Where the camera is (world units): thunder is delayed by the distance to the strike. */
  private readonly listener = new THREE.Vector3();
  /** Scratch vectors for the ribbon's per-point frames (reused, never allocated per frame). */
  private readonly rightA = new THREE.Vector3();
  private readonly rightB = new THREE.Vector3();

  constructor() {
    // ---- the cell: one instanced puff cloud, tinted per instance
    this.puffMaterial = new THREE.MeshBasicMaterial({
      map: puffTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.puffs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.puffMaterial, PUFF_COUNT);
    this.puffs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.puffs.frustumCulled = false;
    this.puffs.renderOrder = 23;
    this.group.add(this.puffs);
    this.placePuffs();

    // A soft pale cap behind the anvil puffs: from the side it completes the overhang; kept faint so from above it reads as
    // deck, never as a saucer.
    this.anvilMaterial = new THREE.MeshBasicMaterial({
      map: anvilTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      color: 0x8f99ab,
    });
    this.anvil = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.anvilMaterial);
    this.anvil.rotation.x = -Math.PI / 2;
    this.anvil.renderOrder = 22;
    this.group.add(this.anvil);

    // ---- cold-pool outflow rings at ground level
    const ringTexture = outflowTexture();
    for (let i = 0; i < 2; i++) {
      const material = new THREE.MeshBasicMaterial({
        map: ringTexture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false,
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

    // ---- lightning: one dynamic triangle-soup ribbon (vertex colours carry core vs glow brightness)
    this.boltMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    const boltGeometry = new THREE.BufferGeometry();
    boltGeometry.setAttribute('position', new THREE.BufferAttribute(this.boltPositions, 3));
    boltGeometry.setAttribute('color', new THREE.BufferAttribute(this.boltColours, 3));
    boltGeometry.setDrawRange(0, 0);
    this.boltMesh = new THREE.Mesh(boltGeometry, this.boltMaterial);
    this.boltMesh.frustumCulled = false;
    this.boltMesh.renderOrder = 26;
    this.group.add(this.boltMesh);

    this.groundFlash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flashTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      color: 0xcfe0ff,
    }));
    this.groundFlash.renderOrder = 27;
    this.group.add(this.groundFlash);

    this.cloudFlash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flashTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      color: 0xbfd2f2,
    }));
    this.cloudFlash.renderOrder = 27;
    this.group.add(this.cloudFlash);

    this.group.visible = false;
  }

  /**
   * The cell's fixed skeleton, relative to its centre and footprint radius R. Three tiers:
   * base shelf (dark, the rain area) → narrowing cauliflower tower → pale spreading anvil.
   */
  private placePuffs(): void {
    const push = (ox: number, oy: number, oz: number, size: number, colour: THREE.Color) => {
      this.spec.push({ ox, oy, oz, size, colour, phase: rand(this.spec.length * 1.97 + 4.9) * Math.PI * 2 });
    };

    // 1) base shelf: dense, dark, ragged — the rain-cloud underside
    for (let i = 0; i < 58; i++) {
      const angle = rand(i * 3.17 + 1.1) * Math.PI * 2;
      const radius = Math.sqrt(rand(i * 5.71 + 2.3)) * 0.88;
      const shade = 0.8 + rand(i * 9.13 + 0.7) * 0.35;
      push(
        Math.cos(angle) * radius,
        rand(i * 1.37 + 5.2) * 15,
        Math.sin(angle) * radius,
        0.16 + rand(i * 2.29 + 3.8) * 0.15,
        new THREE.Color(0.150 * shade, 0.175 * shade, 0.220 * shade),
      );
    }

    // 2) tower: a leaning cauliflower column, dark at the bottom, catching light towards the top
    for (let i = 0; i < 56; i++) {
      const t = rand(i * 4.31 + 2.2); // 0 at the base → 1 at the top
      const lean = t * 0.4; // the updraught leans with the wind
      const angle = rand(i * 6.53 + 0.9) * Math.PI * 2 + t * 2.4;
      const radius = Math.sqrt(rand(i * 7.77 + 1.4)) * (0.95 - t * 0.35);
      const shade = 0.85 + rand(i * 8.11 + 6.1) * 0.3;
      const lum = 0.235 + t * 0.21;
      push(
        Math.cos(angle) * radius + lean,
        12 + t * (TOWER_TOP_LOCAL - 12) + (rand(i * 3.71 + 8.3) - 0.5) * 7,
        Math.sin(angle) * radius + lean * 0.6,
        0.17 + rand(i * 2.53 + 4.4) * 0.13,
        new THREE.Color(lum * shade, (lum + 0.025) * shade, (lum + 0.075) * shade),
      );
    }

    // 3) anvil: pale, flat, spreading well past the tower — the icy top catching the sun
    for (let i = 0; i < 46; i++) {
      const angle = rand(i * 5.19 + 2.7) * Math.PI * 2;
      const radius = Math.sqrt(rand(i * 3.93 + 7.7)) * 1.12;
      const shade = 0.85 + rand(i * 6.29 + 1.6) * 0.3;
      push(
        Math.cos(angle) * radius,
        ANVIL_LOCAL - rand(i * 4.67 + 3.1) * 13,
        Math.sin(angle) * radius,
        0.20 + rand(i * 1.71 + 9.2) * 0.14,
        new THREE.Color(0.50 * shade, 0.545 * shade, 0.625 * shade),
      );
    }
  }

  setThunderEnabled(enabled: boolean): void {
    this.thunderEnabled = enabled;
  }

  /**
   * Per frame. `flash` is the scene's lightning pulse (the one that lights the terrain): the bolt is emitted on its rising
   * edge, so the visual and the light always belong to the same strike.
   */
  update(dt: number, cell: StormCell | null, camera: THREE.Camera, flash: boolean): void {
    this.clock += dt;
    if (!cell || cell.intensity <= 0.02) {
      if (this.active) {
        this.group.visible = false;
        this.active = false;
        this.hideBolt();
      }
      this.lastFlash = flash;
      return;
    }
    if (!this.active) {
      this.group.visible = true;
      this.active = true;
    }

    const { x, z, radiusUnits, intensity, groundY } = cell;
    const towerTop = Math.min(MAX_TOP_Y - 14, BASE_Y + TOWER_TOP_LOCAL);
    const anvilY = Math.min(MAX_TOP_Y, towerTop + (ANVIL_LOCAL - TOWER_TOP_LOCAL));

    this.puffMaterial.opacity = Math.min(0.94, 0.30 + intensity * 0.62);

    for (let i = 0; i < this.spec.length && i < PUFF_COUNT; i++) {
      const s = this.spec[i];
      const sway = 1 + Math.sin(this.clock * 0.4 + s.phase) * 0.018;
      this.dummy.position.set(x + s.ox * radiusUnits * sway, BASE_Y + s.oy, z + s.oz * radiusUnits * sway);
      this.dummy.scale.set(s.size * radiusUnits, s.size * radiusUnits * 0.86, 1);
      this.dummy.quaternion.copy(camera.quaternion);
      this.dummy.updateMatrix();
      this.puffs.setMatrixAt(i, this.dummy.matrix);
      this.puffs.setColorAt(i, s.colour);
    }
    this.puffs.count = Math.min(this.spec.length, PUFF_COUNT);
    this.puffs.instanceMatrix.needsUpdate = true;
    if (this.puffs.instanceColor) this.puffs.instanceColor.needsUpdate = true;

    this.anvil.position.set(x, anvilY + 2, z);
    this.anvil.scale.set(radiusUnits * 1.4, radiusUnits * 1.4, 1);
    this.anvilMaterial.opacity = intensity * 0.15;

    // cold-pool outflow: rings of displaced dust spreading out from under the base, resetting as they fade
    for (let i = 0; i < this.rings.length; i++) {
      const phase = (this.clock * 0.055 + this.ringPhases[i]) % 1;
      const ring = this.rings[i];
      ring.position.set(x, groundY + 0.8, z);
      ring.scale.set(radiusUnits * (0.35 + phase * 1.5), radiusUnits * (0.35 + phase * 1.5), 1);
      this.ringMaterial[i].opacity = intensity * Math.sin(phase * Math.PI) ** 1.3 * 0.34;
    }

    // lightning: emitted on the rising edge of the scene's flash, drawn as a ribbon while it lives
    if (flash && !this.lastFlash) this.strike(x, z, radiusUnits, groundY);
    this.lastFlash = flash;
    if (this.boltLife > 0) {
      this.boltLife = Math.max(0, this.boltLife - dt);
      const t = 1 - this.boltLife / BOLT_LIFE_S;
      const env = envelope(t) * flicker(t, this.boltSeed);
      if (this.boltMode === 'ground') {
        this.drawBolt(camera, env, t);
        const impact = this.channel[this.channel.length - 1];
        this.groundFlash.position.copy(impact);
        this.groundFlash.scale.setScalar(8 + t * 26);
        (this.groundFlash.material as THREE.SpriteMaterial).opacity = env * 0.85;
        (this.cloudFlash.material as THREE.SpriteMaterial).opacity = 0;
      } else {
        this.boltGeometry().setDrawRange(0, 0);
        const start = this.channel[0];
        this.cloudFlash.position.set(start.x, start.y + 6, start.z);
        this.cloudFlash.scale.setScalar(radiusUnits * 0.9 * (0.7 + t * 0.5));
        (this.cloudFlash.material as THREE.SpriteMaterial).opacity = env * 0.9;
        (this.groundFlash.material as THREE.SpriteMaterial).opacity = 0;
      }
    } else {
      this.hideBolt();
    }
  }

  private hideBolt(): void {
    this.boltGeometry().setDrawRange(0, 0);
    (this.groundFlash.material as THREE.SpriteMaterial).opacity = 0;
    (this.cloudFlash.material as THREE.SpriteMaterial).opacity = 0;
  }

  private boltGeometry(): THREE.BufferGeometry {
    return this.boltMesh.geometry as THREE.BufferGeometry;
  }

  /** A new strike: a fractal stepped-leader channel from the cloud base to the ground (or an intra-cloud flash), plus branches. */
  private strike(x: number, z: number, radiusUnits: number, groundY: number): void {
    this.boltMode = rand(this.clock * 13.7 + 2.1) < 0.35 ? 'cloud' : 'ground';
    const start = new THREE.Vector3(
      x + (rand(this.clock * 7.3 + 4.2) - 0.5) * radiusUnits * 0.5,
      BASE_Y + 4,
      z + (rand(this.clock * 3.9 + 8.8) - 0.5) * radiusUnits * 0.5,
    );
    const end = new THREE.Vector3(
      start.x + (rand(this.clock * 5.1 + 2.6) - 0.5) * radiusUnits * 0.3,
      this.boltMode === 'ground' ? groundY + 0.5 : start.y - radiusUnits * 0.25,
      start.z + (rand(this.clock * 6.7 + 9.4) - 0.5) * radiusUnits * 0.3,
    );
    const roughness = this.boltMode === 'ground' ? 0.22 : 0.16; // horizontal swing per level, as a share of segment length
    this.channel = fractalBolt(start, end, BOLT_LEVELS, roughness, (seed) => rand(seed + this.clock * 3.71));

    // branches: fork off the channel at coarse levels, reach out and down, and are themselves little fractal bolts
    this.branches = [];
    const forkCount = 1 + Math.floor(rand(this.clock * 2.17 + 5.5) * MAX_BRANCHES);
    for (let b = 0; b < forkCount; b++) {
      const at = 4 + Math.floor(rand(this.clock * 4.4 + b * 7.7) * (MAIN_POINTS - 10));
      const from = this.channel[Math.min(at, MAIN_POINTS - 2)];
      const tip = new THREE.Vector3(
        from.x + (rand(this.clock * 6.1 + b * 2.3) - 0.3) * radiusUnits * 0.35,
        Math.max(groundY, from.y - (from.y - end.y) * (0.45 + rand(this.clock + b) * 0.3)),
        from.z + (rand(this.clock * 8.3 + b * 5.1) - 0.3) * radiusUnits * 0.35,
      );
      this.branches.push(fractalBolt(from.clone(), tip, 3, 0.24, (seed) => rand(seed + this.clock * 7.77 + b * 31)));
    }

    this.boltLife = BOLT_LIFE_S;

    if (this.boltMode === 'ground') {
      const impact = this.channel[this.channel.length - 1];
      const distanceM = Math.hypot(impact.x - this.listener.x, (impact.y - this.listener.y) * 2, impact.z - this.listener.z) * 10; // 1 unit = 10 m
      if (this.thunderEnabled) this.thunder.play(Math.min(MAX_THUNDER_DELAY_S, distanceM / 343), intensityForStrike(distanceM));
    } else if (this.thunderEnabled) {
      this.thunder.play(0.4 + rand(this.clock) * 1.2, 0.25); // intra-cloud: a distant, muted rumble
    }
  }

  /**
   * Rebuilds the ribbon around the stored channel and branches. Per-point frames (tangent averaged from both neighbours) keep
   * the ribbon smooth instead of a ladder of twisted sheets; the return stroke sweeps upward during the first instants, so the
   * bolt *happens* instead of just appearing. Brightness (envelope × flicker × sweep) is premultiplied into vertex colours.
   */
  private drawBolt(camera: THREE.Camera, env: number, t: number): void {
    const pos = this.boltPositions;
    const col = this.boltColours;
    let v = 0;
    const viewDir = new THREE.Vector3();
    const segDir = new THREE.Vector3();
    const pa = new THREE.Vector3();
    const pb = new THREE.Vector3();

    // per-point view-aligned right vector, from the averaged tangent (smooths the ribbon across bends)
    const pointRight = (points: THREE.Vector3[], i: number, out: THREE.Vector3): THREE.Vector3 => {
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      segDir.subVectors(next, prev);
      if (segDir.lengthSq() < 1e-8) segDir.set(0, -1, 0);
      segDir.normalize();
      viewDir.subVectors(points[i], camera.position).normalize();
      out.crossVectors(segDir, viewDir);
      if (out.lengthSq() < 1e-4) out.set(-viewDir.z, 0, viewDir.x); // segment along the view: ribbon horizontally instead
      return out.normalize();
    };

    const quad = (p: THREE.Vector3, pr: THREE.Vector3, q: THREE.Vector3, qr: THREE.Vector3, halfW: number, colour: THREE.Color, bright: number) => {
      if (v + 18 > BOLT_FLOATS) return;
      pa.copy(p).addScaledVector(pr, -halfW); pb.copy(q).addScaledVector(qr, -halfW);
      pos[v] = pa.x; pos[v + 1] = pa.y; pos[v + 2] = pa.z;
      pos[v + 3] = p.x + pr.x * halfW; pos[v + 4] = p.y + pr.y * halfW; pos[v + 5] = p.z + pr.z * halfW;
      pos[v + 6] = pb.x; pos[v + 7] = pb.y; pos[v + 8] = pb.z;
      pos[v + 9] = p.x + pr.x * halfW; pos[v + 10] = p.y + pr.y * halfW; pos[v + 11] = p.z + pr.z * halfW;
      pos[v + 12] = q.x + qr.x * halfW; pos[v + 13] = q.y + qr.y * halfW; pos[v + 14] = q.z + qr.z * halfW;
      pos[v + 15] = pb.x; pos[v + 16] = pb.y; pos[v + 17] = pb.z;
      for (let k = 0; k < 18; k += 3) {
        col[v + k] = colour.r * bright;
        col[v + k + 1] = colour.g * bright;
        col[v + k + 2] = colour.b * bright;
      }
      v += 18;
    };

    const emit = (points: THREE.Vector3[], widthAt: (f: number) => number, gain: number) => {
      for (let i = 0; i + 1 < points.length; i++) {
        const f = (i + 0.5) / (points.length - 1);
        const bright = env * returnStroke(f, t);
        const w = widthAt(f) * gain;
        quad(points[i], pointRight(points, i, this.rightA), points[i + 1], pointRight(points, i + 1, this.rightB), w, CORE, bright);
        quad(points[i], pointRight(points, i, this.rightA), points[i + 1], pointRight(points, i + 1, this.rightB), w * 2.4, GLOW, bright * 0.75);
      }
    };

    const r = boltWidth(this.channel);
    emit(this.channel, (f) => r * (0.45 + 0.75 * Math.sin(Math.PI * Math.min(1, f * 1.15)) ** 0.7), 1);
    for (let b = 0; b < this.branches.length; b++) {
      emit(this.branches[b], (f) => r * 0.5 * (1 - f * 0.7), 0.75);
    }

    this.boltGeometry().setDrawRange(0, v / 3);
    this.boltGeometry().attributes.position.needsUpdate = true;
    this.boltGeometry().attributes.color.needsUpdate = true;
  }

  /** Tell the thunder where the camera is, so the sound arrives after the light by the right delay (one allocated vector). */
  setListener(position: THREE.Vector3 | null): void {
    if (position) this.listener.copy(position);
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
    this.boltGeometry().dispose();
    this.boltMaterial.dispose();
    (this.groundFlash.material as THREE.SpriteMaterial).map?.dispose();
    (this.groundFlash.material as THREE.SpriteMaterial).dispose();
    (this.cloudFlash.material as THREE.SpriteMaterial).dispose();
    this.thunder.dispose();
  }
}

/** Half-width of the bolt's core ribbon: a fraction of the channel's length (a 2 km drop draws a ~50 m channel). */
function boltWidth(channel: THREE.Vector3[]): number {
  const length = channel[0].distanceTo(channel[channel.length - 1]);
  return Math.max(1.4, Math.min(5.5, length * 0.024));
}

/**
 * Fractal midpoint displacement — the classic procedural-lightning generator (Drilian, "Lightning Bolts… Zap!", the algorithm
 * behind most game lightning): subdivide every segment at its midpoint, push the midpoint along the segment's horizontal
 * perpendicular by `roughness × segmentLength` worth of randomness, then shrink the roughness per level. Produces the jagged,
 * self-similar shape everyone recognises as lightning, with 2^levels + 1 points.
 */
function fractalBolt(from: THREE.Vector3, to: THREE.Vector3, levels: number, roughness: number, rnd: (seed: number) => number): THREE.Vector3[] {
  let points = [from.clone(), to.clone()];
  let magnitude = roughness;
  for (let level = 0; level < levels; level++) {
    const next: THREE.Vector3[] = [points[0]];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const len = b.distanceTo(a);
      const seed = level * 977 + i * 61;
      // horizontal perpendicular of the segment (a vertical segment's perpendicular is any horizontal direction)
      let perpX = -(b.z - a.z);
      let perpZ = b.x - a.x;
      const perpLen = Math.hypot(perpX, perpZ);
      if (perpLen < 1e-5) {
        const side = rnd(seed + 0.5) < 0.5 ? -1 : 1;
        perpX = side;
        perpZ = 0;
      } else {
        perpX /= perpLen;
        perpZ /= perpLen;
      }
      const offset = (rnd(seed + 1.7) * 2 - 1) * magnitude * len;
      mid.x += perpX * offset;
      mid.z += perpZ * offset;
      mid.y += (rnd(seed + 2.9) * 2 - 1) * magnitude * len * 0.25; // a little vertical jitter too
      next.push(mid, b);
    }
    points = next;
    magnitude *= 0.62; // roughness decay: big swings high up, fine detail low down
  }
  return points;
}

/** Restrike envelope over the bolt's life: the return stroke is brightest the instant it lands, then re-strikes decay. */
function envelope(t: number): number {
  const tri = (s: number, e: number) => (t < s || t > e ? 0 : 1 - Math.abs(2 * (t - s) / (e - s) - 1));
  const first = t < 0.15 ? 1 - 0.35 * (t / 0.15) : 0; // peak at t=0: the return stroke
  const env = Math.max(first, 0.82 * tri(0.22, 0.46), 0.5 * tri(0.54, 0.84));
  return env * (1 - 0.25 * t);
}

/** High-frequency flicker, so the channel strobes like a real discharge instead of glowing steadily. */
function flicker(t: number, seed: number): number {
  return 0.82 + 0.18 * Math.sin(t * 240 + seed * 17.3) * Math.sin(t * 93 + seed * 3.1);
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

/** Soft white puff with a shaded underside; white so the per-instance colour carries the tone. */
function puffTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);
  const blob = (cx: number, cy: number, r: number, alpha: number, topLift: number) => {
    const grad = ctx.createRadialGradient(cx, cy - topLift, r * 0.08, cx, cy, r);
    grad.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    grad.addColorStop(0.5, `rgba(252, 252, 253, ${alpha * 0.85})`);
    grad.addColorStop(0.78, `rgba(238, 240, 246, ${alpha * 0.42})`);
    grad.addColorStop(1, 'rgba(228, 232, 240, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };
  // one dense, lumpy mass: many overlapping lobes so no hard circle edge survives
  blob(128, 128, 108, 0.5, 8);
  blob(96, 118, 66, 0.55, 12);
  blob(160, 120, 70, 0.55, 12);
  blob(112, 148, 58, 0.5, -6);
  blob(146, 150, 60, 0.5, -6);
  blob(128, 100, 56, 0.6, 16);
  blob(88, 140, 44, 0.45, 0);
  blob(170, 142, 46, 0.45, 0);
  blob(128, 132, 88, 0.4, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/** Soft pale disc for the anvil cap behind the puffs. */
function anvilTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);
  const grad = ctx.createRadialGradient(128, 128, 10, 128, 128, 126);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
  grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.38)');
  grad.addColorStop(0.78, 'rgba(255, 255, 255, 0.16)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

/** Warm dusty ring for the surface outflow (gust front). */
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

/** Radial glow for the ground / in-cloud flash sprites. */
function flashTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);
  const grad = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  grad.addColorStop(0.3, 'rgba(235, 240, 255, 0.55)');
  grad.addColorStop(0.65, 'rgba(200, 214, 250, 0.2)');
  grad.addColorStop(1, 'rgba(180, 200, 250, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

/**
 * Thunder, synthesised (no asset): a sharp wideband crack over a decaying low rumble, delayed by the distance to the strike.
 * It only works after the operator has interacted with the page (browser autoplay policy); until then it stays silent.
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
    low.frequency.setValueAtTime(900, ctx.currentTime);
    low.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 2.6);
    const gain = ctx.createGain();
    const now = ctx.currentTime + Math.max(0.03, delayS);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.02, volume * 0.55), now + 0.04); // fast attack: the crack
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 3.4);
    src.connect(low).connect(gain).connect(ctx.destination);
    src.start(now);
    src.stop(now + 3.6);
  }

  private makeBuffer(ctx: AudioContext): AudioBuffer {
    const seconds = 3.6;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.025 * white) / 1.025;
      const rumble = brown * 3.0 * Math.pow(1 - t, 1.7) * Math.min(1, t * 60);
      const crack = white * Math.pow(1 - t, 22) * 1.6; // the first 100 ms or so
      data[i] = rumble + crack;
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
