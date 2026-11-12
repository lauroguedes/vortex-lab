// Street furniture: timber utility poles carrying overhead lines, steel street
// lights, and the blue-green "power flashes" seen when a tornado tears lines down.
// Failure wind speeds follow the EF-scale damage indicators for electrical
// transmission lines (DI 24) and free-standing light poles (DI 26).

import * as THREE from 'three';
import { env, LIGHT_GLSL } from '../render/environment';
import { shadowAssets } from '../physics/debris';
import type { Tornado } from '../physics/tornado';
import type { City } from './city';
import { makeStreetLight, makeUtilityPole } from './shapes';

const MPH = 0.44704;
const LEAN = [108 * MPH, 102 * MPH]; // utility pole leaning, light pole bent
const FALL = [118 * MPH, 118 * MPH]; // broken / collapsed
const POWER_CUT = 27; // m/s: lines and transformers fail well before the poles do
const WIRE_SEGS = 8;
const WIRES: [number, number][] = [[-1.05, 9.82], [0, 9.82], [1.05, 9.82], [0, 7.1]];
const MAX_FLASH = 12;

const m4 = new THREE.Matrix4();
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();
const axis = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);
const vPos = new THREE.Vector3();
const one = new THREE.Vector3(1, 1, 1);
const col = new THREE.Color();
const w3 = new Float32Array(3);

const NIGHT_GLSL = /* glsl */ `float nightF() { return smoothstep(0.05, 0.45, uNight); }`;

export class Street {
  readonly group = new THREE.Group();
  readonly count: number;
  polesDown = 0;
  /** an arc or transformer failure at (x, z) */
  onFlash: ((x: number, z: number) => void) | null = null;

  private x: Float32Array; private z: Float32Array; private yaw: Float32Array;
  private kind: Uint8Array; // 0 utility pole, 1 street light
  private slot: Uint16Array; // instance index within its mesh
  private strength: Float32Array;
  private state: Uint8Array; private lit: Uint8Array;
  private lean: Float32Array; private leanT: Float32Array;
  private dx: Float32Array; private dz: Float32Array;
  private animating = new Set<number>();
  private meshes: THREE.InstancedMesh[] = [];
  private wires: THREE.LineSegments | null = null;
  private wireAlive: THREE.BufferAttribute | null = null;
  /** spans attached to each pole */
  private spansOf: number[][] = [];
  private glows: THREE.Points;
  private glowOn: THREE.BufferAttribute;
  private pools: THREE.InstancedMesh;
  private flashes: THREE.Points;
  private flashPos: THREE.BufferAttribute; private flashAmp: THREE.BufferAttribute;
  private flashT = new Float32Array(MAX_FLASH).fill(-1);
  private flashLen = new Float32Array(MAX_FLASH);
  private nextFlash = 0;
  private uPx = { value: 800 };
  private disposables: { dispose(): void }[] = [];

  constructor(private city: City) {
    const rand = city.rand;
    const half = city.half - 3;
    const xs: number[] = [], zs: number[] = [], yaws: number[] = [], kinds: number[] = [];
    const spans: [number, number][] = [];

    let lenPoles = 0, lenLights = 0;
    for (const r of city.tile.roads) {
      let l = 0;
      for (let i = 0; i + 3 < r.p.length; i += 2) l += Math.hypot(r.p[i + 2] - r.p[i], r.p[i + 3] - r.p[i + 1]) / 10;
      if (r.k === 1 || r.k === 2) lenPoles += l;
      else if (r.k >= 3 && r.k <= 5) lenLights += l;
    }
    const poleGap = Math.max(46, lenPoles / 1500), lightGap = Math.max(52, lenLights / 1300);

    for (const r of city.tile.roads) {
      const poles = r.k === 1 || r.k === 2;
      if (!poles && !(r.k >= 3 && r.k <= 5)) continue;
      const w = r.w / 10;
      const gap = poles ? poleGap : lightGap;
      const side0 = rand() < 0.5 ? -1 : 1;
      let s = gap * (0.3 + rand() * 0.6), prev = -1, k = 0;
      for (let i = 0; i + 3 < r.p.length; i += 2) {
        const ax = r.p[i] / 10, az = r.p[i + 1] / 10, bx = r.p[i + 2] / 10, bz = r.p[i + 3] / 10;
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.5) continue;
        const dx = (bx - ax) / len, dz = (bz - az) / len;
        while (s < len) {
          const side = poles ? side0 : k++ % 2 ? -1 : 1;
          const off = (w / 2 + (poles ? 2.4 : 1.2)) * side;
          const x = ax + dx * s - dz * off, z = az + dz * s + dx * off;
          s += gap;
          if (Math.abs(x) > half || Math.abs(z) > half || city.maskAt(x, z) & 12) { prev = -1; continue; }
          const id = xs.length;
          xs.push(x); zs.push(z); kinds.push(poles ? 0 : 1);
          // poles: cross-arm square to the road; lights: arm reaching over the carriageway
          yaws.push(poles ? Math.atan2(-dz, dx) : Math.atan2(dx * side, dz * side));
          if (poles && prev >= 0 && Math.hypot(xs[prev] - x, zs[prev] - z) < gap * 1.7) spans.push([prev, id]);
          prev = poles ? id : -1;
        }
        s -= len;
      }
    }

    const n = (this.count = xs.length);
    const f = () => new Float32Array(n);
    this.x = Float32Array.from(xs); this.z = Float32Array.from(zs); this.yaw = Float32Array.from(yaws);
    this.kind = Uint8Array.from(kinds);
    this.slot = new Uint16Array(n);
    this.strength = f(); this.lean = f(); this.leanT = f(); this.dx = f(); this.dz = f();
    this.state = new Uint8Array(n); this.lit = new Uint8Array(n);
    for (let i = 0; i < n; i++) { this.strength[i] = 0.85 + rand() * 0.35; this.spansOf.push([]); }

    // ---- instanced poles
    const counts = [0, 0];
    for (let i = 0; i < n; i++) this.slot[i] = counts[this.kind[i]]++;
    const mat = new THREE.ShaderMaterial({
      uniforms: env,
      vertexShader: /* glsl */ `
        attribute vec3 color; attribute float aTint;
        varying vec3 vWorld; varying vec3 vNormal; varying vec3 vColor; varying float vLamp;
        void main() {
          vec4 wp = instanceMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vNormal = normalize(mat3(instanceMatrix) * normal);
          vColor = color;
          vLamp = aTint * instanceColor.r;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        ${LIGHT_GLSL}
        ${NIGHT_GLSL}
        varying vec3 vWorld; varying vec3 vNormal; varying vec3 vColor; varying float vLamp;
        void main() {
          vec3 c = shade(vColor * (1.0 - 0.15 * uWet), normalize(vNormal));
          c += vLamp * nightF() * vec3(1.0, 0.85, 0.6) * 2.0;
          gl_FragColor = vec4(applyFog(c, distance(vWorld, cameraPosition)), 1.0);
        }`,
    });
    this.disposables.push(mat);
    for (const [k, geo] of [makeUtilityPole(), makeStreetLight()].entries()) {
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, counts[k]));
      mesh.count = counts[k];
      mesh.frustumCulled = false;
      mesh.setColorAt(0, col.set(0xffffff));
      this.meshes.push(mesh);
      this.group.add(mesh);
      this.disposables.push(geo);
    }

    // ---- overhead lines: three phase conductors on the cross-arm plus a lower cable
    if (spans.length) {
      const per = WIRES.length * WIRE_SEGS * 2;
      const pos = new Float32Array(spans.length * per * 3);
      const alive = new Float32Array(spans.length * per).fill(1);
      let o = 0;
      spans.forEach(([a, b], si) => {
        this.spansOf[a].push(si); this.spansOf[b].push(si);
        const ca = Math.cos(this.yaw[a]), sa = Math.sin(this.yaw[a]);
        const cb = Math.cos(this.yaw[b]), sb = Math.sin(this.yaw[b]);
        // keep each conductor on the same side of both poles even where the road bends back
        const flip = ca * cb + sa * sb < 0 ? -1 : 1;
        const span = Math.hypot(this.x[a] - this.x[b], this.z[a] - this.z[b]);
        const sag = span * 0.022;
        for (const [lz, ly] of WIRES) {
          const x0 = this.x[a] + sa * lz, z0 = this.z[a] + ca * lz;
          const x1 = this.x[b] + sb * lz * flip, z1 = this.z[b] + cb * lz * flip;
          for (let k = 0; k < WIRE_SEGS; k++) {
            for (const t of [k / WIRE_SEGS, (k + 1) / WIRE_SEGS]) {
              pos[o++] = x0 + (x1 - x0) * t;
              pos[o++] = ly - 4 * sag * t * (1 - t);
              pos[o++] = z0 + (z1 - z0) * t;
            }
          }
        }
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.wireAlive = new THREE.BufferAttribute(alive, 1);
      this.wireAlive.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aAlive', this.wireAlive);
      const wmat = new THREE.ShaderMaterial({
        uniforms: env,
        vertexShader: /* glsl */ `
          attribute float aAlive;
          varying vec3 vWorld;
          void main() {
            vWorld = position;
            gl_Position = aAlive > 0.5 ? projectionMatrix * viewMatrix * vec4(position, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          ${LIGHT_GLSL}
          varying vec3 vWorld;
          void main() { gl_FragColor = vec4(applyFog(vec3(0.012), distance(vWorld, cameraPosition)), 1.0); }`,
      });
      this.wires = new THREE.LineSegments(geo, wmat);
      this.wires.frustumCulled = false;
      this.group.add(this.wires);
      this.disposables.push(geo, wmat);
    }

    // ---- lamp glow sprites and pools of light on the road
    const lamps = counts[1];
    const gpos = new Float32Array(Math.max(1, lamps) * 3);
    const sh = shadowAssets();
    this.pools = new THREE.InstancedMesh(sh.geo, new THREE.ShaderMaterial({
      uniforms: env,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vWorld;
        void main() {
          vUv = uv;
          vec4 wp = instanceMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        ${LIGHT_GLSL}
        ${NIGHT_GLSL}
        varying vec2 vUv; varying vec3 vWorld;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float a = exp(-r * r * 4.0) * (1.0 - smoothstep(0.8, 1.0, r));
          float fog = exp(-distance(vWorld, cameraPosition) * uFogDensity);
          gl_FragColor = vec4(vec3(1.0, 0.74, 0.44) * 0.085 * a * nightF() * fog * (1.0 + 0.6 * uWet), 1.0);
        }`,
    }), Math.max(1, lamps));
    this.pools.count = lamps;
    this.pools.frustumCulled = false;
    this.pools.renderOrder = -1;
    for (let i = 0; i < n; i++) {
      if (this.kind[i] !== 1) continue;
      const s = this.slot[i];
      // lamp head sits 2.05 m out along the arm (local +x)
      gpos[s * 3] = this.x[i] + Math.cos(this.yaw[i]) * 2.05;
      gpos[s * 3 + 1] = 8.9;
      gpos[s * 3 + 2] = this.z[i] - Math.sin(this.yaw[i]) * 2.05;
    }
    const ggeo = new THREE.BufferGeometry();
    ggeo.setAttribute('position', new THREE.BufferAttribute(gpos, 3));
    this.glowOn = new THREE.BufferAttribute(new Float32Array(Math.max(1, lamps)).fill(1), 1);
    this.glowOn.setUsage(THREE.DynamicDrawUsage);
    ggeo.setAttribute('aOn', this.glowOn);
    ggeo.setDrawRange(0, lamps);
    const sprite = (size: string, colour: string, falloff: string) => new THREE.ShaderMaterial({
      uniforms: { ...env, uPx: this.uPx },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        ${LIGHT_GLSL}
        ${NIGHT_GLSL}
        attribute float aOn;
        uniform float uPx;
        varying float vK;
        void main() {
          vec4 mv = viewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = max(-mv.z, 1.0);
          vK = aOn * exp(-d * uFogDensity);
          gl_PointSize = aOn > 0.001 ? ${size} : 0.0;
        }`,
      fragmentShader: /* glsl */ `
        ${LIGHT_GLSL}
        ${NIGHT_GLSL}
        varying float vK;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float a = ${falloff};
          gl_FragColor = vec4(${colour} * a * vK, 1.0);
        }`,
    });
    const gmat = sprite('clamp(uPx * 2.2 / d, 3.0, 64.0)', 'vec3(1.0, 0.82, 0.56) * 0.8 * nightF()', 'exp(-r * r * 6.0) + 0.6 * exp(-r * r * 60.0)');
    this.glows = new THREE.Points(ggeo, gmat);
    this.glows.frustumCulled = false;
    this.glows.renderOrder = 4;
    this.group.add(this.pools, this.glows);

    // ---- power flashes
    const fgeo = new THREE.BufferGeometry();
    this.flashPos = new THREE.BufferAttribute(new Float32Array(MAX_FLASH * 3), 3);
    this.flashAmp = new THREE.BufferAttribute(new Float32Array(MAX_FLASH), 1);
    this.flashPos.setUsage(THREE.DynamicDrawUsage);
    this.flashAmp.setUsage(THREE.DynamicDrawUsage);
    fgeo.setAttribute('position', this.flashPos);
    fgeo.setAttribute('aOn', this.flashAmp);
    const fmat = sprite('clamp(uPx * 26.0 / d, 6.0, 420.0) * sqrt(aOn)', 'vec3(0.45, 0.8, 1.0) * 5.0', 'exp(-r * r * 5.0) + 3.0 * exp(-r * r * 70.0)');
    this.flashes = new THREE.Points(fgeo, fmat);
    this.flashes.frustumCulled = false;
    this.flashes.renderOrder = 5;
    this.group.add(this.flashes);
    this.disposables.push(ggeo, gmat, fgeo, fmat, this.pools.material as THREE.Material);

    this.reset();
  }

  /** @param heightPx drawing-buffer height, @param fov vertical field of view in degrees */
  setViewport(heightPx: number, fov: number) {
    this.uPx.value = heightPx / (2 * Math.tan((fov * Math.PI) / 360));
  }

  reset() {
    this.state.fill(0);
    this.lit.fill(1);
    this.lean.fill(0); this.leanT.fill(0);
    this.animating.clear();
    this.polesDown = 0;
    this.flashT.fill(-1);
    (this.flashAmp.array as Float32Array).fill(0);
    this.flashAmp.needsUpdate = true;
    for (let i = 0; i < this.count; i++) { this.write(i); this.setLit(i, true); }
    if (this.wireAlive) { (this.wireAlive.array as Float32Array).fill(1); this.wireAlive.needsUpdate = true; }
    this.flush();
  }

  private flush() {
    for (const m of this.meshes) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    this.pools.instanceMatrix.needsUpdate = true;
    this.glowOn.needsUpdate = true;
  }

  private write(i: number) {
    qB.setFromAxisAngle(up, this.yaw[i]);
    if (this.lean[i] > 0) {
      axis.set(this.dz[i], 0, -this.dx[i]).normalize();
      qA.setFromAxisAngle(axis, this.lean[i]).multiply(qB);
    } else qA.copy(qB);
    m4.compose(vPos.set(this.x[i], 0, this.z[i]), qA, one);
    this.meshes[this.kind[i]].setMatrixAt(this.slot[i], m4);
  }

  private setLit(i: number, on: boolean) {
    this.lit[i] = on ? 1 : 0;
    if (this.kind[i] !== 1) return;
    const s = this.slot[i];
    this.meshes[1].setColorAt(s, col.setScalar(on ? 1 : 0));
    (this.glowOn.array as Float32Array)[s] = on ? 1 : 0;
    const g = this.glows.geometry.attributes.position.array as Float32Array;
    const size = on ? 34 : 0;
    m4.makeScale(size, 1, size).setPosition(g[s * 3], 0.06, g[s * 3 + 2]);
    this.pools.setMatrixAt(s, m4);
  }

  private flash(x: number, y: number, z: number) {
    const k = this.nextFlash;
    this.nextFlash = (k + 1) % MAX_FLASH;
    this.flashPos.setXYZ(k, x, y, z);
    this.flashPos.needsUpdate = true;
    this.flashT[k] = 0;
    this.flashLen[k] = 0.35 + Math.random() * 0.9;
    this.onFlash?.(x, z);
  }

  step(dt: number, tornado: Tornado) {
    let lights = false;
    if (tornado.intensity > 0) {
      const reach = tornado.radiusOfWind(POWER_CUT) + 30;
      const r2 = reach * reach;
      for (let i = 0; i < this.count; i++) {
        if (this.state[i] === 2) continue;
        const ddx = this.x[i] - tornado.x, ddz = this.z[i] - tornado.z;
        if (ddx * ddx + ddz * ddz > r2) continue;
        tornado.sample(this.x[i], 8, this.z[i], w3);
        const sp = Math.hypot(w3[0], w3[2]);
        if (this.lit[i] && sp > POWER_CUT) { this.setLit(i, false); lights = true; }
        const k = this.kind[i];
        const eff = sp / this.strength[i];
        const next = eff >= FALL[k] ? 2 : eff >= LEAN[k] ? 1 : 0;
        if (next <= this.state[i]) continue;
        this.state[i] = next;
        this.dx[i] = w3[0] / (sp + 1e-3); this.dz[i] = w3[2] / (sp + 1e-3);
        this.leanT[i] = next === 2 ? 1.38 + Math.random() * 0.15 : 0.18 + Math.random() * 0.3;
        this.animating.add(i);
        if (next === 2) this.polesDown++;
        if (k === 0) {
          // conductors clash as the pole goes over; the spans it carries come down with it
          if (next === 2 && this.wireAlive) {
            const per = WIRES.length * WIRE_SEGS * 2;
            const a = this.wireAlive.array as Float32Array;
            for (const s of this.spansOf[i]) a.fill(0, s * per, (s + 1) * per);
            this.wireAlive.needsUpdate = true;
          }
          if (Math.random() < (next === 2 ? 0.75 : 0.35)) this.flash(this.x[i], 8.5, this.z[i]);
        }
      }
    }
    if (this.animating.size) {
      for (const i of this.animating) {
        const dl = this.leanT[i] - this.lean[i];
        this.lean[i] += Math.min(dl, dt * (0.5 + this.lean[i] * 2.4));
        this.write(i);
        if (dl < 1e-3) this.animating.delete(i);
      }
      for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
    }
    if (lights) this.flush();
    // flickering arcs
    let any = false;
    const amp = this.flashAmp.array as Float32Array;
    for (let k = 0; k < MAX_FLASH; k++) {
      if (this.flashT[k] < 0) continue;
      any = true;
      this.flashT[k] += dt;
      const u = this.flashT[k] / this.flashLen[k];
      if (u >= 1) { this.flashT[k] = -1; amp[k] = 0; continue; }
      amp[k] = (1 - u * u) * (0.35 + 0.65 * Math.abs(Math.sin(this.flashT[k] * 47 + k * 2.1) * Math.sin(this.flashT[k] * 19)));
    }
    if (any) this.flashAmp.needsUpdate = true;
  }

  dispose() {
    for (const m of this.meshes) m.dispose();
    this.pools.dispose();
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}

/** A cloud-to-ground lightning channel: a jagged, branching polyline shown for the length of the flash. */
export class Bolt {
  readonly line: THREE.LineSegments;
  private pos: Float32Array;
  private uI = { value: 0 };

  constructor(private max = 220) {
    this.pos = new Float32Array(max * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.line = new THREE.LineSegments(geo, new THREE.ShaderMaterial({
      uniforms: { uI: this.uI },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `uniform float uI; void main() { gl_FragColor = vec4(vec3(0.82, 0.86, 1.0) * uI, 1.0); }`,
    }));
    this.line.frustumCulled = false;
    this.line.visible = false;
    this.line.renderOrder = 3;
  }

  strike(x: number, z: number, top: number) {
    let n = 0;
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
      if (n >= this.max) return;
      this.pos.set([ax, ay, az, bx, by, bz], n++ * 6);
    };
    const channel = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, steps: number, jitter: number, depth: number) => {
      let px = x0, py = y0, pz = z0;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, last = i === steps;
        const qx = x0 + (x1 - x0) * t + (last ? 0 : (Math.random() - 0.5) * jitter);
        const qy = y0 + (y1 - y0) * t;
        const qz = z0 + (z1 - z0) * t + (last ? 0 : (Math.random() - 0.5) * jitter);
        seg(px, py, pz, qx, qy, qz);
        if (depth > 0 && !last && Math.random() < 0.16) {
          const len = (y0 - y1) * (0.15 + Math.random() * 0.25);
          const a = Math.random() * 6.283;
          channel(qx, qy, qz, qx + Math.cos(a) * len * 0.7, Math.max(0, qy - len), qz + Math.sin(a) * len * 0.7, 6, jitter * 0.6, depth - 1);
        }
        px = qx; py = qy; pz = qz;
      }
    };
    const a = Math.random() * 6.283, lean = top * (0.1 + Math.random() * 0.3);
    channel(x, top, z, x + Math.cos(a) * lean, 0, z + Math.sin(a) * lean, 26, top * 0.06, 2);
    this.line.geometry.setDrawRange(0, n * 2);
    this.line.geometry.attributes.position.needsUpdate = true;
    this.live = true;
  }

  private live = false;

  /** @param flash current lightning brightness 0..1 */
  update(flash: number) {
    if (this.live && flash < 0.02) this.live = false;
    this.line.visible = this.live;
    this.uI.value = flash * 14;
  }
}
