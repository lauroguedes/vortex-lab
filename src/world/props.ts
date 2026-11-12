import * as THREE from 'three';
import { env, LIGHT_GLSL, VORTEX_GLSL } from '../render/environment';
import { DebrisField, DebrisType, shadowAssets } from '../physics/debris';
import type { Tornado } from '../physics/tornado';
import type { City } from './city';

const MPH = 0.44704;
// EF-scale DI 27 (hardwood trees): small limbs, large branches, uprooted, trunk snapped, debarked
const TREE_DOD = [60, 74, 91, 110, 143].map((v) => v * MPH);

const m4 = new THREE.Matrix4();
const quat = new THREE.Quaternion();
const axis = new THREE.Vector3();
const vPos = new THREE.Vector3();
const vScale = new THREE.Vector3();
const col = new THREE.Color();
const w3 = new Float32Array(3);

export class Trees {
  readonly group = new THREE.Group();
  readonly count: number;
  downed = 0;
  /** a tree has been uprooted or snapped at (x, z) */
  onFall: ((x: number, z: number) => void) | null = null;
  private trunks: THREE.InstancedMesh;
  private shadows: THREE.InstancedMesh;
  private crowns: THREE.InstancedMesh;
  private x: Float32Array; private z: Float32Array;
  private h: Float32Array; private cr: Float32Array; private tr: Float32Array;
  private strength: Float32Array;
  private dod: Uint8Array;
  private lean: Float32Array; private leanT: Float32Array;
  private crown: Float32Array; private crownT: Float32Array;
  private trunkK: Float32Array;
  private dx: Float32Array; private dz: Float32Array;
  private animating = new Set<number>();
  private crownHex: Uint32Array;

  constructor(private city: City, private debris: DebrisField) {
    const rand = city.rand;
    const want = Math.round(500 + 4200 * city.meta.trees);
    const xs: number[] = [], zs: number[] = [];
    const half = city.half;
    for (let tries = 0; tries < want * 14 && xs.length < want; tries++) {
      const x = (rand() * 2 - 1) * half, z = (rand() * 2 - 1) * half;
      const m = city.maskAt(x, z);
      if (m & 1 || m & 4) continue;
      if (rand() > (m & 2 ? 1 : 0.4)) continue;
      xs.push(x); zs.push(z);
    }
    const n = (this.count = xs.length);
    const f = () => new Float32Array(n);
    this.x = Float32Array.from(xs); this.z = Float32Array.from(zs);
    this.h = f(); this.cr = f(); this.tr = f(); this.strength = f();
    this.lean = f(); this.leanT = f(); this.crown = f(); this.crownT = f(); this.trunkK = f();
    this.dx = f(); this.dz = f();
    this.dod = new Uint8Array(n);
    this.crownHex = new Uint32Array(n);

    const trunkGeo = new THREE.CylinderGeometry(0.55, 1, 1, 6, 1, true);
    trunkGeo.translate(0, 0.5, 0);
    // a canopy of several overlapping lobes reads as foliage rather than a ball
    const lobes: [number, number, number, number][] = [[0, 0, 0, 0.82], [0.55, -0.12, 0.22, 0.62], [-0.48, 0.05, -0.38, 0.66], [0.02, 0.42, -0.1, 0.58], [-0.2, -0.2, 0.52, 0.54]];
    const cpos: number[] = [];
    for (const [lx, ly, lz, lr] of lobes) {
      const g = new THREE.IcosahedronGeometry(1, 1);
      const gp = g.attributes.position;
      for (let i = 0; i < gp.count; i++) {
        vPos.fromBufferAttribute(gp, i);
        const s = Math.sin(vPos.x * 12.9 + vPos.y * 78.2 + vPos.z * 37.7 + lx * 5.0) * 43758.5;
        vPos.multiplyScalar(lr * (0.82 + 0.36 * (s - Math.floor(s))));
        cpos.push(vPos.x + lx, vPos.y * 0.9 + ly, vPos.z + lz);
      }
      g.dispose();
    }
    const crownGeo = new THREE.BufferGeometry();
    crownGeo.setAttribute('position', new THREE.Float32BufferAttribute(cpos, 3));
    crownGeo.computeVertexNormals();

    const trunkMat = new THREE.ShaderMaterial({
      uniforms: env,
      vertexShader: /* glsl */ `
        varying vec3 vWorld; varying vec3 vNormal; varying vec3 vColor;
        void main() {
          vec4 wp = instanceMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vNormal = normalize(mat3(instanceMatrix) * normal);
          vColor = instanceColor;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        ${LIGHT_GLSL}
        varying vec3 vWorld; varying vec3 vNormal; varying vec3 vColor;
        void main() {
          vec3 c = shade(vColor, normalize(vNormal));
          gl_FragColor = vec4(applyFog(c, distance(vWorld, cameraPosition)), 1.0);
        }`,
    });
    const crownMat = new THREE.ShaderMaterial({
      uniforms: env,
      vertexShader: /* glsl */ `
        ${VORTEX_GLSL}
        uniform float uTime;
        varying vec3 vWorld; varying vec3 vNormal; varying vec3 vColor; varying float vAo;
        void main() {
          vec4 wp = instanceMatrix * vec4(position, 1.0);
          vec3 origin = instanceMatrix[3].xyz;
          // foliage streams downwind and flutters harder as the wind rises
          vec2 w = vortexWind(origin.xz);
          float sp = length(w);
          float bend = clamp(sp / 42.0, 0.0, 1.0);
          float flutter = sin(uTime * (2.5 + sp * 0.2) + origin.x * 0.7 + origin.z * 0.4 + position.y * 2.3);
          wp.xz += (w / (sp + 0.5)) * (bend * (1.6 + 0.7 * flutter) + 0.12 * flutter) * (0.7 + position.y * 0.6);
          wp.y -= bend * 0.5 * abs(position.x + position.z);
          vWorld = wp.xyz;
          vNormal = normalize(mat3(instanceMatrix) * normal);
          vColor = instanceColor;
          vAo = 0.55 + 0.45 * smoothstep(-1.0, 0.8, position.y);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        ${LIGHT_GLSL}
        varying vec3 vWorld; varying vec3 vNormal; varying vec3 vColor; varying float vAo;
        void main() {
          vec3 c = shade(vColor, normalize(vNormal)) * vAo;
          gl_FragColor = vec4(applyFog(c, distance(vWorld, cameraPosition)), 1.0);
        }`,
    });

    this.trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, n);
    this.crowns = new THREE.InstancedMesh(crownGeo, crownMat, n);
    this.trunks.frustumCulled = this.crowns.frustumCulled = false;
    const greens = [0x3f5a2a, 0x4a6630, 0x35502a, 0x566b33, 0x2f4a2c, 0x5b6e3a];
    for (let i = 0; i < n; i++) {
      const s = 0.55 + rand() * 0.9;
      this.h[i] = 3.2 + s * 4.5;
      this.cr[i] = 2.2 + s * 3.2;
      this.tr[i] = 0.16 + s * 0.22;
      this.strength[i] = 0.8 + rand() * 0.45;
      this.crowns.setColorAt(i, col.set(greens[(rand() * greens.length) | 0]).multiplyScalar(0.75 + rand() * 0.5));
      this.crownHex[i] = col.getHex();
      this.trunks.setColorAt(i, col.set(0x4a3b2c).multiplyScalar(0.8 + rand() * 0.4));
    }
    const sh = shadowAssets();
    this.shadows = new THREE.InstancedMesh(sh.geo, sh.mat, n);
    this.shadows.frustumCulled = false;
    this.shadows.renderOrder = -2;
    this.group.add(this.shadows, this.trunks, this.crowns);
    this.reset();
  }

  reset() {
    this.dod.fill(0);
    this.lean.fill(0); this.leanT.fill(0);
    this.crown.fill(1); this.crownT.fill(1);
    this.trunkK.fill(1);
    this.animating.clear();
    this.downed = 0;
    for (let i = 0; i < this.count; i++) {
      this.trunks.setColorAt(i, col.set(0x4a3b2c));
      this.write(i);
    }
    this.flush();
  }

  private flush() {
    this.trunks.instanceMatrix.needsUpdate = true;
    this.crowns.instanceMatrix.needsUpdate = true;
    this.shadows.instanceMatrix.needsUpdate = true;
    this.trunks.instanceColor!.needsUpdate = true;
  }

  private write(i: number) {
    const lean = this.lean[i];
    axis.set(this.dz[i], 0, -this.dx[i]);
    if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
    quat.setFromAxisAngle(axis.normalize(), lean);
    const th = this.h[i] * this.trunkK[i];
    vPos.set(this.x[i], 0, this.z[i]);
    vScale.set(this.tr[i], th, this.tr[i]);
    m4.compose(vPos, quat, vScale);
    this.trunks.setMatrixAt(i, m4);
    const cs = this.cr[i] * this.crown[i];
    vPos.set(0, this.h[i] + this.cr[i] * 0.45, 0).applyQuaternion(quat);
    vPos.x += this.x[i]; vPos.z += this.z[i];
    vScale.set(cs, cs * 0.85, cs);
    m4.compose(vPos, quat, vScale);
    this.crowns.setMatrixAt(i, m4);
    // the patch of shade under the canopy goes when the tree does
    const shade = lean > 0.6 ? 0 : cs * 2.7;
    m4.makeScale(shade, 1, shade).setPosition(this.x[i], 0.045, this.z[i]);
    this.shadows.setMatrixAt(i, m4);
  }

  step(dt: number, tornado: Tornado) {
    if (tornado.intensity > 0) {
      const reach = tornado.radiusOfWind(TREE_DOD[0] * 0.8) + 40;
      const r2 = reach * reach;
      for (let i = 0; i < this.count; i++) {
        const d = this.dod[i];
        if (d >= 5) continue;
        const ddx = this.x[i] - tornado.x, ddz = this.z[i] - tornado.z;
        if (ddx * ddx + ddz * ddz > r2) continue;
        tornado.sample(this.x[i], 8, this.z[i], w3);
        const sp = Math.hypot(w3[0], w3[2]);
        const eff = sp / this.strength[i];
        let nd = d;
        while (nd < 5 && eff >= TREE_DOD[nd]) nd++;
        if (nd === d) continue;
        this.dod[i] = nd;
        const x = this.x[i], z = this.z[i], top = this.h[i] + this.cr[i] * 0.4;
        const shed = (k: number) => {
          for (let j = 0; j < k; j++)
            this.debris.spawn(DebrisType.Branch, x + (Math.random() - 0.5) * 3, top * (0.6 + Math.random() * 0.4), z + (Math.random() - 0.5) * 3,
              w3[0] * 0.2, 1 + Math.random() * 3, w3[2] * 0.2, false, 0, -1, 0.5 + this.cr[i] * 0.14);
        };
        if (nd >= 1 && d < 1) { this.crownT[i] = 0.93; }
        if (nd >= 2 && d < 2) { this.crownT[i] = 0.78; shed(1); }
        if (nd >= 3 && d < 3) {
          // uprooted: falls with the wind
          this.dx[i] = w3[0] / (sp + 1e-3); this.dz[i] = w3[2] / (sp + 1e-3);
          this.leanT[i] = 1.35 + Math.random() * 0.2;
          this.downed++;
          shed(1);
          this.onFall?.(x, z);
        }
        if (nd >= 4 && d < 4) {
          // trunk snapped, crown carried away
          this.crownT[i] = 0;
          this.trunkK[i] = 0.3 + Math.random() * 0.25;
          shed(2);
          this.debris.spawn(DebrisType.TreeTop, x, this.h[i] * 0.7, z, w3[0] * 0.3, 2 + Math.random() * 4, w3[2] * 0.3, false, 0, this.crownHex[i], this.cr[i] / 3.4);
        }
        if (nd >= 5) {
          this.trunkK[i] = Math.min(this.trunkK[i], 0.35);
          this.trunks.setColorAt(i, col.set(0xb9a98a));
          this.trunks.instanceColor!.needsUpdate = true;
        }
        this.animating.add(i);
      }
    }
    if (this.animating.size) {
      for (const i of this.animating) {
        const dl = this.leanT[i] - this.lean[i];
        const dc = this.crownT[i] - this.crown[i];
        this.lean[i] += Math.sign(dl) * Math.min(Math.abs(dl), dt * (0.6 + this.lean[i] * 2.2));
        this.crown[i] += Math.sign(dc) * Math.min(Math.abs(dc), dt * 1.6);
        this.write(i);
        if (Math.abs(dl) < 1e-3 && Math.abs(dc) < 1e-3) this.animating.delete(i);
      }
      this.trunks.instanceMatrix.needsUpdate = true;
      this.crowns.instanceMatrix.needsUpdate = true;
      this.shadows.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    for (const m of [this.trunks, this.crowns]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
    this.shadows.dispose();
    this.group.removeFromParent();
  }
}

function pointInPoly(x: number, z: number, p: number[]) {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i] / 10, zi = p[i + 1] / 10, xj = p[j] / 10, zj = p[j + 1] / 10;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Park vehicles along the kerbs and in car parks. Returns how many were placed. */
export function placeVehicles(city: City, field: DebrisField): number {
  const rand = city.rand;
  const half = city.half - 5;
  let placed = 0;
  const left: Record<number, number> = {};
  // the rest of each pool is for moving traffic and its replacements
  for (const t of [DebrisType.Sedan, DebrisType.Suv, DebrisType.Pickup, DebrisType.Van]) left[t] = Math.floor(field.capacity(t) * 0.5);
  const add = (type: DebrisType, x: number, z: number, yaw: number) => {
    if (Math.abs(x) > half || Math.abs(z) > half) return;
    if (left[type] <= 0) type = left[DebrisType.Sedan] > 0 ? DebrisType.Sedan : left[DebrisType.Suv] > 0 ? DebrisType.Suv : DebrisType.Pickup;
    if (left[type] <= 0) return;
    left[type]--;
    field.place(type, x, z, yaw);
    placed++;
  };
  const car = () => {
    const r = rand();
    return r < 0.44 ? DebrisType.Sedan : r < 0.74 ? DebrisType.Suv : DebrisType.Pickup;
  };
  // car parks: rows aligned with the longest edge
  for (const p of city.tile.parking) {
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9, best = 0, ang = 0;
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i] / 10, z = p[i + 1] / 10;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      const j = (i + 2) % p.length;
      const ex = p[j] / 10 - x, ez = p[j + 1] / 10 - z, l = Math.hypot(ex, ez);
      if (l > best) { best = l; ang = Math.atan2(-ez, ex); }
    }
    const area = (x1 - x0) * (z1 - z0);
    const want = Math.min(26, Math.floor((area / 130) * (0.25 + rand() * 0.5)));
    for (let k = 0; k < want; k++) {
      const x = x0 + rand() * (x1 - x0), z = z0 + rand() * (z1 - z0);
      if (pointInPoly(x, z, p)) add(rand() < 0.03 ? DebrisType.Van : car(), x, z, ang + Math.PI / 2 + (rand() < 0.5 ? Math.PI : 0));
    }
  }
  // kerbside parking and traffic on the streets
  for (const r of city.tile.roads) {
    if (r.k === 0 && rand() < 0.7) continue;
    const w = r.w / 10;
    let s = 10 + rand() * 60;
    for (let i = 0; i + 3 < r.p.length; i += 2) {
      const ax = r.p[i] / 10, az = r.p[i + 1] / 10, bx = r.p[i + 2] / 10, bz = r.p[i + 3] / 10;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.5) continue;
      const dx = (bx - ax) / len, dz = (bz - az) / len;
      while (s < len) {
        const side = rand() < 0.5 ? -1 : 1;
        const type = rand() < 0.07 ? DebrisType.Van : car();
        // parked hard against the kerb, clear of the running lanes
        const off = Math.max(1.6, w / 2 - 0.6) * side;
        add(type, ax + dx * s - dz * off, az + dz * s + dx * off, Math.atan2(-dz, dx) + (side > 0 ? 0 : Math.PI));
        s += r.k >= 3 ? 28 + rand() * 70 : 45 + rand() * 150;
      }
      s -= len;
    }
  }
  field.flush();
  return placed;
}

/**
 * Everything that stands around buildings waiting to become a missile: wheelie bins,
 * garden sheds, trampolines, back-yard fences, dumpsters and shipping containers.
 */
export function placeYardObjects(city: City, field: DebrisField) {
  const rand = city.rand;
  const half = city.half - 4;
  const left: Record<number, number> = {};
  for (const t of [DebrisType.Bin, DebrisType.Shed, DebrisType.Trampoline, DebrisType.Fence, DebrisType.Dumpster, DebrisType.Container]) left[t] = field.capacity(t) - 2;
  /** place if the spot is on the tile and clear of (blocked & bits) */
  const put = (type: DebrisType, x: number, z: number, yaw: number, bits: number, anchor = 1, color = -1) => {
    if (left[type] <= 0 || Math.abs(x) > half || Math.abs(z) > half) return false;
    if (city.maskAt(x, z) & bits) return false;
    left[type]--;
    field.place(type, x, z, yaw, color, 1, anchor);
    return true;
  };
  for (let b = 0; b < city.count; b++) {
    const cls = city.cls[b];
    const x = city.cx[b], z = city.cz[b];
    const r = Math.sqrt(city.area[b]) / 2;
    const ax = city.axisX[b], az = city.axisZ[b];
    if (cls === 0) {
      if (city.frontD[b] === 0) continue;
      // lot axes: snap the direction of the street to the house's own walls
      const d1 = city.frontX[b] * ax + city.frontZ[b] * az, d2 = city.frontX[b] * -az + city.frontZ[b] * ax;
      let fx: number, fz: number;
      if (Math.abs(d1) >= Math.abs(d2)) { fx = ax * Math.sign(d1); fz = az * Math.sign(d1); }
      else { fx = -az * Math.sign(d2); fz = ax * Math.sign(d2); }
      const sx = -fz, sz = fx; // along the street
      const yawF = Math.atan2(-fz, fx), yawS = Math.atan2(-sz, sx);
      if (rand() < 0.6) {
        const side = rand() < 0.5 ? -1 : 1;
        put(DebrisType.Bin, x + sx * side * (r + 1.6) + fx * r * 0.5, z + sz * side * (r + 1.6) + fz * r * 0.5, yawF + (rand() - 0.5) * 0.4, 8);
      }
      if (rand() < 0.11) put(DebrisType.Shed, x - fx * (r + 7) + sx * (rand() - 0.5) * 8, z - fz * (r + 7) + sz * (rand() - 0.5) * 8, yawS, 13);
      if (rand() < 0.06) put(DebrisType.Trampoline, x - fx * (r + 6) + sx * (rand() - 0.5) * 6, z - fz * (r + 6) + sz * (rand() - 0.5) * 6, rand() * 6.28, 13);
      if (rand() < 0.42 && left[DebrisType.Fence] > 30) {
        // timber privacy fence round the back yard
        const hw = r + 3.2 + rand() * 2, d0 = r * 0.4, d1b = r + 9 + rand() * 5;
        const color = [0xb39a78, 0x9c8462, 0xc4b08e, 0x8a7658, 0xa7a39a][(rand() * 5) | 0];
        const run = (x0: number, z0: number, tx: number, tz: number, len: number, yaw: number) => {
          const n = Math.max(1, Math.round(len / 2.4));
          for (let k = 0; k < n; k++) {
            const t = (k + 0.5) * (len / n);
            put(DebrisType.Fence, x0 + tx * t, z0 + tz * t, yaw, 5, 1, color);
          }
        };
        for (const side of [-1, 1]) run(x + sx * side * hw - fx * d0, z + sz * side * hw - fz * d0, -fx, -fz, d1b - d0, yawF);
        run(x - sx * hw - fx * d1b, z - sz * hw - fz * d1b, sx, sz, hw * 2, yawS);
      }
    } else if (cls === 1 || cls === 4) {
      const yaw = Math.atan2(-az, ax);
      if (rand() < 0.5) {
        const a = rand() * 6.283;
        put(DebrisType.Dumpster, x + Math.cos(a) * (r + 3.5), z + Math.sin(a) * (r + 3.5), yaw + (rand() < 0.5 ? Math.PI / 2 : 0), 12);
      }
      if (cls === 4 && city.area[b] > 700) {
        const count = 1 + ((rand() * 4) | 0);
        const a = rand() * 6.283;
        for (let k = 0; k < count; k++) {
          const d = r + 9 + k * 3.1;
          put(DebrisType.Container, x + Math.cos(a) * d, z + Math.sin(a) * d, yaw, 12);
        }
      }
    }
  }
  field.flush();
}
