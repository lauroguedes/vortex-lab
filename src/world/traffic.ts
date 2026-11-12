// Road traffic. The mapped streets are turned into a graph (junctions are the
// vertices two or more streets share); vehicles follow it lane by lane with the
// Intelligent Driver Model for car-following, slow for turns and take junctions
// one at a time. Drivers react to the storm: they speed away when it is close,
// crawl in strong wind, stop when it is too violent to drive — and once the wind
// can move the vehicle the debris physics takes it over.
//
// Emergency vehicles (police, ambulance, fire) are dispatched as damage is
// reported and make for the latest reported location with lights flashing.

import * as THREE from 'three';
import { env, LIGHT_GLSL } from '../render/environment';
import { DebrisField, DebrisType, shadowAssets } from '../physics/debris';
import type { Tornado } from '../physics/tornado';
import type { City } from './city';

/** free-flow speed by road rank (service … motorway), m/s */
const SPEED = [0, 8.5, 11, 13.5, 15.5, 21, 27];
/** relative traffic density by road rank */
const WEIGHT = [0, 0.45, 1, 1.6, 2.2, 2.6, 3];
const MAX_AGENTS = 820;
const MAX_EMERGENCY = 14;

export type EmergencyKind = 'police' | 'ambulance' | 'fire';
const EMERGENCY_TYPE: Record<EmergencyKind, DebrisType> = {
  police: DebrisType.Police, ambulance: DebrisType.Ambulance, fire: DebrisType.FireTruck,
};
const KIND_ID: Record<EmergencyKind, number> = { police: 1, ambulance: 2, fire: 3 };

interface Edge {
  x: Float32Array; z: Float32Array; cum: Float32Array;
  len: number; a: number; b: number; k: number; w: number;
}
interface Node { x: number; z: number; out: [edge: number, dir: number][]; owner: number; until: number }

const m4 = new THREE.Matrix4();

export class Traffic {
  readonly beams: THREE.InstancedMesh;
  /** a driver leaning on the horn at (x, z) */
  onHorn: ((x: number, z: number) => void) | null = null;
  private edges: Edge[] = [];
  private nodes: Node[] = [];
  private entries: [edge: number, dir: number][] = [];
  private pick: Float32Array; // cumulative spawn weight per edge
  private side: number;
  private n = 0;
  // agents
  private alive = new Uint8Array(MAX_AGENTS);
  private type = new Uint8Array(MAX_AGENTS);
  private kind = new Uint8Array(MAX_AGENTS); // 0 civilian, 1 police, 2 ambulance, 3 fire
  private inst = new Int32Array(MAX_AGENTS).fill(-1);
  private edge = new Int32Array(MAX_AGENTS);
  private dir = new Int8Array(MAX_AGENTS);
  private nextEdge = new Int32Array(MAX_AGENTS);
  private nextDir = new Int8Array(MAX_AGENTS);
  private turn = new Float32Array(MAX_AGENTS);
  private s = new Float32Array(MAX_AGENTS);
  private v = new Float32Array(MAX_AGENTS);
  private drive = new Float32Array(MAX_AGENTS); // driver's speed factor
  private mood = new Float32Array(MAX_AGENTS); // storm reaction: speed multiplier
  private len = new Float32Array(MAX_AGENTS);
  private px = new Float32Array(MAX_AGENTS);
  private pz = new Float32Array(MAX_AGENTS);
  private yaw = new Float32Array(MAX_AGENTS);
  private wait = new Float32Array(MAX_AGENTS); // seconds until a lost vehicle is replaced / next wind check
  private order = new Int32Array(MAX_AGENTS);
  private time = 0;
  private target = { x: 0, z: 0, set: false };
  private beamM: Float32Array;

  constructor(private city: City, private field: DebrisField, leftHand: boolean) {
    this.side = leftHand ? -1 : 1;
    this.buildGraph();
    this.pick = new Float32Array(this.edges.length);
    let acc = 0;
    this.edges.forEach((e, i) => { acc += e.len * WEIGHT[e.k]; this.pick[i] = acc; });

    const sh = shadowAssets();
    this.beams = new THREE.InstancedMesh(sh.geo, new THREE.ShaderMaterial({
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
        varying vec2 vUv; varying vec3 vWorld;
        void main() {
          // a pool thrown forward of the car: bright near the bumper, fanning out and fading
          float along = vUv.x, across = abs(vUv.y - 0.5) * 2.0;
          float a = pow(1.0 - along, 1.6) * smoothstep(0.0, 0.06, along) * exp(-across * across * (7.0 - 4.5 * along));
          float fog = exp(-distance(vWorld, cameraPosition) * uFogDensity);
          gl_FragColor = vec4(vec3(1.0, 0.93, 0.78) * 0.11 * a * smoothstep(0.05, 0.45, uNight) * fog * (1.0 + 0.8 * uWet), 1.0);
        }`,
    }), MAX_AGENTS);
    this.beams.frustumCulled = false;
    this.beams.renderOrder = -1;
    this.beams.count = 0;
    this.beamM = this.beams.instanceMatrix.array as Float32Array;
    this.beamM.fill(0);
  }

  private buildGraph() {
    const roads = this.city.tile.roads.filter((r) => r.k >= 1 && r.p.length >= 4);
    // junctions: vertices shared between streets, plus every street end
    const uses = new Map<string, number>();
    for (const r of roads) {
      const seen = new Set<string>();
      for (let i = 0; i < r.p.length; i += 2) {
        const key = r.p[i] + ',' + r.p[i + 1];
        if (seen.has(key)) continue;
        seen.add(key);
        uses.set(key, (uses.get(key) ?? 0) + 1);
      }
    }
    const ids = new Map<string, number>();
    const nodeAt = (px: number, pz: number) => {
      const key = px + ',' + pz;
      let id = ids.get(key);
      if (id === undefined) {
        id = this.nodes.length;
        ids.set(key, id);
        this.nodes.push({ x: px / 10, z: pz / 10, out: [], owner: -1, until: 0 });
      }
      return id;
    };
    for (const r of roads) {
      const m = r.p.length / 2;
      let start = 0;
      for (let i = 1; i < m; i++) {
        const junction = i === m - 1 || (uses.get(r.p[i * 2] + ',' + r.p[i * 2 + 1]) ?? 0) > 1;
        if (!junction) continue;
        const cnt = i - start + 1;
        const x = new Float32Array(cnt), z = new Float32Array(cnt), cum = new Float32Array(cnt);
        for (let k = 0; k < cnt; k++) {
          x[k] = r.p[(start + k) * 2] / 10; z[k] = r.p[(start + k) * 2 + 1] / 10;
          if (k) cum[k] = cum[k - 1] + Math.hypot(x[k] - x[k - 1], z[k] - z[k - 1]);
        }
        const len = cum[cnt - 1];
        if (len > 3) {
          const a = nodeAt(r.p[start * 2], r.p[start * 2 + 1]), b = nodeAt(r.p[i * 2], r.p[i * 2 + 1]);
          const id = this.edges.length;
          this.edges.push({ x, z, cum, len, a, b, k: Math.min(6, r.k), w: r.w / 10 });
          this.nodes[a].out.push([id, 1]);
          this.nodes[b].out.push([id, -1]);
        }
        start = i;
      }
    }
    // streets that run off the map are where traffic enters and leaves
    const lim = this.city.half - 30;
    for (const nd of this.nodes) {
      if (nd.out.length === 1 && (Math.abs(nd.x) > lim || Math.abs(nd.z) > lim)) this.entries.push(nd.out[0]);
    }
  }

  /** Distance from the edge's first vertex, segment index and unit direction of travel. */
  private locate(i: number, out: { x: number; z: number; tx: number; tz: number }) {
    const e = this.edges[this.edge[i]];
    const d = this.dir[i] > 0 ? this.s[i] : e.len - this.s[i];
    let k = 1;
    while (k < e.cum.length - 1 && e.cum[k] < d) k++;
    const seg = e.cum[k] - e.cum[k - 1] || 1;
    const t = Math.min(1, Math.max(0, (d - e.cum[k - 1]) / seg));
    const tx = ((e.x[k] - e.x[k - 1]) / seg) * this.dir[i], tz = ((e.z[k] - e.z[k - 1]) / seg) * this.dir[i];
    // keep to the nearside lane, clear of the parked cars at the kerb
    const off = Math.max(0.9, Math.min(e.w / 4, e.w / 2 - 2.6)) * this.side;
    out.x = e.x[k - 1] + (e.x[k] - e.x[k - 1]) * t - tz * off;
    out.z = e.z[k - 1] + (e.z[k] - e.z[k - 1]) * t + tx * off;
    out.tx = tx; out.tz = tz;
  }

  /** Heading (unit vector) with which an edge is entered in the given direction. */
  private heading(edge: number, dir: number, atEnd: boolean, out: { x: number; z: number }) {
    const e = this.edges[edge], n = e.x.length;
    const k = (dir > 0) !== atEnd ? 1 : n - 1;
    const l = Math.hypot(e.x[k] - e.x[k - 1], e.z[k] - e.z[k - 1]) || 1;
    out.x = ((e.x[k] - e.x[k - 1]) / l) * dir; out.z = ((e.z[k] - e.z[k - 1]) / l) * dir;
  }

  /** Decide where agent i goes after its current edge. */
  private plan(i: number) {
    const e = this.edges[this.edge[i]];
    const node = this.nodes[this.dir[i] > 0 ? e.b : e.a];
    const h = { x: 0, z: 0 }, g = { x: 0, z: 0 };
    this.heading(this.edge[i], this.dir[i], true, h);
    let best = -1, bestDir = 1, bestW = -1, bestTurn = 0;
    // emergency crews steer for the reported damage; everyone else mostly keeps straight on
    const seek = this.kind[i] > 0 && this.target.set;
    let sx = 0, sz = 0;
    if (seek) {
      const l = Math.hypot(this.target.x - node.x, this.target.z - node.z) || 1;
      sx = (this.target.x - node.x) / l; sz = (this.target.z - node.z) / l;
    }
    for (const [id, dir] of node.out) {
      if (id === this.edge[i]) continue;
      this.heading(id, dir, false, g);
      const dot = h.x * g.x + h.z * g.z;
      let w = Math.exp(2.2 * dot) * WEIGHT[this.edges[id].k] * (0.4 + Math.random());
      if (seek) w = Math.exp(3 * (sx * g.x + sz * g.z)) * (0.8 + 0.4 * Math.random());
      if (w > bestW) { bestW = w; best = id; bestDir = dir; bestTurn = Math.acos(Math.max(-1, Math.min(1, dot))); }
    }
    this.nextEdge[i] = best;
    this.nextDir[i] = bestDir;
    this.turn[i] = bestTurn;
  }

  private randomEdge() {
    const r = Math.random() * this.pick[this.pick.length - 1];
    let lo = 0, hi = this.pick.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.pick[mid] < r) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /** Put agent i on the road: at a map entry (or anywhere, for the initial population). */
  private enter(i: number, anywhere: boolean, tornado: Tornado | null) {
    if (!this.edges.length) return false;
    const loc = { x: 0, z: 0, tx: 0, tz: 0 };
    for (let tries = 0; tries < 6; tries++) {
      if (anywhere || !this.entries.length) {
        this.edge[i] = this.randomEdge();
        this.dir[i] = Math.random() < 0.5 ? 1 : -1;
        this.s[i] = Math.random() * this.edges[this.edge[i]].len;
      } else {
        const [e, d] = this.entries[(Math.random() * this.entries.length) | 0];
        this.edge[i] = e; this.dir[i] = d; this.s[i] = 0;
      }
      this.locate(i, loc);
      if (Math.abs(loc.x) > this.city.half + 60 || Math.abs(loc.z) > this.city.half + 60) continue;
      if (tornado && tornado.intensity > 0 && tornado.speedAt(loc.x, loc.z) > 14) continue;
      const sys = this.field.system(this.type[i]);
      const yaw = Math.atan2(-loc.tz, loc.tx);
      if (this.inst[i] < 0 || !sys.isDriven(this.inst[i])) {
        this.inst[i] = this.field.place(this.type[i], loc.x, loc.z, yaw);
        sys.setDriven(this.inst[i], true);
      }
      this.px[i] = loc.x; this.pz[i] = loc.z; this.yaw[i] = yaw;
      this.v[i] = SPEED[this.edges[this.edge[i]].k] * 0.7;
      this.mood[i] = 1;
      this.alive[i] = 1;
      this.plan(i);
      sys.drive(this.inst[i], loc.x, loc.z, yaw, 0, 0);
      return true;
    }
    return false;
  }

  private add(type: DebrisType, kind: number, anywhere: boolean, tornado: Tornado | null) {
    if (this.n >= MAX_AGENTS) return -1;
    const i = this.n++;
    this.type[i] = type; this.kind[i] = kind; this.inst[i] = -1;
    this.len[i] = this.field.lengthOf(type);
    this.drive[i] = kind ? 1.75 : 0.82 + Math.random() * 0.36;
    this.wait[i] = Math.random() * 0.3;
    if (!this.enter(i, anywhere, tornado)) { this.alive[i] = 0; this.wait[i] = 3; }
    return i;
  }

  /** (Re)populate the streets. Call after the debris field has been cleared. */
  populate() {
    this.n = 0;
    this.alive.fill(0);
    this.inst.fill(-1);
    this.time = 0;
    this.target.set = false;
    for (const nd of this.nodes) nd.owner = -1;
    this.beamM.fill(0);
    if (!this.edges.length) return;
    const total = this.pick[this.pick.length - 1];
    const want = Math.min(MAX_AGENTS - MAX_EMERGENCY, Math.max(60, Math.round(total / 70)));
    for (let k = 0; k < want; k++) {
      const r = Math.random();
      const type = r < 0.46 ? DebrisType.Sedan : r < 0.74 ? DebrisType.Suv : r < 0.84 ? DebrisType.Pickup : r < 0.93 ? DebrisType.Van : r < 0.98 ? DebrisType.Bus : DebrisType.Semi;
      this.add(type, 0, true, null);
    }
    // street signs at the junctions
    let signs = this.field.capacity(DebrisType.Sign) - 4;
    const h = { x: 0, z: 0 };
    for (const nd of this.nodes) {
      if (nd.out.length < 3 || signs <= 0) continue;
      if (Math.abs(nd.x) > this.city.half - 8 || Math.abs(nd.z) > this.city.half - 8) continue;
      const [id, dir] = nd.out[(Math.random() * nd.out.length) | 0];
      this.heading(id, dir, false, h);
      const w = this.edges[id].w;
      const x = nd.x + h.x * (w / 2 + 3) + h.z * (w / 2 + 1.2) * this.side, z = nd.z + h.z * (w / 2 + 3) - h.x * (w / 2 + 1.2) * this.side;
      if (this.city.maskAt(x, z) & 12) continue;
      this.field.place(DebrisType.Sign, x, z, Math.atan2(-h.z, h.x));
      signs--;
    }
    this.field.flush();
  }

  /** Send an emergency vehicle in from the edge of the map. */
  dispatch(kind: EmergencyKind, tornado: Tornado) {
    let count = 0;
    for (let i = 0; i < this.n; i++) if (this.kind[i] === KIND_ID[kind]) count++;
    if (count >= this.field.capacity(EMERGENCY_TYPE[kind]) - 2 || count >= 5) return;
    this.add(EMERGENCY_TYPE[kind], KIND_ID[kind], false, tornado);
  }

  /** Where the emergency services are heading: the most recently reported damage. */
  setTarget(x: number, z: number) {
    this.target.x = x; this.target.z = z; this.target.set = true;
  }

  /** Position of the nearest active emergency vehicle of a kind, or null. */
  nearest(kind: EmergencyKind, x: number, z: number, out: { x: number; z: number }) {
    let best = Infinity;
    const id = KIND_ID[kind];
    for (let i = 0; i < this.n; i++) {
      if (this.kind[i] !== id || !this.alive[i]) continue;
      const d = (this.px[i] - x) ** 2 + (this.pz[i] - z) ** 2;
      if (d < best) { best = d; out.x = this.px[i]; out.z = this.pz[i]; }
    }
    return best < Infinity;
  }

  get count() {
    let c = 0;
    for (let i = 0; i < this.n; i++) c += this.alive[i];
    return c;
  }

  private loc = { x: 0, z: 0, tx: 0, tz: 0 };

  step(dt: number, tornado: Tornado) {
    if (dt <= 0 || !this.n) return;
    this.time += dt;
    const n = this.n, order = this.order;
    const live = tornado.intensity > 0;
    const tx = tornado.x, tz = tornado.z;
    const scare = live ? tornado.radiusOfWind(14) + 500 : 0;

    // ---- order the vehicles lane by lane, front to back
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (this.alive[i]) { order[m++] = i; continue; }
      // a vehicle that was thrown or lost is replaced by a new arrival
      this.wait[i] -= dt;
      if (this.wait[i] <= 0) { if (!this.enter(i, false, tornado)) this.wait[i] = 4 + Math.random() * 6; }
    }
    const lane = (i: number) => this.edge[i] * 2 + (this.dir[i] > 0 ? 0 : 1);
    const list = Array.from(order.subarray(0, m));
    list.sort((a, b) => lane(a) - lane(b) || this.s[b] - this.s[a]);

    const loc = this.loc;
    const night = env.uNight.value > 0.04;
    for (let q = 0; q < m; q++) {
      const i = list[q];
      const sys = this.field.system(this.type[i]);
      if (!sys.isDriven(this.inst[i])) {
        // the wind has it now
        this.alive[i] = 0;
        this.inst[i] = -1;
        this.wait[i] = 5 + Math.random() * 10;
        this.beamM[i * 16] = this.beamM[i * 16 + 10] = 0;
        continue;
      }
      const e = this.edges[this.edge[i]];

      // ---- how the driver reacts to the storm (checked a few times a second)
      this.wait[i] -= dt;
      if (this.wait[i] <= 0) {
        this.wait[i] = 0.25 + Math.random() * 0.2;
        let mood = 1;
        if (live) {
          const d = Math.hypot(this.px[i] - tx, this.pz[i] - tz);
          if (d < scare) {
            const sp = tornado.speedAt(this.px[i], this.pz[i]);
            if (sp > 30) mood = 0; // impossible to drive: stopped, sheltering
            else if (sp > 17) mood = 0.45;
            else if (!this.kind[i]) {
              mood = 1.35; // getting out of the way
              if (Math.random() < 0.012) this.onHorn?.(this.px[i], this.pz[i]);
            }
          }
        }
        this.mood[i] = mood;
      }

      // ---- car following (IDM)
      let v0 = SPEED[e.k] * this.drive[i] * this.mood[i];
      const toEnd = e.len - this.s[i];
      if (this.turn[i] > 0.5 && toEnd < 22) v0 = Math.min(v0, this.kind[i] ? 8 : 5.5);
      let gap = 1e6, dv = 0;
      const lead = q > 0 ? list[q - 1] : -1;
      if (lead >= 0 && this.alive[lead] && lane(lead) === lane(i)) {
        gap = this.s[lead] - this.s[i] - 0.5 * (this.len[lead] + this.len[i]);
        dv = this.v[i] - this.v[lead];
      } else if (toEnd < 16 + this.v[i] * 1.5) {
        // first in line: take the junction if it is free, otherwise hold at the line
        const node = this.nodes[this.dir[i] > 0 ? e.b : e.a];
        if (node.out.length >= 3 && !this.kind[i]) {
          if (node.owner === i || node.until < this.time) { node.owner = i; node.until = this.time + 3.5; }
          else { gap = toEnd - 4; dv = this.v[i]; }
        }
        if (this.nextEdge[i] < 0 && this.entries.length === 0) { gap = toEnd - 2; dv = this.v[i]; }
      }
      const v = this.v[i];
      const aMax = this.kind[i] ? 2.6 : 1.7, bComf = 2.6;
      const sStar = 2.2 + Math.max(0, v * 1.25 + (v * dv) / (2 * Math.sqrt(aMax * bComf)));
      let acc = v0 > 0.1 ? aMax * (1 - Math.pow(v / v0, 4)) : -bComf;
      if (gap < 1e5) acc -= aMax * (sStar / Math.max(gap, 0.5)) ** 2;
      this.v[i] = Math.max(0, v + Math.max(acc, -7) * dt);
      this.s[i] += this.v[i] * dt;

      // ---- on to the next street
      if (this.s[i] >= e.len) {
        const node = this.nodes[this.dir[i] > 0 ? e.b : e.a];
        if (node.owner === i) node.until = this.time + 0.8;
        if (this.nextEdge[i] < 0) {
          // ran off the map (or into a dead end): come back in somewhere else
          if (!this.enter(i, false, tornado)) { this.alive[i] = 0; this.wait[i] = 2 + Math.random() * 5; sys.drive(this.inst[i], 1e5, 1e5, 0, 0, 0); }
          continue;
        }
        this.s[i] -= e.len;
        this.edge[i] = this.nextEdge[i];
        this.dir[i] = this.nextDir[i];
        this.s[i] = Math.min(this.s[i], this.edges[this.edge[i]].len - 0.1);
        this.plan(i);
      }

      // ---- pose: follow the lane with a little lag so corners are driven, not teleported
      this.locate(i, loc);
      const k = 1 - Math.exp(-dt * (2.5 + this.v[i] * 0.45));
      const ox = this.px[i], oz = this.pz[i];
      this.px[i] += (loc.x - ox) * k; this.pz[i] += (loc.z - oz) * k;
      const want = Math.atan2(-loc.tz, loc.tx);
      let dy = want - this.yaw[i];
      dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
      this.yaw[i] += dy * Math.min(1, dt * (1.5 + this.v[i] * 0.35));
      sys.drive(this.inst[i], this.px[i], this.pz[i], this.yaw[i], (this.px[i] - ox) / dt, (this.pz[i] - oz) / dt);

      if (night) {
        const c = Math.cos(this.yaw[i]), s = Math.sin(this.yaw[i]);
        const L = this.kind[i] ? 26 : 20, W = 9, o = i * 16, f = this.len[i] / 2;
        const bm = this.beamM;
        bm[o] = c * L; bm[o + 1] = 0; bm[o + 2] = -s * L; bm[o + 3] = 0;
        bm[o + 4] = 0; bm[o + 5] = 1; bm[o + 6] = 0; bm[o + 7] = 0;
        bm[o + 8] = s * W; bm[o + 9] = 0; bm[o + 10] = c * W; bm[o + 11] = 0;
        bm[o + 12] = this.px[i] + c * (f + L / 2); bm[o + 13] = 0.07; bm[o + 14] = this.pz[i] - s * (f + L / 2); bm[o + 15] = 1;
      }
    }
    this.beams.visible = night;
    if (night) {
      this.beams.count = n;
      this.beams.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    (this.beams.material as THREE.Material).dispose();
    this.beams.dispose();
    this.beams.removeFromParent();
  }
}
