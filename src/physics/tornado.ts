// Kinematic tornado vortex model.
//
// Tangential wind follows a smoothed modified-Rankine profile
//     f(r̄) = r̄ / ((α + r̄⁴)/(1+α))^((1+α)/4) · taper(r̄),   r̄ = r / Rc
// which is solid-body rotation inside the core, peaks at r̄ = 1 and decays as
// r^-α outside (mobile-radar observations give α ≈ 0.5–0.7). Beyond ~6 core
// radii the taper 1/(1+(r̄/6)²) returns the flow to the storm's background, so
// the damaging-wind swath has a finite width of a few core diameters.
// The pressure field is obtained by integrating cyclostrophic balance
//     ∂p/∂r = ρ V² / r
// and the visible funnel is the surface where that pressure drop equals the
// hydrostatic pressure difference to the cloud base (see render/volumetric.ts).
// A shallow boundary-layer inflow and a corner-flow updraft (one- or two-cell)
// are layered on top, plus optional orbiting sub-vortices.

import type { TornadoPreset } from '../data/presets';

export const RHO = 1.2; // air density, kg/m³
export const GRAV = 9.81;

export const LUT_N = 1024;
export const LUT_RMAX = 40; // table spans r̄ ∈ [0, 40], sampled on u = sqrt(r̄/40)
export const MAX_SUB = 6;
/** e-folding radius (in core radii) beyond which the vortex blends into the background flow */
export const OUTER = 6;

export interface TornadoConfig extends TornadoPreset {
  /** compass heading of travel in degrees (0 = north, 90 = east) */
  heading: number;
  /** lateral offset of the track from the city centre, m */
  offset: number;
  /** +1 counter-clockwise (northern hemisphere), -1 clockwise */
  rotation: 1 | -1;
}

export class Tornado {
  cfg!: TornadoConfig;

  // shape look-up tables over r̄
  readonly fT = new Float32Array(LUT_N); // tangential
  readonly fR = new Float32Array(LUT_N); // radial inflow
  readonly fW = new Float32Array(LUT_N); // vertical
  readonly fP = new Float32Array(LUT_N); // pressure deficit / (ρ Vmax²)
  p0 = 1;

  // path
  startX = 0; startZ = 0; dirX = 0; dirZ = -1; pathLength = 1;
  travelled = 0;
  time = 0;
  active = false;
  finished = false;

  // live state
  x = 0; z = 0;
  intensity = 0; // life-cycle factor 0..1
  ropeOut = 0; // 0..1 during dissipation
  vmax = 0; // current parent tangential peak
  vsub = 0; // current sub-vortex tangential peak
  rc = 1;
  rcSub = 1;
  tiltX = 0; tiltZ = 0; sinA = 0;
  zin = 20;
  moveK = 0;
  subAngle = 0;
  readonly subCos = new Float32Array(MAX_SUB);
  readonly subSin = new Float32Array(MAX_SUB);
  readonly subAmp = new Float32Array(MAX_SUB);

  configure(cfg: TornadoConfig, half: number) {
    this.cfg = cfg;
    this.buildTables();
    const th = (cfg.heading * Math.PI) / 180;
    this.dirX = Math.sin(th);
    this.dirZ = -Math.cos(th);
    // perpendicular to the right of travel
    const px = -this.dirZ, pz = this.dirX;
    const reach = half * 1.18 + Math.min(cfg.rc * 1.5, 420);
    this.pathLength = reach * 2;
    this.startX = px * cfg.offset - this.dirX * reach;
    this.startZ = pz * cfg.offset - this.dirZ * reach;
    this.reset();
  }

  reset() {
    this.travelled = 0;
    this.time = 0;
    this.active = false;
    this.finished = false;
    this.subAngle = 0;
    this.x = this.startX;
    this.z = this.startZ;
    this.updateState(0);
  }

  /** The vortex has dissipated: winds drop to zero, airborne debris falls out. */
  end() {
    this.active = false;
    this.intensity = 0;
    this.vmax = 0;
    this.vsub = 0;
  }

  private buildTables() {
    const a = this.cfg.alpha;
    const two = this.cfg.twoCell;
    const N = LUT_N;
    const t1 = 1 + 1 / (OUTER * OUTER);
    const shape = (r: number) =>
      (r / Math.pow((a + r * r * r * r) / (1 + a), (1 + a) / 4)) * (t1 / (1 + (r * r) / (OUTER * OUTER)));
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      const r = LUT_RMAX * u * u;
      this.fT[i] = shape(r);
      // inflow: ∝ r̄² near the axis, peaks at r̄ ≈ 1.26, mass-conserving 1/r̄ decay outside
      this.fR[i] = (1.89 * r * r) / (1 + r * r * r);
      const oneCell = Math.exp(-(r * r) / 0.64);
      const twoCell = Math.exp(-(((r - 0.8) / 0.4) ** 2)) - 0.5 * Math.exp(-((r / 0.35) ** 2));
      this.fW[i] = (1 - two) * oneCell + two * twoCell + 0.12 * Math.exp(-((r / 3) ** 2));
    }
    // P(r̄) = ∫_r̄^∞ f² / s ds  — integrate inward from the analytic far-field tail
    // far field: f ≈ C s^-α · OUTER²/s²  →  ∫ f²/s ds = C² OUTER⁴ s^(-2α-4) / (2α+4)
    const C2 = Math.pow(1 + a, (2 * (1 + a)) / 4) * t1 * t1;
    let acc = (C2 * Math.pow(OUTER, 4) * Math.pow(LUT_RMAX, -2 * a - 4)) / (2 * a + 4);
    this.fP[N - 1] = acc;
    for (let i = N - 2; i >= 0; i--) {
      const r0 = LUT_RMAX * (i / (N - 1)) ** 2;
      const r1 = LUT_RMAX * ((i + 1) / (N - 1)) ** 2;
      const steps = 8;
      const h = (r1 - r0) / steps;
      let sum = 0;
      for (let k = 0; k < steps; k++) {
        const s = r0 + (k + 0.5) * h;
        const f = shape(s);
        sum += ((f * f) / s) * h;
      }
      acc += sum;
      this.fP[i] = acc;
    }
    this.p0 = this.fP[0];
  }

  /** Advance along the track. Returns false once the tornado has dissipated. */
  step(dt: number) {
    if (!this.active || this.finished) return;
    this.time += dt;
    const c = this.cfg;
    // forward speed eases in while the vortex organises
    const speed = c.speed * (0.45 + 0.55 * Math.min(1, this.time / 10));
    this.travelled += speed * dt;
    if (this.travelled >= this.pathLength) {
      this.travelled = this.pathLength;
      this.finished = true;
    }
    this.x = this.startX + this.dirX * this.travelled;
    this.z = this.startZ + this.dirZ * this.travelled;
    this.updateState(dt);
  }

  private updateState(dt: number) {
    const c = this.cfg;
    const spin = smooth(this.time / 14);
    const remain = this.pathLength - this.travelled;
    const decayLen = Math.min(520, this.pathLength * 0.16);
    this.ropeOut = 1 - smooth(remain / decayLen);
    this.intensity = this.active ? (0.3 + 0.7 * spin) * (1 - 0.8 * this.ropeOut) : 0;
    const multi = c.subvortices > 0;
    const v = c.vmax * this.intensity;
    this.vmax = multi ? v * 0.55 : v;
    this.vsub = multi ? v * 0.55 : 0;
    this.rc = c.rc * (0.55 + 0.45 * spin) * (1 - 0.6 * this.ropeOut);
    this.rcSub = Math.max(7, this.rc * 0.17);
    this.zin = Math.min(60, Math.max(12, 0.25 * this.rc));
    this.moveK = 0.45 + 0.55 * Math.min(1, this.time / 10);
    const th = ((c.heading + 35) * Math.PI) / 180;
    const tilt = c.tilt * (1 + 2.2 * this.ropeOut) + 0.25 * this.ropeOut;
    this.tiltX = Math.sin(th) * tilt;
    this.tiltZ = -Math.cos(th) * tilt;
    this.sinA = c.sinuous * (1 + 2.5 * this.ropeOut) + 30 * this.ropeOut;
    if (multi) {
      // sub-vortices travel at roughly half the parent tangential speed at their orbit
      const orbit = 0.8 * this.rc;
      const omega = (0.5 * this.vmax * lut(this.fT, 0.8)) / orbit;
      this.subAngle += omega * dt * c.rotation;
      for (let k = 0; k < c.subvortices; k++) {
        const ang = this.subAngle + (k / c.subvortices) * Math.PI * 2 + 0.35 * Math.sin(this.time * 0.21 + k * 1.7);
        this.subCos[k] = Math.cos(ang);
        this.subSin[k] = Math.sin(ang);
        // individual sub-vortices form and decay over time
        this.subAmp[k] = 0.55 + 0.45 * Math.sin(this.time * 0.37 + k * 2.4);
      }
    }
  }

  /** Centreline offset of the vortex axis at height y (must match the GLSL in render/volumetric.ts). */
  axisX(y: number) {
    const H = this.cfg.lcl;
    const s = Math.min(y / H, 1.3);
    return this.x + this.tiltX * y + this.sinA * s * Math.sin((y * 6.9813) / H + this.time * 0.31 + 1.0);
  }
  axisZ(y: number) {
    const H = this.cfg.lcl;
    const s = Math.min(y / H, 1.3);
    return this.z + this.tiltZ * y + this.sinA * s * Math.cos((y * 4.8332) / H - this.time * 0.23);
  }

  /** Ground-relative wind vector (m/s) at a point. Writes into out[0..2]. */
  sample(x: number, y: number, z: number, out: Float32Array | number[]) {
    if (this.intensity <= 0) { out[0] = out[1] = out[2] = 0; return; }
    const c = this.cfg;
    const yy = y > 0 ? y : 0;
    const H = c.lcl;
    const hn = yy < H * 1.2 ? yy / H : 1.2;
    const sN = hn < 1.3 ? hn : 1.3;
    let ax = this.x + this.tiltX * yy, az = this.z + this.tiltZ * yy;
    if (this.sinA > 0.01) {
      ax += this.sinA * sN * Math.sin((yy * 6.9813) / H + this.time * 0.31 + 1.0);
      az += this.sinA * sN * Math.cos((yy * 4.8332) / H - this.time * 0.23);
    }
    const dx = x - ax, dz = z - az;
    const r = Math.sqrt(dx * dx + dz * dz) + 1e-3;
    const rcz = this.rc * (1 + c.flare * hn * Math.sqrt(hn));
    const scale = Math.sqrt(this.rc / rcz);
    const rbar = r / rcz;

    let u = Math.sqrt(rbar / LUT_RMAX) * (LUT_N - 1);
    if (u > LUT_N - 1.001) u = LUT_N - 1.001;
    const i = u | 0, fr = u - i;
    const fT = this.fT[i] + (this.fT[i + 1] - this.fT[i]) * fr;
    const fR = this.fR[i] + (this.fR[i + 1] - this.fR[i]) * fr;
    const fW = this.fW[i] + (this.fW[i + 1] - this.fW[i]) * fr;

    // surface-layer shear: winds reach full strength by ~10 m AGL
    const bl = yy < 10 ? 0.55 + 0.45 * Math.sqrt(yy * 0.1) : 1;
    const ein = Math.exp(-yy / this.zin);
    const vm = this.vmax * scale;
    const vt = vm * fT * bl * c.rotation;
    const vr = -c.inflow * vm * fR * ein * bl;
    const w = c.updraft * vm * fW * (1 - ein) * (0.5 + 0.5 * Math.exp(-yy / (0.9 * H)));
    const rx = dx / r, rz = dz / r;
    let ox = vr * rx + vt * rz;
    let oz = vr * rz - vt * rx;
    let oy = w;

    // translation: the whole vortex is carried along by the parent storm
    const tr = 8 * this.rc + 300;
    const q = (r * r) / (tr * tr);
    const env = (q < 9 ? Math.exp(-q) : 0) * this.moveK;
    ox += this.dirX * c.speed * env;
    oz += this.dirZ * c.speed * env;

    const ns = c.subvortices;
    if (ns > 0 && rbar < 3) {
      const orbit = 0.8 * rcz;
      const tw = yy * 0.0045 * c.rotation; // sub-vortices spiral with height
      const ct = Math.cos(tw), st = Math.sin(tw);
      const fade = Math.exp(-yy / (0.7 * H));
      const rcs = this.rcSub * (1 + 1.5 * hn);
      for (let k = 0; k < ns; k++) {
        const cx = this.subCos[k] * ct - this.subSin[k] * st;
        const sz = this.subSin[k] * ct + this.subCos[k] * st;
        const ddx = x - (ax + orbit * cx), ddz = z - (az + orbit * sz);
        const rs = Math.sqrt(ddx * ddx + ddz * ddz) + 1e-3;
        const rb = rs / rcs;
        if (rb > 12) continue;
        let us = Math.sqrt(rb / LUT_RMAX) * (LUT_N - 1);
        const j = us | 0, fj = us - j;
        const f = this.fT[j] + (this.fT[j + 1] - this.fT[j]) * fj;
        const vs = this.vsub * this.subAmp[k] * f * bl * fade * c.rotation;
        ox += (vs * ddz) / rs;
        oz -= (vs * ddx) / rs;
        oy += 0.55 * this.vsub * this.subAmp[k] * Math.exp(-rb * rb * 1.5) * (1 - ein) * fade;
      }
    }
    out[0] = ox; out[1] = oy; out[2] = oz;
  }

  private tmp = new Float32Array(3);

  /** Horizontal ground-relative wind speed at 10 m AGL. */
  speedAt(x: number, z: number) {
    this.sample(x, 10, z, this.tmp);
    return Math.hypot(this.tmp[0], this.tmp[2]);
  }

  /** Strongest 10 m wind anywhere in the vortex right now (scans the core). */
  peakWind() {
    if (this.intensity <= 0) return 0;
    let best = 0;
    const radii = this.cfg.subvortices > 0 ? [0.6, 0.72, 0.8, 0.88, 1.0, 1.1] : [0.8, 1.0, 1.25];
    const n = this.cfg.subvortices > 0 ? 96 : 40;
    for (const k of radii) {
      const r = this.rc * k;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const s = this.speedAt(this.axisX(10) + Math.cos(a) * r, this.axisZ(10) + Math.sin(a) * r);
        if (s > best) best = s;
      }
    }
    return best;
  }

  /** Central surface pressure deficit in Pa. */
  pressureDeficit() {
    return RHO * this.p0 * (this.vmax * this.vmax + this.vsub * this.vsub);
  }

  /** Radius within which 10 m winds exceed the given speed (storm-relative, approx). */
  radiusOfWind(speed: number) {
    const v = this.vmax + this.vsub + this.cfg.speed;
    if (v <= speed) return 0;
    // outer profile: V ≈ Vmax (1+α)^((1+α)/4) r̄^-α
    const a = this.cfg.alpha;
    const C = Math.pow(1 + a, (1 + a) / 4);
    // power-law bound, capped where the far-field taper has killed the circulation
    return this.rc * Math.min(Math.pow((C * v) / speed, 1 / a), 2.2 * OUTER);
  }
}

function smooth(t: number) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

export function lut(table: Float32Array, rbar: number) {
  let u = Math.sqrt(rbar / LUT_RMAX) * (LUT_N - 1);
  if (u > LUT_N - 1.001) u = LUT_N - 1.001;
  const i = u | 0;
  return table[i] + (table[i + 1] - table[i]) * (u - i);
}
