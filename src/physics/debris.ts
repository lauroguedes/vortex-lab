// Wind-borne debris: every piece is integrated with quadratic aerodynamic drag
//     dv/dt = b |u - v| (u - v) - g,     b = ρ Cd A / 2m   [1/m]
// so its behaviour is set by one physical number per debris class. The terminal
// fall speed is sqrt(g/b): a piece is lofted when the updraft exceeds it.
//
// Small pieces (shingles, lumber, sheet metal…) are instanced boxes. Recognisable
// objects (vehicles, furniture, roof sections, street furniture) each get their
// own instanced model from world/shapes.ts but share exactly the same physics.

import * as THREE from 'three';
import { env, LIGHT_GLSL } from '../render/environment';
import { SHAPES, type ShapeName } from '../world/shapes';
import { GRAV, type Tornado } from './tornado';

export const enum DebrisType {
  // box pieces
  Shingle, Plywood, Lumber, Masonry, SheetMetal, Light, Branch, Glass, Door, WallPanel, RoofPanel,
  // vehicles
  Sedan, Suv, Pickup, Van, Bus, Semi, Police, Ambulance, FireTruck,
  // house contents
  Sofa, Bed, Fridge, Washer, Table, Chair, Bathtub, Cabinet,
  // structure and outdoor objects
  RoofSection, Hvac, Bin, Dumpster, Trampoline, Shed, Container, Fence, TreeTop, Tyre, Sign,
  COUNT,
}

interface Spec {
  /** model name; omitted for plain box pieces */
  shape?: ShapeName;
  /** box pieces: metres (x long, y thin, z wide) */
  size?: [number, number, number];
  /** ballistic coefficient ρ·Cd·A / 2m (1/m) */
  b: number;
  /** lift-to-drag ratio near the ground (plates fly, bricks don't) */
  lift: number;
  /** fraction of the drag area exposed (and not held down) when lying on the ground */
  rest: number;
  colors: number[];
  /** instances reserved for a shaped object */
  pool?: number;
  /** quarter-turns about the long axis the object may come to rest in */
  poses?: number[];
  vehicle?: boolean;
  /** draw a soft contact shadow while resting */
  shadow?: boolean;
}

const PAINT = [0xe9e9e6, 0xe9e9e6, 0xe9e9e6, 0x1b1c1e, 0x1b1c1e, 0x8d9296, 0x8d9296, 0x55595e, 0x55595e, 0x7c2a26, 0x23406e, 0x6f6a5c, 0x1c3a2c, 0x9a4a1e];
const TIMBER = [0x8a6a44, 0x5a3f28, 0xb89468, 0xe5e2da];
const ROLL = [0, 0, 0, 1, 2, 3]; // vehicles end up on their wheels, side or roof

// Masses / areas behind the ballistic coefficients:
//   asphalt shingle strip 1.2 kg · 12 mm plywood sheet 22 kg · 2x4 stud 6.8 kg (the "15 lb missile")
//   brick cluster 8 kg · corrugated steel panel 12 kg · interior door 25 kg · framed wall panel 110 kg
//   sedan 1500 kg, 6.7 m² side area · SUV 2100 kg · pickup 2300 kg · box truck 4.5 t · bus 11 t · semi 14 t
//   sofa 45 kg · bed 30 kg · refrigerator 110 kg · washer 75 kg · table 25 kg · chair 6 kg · bathtub 40 kg
//   roof section (trusses + deck) 15 kg/m² · wheelie bin 12 kg · dumpster 250 kg · trampoline 80 kg, 12 m²
//   garden shed 250 kg · empty 40 ft container 3.8 t · fence panel 30 kg · tree crown 300 kg, 15 m²
//   wheel and tyre 20 kg · street sign 12 kg
const SPECS: Record<number, Spec> = {
  [DebrisType.Shingle]: { size: [1.3, 0.06, 0.55], b: 0.08, lift: 0.9, rest: 0.15, colors: [0x3f3d3b, 0x4d443c, 0x55504b, 0x2f3033] },
  [DebrisType.Plywood]: { size: [2.4, 0.08, 1.2], b: 0.055, lift: 0.85, rest: 0.18, colors: [0xb08d5e, 0xc2a273, 0x9a7b52, 0xd6cdbb] },
  [DebrisType.Lumber]: { size: [3.6, 0.12, 0.16], b: 0.018, lift: 0.3, rest: 0.4, colors: [0xc9a56e, 0xb48e5b, 0xa07c4e] },
  [DebrisType.Masonry]: { size: [0.7, 0.45, 0.55], b: 0.0058, lift: 0.12, rest: 0.6, colors: [0x8a4b3a, 0x9a5a48, 0x8d8a84, 0x6f6a64] },
  [DebrisType.SheetMetal]: { size: [3.0, 0.05, 0.95], b: 0.095, lift: 1.0, rest: 0.15, colors: [0xa9b0b4, 0x8f979c, 0xc3c7c8, 0x7b8a94] },
  [DebrisType.Light]: { size: [0.7, 0.05, 0.5], b: 0.45, lift: 0.8, rest: 0.5, colors: [0xe6c9d2, 0xf0e6c0, 0xd8d8d2, 0xc7b79b] },
  [DebrisType.Branch]: { size: [2.6, 0.22, 0.5], b: 0.06, lift: 0.4, rest: 0.4, colors: [0x4a3a2a, 0x3d4a2a, 0x54452f, 0x40552b] },
  [DebrisType.Glass]: { size: [0.9, 0.04, 0.6], b: 0.03, lift: 0.4, rest: 0.2, colors: [0x9fb6bd, 0x86a0aa, 0xb9c8cc] },
  [DebrisType.Door]: { size: [2.05, 0.045, 0.9], b: 0.044, lift: 0.8, rest: 0.2, colors: [0xe8e4da, 0x6b4a2c, 0x8a2f26, 0x3a4658, 0xd9d2c0] },
  [DebrisType.WallPanel]: { size: [3.6, 0.14, 2.5], b: 0.059, lift: 0.9, rest: 0.15, colors: [0xd9d2c3, 0xc8bfae, 0xb9a58c] },
  [DebrisType.RoofPanel]: { size: [4.0, 0.1, 2.4], b: 0.086, lift: 1.0, rest: 0.14, colors: [0x6e6c68, 0x8a8780, 0x9da1a3, 0xb9b9b4] },

  // a tumbling vehicle is a bluff body (Cd ~1.8 on its side area): terminal fall speed ~45 m/s, so only the
  // updraft of a violent (EF4+) vortex can carry one aloft; weaker tornadoes roll and toss them
  [DebrisType.Sedan]: { shape: 'sedan', b: 0.0048, lift: 0.55, rest: 0.54, colors: PAINT, pool: 1500, poses: ROLL, vehicle: true, shadow: true },
  [DebrisType.Suv]: { shape: 'suv', b: 0.0045, lift: 0.52, rest: 0.58, colors: PAINT, pool: 1100, poses: ROLL, vehicle: true, shadow: true },
  [DebrisType.Pickup]: { shape: 'pickup', b: 0.0046, lift: 0.52, rest: 0.56, colors: PAINT, pool: 700, poses: ROLL, vehicle: true, shadow: true },
  [DebrisType.Van]: { shape: 'van', b: 0.0048, lift: 0.45, rest: 0.74, colors: [0xe9e9e6, 0xe9e9e6, 0xd8c23a, 0x2a4a7a, 0x8d9296], pool: 300, poses: [0, 1, 3, 1, 3, 2], vehicle: true, shadow: true },
  [DebrisType.Bus]: { shape: 'bus', b: 0.0034, lift: 0.35, rest: 0.7, colors: [0xc2261c, 0xe2a81c, 0xe9e9e6, 0x2a5a9a, 0x2f7a4a], pool: 140, poses: [0, 1, 3, 1, 3], vehicle: true, shadow: true },
  [DebrisType.Semi]: { shape: 'semi', b: 0.0048, lift: 0.4, rest: 0.74, colors: [0xb82a22, 0x1f3f7a, 0xe9e9e6, 0x1b1c1e, 0x2f6a3a], pool: 90, poses: [0, 1, 3, 1, 3], vehicle: true, shadow: true },
  [DebrisType.Police]: { shape: 'police', b: 0.0048, lift: 0.55, rest: 0.54, colors: [0xe9e9e6, 0x1b1c1e, 0x1f3f7a], pool: 24, poses: ROLL, vehicle: true, shadow: true },
  [DebrisType.Ambulance]: { shape: 'ambulance', b: 0.0048, lift: 0.45, rest: 0.74, colors: [0xf2f2ee], pool: 16, poses: [0, 1, 3, 1, 3, 2], vehicle: true, shadow: true },
  [DebrisType.FireTruck]: { shape: 'fireTruck', b: 0.0034, lift: 0.35, rest: 0.7, colors: [0xb8201a], pool: 16, poses: [0, 1, 3, 1, 3], vehicle: true, shadow: true },

  [DebrisType.Sofa]: { shape: 'sofa', b: 0.026, lift: 0.5, rest: 0.5, colors: [0x6b6f76, 0x8a7a66, 0x3a4658, 0x7a3b34, 0xb9ae9c, 0x4a5a48], pool: 1000, poses: [0, 1, 2, 3] },
  [DebrisType.Bed]: { shape: 'bed', b: 0.05, lift: 0.8, rest: 0.4, colors: [0x2f4a6e, 0x8a2f3a, 0xd9d2c0, 0x4a6a52, 0x6a5a8a, 0xb8b8b8], pool: 1000, poses: [0, 2, 0, 1] },
  [DebrisType.Fridge]: { shape: 'fridge', b: 0.0076, lift: 0.2, rest: 0.8, colors: [0xeeeeee, 0xeeeeee, 0xb4b8ba, 0x222426], pool: 450, poses: [1, 3, 1, 3, 0] },
  [DebrisType.Washer]: { shape: 'washer', b: 0.0055, lift: 0.15, rest: 0.8, colors: [0xf0f0f0, 0xdadada], pool: 550, poses: [0, 1, 2, 3] },
  [DebrisType.Table]: { shape: 'table', b: 0.03, lift: 0.6, rest: 0.6, colors: TIMBER, pool: 800, poses: [0, 1, 2, 3] },
  [DebrisType.Chair]: { shape: 'chair', b: 0.035, lift: 0.5, rest: 0.7, colors: TIMBER, pool: 2000, poses: [0, 1, 2, 3] },
  [DebrisType.Bathtub]: { shape: 'bathtub', b: 0.012, lift: 0.2, rest: 0.7, colors: [0xffffff], pool: 300, poses: [0, 2, 1, 3] },
  [DebrisType.Cabinet]: { shape: 'cabinet', b: 0.028, lift: 0.4, rest: 0.7, colors: [0x8a6a44, 0x5a3f28, 0xe8e4da, 0xb89468], pool: 600, poses: [1, 3] },

  [DebrisType.RoofSection]: { shape: 'roofSection', b: 0.04, lift: 1.0, rest: 0.2, colors: [0x4a4744, 0x5a4c41, 0x3d3f42], pool: 1200, poses: [0, 0, 2, 1, 3] },
  [DebrisType.Hvac]: { shape: 'hvac', b: 0.008, lift: 0.2, rest: 0.5, colors: [0xffffff], pool: 300, poses: [0, 1, 2, 3] },
  [DebrisType.Bin]: { shape: 'bin', b: 0.033, lift: 0.4, rest: 0.5, colors: [0x2f5a32, 0x24426e, 0x222325, 0x5a4a36], pool: 900, poses: [1, 3] },
  [DebrisType.Dumpster]: { shape: 'dumpster', b: 0.0055, lift: 0.2, rest: 0.8, colors: [0x2f5a32, 0x24426e, 0x6a3a22], pool: 200, poses: [0, 1, 2, 3], shadow: true },
  [DebrisType.Trampoline]: { shape: 'trampoline', b: 0.1, lift: 1.1, rest: 0.12, colors: [0xffffff], pool: 160, poses: [0, 2, 1, 3] },
  [DebrisType.Shed]: { shape: 'shed', b: 0.017, lift: 0.5, rest: 0.25, colors: [0xcfc6b2, 0x8a5a3a, 0x6f8a6a, 0xb9b9b4, 0x7a2f26], pool: 300, poses: [1, 2, 3], shadow: true },
  [DebrisType.Container]: { shape: 'container', b: 0.0049, lift: 0.15, rest: 0.55, colors: [0x8a3322, 0x224a7a, 0x2f6a4a, 0x9a9d9f, 0xb8862a, 0x6a2a22], pool: 120, poses: [0, 1, 2, 3], shadow: true },
  [DebrisType.TreeTop]: { shape: 'treeTop', b: 0.03, lift: 0.5, rest: 0.5, colors: [0x3f5a2a, 0x4a6630, 0x35502a, 0x566b33], pool: 600, poses: [1, 3] },
  [DebrisType.Tyre]: { shape: 'tyre', b: 0.012, lift: 0.2, rest: 0.8, colors: [0xffffff], pool: 400, poses: [1, 3] },
  [DebrisType.Sign]: { shape: 'sign', b: 0.03, lift: 0.7, rest: 0.11, colors: [0xa81c16, 0xa81c16, 0x1f6a3a, 0xd9b01c, 0x1f4f9a], pool: 700, poses: [1, 3] },
  [DebrisType.Fence]: { shape: 'fence', b: 0.086, lift: 0.8, rest: 0.04, colors: [0xb39a78, 0x9c8462, 0xc4b08e, 0x8a7658, 0xa7a39a], pool: 9000, poses: [1, 3] },
};

const FRICTION = 0.6;
// sine table: debris needs many cheap, smooth pseudo-random oscillations per step
const SIN_N = 4096;
const SIN = new Float32Array(SIN_N);
for (let i = 0; i < SIN_N; i++) SIN[i] = Math.sin((i / SIN_N) * Math.PI * 2);
const K_TAB = SIN_N / (Math.PI * 2);
const fsin = (a: number) => SIN[((a * K_TAB) | 0) & (SIN_N - 1)];
const fcos = (a: number) => SIN[(((a * K_TAB) | 0) + SIN_N / 4) & (SIN_N - 1)];
const tmpColor = new THREE.Color();
const wind = new Float32Array(3);

let sharedMaterial: THREE.ShaderMaterial | null = null;
function debrisMaterial() {
  return (sharedMaterial ??= new THREE.ShaderMaterial({
    uniforms: env,
    vertexShader: /* glsl */ `
      attribute vec3 color;
      attribute float aTint; // 0 own colour, 1 instance paint, 2 emergency beacon, 3 headlight, 4 tail light
      attribute float aLive; // 1 while the vehicle is being driven
      uniform float uTime; uniform float uNight;
      varying vec3 vColor; varying vec3 vNormal; varying vec3 vWorld; varying float vGlow;
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNormal = normalize(mat3(instanceMatrix) * normal);
        vColor = aTint > 0.5 && aTint < 1.5 ? color * instanceColor : color;
        float night = smoothstep(0.05, 0.45, uNight);
        float blink = step(0.5, fract(uTime * 2.6 + step(0.0, position.z) * 0.5 + instanceMatrix[3].x * 0.013));
        vGlow = aLive * (aTint > 3.5 ? 1.5 + 3.0 * night : (aTint > 2.5 ? 0.5 + 3.5 * night : (aTint > 1.5 ? 9.0 * blink : 0.0)));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${LIGHT_GLSL}
      varying vec3 vColor; varying vec3 vNormal; varying vec3 vWorld; varying float vGlow;
      void main() {
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        vec3 v = normalize(cameraPosition - vWorld);
        vec3 c = shade(vColor * (1.0 - 0.18 * uWet), n);
        // faint sheen: paint, glass and wet surfaces pick up the bright horizon
        float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
        c += skyColor(reflect(-v, n)) * fres * (0.05 + 0.12 * uWet);
        c += vColor * vGlow;
        c = applyFog(c, distance(vWorld, cameraPosition));
        gl_FragColor = vec4(c, 1.0);
      }`,
  }));
}

let sharedShadow: { geo: THREE.BufferGeometry; mat: THREE.ShaderMaterial } | null = null;
/** Soft dark decal laid on the ground under objects, standing in for ambient occlusion. */
export function shadowAssets() {
  if (sharedShadow) return sharedShadow;
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vec2 q = abs(vUv - 0.5) * 2.0;
        float d = length(max(q - 0.3, 0.0)) / 0.7;
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.5 * (1.0 - smoothstep(0.0, 1.0, d)));
      }`,
  });
  return (sharedShadow = { geo, mat });
}

export class DebrisSystem {
  readonly mesh: THREE.InstancedMesh;
  readonly shadow: THREE.InstancedMesh | null = null;
  readonly max: number;
  readonly px: Float32Array; readonly py: Float32Array; readonly pz: Float32Array;
  private vx: Float32Array; private vy: Float32Array; private vz: Float32Array;
  private sx: Float32Array; private sy: Float32Array; private sz: Float32Array;
  private ax: Float32Array; private ay: Float32Array; private az: Float32Array;
  private ang: Float32Array; private spin: Float32Array; private phase: Float32Array;
  private yaw: Float32Array;
  private bb: Float32Array; private lift: Float32Array; private rest: Float32Array;
  /** lift of a tumbling (autorotating) body, signed by its sense of rotation */
  private auto: Float32Array;
  /** half height upright, and half height when rolled a quarter turn */
  private hy: Float32Array; private hz: Float32Array;
  /** 0 free, 1 airborne / moving, 2 resting, 3 driven (position set by the traffic simulation) */
  private state: Uint8Array;
  private next = 0;
  private high = 0;
  airborne = 0;
  /** pieces that have ever left the ground (used for the "vehicles thrown" statistic) */
  everMoved = 0;
  private moved: Uint8Array;
  private matrices: Float32Array;
  private shadowM: Float32Array | null = null;
  private shadowDirty = false;
  private dirty = false;
  private live: THREE.InstancedBufferAttribute | null = null;
  /** called when a piece hits the ground hard; return true to remove the piece */
  onImpact: ((x: number, z: number, speed: number, color: THREE.Color) => boolean) | null = null;

  /**
   * @param half half extents of a shaped object, or null for unit boxes scaled per piece
   * @param poses quarter-turns about the long axis a shaped object may rest in
   */
  constructor(geometry: THREE.BufferGeometry, max: number, private half: [number, number, number] | null, private poses: number[] = [0], shadow = false) {
    this.max = max;
    const f = () => new Float32Array(max);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.sx = f(); this.sy = f(); this.sz = f();
    this.ax = f(); this.ay = f(); this.az = f();
    this.ang = f(); this.spin = f(); this.phase = f(); this.yaw = f();
    this.bb = f(); this.lift = f(); this.rest = f(); this.auto = f();
    this.hy = f(); this.hz = f();
    this.state = new Uint8Array(max);
    this.moved = new Uint8Array(max);

    this.mesh = new THREE.InstancedMesh(geometry, debrisMaterial(), max);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.matrices = this.mesh.instanceMatrix.array as Float32Array;
    this.mesh.setColorAt(0, tmpColor.set(0xffffff));
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    if (half) {
      this.live = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
      this.live.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('aLive', this.live);
    }
    if (shadow) {
      const a = shadowAssets();
      this.shadow = new THREE.InstancedMesh(a.geo, a.mat, max);
      this.shadow.frustumCulled = false;
      this.shadow.count = 0;
      this.shadow.renderOrder = -2;
      this.shadowM = this.shadow.instanceMatrix.array as Float32Array;
      this.shadowM.fill(0);
    }
  }

  clear() {
    this.state.fill(0);
    this.moved.fill(0);
    this.matrices.fill(0);
    this.next = 0; this.high = 0; this.airborne = 0; this.everMoved = 0;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.live) { (this.live.array as Float32Array).fill(0); this.live.needsUpdate = true; }
    if (this.shadow) {
      this.shadowM!.fill(0);
      this.shadow.count = 0;
      this.shadow.instanceMatrix.needsUpdate = true;
    }
  }

  private alloc(): number {
    const n = this.max;
    for (let tries = 0; tries < 48; tries++) {
      const i = this.next;
      this.next = (this.next + 1) % n;
      if (this.state[i] === 0) return i;
    }
    // pool exhausted: recycle a piece that has come to rest, else the oldest slot
    for (let tries = 0; tries < 256; tries++) {
      const i = this.next;
      this.next = (this.next + 1) % n;
      if (this.state[i] === 2) return i;
    }
    const i = this.next;
    this.next = (this.next + 1) % n;
    return i;
  }

  /**
   * @param resting place the piece at rest (y < 0 sits it on the ground in the given pose)
   * @param anchor multiplies the wind force needed to dislodge a resting piece (posts, bolts, tie-downs)
   */
  spawn(
    s: Spec, x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    resting = false, yaw = 0, color = -1, scale = 1, pose = 0, anchor = 1,
  ) {
    const i = this.alloc();
    if (i >= this.high) this.high = i + 1;
    if (this.half) {
      const k = scale * (0.96 + Math.random() * 0.08);
      this.sx[i] = this.sy[i] = this.sz[i] = k;
      this.hy[i] = this.half[1] * k; this.hz[i] = this.half[2] * k;
    } else {
      const k = scale * (0.7 + Math.random() * 0.6);
      this.sx[i] = s.size![0] * k; this.sy[i] = s.size![1]; this.sz[i] = s.size![2] * k;
      this.hy[i] = this.sy[i] * 0.5 + 0.03; this.hz[i] = this.sz[i] * 0.5;
    }
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    // lighter-than-average and heavier-than-average pieces of each class
    this.bb[i] = s.b * (0.75 + Math.random() * 0.6);
    this.lift[i] = s.lift * (0.5 + Math.random());
    // an autorotating bluff body carries lift of about half its drag, up or down with its spin (Tachikawa 1983)
    this.auto[i] = this.half ? s.lift * (Math.random() < 0.7 ? 0.5 + 0.4 * Math.random() : -0.4) : 0;
    this.rest[i] = s.rest / anchor;
    this.phase[i] = Math.random() * 6.283;
    this.spin[i] = (Math.random() - 0.5) * (this.half ? 5 : 9);
    this.moved[i] = 0;
    this.yaw[i] = yaw;
    if (resting) {
      this.ax[i] = 1; this.ay[i] = 0; this.az[i] = 0; this.ang[i] = pose * (Math.PI / 2);
      if (y < 0) this.py[i] = pose & 1 ? this.hz[i] : this.hy[i];
      this.state[i] = 2;
    } else {
      const u = Math.random() * 2 - 1, t = Math.random() * 6.283, q = Math.sqrt(1 - u * u);
      this.ax[i] = q * Math.cos(t); this.ay[i] = u; this.az[i] = q * Math.sin(t);
      this.ang[i] = Math.random() * 6.283;
      this.state[i] = 1;
    }
    const hex = color >= 0 ? color : s.colors[(Math.random() * s.colors.length) | 0];
    tmpColor.set(hex).multiplyScalar(s.vehicle ? 0.92 + Math.random() * 0.16 : 0.8 + Math.random() * 0.4);
    this.mesh.setColorAt(i, tmpColor);
    this.mesh.instanceColor!.needsUpdate = true;
    this.writeMatrix(i);
    if (this.shadow) this.setShadow(i, resting);
    return i;
  }

  /** Hand a resting vehicle to the traffic simulation. */
  setDriven(i: number, on: boolean) {
    this.state[i] = on ? 3 : 2;
    if (this.live) { (this.live.array as Float32Array)[i] = on ? 1 : 0; this.live.needsUpdate = true; }
  }

  isDriven(i: number) { return this.state[i] === 3; }

  /** Move a driven vehicle; its velocity is what it keeps if the wind takes it. */
  drive(i: number, x: number, z: number, yaw: number, vx: number, vz: number) {
    this.px[i] = x; this.pz[i] = z; this.yaw[i] = yaw;
    this.vx[i] = vx; this.vz[i] = vz;
    this.writeMatrix(i);
    if (this.shadow) this.setShadow(i, true);
    this.dirty = true;
  }

  /** Upload anything moved outside step() (traffic while the storm is not running). */
  sync() {
    if (this.dirty) { this.dirty = false; this.mesh.count = this.high; this.upload(); }
    if (this.shadowDirty) this.uploadShadow();
  }

  private setShadow(i: number, on: boolean) {
    const m = this.shadowM!, o = i * 16;
    if (!on) { m[o] = m[o + 5] = m[o + 10] = 0; this.shadowDirty = true; return; }
    const w = 2 * this.half![0] * this.sx[i] + 1.1, d = 2 * (Math.round(this.ang[i] / (Math.PI / 2)) & 1 ? this.half![1] : this.half![2]) * this.sx[i] + 1.1;
    const c = Math.cos(this.yaw[i]), s = Math.sin(this.yaw[i]);
    m[o] = c * w; m[o + 1] = 0; m[o + 2] = -s * w; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = 1; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = s * d; m[o + 9] = 0; m[o + 10] = c * d; m[o + 11] = 0;
    m[o + 12] = this.px[i]; m[o + 13] = 0.05; m[o + 14] = this.pz[i]; m[o + 15] = 1;
    this.shadowDirty = true;
  }

  private writeMatrix(i: number) {
    // M = T · Ry(yaw) · R(axis, ang) · S
    const m = this.matrices, o = i * 16;
    const x = this.ax[i], y = this.ay[i], z = this.az[i];
    const c = fcos(this.ang[i]), s = fsin(this.ang[i]), t = 1 - c;
    const yw = this.yaw[i];
    const cy = yw === 0 ? 1 : Math.cos(yw), sn = yw === 0 ? 0 : Math.sin(yw);
    const sx = this.sx[i], sy = this.sy[i], sz = this.sz[i];
    let a = t * x * x + c, b = t * x * y + s * z, d = t * x * z - s * y;
    m[o] = (cy * a + sn * d) * sx; m[o + 1] = b * sx; m[o + 2] = (cy * d - sn * a) * sx; m[o + 3] = 0;
    a = t * x * y - s * z; b = t * y * y + c; d = t * y * z + s * x;
    m[o + 4] = (cy * a + sn * d) * sy; m[o + 5] = b * sy; m[o + 6] = (cy * d - sn * a) * sy; m[o + 7] = 0;
    a = t * x * z + s * y; b = t * y * z - s * x; d = t * z * z + c;
    m[o + 8] = (cy * a + sn * d) * sz; m[o + 9] = b * sz; m[o + 10] = (cy * d - sn * a) * sz; m[o + 11] = 0;
    m[o + 12] = this.px[i]; m[o + 13] = this.py[i]; m[o + 14] = this.pz[i]; m[o + 15] = 1;
  }

  private parity = 0;

  step(dtIn: number, tornado: Tornado, bound: number) {
    const n = this.high;
    // under heavy load, integrate alternate halves of the pool on alternate steps with a
    // doubled time step (the drag solve is unconditionally stable, so this is safe)
    const stride = this.airborne > 9000 ? 2 : 1;
    const dt = dtIn * stride;
    this.parity ^= 1;
    const first = stride === 2 ? this.parity : 0;
    const tx = tornado.x, tz = tornado.z;
    const live = tornado.intensity > 0;
    // resting debris only needs checking where winds are strong enough to move anything
    const wakeR = live ? tornado.radiusOfWind(17) + 60 : 0;
    const wakeR2 = wakeR * wakeR;
    const time = tornado.time;
    const shaped = this.half !== null;
    let airborne = 0;
    const { px, py, pz, vx, vy, vz, state, bb } = this;
    for (let i = first; i < n; i += stride) {
      const st = state[i];
      if (st === 0) continue;
      if (st >= 2) {
        const dx = px[i] - tx, dz = pz[i] - tz;
        if (dx * dx + dz * dz > wakeR2) continue;
        tornado.sample(px[i], py[i] > 1.2 ? py[i] : 1.2, pz[i], wind);
        const u2 = wind[0] * wind[0] + wind[2] * wind[2];
        const push = bb[i] * this.rest[i] * u2;
        if (push < FRICTION * GRAV) continue;
        if (st === 3) { if (this.live) { (this.live.array as Float32Array)[i] = 0; this.live.needsUpdate = true; } }
        else { vx[i] = 0; vz[i] = 0; }
        state[i] = 1;
        // once torn loose it is no longer anchored
        if (this.rest[i] < 0.15) this.rest[i] = 0.15;
        vy[i] = 0.8 + Math.random() * 2.5;
        if (!this.moved[i]) { this.moved[i] = 1; this.everMoved++; }
        const u = Math.random() * 2 - 1, t = Math.random() * 6.283, q = Math.sqrt(1 - u * u);
        const a0 = this.ang[i];
        this.ax[i] = q * Math.cos(t); this.ay[i] = u; this.az[i] = q * Math.sin(t);
        // start the tumble from (close to) the pose it was standing in
        if (shaped) { this.ax[i] = this.ax[i] * 0.35 + 0.65; this.ay[i] *= 0.35; this.az[i] *= 0.35; const l = Math.hypot(this.ax[i], this.ay[i], this.az[i]); this.ax[i] /= l; this.ay[i] /= l; this.az[i] /= l; this.ang[i] = a0; }
        if (this.shadow) this.setShadow(i, false);
      }
      airborne++;
      const y = py[i];
      tornado.sample(px[i], y, pz[i], wind);
      // sub-grid turbulence: gusts of ~±22 % of the local mean wind
      const sp = Math.sqrt(wind[0] * wind[0] + wind[1] * wind[1] + wind[2] * wind[2]);
      const ph = this.phase[i] + time * (1.7 + (i & 7) * 0.31);
      const g = sp * 0.22;
      const ux = wind[0] + g * fsin(ph);
      const uy = wind[1] + g * 0.7 * fsin(ph * 1.31 + 2.0);
      const uz = wind[2] + g * fcos(ph * 0.83);
      const rx = ux - vx[i], ry = uy - vy[i], rz = uz - vz[i];
      const rel = Math.sqrt(rx * rx + ry * ry + rz * rz);
      // exact solution of quadratic drag over the step (unconditionally stable)
      const k = bb[i] * rel * dt;
      const f = k / (1 + k);
      vx[i] += rx * f; vy[i] += ry * f; vz[i] += rz * f;
      vy[i] -= GRAV * dt;
      if (y < 4) {
        // aerodynamic lift / ground effect on pieces skimming the surface
        const rh2 = rx * rx + rz * rz;
        vy[i] += this.lift[i] * bb[i] * rh2 * dt * (1 - y * 0.25) / (1 + k);
      }
      if (shaped) vy[i] += this.auto[i] * bb[i] * (rx * rx + rz * rz) * dt / (1 + k);
      px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
      this.ang[i] += this.spin[i] * dt * (0.25 + rel * 0.06);

      const floor = shaped ? Math.min(this.hy[i], this.hz[i]) : this.hy[i];
      if (py[i] <= floor) {
        py[i] = floor;
        let gone = false;
        if (vy[i] < -7 && this.onImpact) {
          this.mesh.getColorAt(i, tmpColor);
          gone = this.onImpact(px[i], pz[i], Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]), tmpColor);
        }
        if (vy[i] < 0) vy[i] *= -0.22;
        vx[i] *= 0.72; vz[i] *= 0.72;
        const v2 = vx[i] * vx[i] + vz[i] * vz[i];
        const u2 = wind[0] * wind[0] + wind[2] * wind[2];
        if (gone) {
          state[i] = 0;
          this.sx[i] = this.sy[i] = this.sz[i] = 0;
        } else if (v2 < 6 && bb[i] * this.rest[i] * u2 < FRICTION * GRAV && vy[i] < 1.5) {
          state[i] = 2;
          vx[i] = vy[i] = vz[i] = 0;
          this.ax[i] = 1; this.ay[i] = 0; this.az[i] = 0;
          this.yaw[i] += this.ang[i];
          if (shaped) {
            const q = this.poses[(Math.random() * this.poses.length) | 0];
            this.ang[i] = q * (Math.PI / 2);
            py[i] = q & 1 ? this.hz[i] : this.hy[i];
            if (this.shadow) this.setShadow(i, true);
          } else {
            this.ang[i] = 0;
          }
        }
      }
      if (px[i] > bound || px[i] < -bound || pz[i] > bound || pz[i] < -bound) {
        state[i] = 0;
        this.sx[i] = this.sy[i] = this.sz[i] = 0;
      }
      this.writeMatrix(i);
    }
    this.airborne = airborne * stride;
    this.mesh.count = n;
    if (airborne > 0 || this.dirty) { this.dirty = false; this.upload(); }
    if (this.shadowDirty) this.uploadShadow();
  }

  private upload() {
    // only the used part of the instance buffer is sent to the GPU
    const attr = this.mesh.instanceMatrix;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, this.high * 16);
    attr.needsUpdate = true;
  }

  private uploadShadow() {
    this.shadowDirty = false;
    this.shadow!.count = this.high;
    const attr = this.shadow!.instanceMatrix;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, this.high * 16);
    attr.needsUpdate = true;
  }

  flush() {
    this.mesh.count = this.high;
    this.upload();
    if (this.shadow) this.uploadShadow();
  }
}

function makeBoxGeometry() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const n = g.attributes.position.count;
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  g.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
  return g;
}

export type ImpactKind = 'vehicle' | 'roof';

/** Every loose object in the scene: one pool of box pieces plus one pool per object model. */
export class DebrisField {
  readonly group = new THREE.Group();
  private systems: DebrisSystem[] = [];
  private byType: DebrisSystem[] = [];
  private vehicles: DebrisSystem[] = [];
  private halves: ([number, number, number] | undefined)[] = [];
  airborne = 0;
  /** hard landings worth a sound: (kind, x, z, impact speed) */
  onImpact: ((kind: ImpactKind, x: number, z: number, speed: number) => void) | null = null;

  constructor(boxMax = 60000) {
    const boxes = new DebrisSystem(makeBoxGeometry(), boxMax, null);
    this.systems.push(boxes);
    for (let t = 0; t < DebrisType.COUNT; t++) {
      const s = SPECS[t];
      if (!s.shape) { this.byType[t] = boxes; continue; }
      const shape = SHAPES[s.shape]();
      this.halves[t] = shape.half;
      const sys = new DebrisSystem(shape.geometry, s.pool ?? 200, shape.half, s.poses, s.shadow);
      this.byType[t] = sys;
      this.systems.push(sys);
      if (s.vehicle) {
        this.vehicles.push(sys);
        sys.onImpact = (x, z, speed) => {
          this.onImpact?.('vehicle', x, z, speed);
          // a hard enough landing tears a wheel off
          if (speed > 16 && Math.random() < 0.3) this.spawn(DebrisType.Tyre, x, 0.6, z, (Math.random() - 0.5) * speed, 2 + Math.random() * 4, (Math.random() - 0.5) * speed);
          return false;
        };
      }
    }
    // a roof section that comes down hard breaks up into its sheathing and rafters
    this.byType[DebrisType.RoofSection].onImpact = (x, z, speed, color) => {
      if (speed < 13 || Math.random() < 0.35) return false;
      this.onImpact?.('roof', x, z, speed);
      const hex = color.getHex();
      for (let k = 0; k < 6; k++) {
        const type = k < 2 ? DebrisType.Shingle : k < 4 ? DebrisType.Plywood : DebrisType.Lumber;
        this.spawn(type, x + (Math.random() - 0.5) * 4, 0.4 + Math.random(), z + (Math.random() - 0.5) * 4,
          (Math.random() - 0.5) * speed * 0.5, 1 + Math.random() * 4, (Math.random() - 0.5) * speed * 0.5, false, 0, k < 2 ? hex : -1);
      }
      return true;
    };
    for (const s of this.systems) {
      if (s.shadow) this.group.add(s.shadow);
      this.group.add(s.mesh);
    }
  }

  spawn(
    type: DebrisType, x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    resting = false, yaw = 0, color = -1, scale = 1,
  ) {
    return this.byType[type].spawn(SPECS[type], x, y, z, vx, vy, vz, resting, yaw, color, scale);
  }

  /** Stand an object on the ground (or at height y), at rest until the wind dislodges it. */
  place(type: DebrisType, x: number, z: number, yaw: number, color = -1, scale = 1, anchor = 1, y = -1) {
    return this.byType[type].spawn(SPECS[type], x, y, z, 0, 0, 0, true, yaw, color, scale, 0, anchor);
  }

  capacity(type: DebrisType) { return this.byType[type].max; }

  /** bounding length of a shaped object, m */
  lengthOf(type: DebrisType) { return (this.halves[type]?.[0] ?? 1) * 2; }

  system(type: DebrisType) { return this.byType[type]; }

  /** Upload matrices changed outside step(). */
  sync() { for (const s of this.systems) s.sync(); }

  step(dt: number, tornado: Tornado, bound: number) {
    let a = 0;
    for (const s of this.systems) { s.step(dt, tornado, bound); a += s.airborne; }
    this.airborne = a;
  }

  get vehiclesMoved() {
    let n = 0;
    for (const s of this.vehicles) n += s.everMoved;
    return n;
  }

  clear() {
    for (const s of this.systems) s.clear();
    this.airborne = 0;
  }

  flush() {
    for (const s of this.systems) s.flush();
  }
}
