import * as THREE from 'three';
import { env, LIGHT_GLSL } from '../render/environment';

export interface CityMeta {
  id: string; name: string; region: string; lat: number; lon: number;
  kind: string; blurb: string; soil: string; land: string; trees: number; heading: number;
  /** architectural palette */
  style?: string;
  /** dense centre: open ground is paving, not grass */
  urban?: boolean;
  /** traffic keeps left */
  left?: boolean;
  /** blocks carry pitched roofs (European centres) */
  pitched?: boolean;
}

export interface CityTile {
  id: string;
  half: number;
  buildings: { p: number[]; h: number; c: number }[];
  roads: { p: number[]; w: number; k: number }[];
  water: number[][];
  green: number[][];
  parking: number[][];
}

/** Building classes, matching the EF-scale damage indicators used in physics/damage.ts */
export const enum BClass { House = 0, LowRise = 1, MidRise = 2, HighRise = 3, Industrial = 4 }

const WALLS: number[][] = [
  [0xd9d2c3, 0xc8bfae, 0xb9a58c, 0xa0604c, 0x8d8f8c, 0xe2ddd2, 0x9aa3a6, 0xb3895f, 0x93573f, 0xcfc6b2],
  [0xb5a999, 0x9c8f80, 0xa8a39b, 0x8a6a58, 0xc2bcb0, 0x7d7a76, 0x94614d, 0xa99f8c],
  [0xa09a90, 0x8f8a84, 0xb3aca0, 0x77726c, 0x9c8573, 0x8a8f94, 0xa5958a],
  [0x4d6272, 0x5c6f78, 0x3f4f5c, 0x6b7780, 0x54606a, 0x7a8288, 0x48606a, 0x66727c],
  [0xa9adb0, 0xc4c0b4, 0x8f979c, 0xb7a98f, 0x9da4a0],
];
const ROOFS: number[][] = [
  [0x4a4744, 0x5a4c41, 0x3d3f42, 0x6b5a4d, 0x57534e, 0x6e4034, 0x44484b],
  [0x6e6c68, 0x8a8780, 0x55524e, 0xb4b2ac, 0x777570],
  [0x6a6864, 0x7c7a75, 0x5a5855, 0x8d8b86],
  [0x55585a, 0x626568, 0x4a4c4e],
  [0x9da1a3, 0xb9b9b4, 0x7f8588, 0xa8aaa6],
];
// Regional materials for houses, low-rise and mid-rise blocks (towers stay glass and steel)
const STYLES: Record<string, { walls: number[]; roofs: number[] }> = {
  paris: { walls: [0xd8ccb4, 0xcfc2a8, 0xe0d6c2, 0xc9bda6, 0xd2c8b6], roofs: [0x5d6670, 0x66707a, 0x545c66, 0x6f7880] }, // limestone, zinc
  rome: { walls: [0xc98f52, 0xd4a86a, 0xb8733e, 0xdcc08a, 0xc47a4a, 0xe0c9a0], roofs: [0x9a5a3c, 0xa8643f, 0x8a5236, 0xb06e48] }, // ochre render, terracotta
  london: { walls: [0x8a7a5c, 0xb9b2a2, 0x7a5a48, 0xa39a88, 0x6e5a4a, 0xcfc9bb], roofs: [0x4a4d52, 0x3f4246, 0x55585c] }, // stock brick, Portland stone, slate
  tokyo: { walls: [0xd9d9d4, 0xbfc2c2, 0xa8aaa8, 0xcfc8b8, 0x8f9496, 0xe6e4de, 0x9c8f80], roofs: [0x6a6c6e, 0x7c7e80, 0x55585a, 0x8a8c8e] }, // tile and concrete
  newyork: { walls: [0x7a4a3a, 0x8a5a44, 0x6a4034, 0xb3a894, 0x9c8f7c, 0x5e4a40], roofs: [0x3a3a3c, 0x4a4a4c, 0x55524e] }, // brick, limestone, tar
  rio: { walls: [0xe2ddd2, 0xd9cdb4, 0xcfd8d6, 0xe6c9a8, 0xb9b4a8, 0xd8b8a0, 0xa8a39b], roofs: [0x8a5a44, 0x6e6c68, 0x9a9790] }, // painted render, clay tile
};
const PARAPET = [0, 0.7, 1.0, 1.2, 0.3];
const EAVE = 0.45;

export const GROUND_SCALE = 16 / 15; // ground texture covers a little more than the tile
const GROUND_PX = 4096;
const MAT_PX = 2048;
const MASK_PX = 1024;
export const SCOUR_PX = 512;

function rnd2(x: number, z: number) {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** roof / wall vertex: x, y, z, kind, inset x, inset z */
type RV = [number, number, number, number, number, number];

export class City {
  readonly group = new THREE.Group();
  readonly half: number;
  readonly groundHalf: number;
  readonly count: number;
  readonly tile: CityTile;
  readonly meta: CityMeta;

  // per-building data
  readonly cx: Float32Array;
  readonly cz: Float32Array;
  readonly height: Float32Array;
  readonly area: Float32Array;
  readonly cls: Uint8Array;
  readonly polyStart: Uint32Array;
  readonly polyLen: Uint16Array;
  readonly polyPts: Float32Array;
  /** sRGB hex colours, so debris torn off a building matches it */
  readonly wallHex: Uint32Array;
  readonly roofHex: Uint32Array;
  /** unit vector along the longest wall */
  readonly axisX: Float32Array;
  readonly axisZ: Float32Array;
  /** unit vector from the building toward the nearest street, and the distance to it (0 if none nearby) */
  readonly frontX: Float32Array;
  readonly frontZ: Float32Array;
  readonly frontD: Float32Array;

  /** RGBA float per building: roof loss, collapse (0..2), glazing loss, power out */
  readonly damageData: Float32Array;
  readonly damageTex: THREE.DataTexture;
  readonly scourData: Uint8Array;
  readonly scourTex: THREE.DataTexture;
  /** occupancy raster: R = building/road, G = vegetation, B = water */
  readonly mask: Uint8ClampedArray;
  readonly rand: () => number;

  private frameTex!: THREE.DataTexture;
  private disposables: { dispose(): void }[] = [];

  constructor(tile: CityTile, meta: CityMeta) {
    this.tile = tile;
    this.meta = meta;
    this.half = tile.half;
    this.groundHalf = tile.half * GROUND_SCALE;
    this.rand = mulberry32(tile.buildings.length * 7919 + 13);
    const n = (this.count = tile.buildings.length);

    const f = () => new Float32Array(n);
    this.cx = f(); this.cz = f(); this.height = f(); this.area = f();
    this.axisX = f(); this.axisZ = f(); this.frontX = f(); this.frontZ = f(); this.frontD = f();
    this.cls = new Uint8Array(n);
    this.wallHex = new Uint32Array(n);
    this.roofHex = new Uint32Array(n);
    this.polyStart = new Uint32Array(n);
    this.polyLen = new Uint16Array(n);
    let totalPts = 0;
    for (const b of tile.buildings) totalPts += b.p.length / 2;
    this.polyPts = new Float32Array(totalPts * 2);

    const texW = 128, texH = Math.max(1, Math.ceil(n / texW));
    this.damageData = new Float32Array(texW * texH * 4);
    this.damageTex = new THREE.DataTexture(this.damageData, texW, texH, THREE.RGBAFormat, THREE.FloatType);
    this.damageTex.needsUpdate = true;
    this.scourData = new Uint8Array(SCOUR_PX * SCOUR_PX);
    this.scourTex = new THREE.DataTexture(this.scourData, SCOUR_PX, SCOUR_PX, THREE.RedFormat, THREE.UnsignedByteType);
    this.scourTex.magFilter = this.scourTex.minFilter = THREE.LinearFilter;
    this.scourTex.needsUpdate = true;
    this.disposables.push(this.damageTex, this.scourTex);

    this.buildBuildings(texW, texH);
    this.findFronts();
    const { texture, material, mask } = this.buildGround();
    this.mask = mask;
    this.buildGroundMesh(texture, material);
  }

  // ------------------------------------------------------------------ buildings

  private buildBuildings(texW: number, texH: number) {
    const tile = this.tile;
    const n = this.count;
    let maxVerts = 0;
    for (const b of tile.buildings) {
      const m = b.p.length / 2;
      maxVerts += m * 9 + 24 + (b.c >= BClass.MidRise && b.c !== BClass.Industrial ? m * 9 : 0) + (b.c !== BClass.House && b.c !== BClass.HighRise ? 90 : 0);
    }
    const pos = new Float32Array(maxVerts * 3);
    const nor = new Float32Array(maxVerts * 3);
    const col = new Float32Array(maxVerts * 3);
    const info = new Float32Array(maxVerts * 4);
    const info2 = new Float32Array(maxVerts * 3);
    const inset = new Float32Array(maxVerts * 2);
    const frame = new Float32Array(texW * texH * 4);
    let v = 0;
    const rand = this.rand;
    const wallC = new THREE.Color(), roofC = new THREE.Color(), plantC = new THREE.Color(0x9a9d9c);

    let id = 0, cls = 0, wallH = 0, nSign = 1;
    /**
     * @param kind 0 = fixed to the ground, 1 = follows the wall top, 2 = roof structure (lost with the roof)
     * @param flag 0 facade, 1 roof surface, 2 plain wall, 3 rooftop plant
     */
    const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number, kind: number, u: number, flag: number, ix = 0, iz = 0) => {
      const o3 = v * 3, o4 = v * 4;
      pos[o3] = x; pos[o3 + 1] = y; pos[o3 + 2] = z;
      nor[o3] = nx; nor[o3 + 1] = ny; nor[o3 + 2] = nz;
      const cc = flag === 1 ? roofC : flag === 3 ? plantC : wallC;
      col[o3] = cc.r; col[o3 + 1] = cc.g; col[o3 + 2] = cc.b;
      // the collapse height is randomised per position: use the spot the vertex settles on
      info[o4] = id; info[o4 + 1] = kind; info[o4 + 2] = u; info[o4 + 3] = rnd2(x + ix, z + iz);
      info2[o3] = flag; info2[o3 + 1] = cls; info2[o3 + 2] = wallH;
      inset[v * 2] = ix; inset[v * 2 + 1] = iz;
      v++;
    };
    /** triangle with an upward / outward-facing normal */
    const tri = (a: RV, b: RV, q: RV, flag: number) => {
      let nx = (b[1] - a[1]) * (q[2] - a[2]) - (b[2] - a[2]) * (q[1] - a[1]);
      let ny = (b[2] - a[2]) * (q[0] - a[0]) - (b[0] - a[0]) * (q[2] - a[2]);
      let nz = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      for (const p of [a, b, q]) put(p[0], p[1], p[2], nx, ny, nz, p[3], 0, flag, p[4], p[5]);
    };
    /** vertical quad between two ground-plan points */
    const wall = (ax: number, az: number, bx: number, bz: number, y0: number, y1: number, k0: number, k1: number, u0: number, flag: number, ix = 0, iz = 0, jx = 0, jz = 0) => {
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) return u0;
      const nx = (dz / len) * nSign, nz = (-dx / len) * nSign;
      const u1 = u0 + len;
      put(ax, y0, az, nx, 0, nz, k0, u0, flag, ix, iz);
      put(bx, y0, bz, nx, 0, nz, k0, u1, flag, jx, jz);
      put(bx, y1, bz, nx, 0, nz, k1, u1, flag, jx, jz);
      put(ax, y0, az, nx, 0, nz, k0, u0, flag, ix, iz);
      put(bx, y1, bz, nx, 0, nz, k1, u1, flag, jx, jz);
      put(ax, y1, az, nx, 0, nz, k1, u0, flag, ix, iz);
      return u1;
    };

    let pp = 0;
    const ring: THREE.Vector2[] = [];
    for (let b = 0; b < n; b++) {
      const src = tile.buildings[b];
      const m = src.p.length / 2;
      id = b; cls = src.c; wallH = src.h / 10;
      this.polyStart[b] = pp / 2;
      this.polyLen[b] = m;
      let sx = 0, sz = 0;
      ring.length = 0;
      for (let i = 0; i < m; i++) {
        const x = src.p[i * 2] / 10, z = src.p[i * 2 + 1] / 10;
        this.polyPts[pp++] = x; this.polyPts[pp++] = z;
        sx += x; sz += z;
        ring.push(new THREE.Vector2(x, z));
      }
      const cx = sx / m, cz = sz / m;
      let area = 0, longest = 0, fx = 1, fz = 0;
      for (let i = 0; i < m; i++) {
        const p = ring[i], q = ring[(i + 1) % m];
        area += p.x * q.y - q.x * p.y;
        const l = Math.hypot(q.x - p.x, q.y - p.y);
        if (l > longest) { longest = l; fx = (q.x - p.x) / l; fz = (q.y - p.y) / l; }
      }
      const ccw = area > 0;
      nSign = ccw ? 1 : -1;
      area = Math.abs(area) / 2;
      this.cx[b] = cx; this.cz[b] = cz; this.area[b] = area; this.cls[b] = cls; this.height[b] = wallH;
      this.axisX[b] = fx; this.axisZ[b] = fz;
      frame[b * 4] = cx; frame[b * 4 + 1] = cz; frame[b * 4 + 2] = fx; frame[b * 4 + 3] = fz;

      const style = cls <= BClass.MidRise ? STYLES[this.meta.style ?? ''] : undefined;
      const wp = style?.walls ?? WALLS[cls], rp = style?.roofs ?? ROOFS[cls];
      wallC.set(wp[(rand() * wp.length) | 0]).multiplyScalar(0.85 + rand() * 0.3);
      roofC.set(rp[(rand() * rp.length) | 0]).multiplyScalar(0.85 + rand() * 0.3);
      this.wallHex[b] = wallC.getHex();
      this.roofHex[b] = roofC.getHex();

      // star-shaped about the centroid: safe to shrink toward it or fan a roof from it
      let star = m <= 16;
      for (let i = 0; i < m && star; i++) {
        const p = ring[i], q = ring[(i + 1) % m];
        const cr = (p.x - cx) * (q.y - cz) - (q.x - cx) * (p.y - cz);
        if ((ccw ? cr : -cr) <= 0.5) star = false;
      }

      // does it carry a pitched roof? Houses do; so do the blocks of old European centres.
      // The roof sits on the footprint's bounding rectangle, aligned with the longest wall.
      let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
      for (const p of ring) {
        const al = (p.x - cx) * fx + (p.y - cz) * fz, pe = -(p.x - cx) * fz + (p.y - cz) * fx;
        a0 = Math.min(a0, al); a1 = Math.max(a1, al); b0 = Math.min(b0, pe); b1 = Math.max(b1, pe);
      }
      const fill = area / Math.max(1, (a1 - a0) * (b1 - b0));
      const block = this.meta.pitched === true && (cls === BClass.LowRise || cls === BClass.MidRise) && wallH <= 34 && area < 2200;
      const pitch = (cls === BClass.House || block) && fill > (block ? 0.55 : 0.62) && a1 - a0 > 2 && b1 - b0 > 2;

      // walls (with a parapet above flat roofs)
      const parapet = pitch ? 0 : PARAPET[cls];
      let u = 0;
      for (let i = 0; i < m; i++) {
        const p = ring[i], q = ring[(i + 1) % m];
        u = wall(p.x, p.y, q.x, q.y, 0, wallH + parapet, 0, 1, u, 0);
      }

      // roof
      const faces = THREE.ShapeUtils.triangulateShape(ring, []);
      // flat deck at wall-top level: the roof of a flat-roofed building, and for a house the
      // ceiling line you look through into the rooms once the pitched roof has gone
      for (const f of faces) {
        const a = ring[f[0]], bb = ring[f[1]], q = ring[f[2]];
        tri([a.x, wallH, a.y, 1, 0, 0], [bb.x, wallH, bb.y, 1, 0, 0], [q.x, wallH, q.y, 1, 0, 0], 1);
      }
      let done = false;
      {
        if (pitch) {
          const corner = (al: number, pe: number) => new THREE.Vector2(cx + al * fx - pe * fz, cz + al * fz + pe * fx);
          const R = [corner(a0, b0), corner(a1, b0), corner(a1, b1), corner(a0, b1)];
          const e0 = a1 - a0, e1 = b1 - b0;
          const o = e0 >= e1 ? 0 : 1;
          const P = [R[o], R[(o + 1) % 4], R[(o + 2) % 4], R[(o + 3) % 4]];
          const long = Math.max(e0, e1), short = Math.min(e0, e1);
          const hip = block || rand() < 0.55;
          const ins = hip ? Math.min(short * 0.5, long * 0.42) : 0;
          // blocks carry a low mansard / hipped roof, houses a steeper one
          const rh = block ? Math.min(short * (0.14 + rand() * 0.1), 3 + rand() * 2.5) : short * (0.2 + rand() * 0.14);
          const dx = (P[1].x - P[0].x) / long, dz = (P[1].y - P[0].y) / long;
          const ex = (P[3].x - P[0].x) / short, ez = (P[3].y - P[0].y) / short;
          const top = wallH + rh;
          const eaveY = wallH - (EAVE * rh) / (short / 2);
          // every roof vertex carries the offset back to the centre: when the roof is lost the
          // whole structure folds to a point and leaves the open deck below
          const rv = (x: number, y: number, z: number): RV => [x, y, z, 2, cx - x, cz - z];
          const sd = [-1, 1, 1, -1], se = [-1, -1, 1, 1];
          const E = P.map((p, i) => rv(p.x + (sd[i] * dx + se[i] * ex) * EAVE, eaveY, p.y + (sd[i] * dz + se[i] * ez) * EAVE));
          const g = hip ? 0 : EAVE; // gable roofs also overhang their end walls
          const ax = (P[3].x + P[0].x) / 2 + dx * ins, az = (P[3].y + P[0].y) / 2 + dz * ins;
          const bx = (P[1].x + P[2].x) / 2 - dx * ins, bz = (P[1].y + P[2].y) / 2 - dz * ins;
          const A = rv(ax - dx * g, top, az - dz * g), B = rv(bx + dx * g, top, bz + dz * g);
          tri(E[0], E[1], B, 1); tri(E[0], B, A, 1);
          tri(E[2], E[3], A, 1); tri(E[2], A, B, 1);
          if (hip) { tri(E[1], E[2], B, 1); tri(E[3], E[0], A, 1); }
          else {
            // gable end walls
            tri(rv(P[1].x, wallH, P[1].y), rv(P[2].x, wallH, P[2].y), rv(bx, top, bz), 2);
            tri(rv(P[3].x, wallH, P[3].y), rv(P[0].x, wallH, P[0].y), rv(ax, top, az), 2);
          }
          done = true;
        }
      }
      if (!done && cls !== BClass.House) {
        nSign = ccw ? 1 : -1;
        // mechanical penthouse on larger towers
        const pent = star && area > 260 && (cls === BClass.MidRise || cls === BClass.HighRise) && rand() < 0.8;
        if (pent) {
          const k = 0.34 + rand() * 0.2;
          const ph = cls === BClass.HighRise ? 5 + rand() * 6 : 3 + rand() * 2.5;
          const R = ring.map((p) => new THREE.Vector2(cx + (p.x - cx) * k, cz + (p.y - cz) * k));
          let pu = 0;
          for (let i = 0; i < m; i++) pu = wall(R[i].x, R[i].y, R[(i + 1) % m].x, R[(i + 1) % m].y, wallH, wallH + ph, 1, 1, pu, 2);
          for (const f of faces) {
            const a = R[f[0]], bb = R[f[1]], q = R[f[2]];
            tri([a.x, wallH + ph, a.y, 1, 0, 0], [bb.x, wallH + ph, bb.y, 1, 0, 0], [q.x, wallH + ph, q.y, 1, 0, 0], 1);
          }
        }
        // rooftop air-handling units
        if (cls !== BClass.HighRise && area > 160 && faces.length > 0) {
          const units = Math.min(3, 1 + Math.floor(area / 500));
          for (let k = 0; k < units; k++) {
            const f = faces[(rand() * faces.length) | 0];
            const a = ring[f[0]], bb = ring[f[1]], q = ring[f[2]];
            let ux = (a.x + bb.x + q.x) / 3, uz = (a.y + bb.y + q.y) / 3;
            if (pent) { ux = cx + (ux - cx) * 1.5; uz = cz + (uz - cz) * 1.5; }
            const hx = 1.1, hz = 0.75, hh = 1.5 + rand() * 0.4;
            nSign = 1;
            const c: [number, number][] = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([lx, lz]) => [ux + lx * fx - lz * fz, uz + lx * fz + lz * fx]);
            for (let i = 0; i < 4; i++) {
              const p = c[i], q2 = c[(i + 1) % 4];
              wall(p[0], p[1], q2[0], q2[1], wallH, wallH + hh, 2, 2, 0, 3, ux - p[0], uz - p[1], ux - q2[0], uz - q2[1]);
            }
            const T: RV[] = c.map((p) => [p[0], wallH + hh, p[1], 2, ux - p[0], uz - p[1]]);
            tri(T[0], T[1], T[2], 3); tri(T[0], T[2], T[3], 3);
          }
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, v * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor.slice(0, v * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col.slice(0, v * 3), 3));
    geo.setAttribute('aInfo', new THREE.BufferAttribute(info.slice(0, v * 4), 4));
    geo.setAttribute('aInfo2', new THREE.BufferAttribute(info2.slice(0, v * 3), 3));
    geo.setAttribute('aInset', new THREE.BufferAttribute(inset.slice(0, v * 2), 2));

    this.frameTex = new THREE.DataTexture(frame, texW, texH, THREE.RGBAFormat, THREE.FloatType);
    this.frameTex.needsUpdate = true;

    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: { ...env, tDamage: { value: this.damageTex }, tFrame: { value: this.frameTex }, uTexW: { value: texW }, uMasonry: { value: this.meta.pitched ? 1 : 0 } },
      vertexShader: BUILDING_VERT,
      fragmentShader: BUILDING_FRAG,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.disposables.push(geo, mat, this.frameTex);
  }

  /** For every building, the direction and distance to the nearest street (used for driveways, fences, bins). */
  private findFronts() {
    const CELL = 70;
    const grid = new Map<number, number[]>();
    const segs: number[] = [];
    const key = (i: number, j: number) => (i + 512) * 1024 + (j + 512);
    for (const r of this.tile.roads) {
      if (r.k < 1 || r.k > 4) continue;
      for (let i = 0; i + 3 < r.p.length; i += 2) {
        const ax = r.p[i] / 10, az = r.p[i + 1] / 10, bx = r.p[i + 2] / 10, bz = r.p[i + 3] / 10;
        const s = segs.length / 4;
        segs.push(ax, az, bx, bz);
        const i0 = Math.floor(Math.min(ax, bx) / CELL), i1 = Math.floor(Math.max(ax, bx) / CELL);
        const j0 = Math.floor(Math.min(az, bz) / CELL), j1 = Math.floor(Math.max(az, bz) / CELL);
        for (let ci = i0; ci <= i1; ci++) for (let cj = j0; cj <= j1; cj++) {
          const k = key(ci, cj);
          let list = grid.get(k);
          if (!list) grid.set(k, (list = []));
          list.push(s);
        }
      }
    }
    for (let b = 0; b < this.count; b++) {
      const x = this.cx[b], z = this.cz[b];
      const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
      let best = 70 * 70, bx = 0, bz = 0;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const list = grid.get(key(ci + di, cj + dj));
        if (!list) continue;
        for (const s of list) {
          const ax = segs[s * 4], az = segs[s * 4 + 1], ex = segs[s * 4 + 2] - ax, ez = segs[s * 4 + 3] - az;
          const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez + 1e-6)));
          const qx = ax + ex * t - x, qz = az + ez * t - z;
          const d2 = qx * qx + qz * qz;
          if (d2 < best) { best = d2; bx = qx; bz = qz; }
        }
      }
      const d = Math.hypot(bx, bz);
      if (d > 1) { this.frontX[b] = bx / d; this.frontZ[b] = bz / d; this.frontD[b] = d; }
    }
  }

  // ------------------------------------------------------------------ ground

  private buildGround() {
    const tile = this.tile, meta = this.meta;
    const gh = this.groundHalf;
    const rand = this.rand;

    const make = (size: number) => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = size;
      const ctx = cv.getContext('2d', { willReadFrequently: size === MASK_PX })!;
      const s = size / (gh * 2);
      ctx.setTransform(s, 0, 0, s, size / 2, size / 2);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      return { cv, ctx };
    };
    const poly = (ctx: CanvasRenderingContext2D, p: number[]) => {
      ctx.beginPath();
      ctx.moveTo(p[0] / 10, p[1] / 10);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] / 10, p[i + 1] / 10);
      ctx.closePath();
    };
    /** polyline, optionally shifted sideways by off metres */
    const line = (ctx: CanvasRenderingContext2D, p: number[], off = 0) => {
      ctx.beginPath();
      for (let i = 0; i < p.length; i += 2) {
        let x = p[i] / 10, z = p[i + 1] / 10;
        if (off !== 0) {
          const j = Math.min(i, p.length - 4);
          const dx = p[j + 2] / 10 - p[j] / 10, dz = p[j + 3] / 10 - p[j + 1] / 10, l = Math.hypot(dx, dz) || 1;
          x += (-dz / l) * off; z += (dx / l) * off;
        }
        if (i === 0) ctx.moveTo(x, z); else ctx.lineTo(x, z);
      }
    };
    const css = (c: THREE.Color, k = 1) =>
      `rgb(${Math.round(Math.min(1, c.r * k) * 255)},${Math.round(Math.min(1, c.g * k) * 255)},${Math.round(Math.min(1, c.b * k) * 255)})`;
    // THREE.Color stores linear values; canvas wants sRGB
    const landS = new THREE.Color(meta.land).convertLinearToSRGB();
    const greenS = landS.clone().lerp(new THREE.Color(0x3f6a30), 0.55);

    interface Palette {
      land: string; green: string; drive: string; apron: string; parking: string; water: string; kerb: string;
      road: (k: number) => string; slab: string; detail: boolean;
    }
    const paint = (ctx: CanvasRenderingContext2D, P: Palette) => {
      ctx.fillStyle = P.land;
      ctx.fillRect(-gh, -gh, gh * 2, gh * 2);
      if (P.detail) {
        for (let i = 0; i < 2600; i++) {
          ctx.fillStyle = css(landS, 0.82 + rand() * 0.36);
          ctx.globalAlpha = 0.16;
          ctx.beginPath();
          ctx.arc((rand() * 2 - 1) * gh, (rand() * 2 - 1) * gh, 8 + rand() * 55, 0, 6.283);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = P.green;
      for (const g of tile.green) { poly(ctx, g); ctx.fill(); }
      // driveways from each house to its street
      ctx.strokeStyle = P.drive;
      ctx.lineCap = 'butt';
      for (let b = 0; b < this.count; b++) {
        const d = this.frontD[b];
        if (this.cls[b] !== BClass.House || d < 4 || d > 48) continue;
        const sx = -this.frontZ[b], sz = this.frontX[b];
        const side = ((b * 7) % 3 - 1) * 2.2;
        const x0 = this.cx[b] + sx * side, z0 = this.cz[b] + sz * side;
        ctx.lineWidth = 3.2 + (b % 3) * 1.2;
        ctx.beginPath();
        ctx.moveTo(x0, z0);
        ctx.lineTo(x0 + this.frontX[b] * d, z0 + this.frontZ[b] * d);
        ctx.stroke();
      }
      ctx.lineCap = 'round';
      // paved aprons around commercial / tall buildings
      ctx.strokeStyle = P.apron;
      ctx.fillStyle = P.apron;
      ctx.lineWidth = 14;
      for (const b of tile.buildings) if (b.c !== BClass.House) { poly(ctx, b.p); ctx.stroke(); ctx.fill(); }
      ctx.fillStyle = P.parking;
      for (const p of tile.parking) { poly(ctx, p); ctx.fill(); }
      if (P.detail) {
        // parking bays
        ctx.strokeStyle = 'rgba(225,225,215,0.5)';
        ctx.lineWidth = 0.35;
        ctx.lineCap = 'butt';
        for (const p of tile.parking) {
          let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9, best = 0, ang = 0;
          for (let i = 0; i < p.length; i += 2) {
            const x = p[i] / 10, z = p[i + 1] / 10;
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
            const j = (i + 2) % p.length;
            const ex = p[j] / 10 - x, ez = p[j + 1] / 10 - z, l = Math.hypot(ex, ez);
            if (l > best) { best = l; ang = Math.atan2(ez, ex); }
          }
          const R = Math.hypot(x1 - x0, z1 - z0) / 2;
          if (R < 12 || R > 400) continue;
          ctx.save();
          poly(ctx, p);
          ctx.clip();
          ctx.translate((x0 + x1) / 2, (z0 + z1) / 2);
          ctx.rotate(ang);
          ctx.beginPath();
          for (let row = -R; row < R; row += 17) {
            for (let x = -R; x < R; x += 2.7) { ctx.moveTo(x, row); ctx.lineTo(x, row + 5.2); ctx.moveTo(x, row + 11.4); ctx.lineTo(x, row + 16.6); }
          }
          ctx.stroke();
          ctx.restore();
        }
        ctx.lineCap = 'round';
      }
      ctx.fillStyle = P.water;
      for (const w of tile.water) { poly(ctx, w); ctx.fill(); }
      // roads: kerb / sidewalk casing first, then asphalt, minor to major
      ctx.strokeStyle = P.kerb;
      for (const r of tile.roads) {
        if (r.k < 1) continue;
        ctx.lineWidth = r.w / 10 + 3.6;
        line(ctx, r.p); ctx.stroke();
      }
      for (const r of tile.roads) {
        ctx.strokeStyle = P.road(r.k);
        ctx.lineWidth = r.w / 10;
        line(ctx, r.p); ctx.stroke();
      }
      if (P.detail) {
        ctx.lineCap = 'butt';
        for (const r of tile.roads) {
          if (r.k < 2) continue;
          const w = r.w / 10;
          ctx.strokeStyle = 'rgba(214,186,84,0.8)';
          ctx.lineWidth = r.k >= 3 ? 0.55 : 0.4;
          ctx.setLineDash(r.k >= 3 ? [] : [6, 9]);
          line(ctx, r.p); ctx.stroke();
          if (w >= 11) {
            ctx.strokeStyle = 'rgba(232,232,224,0.7)';
            ctx.lineWidth = 0.35;
            ctx.setLineDash([3, 9]);
            for (const s of [-1, 1]) { line(ctx, r.p, (s * w) / 4); ctx.stroke(); }
          }
          if (r.k >= 3) {
            ctx.strokeStyle = 'rgba(232,232,224,0.55)';
            ctx.lineWidth = 0.3;
            ctx.setLineDash([]);
            for (const s of [-1, 1]) { line(ctx, r.p, s * (w / 2 - 0.5)); ctx.stroke(); }
          }
        }
        ctx.setLineDash([]);
        ctx.lineCap = 'round';
        // soft contact shadow where walls meet the ground
        for (const [lw, a] of [[9, 0.09], [5, 0.12], [2.4, 0.16]]) {
          ctx.strokeStyle = `rgba(0,0,0,${a})`;
          ctx.lineWidth = lw;
          for (const b of tile.buildings) { poly(ctx, b.p); ctx.stroke(); }
        }
      }
      // foundation slabs (visible once a structure is swept away)
      ctx.fillStyle = P.slab;
      for (const b of tile.buildings) { poly(ctx, b.p); ctx.fill(); }
    };

    // ---- colour map
    const { cv, ctx } = make(GROUND_PX);
    paint(ctx, {
      land: css(landS), green: css(greenS), drive: '#8f8c84', apron: '#77756f', parking: '#56575a', water: '#2c434c', kerb: '#8d8a82',
      road: (k) => (k >= 3 ? '#36383b' : k >= 1 ? '#434547' : '#4d4e50'), slab: '#6b6862', detail: true,
    });
    const texture = new THREE.CanvasTexture(cv);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;

    // ---- surface material map: R asphalt, G grass / soil, B water, none = concrete
    const mt = make(MAT_PX);
    paint(mt.ctx, {
      land: meta.urban ? '#000000' : '#00ff00', green: '#00ff00', drive: '#000000', apron: '#000000', parking: '#ff0000', water: '#0000ff', kerb: '#000000',
      road: () => '#ff0000', slab: '#000000', detail: false,
    });
    const material = new THREE.CanvasTexture(mt.cv);
    material.colorSpace = THREE.NoColorSpace;
    material.generateMipmaps = true;
    material.minFilter = THREE.LinearMipmapLinearFilter;
    this.disposables.push(texture, material);

    // ---- occupancy mask (red: 40 = paved, 255 = building)
    const m = make(MASK_PX);
    const mc = m.ctx;
    mc.fillStyle = '#000';
    mc.fillRect(-gh, -gh, gh * 2, gh * 2);
    mc.globalCompositeOperation = 'lighter';
    mc.fillStyle = '#00ff00';
    for (const g of tile.green) { poly(mc, g); mc.fill(); }
    mc.fillStyle = '#0000ff';
    for (const w of tile.water) { poly(mc, w); mc.fill(); }
    mc.fillStyle = '#280000';
    mc.strokeStyle = '#280000';
    for (const p of tile.parking) { poly(mc, p); mc.fill(); }
    for (const r of tile.roads) {
      mc.lineWidth = r.w / 10 + 5;
      line(mc, r.p); mc.stroke();
    }
    mc.fillStyle = '#ff0000';
    mc.strokeStyle = '#ff0000';
    mc.lineWidth = 5;
    for (const b of tile.buildings) { poly(mc, b.p); mc.fill(); mc.stroke(); }
    const mask = mc.getImageData(0, 0, MASK_PX, MASK_PX).data;
    return { texture, material, mask };
  }

  /** Occupancy at a world position: bit 1 = paved or built on, 2 = vegetation, 4 = water, 8 = building */
  maskAt(x: number, z: number) {
    const gh = this.groundHalf;
    const i = Math.floor(((x + gh) / (gh * 2)) * MASK_PX);
    const j = Math.floor(((z + gh) / (gh * 2)) * MASK_PX);
    if (i < 0 || j < 0 || i >= MASK_PX || j >= MASK_PX) return 0;
    const o = (j * MASK_PX + i) * 4;
    const r = this.mask[o];
    return (r > 20 ? 1 : 0) | (this.mask[o + 1] > 60 ? 2 : 0) | (this.mask[o + 2] > 60 ? 4 : 0) | (r > 230 ? 8 : 0);
  }

  private buildGroundMesh(texture: THREE.Texture, material: THREE.Texture) {
    const geo = new THREE.PlaneGeometry(90000, 90000);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      depthWrite: false,
      uniforms: {
        ...env,
        tCity: { value: texture },
        tMat: { value: material },
        tScour: { value: this.scourTex },
        uHalf: { value: this.groundHalf },
        uLand: { value: new THREE.Color(this.meta.land) },
        uSoil: { value: new THREE.Color(this.meta.soil) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
        }`,
      fragmentShader: GROUND_FRAG,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -5;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
  }

  private lookup: Map<number, number[]> | null = null;

  /** Index of the building whose footprint contains (x, z), or -1. */
  buildingAt(x: number, z: number) {
    const CELL = 32;
    if (!this.lookup) {
      this.lookup = new Map();
      for (let b = 0; b < this.count; b++) {
        let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
        for (let k = this.polyStart[b], e = k + this.polyLen[b]; k < e; k++) {
          const px = this.polyPts[k * 2], pz = this.polyPts[k * 2 + 1];
          if (px < x0) x0 = px; if (px > x1) x1 = px; if (pz < z0) z0 = pz; if (pz > z1) z1 = pz;
        }
        for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
          const key = (i + 512) * 1024 + (j + 512);
          let list = this.lookup.get(key);
          if (!list) this.lookup.set(key, (list = []));
          list.push(b);
        }
      }
    }
    const list = this.lookup.get((Math.floor(x / CELL) + 512) * 1024 + (Math.floor(z / CELL) + 512));
    if (!list) return -1;
    const pts = this.polyPts;
    for (const b of list) {
      const s0 = this.polyStart[b], n = this.polyLen[b];
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = pts[(s0 + i) * 2], zi = pts[(s0 + i) * 2 + 1], xj = pts[(s0 + j) * 2], zj = pts[(s0 + j) * 2 + 1];
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      if (inside) return b;
    }
    return -1;
  }

  /** Unit vector pointing from building b's nearest wall toward the outside point (x, z). */
  wallNormal(b: number, x: number, z: number, out: { x: number; z: number }) {
    const pts = this.polyPts, s0 = this.polyStart[b], n = this.polyLen[b];
    let best = Infinity;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = pts[(s0 + j) * 2], az = pts[(s0 + j) * 2 + 1], ex = pts[(s0 + i) * 2] - ax, ez = pts[(s0 + i) * 2 + 1] - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez + 1e-9)));
      const dx = x - (ax + ex * t), dz = z - (az + ez * t), d = dx * dx + dz * dz;
      if (d < best) { best = d; out.x = dx; out.z = dz; }
    }
    const l = Math.hypot(out.x, out.z) || 1;
    out.x /= l; out.z /= l;
  }

  /** Current height of a building's remains (walls settle as it collapses; see the vertex shader). */
  topOf(b: number) {
    const c = this.damageData[b * 4 + 1];
    return this.height[b] * (1 - Math.min(c, 1) * 0.86) * (1 - 0.95 * Math.max(0, c - 1));
  }

  /** Darken the ground where winds are strong enough to strip vegetation and soil. */
  stampScour(x: number, z: number, radius: number, speedAt: (x: number, z: number) => number) {
    const gh = this.groundHalf, px = (gh * 2) / SCOUR_PX;
    const i0 = Math.max(0, Math.floor((x - radius + gh) / px)), i1 = Math.min(SCOUR_PX - 1, Math.ceil((x + radius + gh) / px));
    const j0 = Math.max(0, Math.floor((z - radius + gh) / px)), j1 = Math.min(SCOUR_PX - 1, Math.ceil((z + radius + gh) / px));
    let changed = false;
    for (let j = j0; j <= j1; j++) {
      const wz = (j + 0.5) * px - gh;
      for (let i = i0; i <= i1; i++) {
        const wx = (i + 0.5) * px - gh;
        const dx = wx - x, dz = wz - z;
        if (dx * dx + dz * dz > radius * radius) continue;
        const sp = speedAt(wx, wz);
        // light debris / mud from ~45 m/s, deep scouring above ~85 m/s
        const val = Math.min(255, Math.max(0, ((sp - 42) / 48) * 255)) | 0;
        const o = j * SCOUR_PX + i;
        if (val > this.scourData[o]) { this.scourData[o] = val; changed = true; }
      }
    }
    if (changed) this.scourTex.needsUpdate = true;
  }

  resetDamage() {
    this.damageData.fill(0);
    this.damageTex.needsUpdate = true;
    this.scourData.fill(0);
    this.scourTex.needsUpdate = true;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}

// ---------------------------------------------------------------------- shaders

const BUILDING_VERT = /* glsl */ `
  attribute vec3 color;
  attribute vec4 aInfo;
  attribute vec3 aInfo2;
  attribute vec2 aInset;
  uniform sampler2D tDamage;
  uniform sampler2D tFrame;
  uniform float uTexW;
  varying vec3 vWorld; varying vec3 vNormal; varying vec3 vColor;
  varying vec4 vDmg; varying vec4 vMisc; varying vec4 vFrame; varying vec2 vExtra;
  void main() {
    float id = aInfo.x;
    ivec2 tc = ivec2(int(mod(id, uTexW)), int(floor(id / uTexW)));
    vec4 d = texelFetch(tDamage, tc, 0);
    float c1 = clamp(d.g, 0.0, 1.0);
    float sw = clamp(d.g - 1.0, 0.0, 1.0);
    float roofGone = smoothstep(0.7, 1.0, d.r);
    float wallH = aInfo2.z;
    float top = wallH * (1.0 - c1 * (0.72 + 0.28 * aInfo.w)) * (1.0 - 0.95 * sw);
    vec3 p = position;
    if (aInfo.y > 0.5) {
      // parts above the wall line (parapets, plant, roof framing) ride on the wall top;
      // the roof structure folds flat onto it once the roof is lost
      float roofPart = step(1.5, aInfo.y);
      p.y = top + (position.y - wallH) * (1.0 - c1) * (1.0 - roofGone * roofPart) + 2.5 * roofGone * (1.0 - roofGone) * roofPart;
      p.xz += aInset * roofGone * roofPart;
    }
    vWorld = p;
    vNormal = normal;
    vColor = color;
    vDmg = d;
    vMisc = vec4(aInfo.z, aInfo2.x, aInfo2.y, id);
    vFrame = texelFetch(tFrame, tc, 0);
    vExtra = vec2(top, wallH);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }`;

const BUILDING_FRAG = /* glsl */ `
  ${LIGHT_GLSL}
  varying vec3 vWorld; varying vec3 vNormal; varying vec3 vColor;
  varying vec4 vDmg; varying vec4 vMisc; varying vec4 vFrame; varying vec2 vExtra;
  uniform float uMasonry;

  float rectMask(vec2 f, vec4 box) {
    return step(box.x, f.x) * step(f.x, box.z) * step(box.y, f.y) * step(f.y, box.w);
  }

  // Rooms seen from above through a missing roof: one ray per pixel is intersected with a
  // grid of partition walls and the floor ("interior mapping"), so the rooms have real depth.
  vec3 interior(vec2 lp, vec3 d, float depth, vec2 cs, float id) {
    const float wt = 0.08;
    vec2 cell = floor(lp / cs);
    vec2 f = lp - cell * cs;
    float edge = min(min(f.x, cs.x - f.x), min(f.y, cs.y - f.y));
    if (edge < wt) return vec3(0.5, 0.48, 0.44) * (0.7 + 0.5 * hash12(floor(lp / 0.4) + id));
    if (d.y > -0.02) return vec3(0.06);
    float ty = depth / -d.y;
    float tx = abs(d.x) < 1e-4 ? 1e9 : (d.x > 0.0 ? (cs.x - wt - f.x) : (wt - f.x)) / d.x;
    float tz = abs(d.z) < 1e-4 ? 1e9 : (d.z > 0.0 ? (cs.y - wt - f.y) : (wt - f.y)) / d.z;
    float t = min(ty, min(tx, tz));
    float hr = hash12(cell + id * 1.37);
    if (t >= ty) {
      vec2 hp = f + d.xz * t;
      vec2 ap = lp + d.xz * t;
      vec3 fl = hr < 0.35 ? vec3(0.42, 0.36, 0.3) : (hr < 0.7 ? vec3(0.36, 0.24, 0.14) : vec3(0.52, 0.52, 0.5));
      // floorboards / tiles
      fl *= hr < 0.35 ? 1.0 : (0.9 + 0.2 * hash12(floor(ap / (hr < 0.7 ? vec2(1.6, 0.14) : vec2(0.4)))));
      // furniture and scattered belongings
      vec2 q = floor(ap / 0.85);
      float fb = hash12(q + id);
      vec3 stuff = vec3(hash12(q + 3.1), hash12(q + 7.7), hash12(q + 1.3)) * 0.4 + 0.07;
      fl = mix(fl, stuff, step(0.74, fb));
      // plaster, insulation and wet litter over everything
      fl = mix(fl, vec3(0.62, 0.6, 0.55), step(0.9, hash12(floor(ap / 0.3) + id)));
      fl = mix(fl, vec3(0.5, 0.36, 0.36), step(0.94, hash12(floor(ap / 0.5) + id + 9.0)));
      fl *= 0.75 + 0.5 * hash12(floor(ap / 1.3) + id + 2.0);
      float corner = min(min(hp.x - wt, cs.x - wt - hp.x), min(hp.y - wt, cs.y - wt - hp.y));
      return fl * (0.3 + 0.5 * smoothstep(0.0, 1.1, corner));
    }
    float hy = -d.y * t;
    vec3 wc = hr > 0.6 ? vec3(0.6, 0.66, 0.7) : (hr > 0.3 ? vec3(0.74, 0.7, 0.62) : vec3(0.72, 0.72, 0.7));
    float dirt = 0.7 + 0.3 * hash12(floor(vec2(lp.x + lp.y + t, hy) / vec2(0.6, 0.35)) + id);
    return wc * dirt * (0.7 - 0.42 * hy / depth) * (t < tz ? 0.84 : 1.0);
  }

  void main() {
    vec3 n = normalize(vNormal);
    vec3 toCam = cameraPosition - vWorld;
    float dist = length(toCam);
    vec3 v = toCam / dist;
    float flag = vMisc.y, cls = vMisc.z, id = vMisc.w;
    float roofDmg = vDmg.r, c1 = clamp(vDmg.g, 0.0, 1.0), sw = clamp(vDmg.g - 1.0, 0.0, 1.0);
    float glassDmg = vDmg.b, powerOff = vDmg.a;
    float hid = hash12(vec2(id, 3.7)), hid2 = hash12(vec2(id, 9.1));
    float near = 1.0 - smoothstep(50.0, 190.0, dist);
    // building-local frame (x along the longest wall)
    vec2 rel = vWorld.xz - vFrame.xy;
    vec2 lp = vec2(dot(rel, vFrame.zw), dot(rel, vec2(-vFrame.w, vFrame.z)));

    vec3 alb = vColor;
    vec3 emissive = vec3(0.0);
    vec3 refl = vec3(0.0);
    float reflAmt = 0.0;
    float ao = 1.0;
    vec3 sn = n; // shading normal

    if (flag < 0.5) {
      // =========================== facade
      float u = vMisc.x, y = vWorld.y;
      bool house = cls < 0.5, tower = cls > 2.5 && cls < 3.5, shed = cls > 3.5;
      vec3 wall = vColor;
      if (house) {
        if (hid < 0.42) {
          vec2 bp = vec2(u / 0.23, y / 0.075);
          bp.x += 0.5 * mod(floor(bp.y), 2.0);
          vec2 bf = fract(bp);
          float mortar = 1.0 - step(0.07, bf.x) * step(0.16, bf.y);
          wall *= mix(1.0, 0.78 + 0.42 * hash12(floor(bp) + id), near);
          wall = mix(wall, vec3(0.6, 0.58, 0.54), mortar * near * 0.7);
        } else {
          float board = fract(y / 0.19);
          wall *= 1.0 - 0.3 * near * smoothstep(0.78, 1.0, board);
          wall *= 0.97 + 0.06 * hash12(vec2(floor(y / 0.19), id));
        }
        wall = mix(wall, vec3(0.5, 0.49, 0.46), step(y, 0.32));
      } else if (shed) {
        wall *= 1.0 - 0.1 * near * (0.5 + 0.5 * sin(u * 20.9));
        wall *= mix(0.8, 1.0, step(1.1, y));
      } else if (!tower) {
        // panel joints and weathering streaks
        wall *= 1.0 - 0.1 * near * step(0.96, fract(u / 3.0));
        wall *= 0.93 + 0.1 * hash12(vec2(floor(u / 0.7), id)) * smoothstep(0.0, 6.0, vExtra.y - y);
        // stone or render with a string course at each floor and a darker ground storey
        float storey = fract(y / 3.4);
        wall *= 1.0 - uMasonry * (0.16 * near * step(0.94, storey) + 0.1 * step(y, 3.4));
        wall *= 1.0 + uMasonry * 0.08 * (hash12(floor(vec2(u / 1.1, y / 0.42)) + id) - 0.5) * near;
      }

      // ---- openings
      vec2 cs = house ? vec2(3.2, 2.9) : (tower ? vec2(1.7, 3.9) : (cls > 1.5 && !shed ? vec2(2.9, 3.4) : vec2(2.7, 3.6)));
      vec4 box = house ? vec4(0.28, 0.3, 0.72, 0.74) : (tower ? vec4(0.03, 0.22, 0.97, 0.985) : vec4(0.16, 0.3, 0.84, 0.8));
      float skip = house ? 0.4 : (shed ? 0.86 : (tower ? 0.0 : 0.08));
      vec2 g = vec2(u, y) / cs;
      vec2 cell = floor(g), f = fract(g);
      float h1 = hash12(cell + id * 7.13);
      float h2 = hash12(cell * 1.7 + id * 3.31 + 11.0);
      float h3 = hash12(cell * 0.61 + id * 1.93 + 5.0);
      float fits = step((cell.y + box.w) * cs.y, vExtra.y + 0.05);
      float open = rectMask(f, box) * step(skip, h1) * fits;
      vec2 trim = (tower ? vec2(0.0) : vec2(0.08)) / cs;
      float pane = rectMask(f, vec4(box.xy + trim, box.zw - trim)) * step(skip, h1) * fits;
      // glazing bars
      vec2 pf = (f - box.xy) / (box.zw - box.xy);
      float bars = house ? max(step(abs(pf.x - 0.5), 0.02), step(abs(pf.y - 0.5), 0.02)) : 0.0;
      vec3 frameCol = house ? vec3(0.82, 0.81, 0.78) : wall * 0.45;
      float spandrel = 0.0;

      if (cls > 0.5 && cls < 1.5 && y < 3.3) {
        // shopfronts: glazed bays between solid piers, under a fascia
        float bay = floor(u / 6.0);
        float glazed = step(0.3, hash12(vec2(bay, id + 2.0)));
        float fx = fract(u / 6.0);
        open = glazed * step(0.06, fx) * step(fx, 0.94) * step(0.45, y) * step(y, 2.95) * step(3.2, vExtra.y);
        float mull = step(0.03, fract(u / 1.5)) * step(0.52, y) * step(y, 2.88);
        pane = open * mull * step(0.09, fx) * step(fx, 0.91);
        frameCol = vec3(0.12, 0.12, 0.13);
        h1 = 1.0; h3 = hash12(vec2(bay, id));
        h2 = hash12(vec2(floor(u / 1.5), id + 4.0));
        cell = vec2(floor(u / 1.5), 0.0);
      }
      if (cls > 0.5 && cls < 1.5 && y > 3.08 && y < 3.95 && hid2 > 0.4 && vExtra.y > 4.2) {
        // signage band
        vec3 signCol = hid < 0.25 ? vec3(0.5, 0.08, 0.07) : (hid < 0.5 ? vec3(0.06, 0.18, 0.4) : (hid < 0.75 ? vec3(0.07, 0.3, 0.16) : vec3(0.75, 0.72, 0.66)));
        wall = signCol * (0.9 + 0.2 * step(0.5, hash12(vec2(floor(u / 0.9), id))) * near);
        open = 0.0; pane = 0.0;
      }
      if (shed && y < min(4.4, vExtra.y - 0.6)) {
        // roller doors
        float bay = floor(u / 9.0), fx = fract(u / 9.0) * 9.0;
        float door = step(hash12(vec2(bay, id + 5.0)), 0.32) * step(2.4, fx) * step(fx, 6.4) * step(0.02, y);
        wall = mix(wall, vec3(0.74, 0.75, 0.74) * (1.0 - 0.18 * near * step(0.85, fract(y / 0.3))), door);
        open *= 1.0 - door; pane *= 1.0 - door;
      }
      if (house) {
        // front door and garage door
        float d0 = 2.0 + hid2 * 5.0;
        float door = step(d0, u) * step(u, d0 + 0.95) * step(0.32, y) * step(y, 2.4);
        float g0 = d0 + 3.4;
        float garage = step(0.5, hid) * step(g0, u) * step(u, g0 + 4.9) * step(0.32, y) * step(y, 2.5);
        vec3 doorCol = hid2 < 0.3 ? vec3(0.32, 0.07, 0.06) : (hid2 < 0.6 ? vec3(0.2, 0.13, 0.08) : vec3(0.8, 0.79, 0.76));
        wall = mix(wall, doorCol, door);
        wall = mix(wall, vec3(0.8, 0.79, 0.76) * (1.0 - 0.2 * near * step(0.9, fract((y - 0.32) / 0.55))), garage);
        open *= 1.0 - max(door, garage); pane *= 1.0 - max(door, garage);
      }
      if (tower) spandrel = step(f.y, 0.22);

      // ---- glass: mostly a mirror of the sky at these angles
      float lod = clamp(1.0 - max(fwidth(g.x), fwidth(g.y)) * 1.3, 0.0, 1.0);
      float cover = (box.z - box.x) * (box.w - box.y) * (1.0 - skip) * (house ? 0.8 : 1.0);
      float broken = step(h2, glassDmg * 1.05);
      float fres = 0.04 + 0.96 * pow(1.0 - abs(dot(n, v)), 5.0);
      vec3 rd = reflect(-v, n);
      rd.y += (h3 - 0.5) * 0.07; // panes are never perfectly coplanar
      vec3 skyR = skyColor(rd);
      // low panes mostly mirror the buildings and trees across the street, not open sky
      float openSky = clamp(rd.y * 2.5 + y / (house ? 14.0 : 110.0) + (house ? 0.35 : 0.12), 0.0, 1.0);
      skyR = mix((uSkyColor * 0.4 + uGroundColor * 0.6) * (0.7 + 0.6 * h1), skyR, openSky);
      vec3 inside = tower ? vColor * (0.1 + 0.12 * h3) : mix(vec3(0.015, 0.018, 0.022), vec3(0.3, 0.28, 0.24), step(0.72, h2) * 0.5);
      inside = mix(inside, vColor * 0.22, spandrel);
      float mirror = (tower ? 0.42 : 0.2) + (tower ? 0.58 : 0.8) * fres;
      float glassMask = pane * (1.0 - bars) * (1.0 - broken);
      vec3 opening = mix(frameCol, inside, pane * (1.0 - bars));
      opening = mix(opening, vec3(0.012, 0.012, 0.014), pane * broken);
      // far away the grid cannot be resolved: fall back to its average
      alb = mix(mix(wall, mix(wall, inside, 0.8), cover), mix(wall, opening, open), lod);
      reflAmt = mix(cover * mirror * (1.0 - glassDmg), glassMask * mirror, lod);
      refl = skyR;
      // facade streaking / cladding loss on heavily damaged walls
      float strip = step(hash12(floor(vec2(u, y) / 2.2) + id), glassDmg * 0.35 - 0.05);
      alb = mix(alb, vec3(0.2, 0.18, 0.17), strip * 0.8);
      reflAmt *= 1.0 - strip;
      float lit = step(0.68, h3) * (1.0 - broken) * (1.0 - spandrel);
      emissive = mix(cover * 0.32, pane * lit, lod) * (1.0 - powerOff) * uNight * vec3(1.0, 0.7, 0.38) * (0.07 + 0.17 * h2);
      ao = 0.68 + 0.32 * smoothstep(0.0, 3.5, y);
      if (house) ao *= 0.7 + 0.3 * smoothstep(0.0, 0.8, vExtra.y - y);
    } else if (flag < 1.5) {
      // =========================== roof
      float open = smoothstep(0.75, 1.0, roofDmg) * (1.0 - c1);
      float patchN = hash12(floor(lp / vec2(1.22, 0.8)) + id);
      float stripped = step(patchN, roofDmg * 1.3 - 0.04);
      if (cls < 0.5 || n.y < 0.985) {
        // shingle, slate or tile courses follow the slope: constant-height lines, staggered tabs
        vec2 tdir = normalize(vec2(-n.z, n.x) + vec2(1e-4, 0.0));
        float course = vWorld.y / 0.1;
        float tab = hash12(vec2(floor(dot(vWorld.xz, tdir) / 0.32 + 0.5 * mod(floor(course), 2.0)), floor(course)) + id);
        alb *= mix(1.0, (0.78 + 0.4 * tab) * (1.0 - 0.28 * smoothstep(0.75, 1.0, fract(course))), near);
      } else if (cls > 3.5) {
        // standing-seam metal
        alb *= 1.0 - 0.3 * near * step(0.93, fract(lp.y / 0.6));
        alb *= 0.94 + 0.1 * hash12(vec2(floor(lp.y / 0.6), id));
        reflAmt = 0.1 + 0.25 * uWet;
        refl = skyColor(reflect(-v, n));
      } else {
        // membrane / ballast with ponding stains
        float stain = hash12(floor(vWorld.xz / 7.0) + id) * 0.5 + hash12(floor(vWorld.xz / 2.3) + id) * 0.5;
        alb *= 0.82 + 0.3 * stain;
        alb *= 1.0 - 0.12 * near * hash12(floor(vWorld.xz / 0.25));
      }
      alb = mix(alb, vec3(0.36, 0.27, 0.17) * (0.7 + 0.6 * patchN), stripped);
      alb *= 0.92 + 0.16 * hash12(floor(vWorld.xz / 0.6));
      if (open > 0.0) {
        vec3 room;
        if (cls < 1.5 || cls > 3.5) {
          vec3 rdir = -v;
          vec3 ld = vec3(dot(rdir.xz, vFrame.zw), rdir.y, dot(rdir.xz, vec2(-vFrame.w, vFrame.z)));
          vec2 cs = cls < 0.5 ? vec2(4.6, 3.9) : (cls > 3.5 ? vec2(14.0, 11.0) : vec2(7.5, 6.5));
          float depth = clamp(vWorld.y - 0.2, 0.4, cls < 0.5 ? 2.7 : 4.5);
          room = interior(lp + hid * 3.0, ld, depth, cs, id);
          float il = clamp(1.0 - fwidth(lp.x) * 0.5, 0.0, 1.0);
          room = mix(vec3(0.36, 0.33, 0.29), room, il);
          sn = vec3(0.0, 1.0, 0.0);
        } else {
          room = vec3(0.13, 0.115, 0.1) * (0.7 + 0.6 * patchN);
        }
        alb = mix(alb, room, open);
        reflAmt *= 1.0 - open;
        ao = mix(1.0, 0.8, open);
      }
    } else if (flag < 2.5) {
      // =========================== plain wall (gable ends, penthouses)
      if (cls < 0.5 && hid >= 0.42) alb *= 1.0 - 0.3 * near * smoothstep(0.78, 1.0, fract(vWorld.y / 0.19));
      alb *= cls > 1.5 ? 0.82 : 1.0;
    } else {
      // =========================== rooftop plant
      alb *= n.y > 0.5 ? 0.55 + 0.3 * step(0.5, hash12(floor(vWorld.xz / 0.5))) : 0.9 + 0.1 * step(0.5, fract(vWorld.y / 0.12));
    }

    float rub = hash12(floor(vWorld.xz / 0.9) + id * 0.37);
    float rub2 = hash12(floor(vWorld.xz / 0.35) + id * 0.11);
    vec3 rubble = mix(vColor, vec3(0.13, 0.11, 0.09), 0.62) * (0.35 + 0.8 * rub + 0.6 * rub2 * rub2);
    // splintered framing and sheathing lying across the heap
    float plank = hash12(floor(vec2(lp.x * 0.55 + lp.y * 0.83, lp.y * 0.55 - lp.x * 0.83) / vec2(2.6, 0.22)) + id);
    rubble = mix(rubble, vec3(0.5, 0.39, 0.25) * (0.5 + 0.8 * rub2), step(0.72, plank) * step(flag, 1.5) * step(0.5, flag));
    alb = mix(alb, rubble, c1 * 0.9);
    alb = mix(alb, vec3(0.2, 0.195, 0.185) * (0.75 + 0.5 * rub), sw);
    alb *= 1.0 - 0.14 * uWet;
    vec3 c = shade(alb, sn) * ao;
    c = mix(c, refl, clamp(reflAmt, 0.0, 1.0) * (1.0 - c1));
    c += emissive * (1.0 - c1);
    c = applyFog(c, dist);
    gl_FragColor = vec4(c, 1.0);
  }`;

const GROUND_FRAG = /* glsl */ `
  ${LIGHT_GLSL}
  uniform sampler2D tCity; uniform sampler2D tMat; uniform sampler2D tScour;
  uniform float uHalf; uniform vec3 uLand; uniform vec3 uSoil;
  varying vec3 vWorld;
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    vec2 xz = vWorld.xz;
    vec3 toCam = cameraPosition - vWorld;
    float dist = length(toCam);
    vec3 v = toCam / dist;
    vec2 uv = xz / (2.0 * uHalf) + 0.5;
    // open country beyond the mapped tile: a patchwork of fields
    vec2 fp = xz / 320.0 + vec2(vnoise(xz / 900.0), vnoise(xz / 900.0 + 7.0)) * 0.8;
    float fieldLod = clamp(1.0 - fwidth(fp.x) * 1.5, 0.0, 1.0);
    float fh = mix(0.5, hash12(floor(fp)), fieldLod);
    vec3 far = uLand * mix(vec3(0.8, 0.9, 0.75), vec3(1.35, 1.2, 0.85), fh);
    far *= 0.85 + 0.3 * vnoise(xz / 140.0);
    vec2 e = abs(uv - 0.5);
    float inside = 1.0 - smoothstep(0.455, 0.497, max(e.x, e.y));
    vec2 tuv = vec2(uv.x, 1.0 - uv.y);
    vec3 c = mix(far, texture2D(tCity, tuv).rgb, inside);
    // surface type: asphalt, grass / soil, water, concrete
    vec3 m = mix(vec3(0.0, 1.0, 0.0), texture2D(tMat, tuv).rgb, inside);
    float asphalt = m.r, grass = m.g, water = m.b;
    float concrete = clamp(1.0 - m.r - m.g - m.b, 0.0, 1.0);
    float near = exp(-dist / 70.0), mid = exp(-dist / 380.0);

    // asphalt: aggregate speckle, cracks, patched repairs
    float a1 = vnoise(xz * 7.0), a2 = vnoise(xz * 29.0);
    float crack = smoothstep(0.012, 0.0, abs(vnoise(xz / 1.7) - 0.5)) * smoothstep(0.5, 0.75, vnoise(xz / 9.0 + 3.0)) * step(0.35, a1);
    c *= 1.0 + asphalt * (near * ((a1 * 0.5 + a2 * 0.5 - 0.5) * 0.4 - crack * 0.3) - 0.1 * mid * step(0.7, vnoise(xz / 15.0)));
    // grass: clumps, mowing variation, dry patches
    float g1 = vnoise(xz / 27.0), g2 = vnoise(xz / 3.3), g3 = vnoise(xz * 3.7), g4 = vnoise(xz * 17.0);
    c *= 1.0 + grass * ((g1 - 0.5) * 0.3 + (g2 - 0.5) * 0.22 * mid + ((g3 - 0.5) * 0.16 + (g4 - 0.5) * 0.3) * near);
    c = mix(c, c * vec3(1.14, 1.04, 0.78), grass * smoothstep(0.55, 0.85, g1) * 0.55);
    // concrete: expansion joints, trowel marks
    vec2 j = abs(fract(xz / 1.8) - 0.5);
    c *= 1.0 - concrete * near * (0.3 * smoothstep(0.482, 0.5, max(j.x, j.y)) + (a2 - 0.5) * 0.18);

    // ground scouring and mud deposited along the damage path
    float sc = texture2D(tScour, uv).r;
    float streak = vnoise(xz / 7.0) * 0.6 + vnoise(xz / 1.9) * 0.4;
    float s = smoothstep(0.08, 0.9, sc * (0.55 + 0.9 * streak));
    c = mix(c, uSoil * (0.35 + 0.5 * streak), s * 0.9);

    // rain: hard surfaces darken, pool and mirror the bright horizon
    float hard = (asphalt + concrete) * (1.0 - s);
    c *= 1.0 - uWet * (0.32 * hard + 0.14 * grass);
    vec2 rip = vec2(vnoise(xz * 2.3 + uTime * vec2(0.9, 0.4)), vnoise(xz * 2.3 + 17.0 - uTime * vec2(0.3, 0.8))) - 0.5;
    float rough = mix(0.05, 0.1, water);
    vec3 nW = normalize(vec3(rip.x * rough, 1.0, rip.y * rough));
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(nW, v), 0.0), 5.0);
    vec3 refl = skyColor(reflect(-v, nW));
    float puddle = smoothstep(0.5, 0.95, vnoise(xz / 11.0) * 0.75 + vnoise(xz / 3.7) * 0.25) * smoothstep(0.25, 1.0, uWet) * hard * hard;
    vec3 lit = shade(c, vec3(0.0, 1.0, 0.0));
    lit = mix(lit, refl, clamp(puddle * (0.05 + 0.5 * fres) + uWet * fres * (0.45 * hard + 0.08 * grass), 0.0, 1.0));
    lit = mix(lit, mix(shade(vec3(0.03, 0.05, 0.055), vec3(0.0, 1.0, 0.0)), refl, 0.12 + 0.88 * fres), water * inside);
    gl_FragColor = vec4(applyFog(lit, dist), 1.0);
  }`;

export async function loadCity(meta: CityMeta): Promise<City> {
  const res = await fetch(`${import.meta.env.BASE_URL}cities/${meta.id}.json`);
  if (!res.ok) throw new Error(`Could not load map tile for ${meta.name}`);
  const tile = (await res.json()) as CityTile;
  return new City(tile, meta);
}
