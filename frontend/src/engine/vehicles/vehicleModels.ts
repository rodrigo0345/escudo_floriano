import * as THREE from 'three';

/**
 * Low-poly 3D vehicles of the Portuguese emergency services, built from primitives (no downloaded meshes: no licences to track, nothing to load, and every vehicle
 * carries its own markings). Sizes are real (metres) and the shapes follow the vehicle classes the services actually use:
 *  - VFCI  Veículo Florestal de Combate a Incêndios: 4x4 truck, cab + equipment/tank body (Mercedes Atego / Unimog class)
 *  - VLCI  Veículo Ligeiro de Combate a Incêndios: pick-up with a water module in the bed (Land Cruiser / Hilux class)
 *  - VTTU/VTTF  tank trucks: cab + long cylindrical tank
 *  - ABSC  ambulance: box body on a van chassis
 *  - GNR BT patrol car, GNR UEPS pick-up, command SUVs, buses, dozers, helicopters, fixed-wing air tankers, drones
 * Liveries by organization: Bombeiros red with white reflective band, ambulances white with the red/yellow chequered band, GNR white with dark green band and
 * green/yellow chequers, INEM yellow, Proteção Civil (ANEPC) white with orange, PSP white with blue. Emergency light bars are blue.
 * Each model faces +x (forward), +y up, width along z.
 */

export type ModelClass = 'truck' | 'pickup' | 'tanker' | 'van' | 'car' | 'suv' | 'bus' | 'dozer' | 'moto' | 'heli' | 'plane' | 'drone';

const CLASS_BY_TYPE: Record<string, ModelClass> = {
  forest_firefighting_vehicle: 'truck', urban_firefighting_vehicle: 'truck', rescue_vehicle: 'truck', operations_vehicle: 'pickup',
  light_firefighting_vehicle: 'pickup', all_terrain_patrol: 'pickup',
  tanker_forest: 'tanker', tanker_urban: 'tanker', tanker_large: 'tanker',
  ambulance: 'van', advanced_medical_vehicle: 'van', immediate_life_support_vehicle: 'suv',
  command_vehicle: 'suv', command_comms_vehicle: 'van', patrol_car: 'car', traffic_unit: 'car', motorcycle: 'moto',
  personnel_transport: 'van', bus: 'bus', bulldozer: 'dozer', heavy_machinery: 'dozer', tractor_plow: 'dozer',
  helicopter: 'heli', airtanker: 'plane', drone: 'drone',
};

export function modelClassOf(vehicleType: string | undefined): ModelClass {
  return CLASS_BY_TYPE[vehicleType ?? ''] ?? 'suv';
}

export const isAircraft = (c: ModelClass): boolean => c === 'heli' || c === 'plane' || c === 'drone';

interface Livery {
  body: number;
  band: number;
  /** Chequered (Battenburg) band colours, when the livery has one. */
  checker?: [string, string];
  text: string;
  textColor: string;
  light: number;
}

export function liveryOf(orgType: string, cls: ModelClass): Livery {
  switch (orgType) {
    case 'fire_brigade':
      if (cls === 'van') return { body: 0xf5f5f2, band: 0xc8102e, checker: ['#c8102e', '#f4c300'], text: 'BOMBEIROS', textColor: '#c8102e', light: 0x2a6bff };
      if (cls === 'heli' || cls === 'plane') return { body: 0xd01a1a, band: 0xffffff, text: 'BOMBEIROS', textColor: '#ffffff', light: 0xff3030 };
      return { body: 0xc8102e, band: 0xf2f2f2, text: 'BOMBEIROS', textColor: '#ffffff', light: 0x2a6bff };
    case 'gnr':
      return { body: 0xf3f3f3, band: 0x1f4d2b, checker: ['#1f4d2b', '#d8e34a'], text: cls === 'pickup' ? 'GNR · UEPS' : 'GNR', textColor: '#1f4d2b', light: 0x2a6bff };
    case 'inem':
      return { body: 0xf6c400, band: 0xc8102e, checker: ['#c8102e', '#ffffff'], text: 'INEM', textColor: '#c8102e', light: 0x2a6bff };
    case 'civil_protection':
      return { body: 0xf5f5f2, band: 0xf57c00, checker: ['#f57c00', '#ffffff'], text: 'PROTEÇÃO CIVIL', textColor: '#e06a00', light: 0xff9a1a };
    case 'psp':
      return { body: 0xf3f3f3, band: 0x1c3f94, checker: ['#1c3f94', '#ffffff'], text: 'PSP', textColor: '#1c3f94', light: 0x2a6bff };
    case 'air_force':
      return { body: 0x8a9096, band: 0x5d6368, text: 'FORÇA AÉREA', textColor: '#ffffff', light: 0xff3030 };
    case 'municipality':
      return { body: 0xf3f3f3, band: 0x6b7f3a, text: 'MUNICÍPIO', textColor: '#4c5c26', light: 0xff9a1a };
    case 'forest_service':
      return { body: 0x3f6b3a, band: 0xe8e4d0, text: 'ICNF', textColor: '#ffffff', light: 0xff9a1a };
    default:
      return { body: 0xdedede, band: 0x777777, text: '', textColor: '#333333', light: 0xff9a1a };
  }
}

/** A built vehicle: the mesh tree, its emergency lights (flashed by the layer), rotor (spun), and where its water comes out. */
export interface VehicleModel {
  root: THREE.Group;
  lights: THREE.Mesh[];
  rotor: THREE.Object3D | null;
  bucket: THREE.Object3D | null;
  lengthM: number;
  heightM: number;
  /** Local position (m) of the water outlet: monitor/hose for trucks, bucket for helicopters, belly for planes. */
  nozzle: THREE.Vector3;
  /** Materials this vehicle owns (lights, markings), to free with it; the shared paints are cached for the whole fleet. */
  own: THREE.Material[];
}

// shared, never disposed: a few dozen small materials and geometries for the whole fleet
const materialCache = new Map<string, THREE.Material>();
function mat(key: string, make: () => THREE.Material): THREE.Material {
  let m = materialCache.get(key);
  if (!m) {
    m = make();
    materialCache.set(key, m);
  }
  return m;
}
const paint = (color: number) => mat(`p${color}`, () => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15 }));
const GLASS = () => mat('glass', () => new THREE.MeshStandardMaterial({ color: 0x18232e, roughness: 0.15, metalness: 0.6 }));
const RUBBER = () => mat('rubber', () => new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 }));
const STEEL = () => mat('steel', () => new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.35, metalness: 0.7 }));
const DARK = () => mat('dark', () => new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.7 }));
const lightMat = (color: number) => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: 0.15, roughness: 0.3 }); // per vehicle: flashed independently

function checkerMaterial(a: string, b: string): THREE.Material {
  return mat(`chk${a}${b}`, () => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 16;
    const ctx = c.getContext('2d')!;
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 2; j++) {
        ctx.fillStyle = (i + j) % 2 ? a : b;
        ctx.fillRect(i * 8, j * 8, 8, 8);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(4, 1);
    tex.magFilter = THREE.NearestFilter;
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0.1 });
  });
}

/** Side markings: organization name and callsign, as on the real vehicles. */
function markingMaterial(text: string, callsign: string, color: string): THREE.Material {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 ${text.length > 10 ? 50 : 64}px Arial, sans-serif`;
  ctx.fillText(text, 256, 46);
  ctx.font = '700 40px Arial, sans-serif';
  ctx.fillText(callsign, 256, 102);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
}

const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 14);
const planeGeo = new THREE.PlaneGeometry(1, 1);

function box(parent: THREE.Object3D, material: THREE.Material, l: number, h: number, w: number, x: number, y: number, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(boxGeo, material);
  m.scale.set(l, h, w);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function cylinder(parent: THREE.Object3D, material: THREE.Material, r: number, len: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z'): THREE.Mesh {
  const m = new THREE.Mesh(cylGeo, material);
  m.scale.set(r, len, r);
  if (axis === 'x') m.rotation.z = Math.PI / 2;
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function wheels(parent: THREE.Object3D, axlesX: number[], r: number, w: number): void {
  for (const x of axlesX) for (const side of [-1, 1]) cylinder(parent, RUBBER(), r, 0.32, x, r, side * (w / 2 - 0.12), 'z');
}

function markings(parent: THREE.Object3D, material: THREE.Material, l: number, h: number, x: number, y: number, w: number): void {
  for (const side of [-1, 1]) {
    const p = new THREE.Mesh(planeGeo, material);
    p.scale.set(l, h, 1);
    p.position.set(x, y, side * (w / 2 + 0.02));
    if (side < 0) p.rotation.y = Math.PI;
    parent.add(p);
  }
}

function lightBar(parent: THREE.Object3D, color: number, x: number, y: number, w: number): THREE.Mesh[] {
  box(parent, DARK(), 0.35, 0.1, w * 0.8, x, y);
  return [-1, 1].map((side) => box(parent, lightMat(color), 0.3, 0.16, w * 0.32, x, y + 0.1, side * w * 0.22));
}

function band(parent: THREE.Object3D, livery: Livery, l: number, w: number, x: number, y: number, h = 0.22): void {
  box(parent, livery.checker ? checkerMaterial(livery.checker[0], livery.checker[1]) : paint(livery.band), l, h, w + 0.02, x, y);
}

/** Builds one vehicle. `callsign` is painted on its sides. */
export function buildVehicle(cls: ModelClass, livery: Livery, callsign: string): VehicleModel {
  const root = new THREE.Group();
  const body = paint(livery.body);
  const marks = livery.text ? markingMaterial(livery.text, callsign, livery.textColor) : null;
  let lights: THREE.Mesh[] = [];
  let rotor: THREE.Object3D | null = null;
  let bucket: THREE.Object3D | null = null;
  let lengthM = 5;
  let heightM = 2;
  const nozzle = new THREE.Vector3();

  switch (cls) {
    case 'truck': { // VFCI: 7.5 m, cab forward, high equipment body with roll-up shutters, roof monitor
      const L = 7.5, W = 2.45;
      wheels(root, [2.4, -2.2], 0.55, W);
      box(root, DARK(), L, 0.35, W - 0.3, 0, 0.75);
      box(root, body, 2.1, 1.75, W, 2.6, 1.85);
      box(root, GLASS(), 0.06, 0.75, W - 0.25, 3.66, 2.2);
      box(root, GLASS(), 1.2, 0.6, W + 0.02, 2.8, 2.25);
      box(root, body, 5.0, 2.2, W, -0.95, 2.05);
      for (let i = 0; i < 3; i++) box(root, STEEL(), 1.3, 1.5, W + 0.03, -2.9 + i * 1.55, 1.95);
      band(root, livery, L - 0.4, W, 0.1, 1.15);
      if (marks) markings(root, marks, 3.4, 0.85, -0.95, 2.75, W);
      lights = lightBar(root, livery.light, 2.8, 2.82, W);
      cylinder(root, STEEL(), 0.12, 0.5, -1.5, 3.4, 0, 'y');
      nozzle.set(-1.5, 3.6, 0);
      lengthM = L; heightM = 3.2;
      break;
    }
    case 'tanker': { // VTTU/VTTF: 9 m, long cylindrical tank
      const L = 9, W = 2.5;
      wheels(root, [3.3, -1.8, -3.1], 0.55, W);
      box(root, DARK(), L, 0.35, W - 0.3, 0, 0.75);
      box(root, body, 2.0, 1.9, W, 3.4, 1.9);
      box(root, GLASS(), 0.06, 0.8, W - 0.25, 4.41, 2.3);
      cylinder(root, body, 1.15, 6.2, -1.1, 2.15, 0, 'x');
      band(root, livery, 6.0, 2.32, -1.1, 1.9, 0.26);
      if (marks) markings(root, marks, 3.8, 0.9, -1.1, 2.75, 2.35);
      lights = lightBar(root, livery.light, 3.5, 2.92, W);
      nozzle.set(-4.2, 1.4, 0);
      lengthM = L; heightM = 3.3;
      break;
    }
    case 'pickup': { // VLCI / GNR UEPS: 5.3 m pick-up, water module and hose reel in the bed
      const L = 5.3, W = 1.9;
      wheels(root, [1.6, -1.6], 0.42, W);
      box(root, body, L, 0.75, W, 0, 0.85);
      box(root, body, 1.9, 0.75, W - 0.1, 0.55, 1.6);
      box(root, GLASS(), 0.05, 0.5, W - 0.3, 1.5, 1.62);
      box(root, GLASS(), 1.5, 0.42, W - 0.04, 0.5, 1.68);
      box(root, STEEL(), 1.9, 0.85, W - 0.35, -1.45, 1.6);
      cylinder(root, paint(livery.band), 0.3, 0.5, -0.65, 1.75, 0, 'z');
      band(root, livery, L - 0.3, W, 0, 0.98, 0.18);
      if (marks) markings(root, marks, 2.1, 0.5, 0.2, 0.85, W);
      lights = lightBar(root, livery.light, 0.6, 2.02, W);
      nozzle.set(-2.2, 1.6, 0);
      lengthM = L; heightM = 2.1;
      break;
    }
    case 'van': { // ABSC / INEM: 6 m van with box body
      const L = 6.0, W = 2.2;
      wheels(root, [2.0, -1.9], 0.4, W);
      box(root, body, 1.6, 1.3, W - 0.1, 2.15, 1.15);
      box(root, GLASS(), 0.6, 0.55, W - 0.2, 2.75, 1.6);
      box(root, body, 4.4, 2.3, W, -0.8, 1.55);
      band(root, livery, 5.9, W, 0, 1.05, 0.32);
      if (marks) markings(root, marks, 3.2, 0.8, -0.8, 2.15, W);
      lights = lightBar(root, livery.light, 1.25, 2.75, W);
      nozzle.set(1.0, 1.0, 0);
      lengthM = L; heightM = 2.8;
      break;
    }
    case 'car': { // GNR BT patrol car: 4.6 m saloon
      const L = 4.6, W = 1.82;
      wheels(root, [1.4, -1.4], 0.33, W);
      box(root, body, L, 0.65, W, 0, 0.62);
      box(root, body, 2.3, 0.5, W - 0.18, -0.2, 1.17);
      box(root, GLASS(), 2.36, 0.4, W - 0.12, -0.2, 1.18);
      band(root, livery, L - 0.1, W, 0, 0.7, 0.2);
      if (marks) markings(root, marks, 1.9, 0.42, -0.1, 0.62, W);
      lights = lightBar(root, livery.light, -0.2, 1.48, W);
      lengthM = L; heightM = 1.6;
      break;
    }
    case 'suv': { // command vehicles, VMER: 4.8 m SUV
      const L = 4.8, W = 1.92;
      wheels(root, [1.5, -1.5], 0.4, W);
      box(root, body, L, 0.8, W, 0, 0.85);
      box(root, body, 3.0, 0.6, W - 0.1, -0.3, 1.55);
      box(root, GLASS(), 3.05, 0.45, W - 0.04, -0.3, 1.58);
      band(root, livery, L - 0.1, W, 0, 0.95, 0.2);
      if (marks) markings(root, marks, 2.2, 0.48, -0.2, 0.85, W);
      lights = lightBar(root, livery.light, -0.2, 1.95, W);
      lengthM = L; heightM = 2.0;
      break;
    }
    case 'bus': {
      const L = 11, W = 2.5;
      wheels(root, [3.6, -3.4], 0.5, W);
      box(root, body, L, 2.6, W, 0, 1.8);
      box(root, GLASS(), L - 1, 0.8, W + 0.02, 0, 2.4);
      band(root, livery, L, W, 0, 1.2, 0.3);
      if (marks) markings(root, marks, 4, 0.8, 0, 1.6, W);
      lengthM = L; heightM = 3.1;
      break;
    }
    case 'dozer': {
      const W = 2.6;
      for (const side of [-1, 1]) box(root, DARK(), 4.2, 0.9, 0.6, 0, 0.45, side * 1.0);
      box(root, paint(0xf2b705), 3.2, 1.3, W - 0.6, -0.2, 1.4);
      box(root, GLASS(), 1.2, 1.0, 1.4, -0.6, 2.5);
      box(root, STEEL(), 0.25, 1.1, W + 0.6, 2.5, 0.7);
      lights = [box(root, lightMat(0xff9a1a), 0.3, 0.2, 0.3, -0.6, 3.1)];
      lengthM = 5; heightM = 3.2;
      break;
    }
    case 'moto': {
      cylinder(root, RUBBER(), 0.32, 0.12, 0.75, 0.32, 0, 'z');
      cylinder(root, RUBBER(), 0.32, 0.12, -0.75, 0.32, 0, 'z');
      box(root, body, 1.6, 0.5, 0.4, 0, 0.75);
      lights = [box(root, lightMat(livery.light), 0.15, 0.15, 0.3, -0.6, 1.15)];
      lengthM = 2.2; heightM = 1.3;
      break;
    }
    case 'heli': { // firefighting helicopter (Ka-32 / AS350 class): fuselage, tail boom, rotor, Bambi bucket on a long line
      box(root, body, 4.2, 2.0, 1.9, 0, 1.6);
      box(root, GLASS(), 1.3, 1.3, 1.92, 1.9, 1.9);
      cylinder(root, body, 0.32, 6.5, -4.8, 2.0, 0, 'x');
      box(root, body, 0.9, 1.4, 0.15, -7.9, 2.6);
      box(root, paint(livery.band), 4.0, 0.3, 1.95, 0, 1.2);
      for (const side of [-1, 1]) box(root, STEEL(), 3.8, 0.1, 0.1, 0, 0.15, side * 1.0);
      if (marks) markings(root, marks, 2.6, 0.6, -0.4, 1.85, 1.9);
      rotor = new THREE.Group();
      rotor.position.set(0, 2.85, 0);
      box(rotor, DARK(), 15, 0.08, 0.45, 0, 0);
      box(rotor, DARK(), 0.45, 0.08, 15, 0, 0);
      root.add(rotor);
      bucket = new THREE.Group();
      box(bucket, DARK(), 0.04, 18, 0.04, 0, -9);
      cylinder(bucket, paint(0xff6a00), 0.9, 1.3, 0, -18.6, 0, 'y');
      root.add(bucket);
      lights = [box(root, lightMat(livery.light), 0.2, 0.2, 0.2, -1.8, 0.55)];
      nozzle.set(0, -19.4, 0);
      lengthM = 16; heightM = 3.2;
      break;
    }
    case 'plane': { // air tanker (Canadair class): fuselage, high wing, tail
      cylinder(root, body, 1.2, 19, 0, 2.2, 0, 'x');
      box(root, body, 3.0, 0.3, 28, 0.5, 3.4);
      box(root, body, 2.2, 3.0, 0.25, -8.8, 4.0);
      box(root, body, 2.0, 0.25, 8.5, -8.8, 5.2);
      box(root, paint(livery.band), 19, 0.35, 2.45, 0, 1.6);
      if (marks) markings(root, marks, 6, 1.2, 0, 2.5, 2.42);
      lights = [box(root, lightMat(livery.light), 0.3, 0.3, 0.3, 0, 3.7, 14)];
      nozzle.set(0, 0.9, 0);
      lengthM = 20; heightM = 6;
      break;
    }
    case 'drone': {
      box(root, DARK(), 0.6, 0.2, 0.6, 0, 0.6);
      for (const [x, z] of [[0.6, 0.6], [-0.6, 0.6], [0.6, -0.6], [-0.6, -0.6]]) cylinder(root, DARK(), 0.35, 0.04, x, 0.75, z, 'y');
      lights = [box(root, lightMat(0xff3030), 0.12, 0.12, 0.12, 0, 0.75)];
      lengthM = 1.6; heightM = 0.8;
      break;
    }
  }
  const own: THREE.Material[] = lights.map((l) => l.material as THREE.Material);
  if (marks) own.push(marks);
  return { root, lights, rotor, bucket, lengthM, heightM, nozzle, own };
}
