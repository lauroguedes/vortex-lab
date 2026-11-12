// Procedural low-poly models for everything the wind can pick up: vehicles,
// furniture, appliances, roof sections and street furniture. All dimensions are
// real-world metres; x is the long axis (vehicles face +x), y is up.
//
// Every vertex carries a colour and a "tint" flag: tinted parts take the
// per-instance colour (car paint, upholstery), untinted parts keep their own
// (glass, tyres, timber).

import * as THREE from 'three';

type Rect = [x0: number, x1: number, z0: number, z1: number];

const GLASS = 0x141b20;
const TYRE = 0x0c0c0d;
const WOOD = 0xb08a58;
const WOOD_DARK = 0x6b4a2c;
const STEEL = 0x9aa0a4;

const m4 = new THREE.Matrix4();
const q4 = new THREE.Quaternion();
const e3 = new THREE.Euler();
const v3 = new THREE.Vector3();
const s3 = new THREE.Vector3(1, 1, 1);
const c3 = new THREE.Color();

export interface Shape {
  geometry: THREE.BufferGeometry;
  /** half extents of the bounding box (the geometry is centred on its origin) */
  half: [number, number, number];
}

class Geo {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private tint: number[] = [];

  private append(g: THREE.BufferGeometry, color: number, tint: number) {
    const src = g.index ? g.toNonIndexed() : g;
    const p = src.attributes.position.array, n = src.attributes.normal.array;
    c3.set(color);
    for (let i = 0; i < p.length; i += 3) {
      this.pos.push(p[i], p[i + 1], p[i + 2]);
      this.nor.push(n[i], n[i + 1], n[i + 2]);
      this.col.push(c3.r, c3.g, c3.b);
      this.tint.push(tint);
    }
    if (src !== g) src.dispose();
    g.dispose();
  }

  /** axis-aligned (optionally rotated) box centred at x, y, z */
  box(sx: number, sy: number, sz: number, x: number, y: number, z: number, color: number, tint = 0, rx = 0, ry = 0, rz = 0) {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    m4.compose(v3.set(x, y, z), q4.setFromEuler(e3.set(rx, ry, rz)), s3);
    g.applyMatrix4(m4);
    this.append(g, color, tint);
    return this;
  }

  /** cylinder of radius r and length len along the given axis */
  cyl(r: number, len: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z', color: number, tint = 0, seg = 10, rTop = r) {
    const g = new THREE.CylinderGeometry(rTop, r, len, seg, 1, false);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    this.append(g, color, tint);
    return this;
  }

  private quad(a: number[], b: number[], c: number[], d: number[], centre: number[], color: number, tint: number) {
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const fx = (a[0] + b[0] + c[0] + d[0]) / 4 - centre[0];
    const fy = (a[1] + b[1] + c[1] + d[1]) / 4 - centre[1];
    const fz = (a[2] + b[2] + c[2] + d[2]) / 4 - centre[2];
    let order = [a, b, c, a, c, d];
    if (nx * fx + ny * fy + nz * fz < 0) { nx = -nx; ny = -ny; nz = -nz; order = [a, c, b, a, d, c]; }
    c3.set(color);
    for (const p of order) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      this.col.push(c3.r, c3.g, c3.b);
      this.tint.push(tint);
    }
  }

  /** lumpy ball (foliage) */
  blob(r: number, x: number, y: number, z: number, color: number, tint = 0) {
    const g = new THREE.IcosahedronGeometry(r, 1);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const s = Math.sin(p.getX(i) * 12.9 + p.getY(i) * 78.2 + p.getZ(i) * 37.7 + x * 3.1) * 43758.5;
      const k = 0.82 + 0.36 * (s - Math.floor(s));
      p.setXYZ(i, p.getX(i) * k + x, p.getY(i) * k * 0.9 + y, p.getZ(i) * k + z);
    }
    g.computeVertexNormals();
    this.append(g, color, tint);
    return this;
  }

  /** tapered box: a bottom rectangle at y0 joined to a top rectangle at y1 */
  hull(bottom: Rect, y0: number, top: Rect, y1: number, color: number, tint = 0) {
    const b = [[bottom[0], y0, bottom[2]], [bottom[1], y0, bottom[2]], [bottom[1], y0, bottom[3]], [bottom[0], y0, bottom[3]]];
    const t = [[top[0], y1, top[2]], [top[1], y1, top[2]], [top[1], y1, top[3]], [top[0], y1, top[3]]];
    const c = [(bottom[0] + bottom[1] + top[0] + top[1]) / 4, (y0 + y1) / 2, (bottom[2] + bottom[3] + top[2] + top[3]) / 4];
    this.quad(b[0], b[1], b[2], b[3], c, color, tint);
    this.quad(t[0], t[1], t[2], t[3], c, color, tint);
    for (let i = 0; i < 4; i++) this.quad(b[i], b[(i + 1) % 4], t[(i + 1) % 4], t[i], c, color, tint);
    return this;
  }

  build(centre = true): Shape {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.tint, 1));
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    const half: [number, number, number] = [(bb.max.x - bb.min.x) / 2, (bb.max.y - bb.min.y) / 2, (bb.max.z - bb.min.z) / 2];
    if (centre) g.translate(-(bb.max.x + bb.min.x) / 2, -(bb.max.y + bb.min.y) / 2, -(bb.max.z + bb.min.z) / 2);
    return { geometry: g, half };
  }
}

// ------------------------------------------------------------------ vehicles

function wheels(g: Geo, xs: number[], zOut: number, r: number, w = 0.24) {
  for (const x of xs) for (const s of [-1, 1]) {
    g.cyl(r, w, x, r, s * (zOut - w / 2), 'z', TYRE, 0, 8);
    g.cyl(r * 0.55, 0.02, x, r, s * (zOut + 0.006), 'z', 0x8c9094, 0, 6);
  }
}

interface CarSpec {
  L: number; W: number; H: number;
  /** ground clearance and belt-line height */
  ground: number; belt: number;
  /** cabin extent along x at the belt line and at the roof */
  cabin: [number, number]; roof: [number, number];
  wheelR: number; axles: number[];
  /** open cargo bed from x = bed[0] to bed[1] (pickup) */
  bed?: [number, number];
  /** roof light bar (police) */
  lightbar?: boolean;
}

function car(s: CarSpec): Shape {
  const g = new Geo();
  const hl = s.L / 2, hw = s.W / 2;
  // lower body with a slight tumblehome
  g.hull([-hl, hl, -hw, hw], s.ground, [-hl + 0.06, hl - 0.1, -hw + 0.05, hw - 0.05], s.belt, 0xffffff, 1);
  g.box(s.L - 0.3, 0.12, s.W - 0.16, 0, s.ground - 0.02, 0, 0x101012);
  // glasshouse and roof panel
  const gi = 0.1, ri = 0.24;
  g.hull([s.cabin[0], s.cabin[1], -hw + gi, hw - gi], s.belt, [s.roof[0], s.roof[1], -hw + ri, hw - ri], s.H - 0.05, GLASS);
  g.hull([s.roof[0] - 0.03, s.roof[1] + 0.03, -hw + ri - 0.02, hw - ri + 0.02], s.H - 0.06, [s.roof[0] + 0.05, s.roof[1] - 0.05, -hw + ri + 0.04, hw - ri - 0.04], s.H, 0xffffff, 1);
  // pillars
  for (const z of [-1, 1]) {
    const mid = (s.cabin[0] + s.cabin[1]) / 2 - 0.1;
    g.box(0.09, s.H - s.belt - 0.04, 0.05, mid, (s.belt + s.H) / 2 - 0.02, z * (hw - (gi + ri) / 2 - 0.005), 0xffffff, 1);
  }
  if (s.bed) {
    g.box(s.bed[1] - s.bed[0], 0.02, s.W - 0.24, (s.bed[0] + s.bed[1]) / 2, s.belt + 0.012, 0, 0x18191b);
    g.box(0.08, 0.5, s.W - 0.3, s.bed[1] + 0.02, s.belt + 0.2, 0, 0xffffff, 1);
  }
  // lights, grille, bumpers
  const ly = s.belt - 0.2;
  for (const z of [-1, 1]) {
    g.box(0.06, 0.14, 0.36, hl - 0.07, ly, z * (hw - 0.3), 0xf2eedb, 3);
    g.box(0.06, 0.13, 0.34, -hl + 0.03, ly, z * (hw - 0.28), 0x8a1210, 4);
  }
  if (s.lightbar) {
    g.box(0.3, 0.06, 1.0, (s.roof[0] + s.roof[1]) / 2, s.H + 0.03, 0, 0x1a1a1c);
    g.box(0.26, 0.12, 0.46, (s.roof[0] + s.roof[1]) / 2, s.H + 0.1, -0.26, 0xff1a10, 2);
    g.box(0.26, 0.12, 0.46, (s.roof[0] + s.roof[1]) / 2, s.H + 0.1, 0.26, 0x1a48ff, 2);
    // door markings
    for (const z of [-1, 1]) g.box(1.5, 0.3, 0.02, 0.0, s.belt - 0.28, z * (hw + 0.002), 0x1c2a52);
  }
  g.box(0.06, 0.2, s.W * 0.42, hl - 0.07, ly - 0.02, 0, 0x121315);
  g.box(0.12, 0.16, s.W - 0.06, hl - 0.04, s.ground + 0.1, 0, 0x1d1e20);
  g.box(0.12, 0.16, s.W - 0.06, -hl + 0.04, s.ground + 0.1, 0, 0x1d1e20);
  wheels(g, s.axles, hw + 0.01, s.wheelR);
  return g.build();
}

const sedan = () => car({ L: 4.6, W: 1.82, H: 1.45, ground: 0.24, belt: 0.95, cabin: [-1.55, 0.95], roof: [-0.95, 0.3], wheelR: 0.33, axles: [-1.38, 1.42] });
const suv = () => car({ L: 4.85, W: 1.94, H: 1.78, ground: 0.3, belt: 1.08, cabin: [-2.3, 0.85], roof: [-2.12, 0.28], wheelR: 0.38, axles: [-1.42, 1.5] });
const police = () => car({ L: 4.9, W: 1.9, H: 1.5, ground: 0.24, belt: 0.98, cabin: [-1.6, 1.0], roof: [-1.0, 0.3], wheelR: 0.35, axles: [-1.5, 1.52], lightbar: true });
const pickup = () => car({ L: 5.75, W: 2.02, H: 1.9, ground: 0.36, belt: 1.14, cabin: [-0.55, 1.25], roof: [-0.42, 0.68], wheelR: 0.41, axles: [-1.8, 1.85], bed: [-2.8, -0.62] });

function van(): Shape {
  const g = new Geo();
  // cab
  g.hull([1.1, 3.35, -1.05, 1.05], 0.42, [1.1, 3.28, -1.02, 1.02], 1.35, 0xffffff, 1);
  g.hull([1.15, 3.2, -0.98, 0.98], 1.35, [1.15, 2.55, -0.9, 0.9], 2.2, GLASS);
  g.box(1.45, 0.06, 1.84, 1.85, 2.22, 0, 0xffffff, 1);
  // cargo box
  g.box(4.6, 2.45, 2.36, -1.25, 2.02, 0, 0xe9e7e0);
  g.box(4.6, 0.06, 2.4, -1.25, 0.8, 0, 0x55585c);
  g.box(0.04, 2.3, 2.2, -3.56, 2.0, 0, 0xc9c7c0);
  g.box(4.4, 0.3, 0.9, -1.25, 0.6, 0, 0x1a1b1d);
  for (const z of [-1, 1]) { g.box(0.06, 0.16, 0.34, 3.33, 0.95, z * 0.75, 0xf2eedb, 3); g.box(0.05, 0.3, 0.14, -3.57, 1.0, z * 1.05, 0x8a1210, 4); }
  g.box(0.12, 0.2, 2.1, 3.32, 0.5, 0, 0x1d1e20);
  wheels(g, [-2.2, 2.4], 1.12, 0.44, 0.3);
  return g.build();
}

function bus(): Shape {
  const g = new Geo();
  const L = 11, hw = 1.25;
  g.box(L, 2.55, hw * 2, 0, 0.45 + 1.275, 0, 0xffffff, 1);
  g.box(L - 0.4, 0.2, hw * 2 - 0.2, 0, 0.42, 0, 0x151617);
  // window band, windscreen, rear window
  for (const z of [-1, 1]) g.box(L - 1.5, 0.85, 0.03, -0.2, 2.15, z * (hw + 0.005), GLASS);
  g.box(0.03, 1.25, hw * 2 - 0.3, L / 2 + 0.005, 1.95, 0, GLASS);
  g.box(0.03, 0.7, hw * 2 - 0.5, -L / 2 - 0.005, 2.2, 0, GLASS);
  for (const z of [-1, 1]) {
    g.box(0.05, 0.16, 0.3, L / 2 + 0.01, 0.85, z * 0.9, 0xf2eedb, 3);
    g.box(0.05, 0.3, 0.16, -L / 2 - 0.01, 1.0, z * 0.95, 0x8a1210, 4);
    g.box(L, 0.1, 0.02, 0, 1.45, z * (hw + 0.008), 0x1a1a1a);
  }
  g.box(0.16, 0.26, hw * 2 + 0.04, L / 2, 0.5, 0, 0x1d1e20);
  wheels(g, [-3.2, 3.6], hw + 0.01, 0.5, 0.32);
  return g.build();
}

function semi(): Shape {
  const g = new Geo();
  // trailer
  g.box(13.6, 2.75, 2.58, -1.6, 1.3 + 1.375, 0, 0xe6e4de);
  g.box(13.6, 0.12, 2.5, -1.6, 1.26, 0, 0x4a4d50);
  g.box(0.04, 2.6, 2.4, -8.41, 2.65, 0, 0xbdbbb4);
  for (const z of [-1, 1]) g.box(13.6, 0.08, 0.02, -1.6, 1.42, z * 1.3, 0x8a1c14);
  // tractor
  g.hull([5.6, 8.3, -1.22, 1.22], 0.55, [5.6, 8.2, -1.2, 1.2], 1.75, 0xffffff, 1);
  g.hull([5.65, 7.45, -1.16, 1.16], 1.75, [5.65, 7.05, -1.08, 1.08], 2.9, GLASS);
  g.box(1.75, 1.15, 2.3, 6.3, 3.4, 0, 0xffffff, 1);
  g.box(1.3, 0.25, 2.2, 5.0, 1.05, 0, 0x202123);
  for (const z of [-1, 1]) { g.box(0.06, 0.2, 0.36, 8.3, 1.0, z * 0.9, 0xf2eedb, 3); g.box(0.05, 0.2, 0.3, -8.42, 1.1, z * 1.0, 0x8a1210, 4); }
  g.box(0.08, 0.7, 1.3, 8.3, 1.2, 0, 0x8d9195);
  g.box(0.14, 0.24, 2.44, 8.28, 0.55, 0, 0x1d1e20);
  for (const z of [-1, 1]) g.cyl(0.07, 2.4, 5.45, 2.6, z * 1.0, 'y', STEEL, 0, 6);
  wheels(g, [7.3, 5.2, 4.0, -6.2, -7.5], 1.26, 0.52, 0.5);
  return g.build();
}

function ambulance(): Shape {
  const g = new Geo();
  g.hull([1.3, 3.2, -1.02, 1.02], 0.42, [1.3, 3.12, -1.0, 1.0], 1.35, 0xffffff, 1);
  g.hull([1.35, 3.05, -0.96, 0.96], 1.35, [1.35, 2.5, -0.88, 0.88], 2.15, GLASS);
  g.box(1.25, 0.06, 1.8, 1.92, 2.17, 0, 0xffffff, 1);
  // patient module with a red band
  g.box(3.9, 2.05, 2.2, -0.75, 1.75, 0, 0xf4f3ee);
  for (const z of [-1, 1]) g.box(3.9, 0.3, 0.02, -0.75, 1.45, z * 1.105, 0xc0221a);
  g.box(0.02, 0.3, 2.2, -2.705, 1.45, 0, 0xc0221a);
  g.box(3.7, 0.3, 0.9, -0.75, 0.58, 0, 0x1a1b1d);
  g.box(0.34, 0.14, 0.5, 1.5, 2.86, -0.6, 0xff1a10, 2);
  g.box(0.34, 0.14, 0.5, 1.5, 2.86, 0.6, 0xff1a10, 2);
  g.box(0.2, 0.12, 0.5, -2.55, 2.84, -0.7, 0xff1a10, 2);
  g.box(0.2, 0.12, 0.5, -2.55, 2.84, 0.7, 0xffffff, 2);
  for (const z of [-1, 1]) { g.box(0.06, 0.16, 0.34, 3.18, 0.95, z * 0.72, 0xf2eedb, 3); g.box(0.05, 0.3, 0.14, -2.72, 1.0, z * 0.98, 0x8a1210, 4); }
  g.box(0.12, 0.2, 2.04, 3.17, 0.5, 0, 0x1d1e20);
  wheels(g, [-1.6, 2.3], 1.08, 0.4, 0.28);
  return g.build();
}

function fireTruck(): Shape {
  const g = new Geo();
  const hw = 1.25;
  // crew cab
  g.hull([1.6, 4.5, -hw, hw], 0.5, [1.6, 4.42, -hw + 0.02, hw - 0.02], 1.7, 0xffffff, 1);
  g.hull([1.7, 4.35, -hw + 0.06, hw - 0.06], 1.7, [1.7, 3.95, -hw + 0.14, hw - 0.14], 2.75, GLASS);
  g.box(2.3, 0.08, 2.24, 2.85, 2.79, 0, 0xffffff, 1);
  // pump body with lockers, hose bed and ladder
  g.box(6.0, 2.2, hw * 2, -1.45, 1.6, 0, 0xffffff, 1);
  for (const z of [-1, 1]) for (let k = 0; k < 4; k++) g.box(1.2, 1.3, 0.02, -3.7 + k * 1.45, 1.45, z * (hw + 0.004), 0xb9bcbe);
  g.box(6.0, 0.14, hw * 2 + 0.04, -1.45, 0.52, 0, 0xc9cbcc);
  g.box(6.4, 0.16, 0.5, -1.2, 2.86, 0, 0xb4b7b9);
  for (let k = 0; k < 9; k++) g.box(0.05, 0.05, 0.5, -4.2 + k * 0.75, 2.97, 0, 0x8f9294);
  g.box(0.5, 0.16, 1.5, 3.3, 2.92, 0, 0x1a1a1c);
  g.box(0.42, 0.14, 0.6, 3.3, 3.02, -0.42, 0xff1a10, 2);
  g.box(0.42, 0.14, 0.6, 3.3, 3.02, 0.42, 0xff1a10, 2);
  g.box(0.2, 0.14, 0.5, -4.4, 2.78, -0.8, 0xff1a10, 2);
  g.box(0.2, 0.14, 0.5, -4.4, 2.78, 0.8, 0xffb010, 2);
  for (const z of [-1, 1]) { g.box(0.06, 0.2, 0.36, 4.5, 1.0, z * 0.9, 0xf2eedb, 3); g.box(0.05, 0.24, 0.2, -4.47, 1.1, z * 1.0, 0x8a1210, 4); }
  g.box(0.16, 0.3, hw * 2 + 0.04, 4.48, 0.6, 0, 0xc9cbcc);
  wheels(g, [3.3, -2.6, -3.8], hw + 0.01, 0.5, 0.36);
  return g.build();
}

// ------------------------------------------------------------------ house contents

function sofa(): Shape {
  const g = new Geo();
  g.box(2.0, 0.24, 0.9, 0, 0.3, 0, 0xffffff, 1);
  g.box(1.62, 0.16, 0.66, 0, 0.5, 0.08, 0xe8e8e8, 1);
  g.box(2.0, 0.5, 0.22, 0, 0.67, -0.34, 0xffffff, 1);
  for (const x of [-1, 1]) g.box(0.2, 0.42, 0.9, x * 0.9, 0.45, 0, 0xf2f2f2, 1);
  for (const x of [-1, 1]) for (const z of [-1, 1]) g.box(0.07, 0.18, 0.07, x * 0.9, 0.09, z * 0.36, WOOD_DARK);
  return g.build();
}

function bed(): Shape {
  const g = new Geo();
  g.box(2.05, 0.26, 1.55, 0, 0.23, 0, WOOD_DARK);
  g.box(1.96, 0.24, 1.46, 0, 0.48, 0, 0xe9e5db);
  g.box(1.3, 0.05, 1.5, 0.34, 0.62, 0, 0xffffff, 1);
  g.box(0.08, 0.95, 1.58, -1.02, 0.52, 0, WOOD_DARK);
  for (const z of [-1, 1]) g.box(0.42, 0.1, 0.56, -0.7, 0.65, z * 0.37, 0xf4f1ea);
  for (const x of [-1, 1]) for (const z of [-1, 1]) g.box(0.08, 0.1, 0.08, x * 0.95, 0.05, z * 0.7, WOOD_DARK);
  return g.build();
}

function fridge(): Shape {
  const g = new Geo();
  g.box(0.74, 1.76, 0.8, 0, 0.9, 0, 0xffffff, 1);
  g.box(0.02, 0.012, 0.78, 0.376, 1.26, 0, 0x202020);
  g.box(0.04, 0.34, 0.03, 0.39, 1.48, 0.3, 0x55585c);
  g.box(0.04, 0.5, 0.03, 0.39, 0.92, 0.3, 0x55585c);
  g.box(0.02, 1.5, 0.66, -0.375, 0.9, 0, 0x8a8d8f);
  return g.build();
}

function washer(): Shape {
  const g = new Geo();
  g.box(0.66, 0.88, 0.62, 0, 0.44, 0, 0xffffff, 1);
  g.cyl(0.2, 0.03, 0.335, 0.42, 0, 'x', 0x24282c, 0, 12);
  g.cyl(0.23, 0.02, 0.332, 0.42, 0, 'x', 0xb9bdc0, 0, 12);
  g.box(0.03, 0.1, 0.56, 0.335, 0.8, 0, 0x3a3d40);
  return g.build();
}

function table(): Shape {
  const g = new Geo();
  g.box(1.6, 0.05, 0.9, 0, 0.745, 0, 0xffffff, 1);
  for (const x of [-1, 1]) for (const z of [-1, 1]) g.box(0.07, 0.72, 0.07, x * 0.72, 0.36, z * 0.37, 0xd8d8d8, 1);
  g.box(1.36, 0.08, 0.03, 0, 0.68, 0.37, 0xd8d8d8, 1);
  g.box(1.36, 0.08, 0.03, 0, 0.68, -0.37, 0xd8d8d8, 1);
  return g.build();
}

function chair(): Shape {
  const g = new Geo();
  g.box(0.44, 0.05, 0.44, 0, 0.455, 0, 0xffffff, 1);
  g.box(0.04, 0.5, 0.44, -0.2, 0.74, 0, 0xffffff, 1);
  for (const x of [-1, 1]) for (const z of [-1, 1]) g.box(0.04, 0.44, 0.04, x * 0.19, 0.22, z * 0.19, 0xcfcfcf, 1);
  return g.build();
}

function bathtub(): Shape {
  const g = new Geo();
  g.hull([-0.72, 0.72, -0.31, 0.31], 0.02, [-0.8, 0.8, -0.38, 0.38], 0.56, 0xeeeeea);
  g.box(1.42, 0.012, 0.58, 0, 0.562, 0, 0x8f9496);
  g.cyl(0.02, 0.2, -0.74, 0.66, 0, 'y', STEEL, 0, 6);
  return g.build();
}

function cabinet(): Shape {
  const g = new Geo();
  g.box(1.1, 1.9, 0.55, 0, 0.95, 0, 0xffffff, 1);
  g.box(0.015, 1.8, 0.012, 0, 0.95, 0.281, 0x1c1410);
  for (const x of [-1, 1]) g.box(0.03, 0.2, 0.03, x * 0.07, 0.98, 0.29, STEEL);
  g.box(1.14, 0.05, 0.58, 0, 1.925, 0, 0xe2e2e2, 1);
  return g.build();
}

// ------------------------------------------------------------------ structure pieces

/** A length of gable roof torn off in one piece: sheathing and shingles on rafters. */
function roofSection(): Shape {
  const g = new Geo();
  const len = 4.2, span = 5.6, rise = 1.45;
  const slope = Math.hypot(span / 2, rise), ang = Math.atan2(rise, span / 2);
  for (const s of [-1, 1]) {
    const cz = (s * span) / 4, cy = rise / 2;
    g.box(len, 0.035, slope + 0.25, 0, cy + 0.075, cz, 0xffffff, 1, s * ang);
    g.box(len - 0.05, 0.03, slope + 0.2, 0, cy + 0.04, cz, WOOD, 0, s * ang);
    for (let k = -3; k <= 3; k++) g.box(0.045, 0.14, slope, (k * (len - 0.2)) / 6, cy - 0.045, cz, WOOD, 0, s * ang);
  }
  for (let k = -3; k <= 3; k += 2) g.box(0.045, 0.14, span - 0.3, (k * (len - 0.2)) / 6, 0.07, 0, WOOD);
  return g.build();
}

function hvac(): Shape {
  const g = new Geo();
  g.box(2.2, 1.3, 1.5, 0, 0.75, 0, 0xb9bcbb);
  g.box(2.24, 0.1, 1.54, 0, 0.08, 0, 0x55585a);
  g.cyl(0.5, 0.06, -0.45, 1.43, 0, 'y', 0x2b2d2f, 0, 12);
  g.cyl(0.5, 0.06, 0.6, 1.43, 0, 'y', 0x2b2d2f, 0, 12);
  g.box(0.02, 0.9, 1.2, 1.105, 0.8, 0, 0x6a6e70);
  return g.build();
}

// ------------------------------------------------------------------ outdoor objects

function bin(): Shape {
  const g = new Geo();
  g.hull([-0.25, 0.25, -0.24, 0.24], 0.1, [-0.36, 0.36, -0.29, 0.29], 1.0, 0xffffff, 1);
  g.box(0.78, 0.05, 0.62, -0.02, 1.03, 0, 0xd9d9d9, 1);
  g.cyl(0.1, 0.56, -0.3, 0.1, 0, 'z', TYRE, 0, 8);
  g.box(0.05, 0.05, 0.5, -0.4, 0.98, 0, 0x1a1a1a);
  return g.build();
}

function dumpster(): Shape {
  const g = new Geo();
  g.hull([-0.82, 0.82, -0.5, 0.5], 0.14, [-0.96, 0.96, -0.6, 0.6], 1.2, 0xffffff, 1);
  g.box(0.94, 0.04, 1.22, -0.48, 1.26, 0, 0x1b1c1d, 0, 0, 0, 0.1);
  g.box(0.94, 0.04, 1.22, 0.48, 1.26, 0, 0x1b1c1d, 0, 0, 0, -0.1);
  for (const x of [-1, 1]) g.box(0.08, 0.14, 1.3, x * 0.98, 0.9, 0, 0x2a2b2c);
  for (const x of [-1, 1]) for (const z of [-1, 1]) g.cyl(0.08, 0.06, x * 0.7, 0.08, z * 0.42, 'z', TYRE, 0, 6);
  return g.build();
}

function trampoline(): Shape {
  const g = new Geo();
  g.cyl(2.0, 0.07, 0, 0.84, 0, 'y', 0x1f4f9a, 0, 18);
  g.cyl(1.72, 0.02, 0, 0.885, 0, 'y', 0x0d0d0e, 0, 18);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    g.box(0.045, 0.82, 0.045, Math.cos(a) * 1.85, 0.41, Math.sin(a) * 1.85, STEEL);
    g.box(0.03, 1.7, 0.03, Math.cos(a) * 1.97, 1.72, Math.sin(a) * 1.97, 0x2a2c2e);
  }
  return g.build();
}

function shed(): Shape {
  const g = new Geo();
  const L = 3.0, W = 2.4, wall = 1.95, rise = 0.55;
  g.box(L, wall, W, 0, wall / 2, 0, 0xffffff, 1);
  const slope = Math.hypot(W / 2, rise), ang = Math.atan2(rise, W / 2);
  for (const s of [-1, 1]) g.box(L + 0.3, 0.05, slope + 0.18, 0, wall + rise / 2 + 0.02, (s * W) / 4, 0x4a4744, 0, s * ang);
  for (const x of [-1, 1]) g.hull([x * (L / 2) - 0.01, x * (L / 2) + 0.01, -W / 2, W / 2], wall, [x * (L / 2) - 0.01, x * (L / 2) + 0.01, -0.02, 0.02], wall + rise, 0xf0f0f0, 1);
  g.box(0.03, 1.75, 1.2, L / 2 + 0.01, 0.9, 0, 0xd8d8d8, 1);
  g.box(0.04, 1.75, 0.02, L / 2 + 0.02, 0.9, 0, 0x1c1c1c);
  return g.build();
}

function container(): Shape {
  const g = new Geo();
  const L = 12.19, W = 2.44, H = 2.59;
  g.box(L, H, W, 0, H / 2, 0, 0xffffff, 1);
  for (let k = 0; k < 20; k++) {
    const x = -L / 2 + 0.45 + k * 0.595;
    for (const z of [-1, 1]) g.box(0.2, H - 0.3, 0.04, x, H / 2, z * (W / 2 + 0.012), 0xdedede, 1);
  }
  for (const z of [-1, 1]) for (const y of [0.08, H - 0.08]) g.box(L + 0.02, 0.16, 0.06, 0, y, z * (W / 2 + 0.02), 0xc4c4c4, 1);
  for (const z of [-0.6, 0.6]) g.cyl(0.025, H - 0.3, L / 2 + 0.03, H / 2, z, 'y', STEEL, 0, 6);
  g.box(0.02, H - 0.2, 0.02, L / 2 + 0.012, H / 2, 0, 0x1a1a1a);
  return g.build();
}

/** The crown of a snapped tree with a length of trunk, carried off whole. */
function treeTop(): Shape {
  const g = new Geo();
  g.cyl(0.17, 2.4, 0, 1.2, 0, 'y', 0x4a3b2c, 0, 6, 0.12);
  g.blob(1.5, 0, 3.3, 0, 0xffffff, 1);
  g.blob(1.1, 1.0, 3.0, 0.4, 0xe6e6e6, 1);
  g.blob(1.15, -0.9, 3.4, -0.7, 0xf0f0f0, 1);
  g.blob(1.0, 0.1, 4.2, -0.2, 0xdcdcdc, 1);
  return g.build();
}

function tyre(): Shape {
  const g = new Geo();
  g.cyl(0.34, 0.22, 0, 0.34, 0, 'z', TYRE, 0, 10);
  g.cyl(0.19, 0.225, 0, 0.34, 0, 'z', 0x8c9094, 0, 8);
  return g.build();
}

/** Street sign on a steel post. */
function sign(): Shape {
  const g = new Geo();
  g.cyl(0.03, 2.5, 0, 1.25, 0, 'y', 0x8f9496, 0, 5);
  g.cyl(0.38, 0.02, 0.03, 2.25, 0, 'x', 0xffffff, 1, 8);
  g.cyl(0.3, 0.022, 0.032, 2.25, 0, 'x', 0xf2f2ee, 0, 8);
  g.cyl(0.38, 0.01, 0.018, 2.25, 0, 'x', 0x9a9d9f, 0, 8);
  return g.build();
}

/** Standing 2.4 m length of timber privacy fence (rails and posts included). */
function fence(): Shape {
  const g = new Geo();
  g.box(2.4, 1.75, 0.02, 0, 0.92, 0, 0xffffff, 1);
  for (let k = -1; k <= 1; k++) g.box(0.014, 1.75, 0.03, k * 0.6, 0.92, 0.012, 0xb4b4b4, 1);
  for (const y of [0.4, 1.5]) g.box(2.4, 0.09, 0.04, 0, y, -0.03, 0xdcdcdc, 1);
  g.box(0.09, 1.9, 0.09, -1.2, 0.95, -0.05, 0xd2d2d2, 1);
  return g.build();
}

// ------------------------------------------------------------------ street furniture (not centred: base at y = 0)

/** Timber distribution pole with cross-arm, insulators and a pole-top transformer. */
export function makeUtilityPole(): THREE.BufferGeometry {
  const g = new Geo();
  g.cyl(0.16, 10.5, 0, 5.25, 0, 'y', 0x5b4633, 0, 7, 0.11);
  g.box(0.1, 0.12, 2.4, 0, 9.6, 0, 0x5b4633);
  for (const z of [-1.05, 0, 1.05]) g.cyl(0.035, 0.16, 0, 9.74, z, 'y', 0x6f8f9a, 0, 6);
  g.cyl(0.24, 0.75, 0.3, 8.3, 0, 'y', 0x7d8588, 0, 8);
  g.box(0.06, 0.06, 1.6, 0, 7.1, 0, 0x5b4633);
  return g.build(false).geometry;
}

/** Steel street light: 9 m column with a 2 m outreach arm and LED head. */
export function makeStreetLight(): THREE.BufferGeometry {
  const g = new Geo();
  g.cyl(0.1, 9, 0, 4.5, 0, 'y', 0x6f7577, 0, 7, 0.06);
  g.box(2.1, 0.07, 0.07, 1.0, 8.95, 0, 0x6f7577, 0, 0, 0, 0.08);
  g.box(0.62, 0.1, 0.26, 2.05, 9.02, 0, 0x4a4e50);
  g.box(0.5, 0.02, 0.2, 2.05, 8.96, 0, 0xffffff, 1);
  g.cyl(0.17, 0.3, 0, 0.15, 0, 'y', 0x55595b, 0, 7);
  return g.build(false).geometry;
}

export const SHAPES = {
  sedan, suv, pickup, van, bus, semi, police, ambulance, fireTruck,
  sofa, bed, fridge, washer, table, chair, bathtub, cabinet,
  roofSection, hvac, bin, dumpster, trampoline, shed, container, fence, treeTop, tyre, sign,
};
export type ShapeName = keyof typeof SHAPES;
