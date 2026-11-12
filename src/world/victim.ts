// First person: someone on foot in the tornado's path.
//
// The body is integrated with the same quadratic-drag physics as every other
// object in the scene, with numbers for a 75 kg adult:
//   standing, facing the wind   Cd·A ≈ 0.84 m²  → b = ρ·Cd·A / 2m = 0.0067 /m
//   tumbling, limbs flung out   Cd·A ≈ 0.50 m²  → b = 0.0040 /m (terminal fall speed ≈ 50 m/s,
//                                                 the free-fall speed of a skydiver)
// A tumbling body also carries autorotation lift, as the other tumbling objects in the
// scene do; its sense changes whenever an impact changes the way the body is turning.
// Standing is lost when drag exceeds friction, b·u² > μ·g, i.e. at about 30 m/s
// (67 mph) — the wind speed at which people are in fact blown off their feet.
// From there the wind decides: a weak tornado rolls and drags the body along
// the ground, a violent one throws it into the air. Buildings are solid to it.

import * as THREE from 'three';
import { GRAV, type Tornado } from '../physics/tornado';
import type { City } from './city';

const B_STAND = 0.0067;
const B_TUMBLE = 0.004;
const MU = 0.6;
const EYE = 1.68, CROUCH = 1.15, LYING = 0.32;

export type VictimState = 'waiting' | 'braced' | 'down' | 'airborne' | 'rest' | 'missed';

export interface VictimReadout {
  state: VictimState;
  /** own speed, height of the eyes above ground, wind speed at the body (SI) */
  speed: number; height: number; wind: number;
  /** load on the body in g */
  load: number;
  /** distance to the vortex axis */
  range: number;
  carried: number; airTime: number; peakHeight: number; peakSpeed: number; peakLoad: number;
  knockWind: number; impacts: number;
}

const w3 = new Float32Array(3);
const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();
const mLook = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);
const wall = { x: 0, z: 0 };

export class Victim {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  state: VictimState = 'waiting';
  /** 0..1 momentary loss of vision after a hard impact */
  blackout = 0;
  private quat = new THREE.Quaternion();
  private omega = new THREE.Vector3();
  private time = 0;
  private phase = Math.random() * 6.283;
  private wind = 0;
  private load = 1;
  private restFor = 0;
  private restAt = 0;
  private onFloor = false;
  private liftK = 0.4;
  private stats = { carried: 0, airTime: 0, peakHeight: 0, peakSpeed: 0, peakLoad: 1, knockWind: 0, impacts: 0 };

  /** Stand the person on open ground a little ahead of the tornado, where its core will pass. */
  place(city: City, tornado: Tornado) {
    const rx = -tornado.dirZ, rz = tornado.dirX;
    const remaining = tornado.pathLength - tornado.travelled;
    // about a quarter of a minute before the wind reaches the speed that takes people off their feet
    const off0 = 0.4 * tornado.cfg.rc * tornado.cfg.rotation;
    // how far ahead of the vortex the wind at body height already takes people off their feet
    let reach = 40;
    for (let d = 1500; d > 40; d -= 10) {
      tornado.sample(tornado.x + tornado.dirX * d + rx * off0, 1.2, tornado.z + tornado.dirZ * d + rz * off0, w3);
      if (B_STAND * (w3[0] * w3[0] + w3[2] * w3[2]) >= MU * GRAV) { reach = d; break; }
    }
    const lead = Math.min(reach + tornado.cfg.speed * 13, Math.max(40, remaining - 150));
    // the side where rotation and forward motion add up is the violent one
    const off = off0;
    const cx = tornado.x + tornado.dirX * lead + rx * off, cz = tornado.z + tornado.dirZ * lead + rz * off;
    // nearby open ground: the spot with the most room around it (a wide street, a square, a park)
    let x = cx, z = cz, best = -1;
    for (let ring = 0; ring < 12; ring++) {
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2 + ring;
        const px = cx + Math.cos(a) * ring * 7, pz = cz + Math.sin(a) * ring * 7;
        if (Math.abs(px) > city.half - 15 || Math.abs(pz) > city.half - 15) continue;
        if (city.maskAt(px, pz) & 12) continue; // not inside a building, not in water
        let room = 0;
        for (let d = 0; d < 8; d++) for (const r of [8, 16, 26, 40]) {
          if (city.maskAt(px + Math.cos(d * 0.785) * r, pz + Math.sin(d * 0.785) * r) & 8) break;
          room++;
        }
        const score = room - ring * 0.8; // prefer staying near where the core will pass
        if (score > best) { best = score; x = px; z = pz; }
      }
    }
    this.pos.set(x, EYE, z);
    this.vel.set(0, 0, 0);
    this.omega.set(0, 0, 0);
    this.quat.identity();
    this.state = 'waiting';
    this.time = 0; this.blackout = 0; this.load = 1; this.restFor = 0; this.restAt = 0; this.wind = 0;
    this.stats = { carried: 0, airTime: 0, peakHeight: 0, peakSpeed: 0, peakLoad: 1, knockWind: 0, impacts: 0 };
  }

  private hit(speed: number) {
    if (speed < 2.5) return;
    this.stats.impacts++;
    this.blackout = Math.min(1, Math.max(this.blackout, speed / 11));
    // brought to rest over roughly a tenth of a second
    this.load = Math.max(this.load, Math.min(45, speed / (0.1 * GRAV)));
    this.omega.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(Math.min(10, speed * 0.7));
    this.liftK = Math.random() < 0.7 ? 0.35 + 0.3 * Math.random() : -0.3;
  }

  step(dt: number, tornado: Tornado, city: City) {
    this.time += dt;
    const p = this.pos, v = this.vel;
    if (this.state === 'rest' || this.state === 'missed') { this.load += (1 - this.load) * Math.min(1, dt * 3); return; }

    if (this.state === 'waiting' || this.state === 'braced') {
      tornado.sample(p.x, 1.2, p.z, w3);
      const u = Math.hypot(w3[0], w3[2]);
      this.wind = u;
      this.state = u > 16 ? 'braced' : 'waiting';
      p.y += ((this.state === 'braced' ? CROUCH : EYE) - p.y) * Math.min(1, dt * 3);
      const ahead = (p.x - tornado.x) * tornado.dirX + (p.z - tornado.z) * tornado.dirZ;
      if (tornado.intensity <= 0 || (ahead < -tornado.radiusOfWind(20) - 80 && u < 12)) { this.state = 'missed'; return; }
      if (B_STAND * u * u < MU * GRAV) return;
      // drag now exceeds what the feet can hold
      this.state = 'down';
      this.stats.knockWind = u;
      v.set(w3[0] * 0.3, 1.5, w3[2] * 0.3);
      this.hit(4);
      vA.set(p.x - tornado.x, 0, p.z - tornado.z).normalize();
      this.quat.setFromRotationMatrix(mLook.lookAt(vB.set(0, 0, 0), vA, UP));
      return;
    }

    // ---- tumbling body: drag toward the gusty wind, gravity, lift
    const y = p.y;
    // the wind on a rolling body acts on its whole height, not just at the ground
    tornado.sample(p.x, y + 0.5, p.z, w3);
    const sp = Math.hypot(w3[0], w3[1], w3[2]);
    this.wind = sp;
    const ph = this.phase + this.time * 2.1;
    const g = sp * 0.22;
    const rx = w3[0] + g * Math.sin(ph) - v.x;
    const ry = w3[1] + g * 0.7 * Math.sin(ph * 1.31 + 2) - v.y;
    const rz = w3[2] + g * Math.cos(ph * 0.83) - v.z;
    const rel = Math.hypot(rx, ry, rz);
    const k = B_TUMBLE * rel * dt, f = k / (1 + k);
    const vx0 = v.x, vy0 = v.y, vz0 = v.z;
    v.x += rx * f; v.y += ry * f; v.z += rz * f;
    v.y -= GRAV * dt;
    const rh2 = rx * rx + rz * rz;
    if (y < 4) v.y += (0.5 * B_TUMBLE * rh2 * dt * (1 - y * 0.25)) / (1 + k);
    // autorotation lift, up or down with the sense of the tumble
    v.y += (this.liftK * B_TUMBLE * rh2 * dt) / (1 + k);
    const px = p.x, py = p.y, pz = p.z;
    p.addScaledVector(v, dt);

    // ---- the ground, and buildings (roofs to land on, walls to be thrown against)
    let floor = LYING;
    const b = city.buildingAt(p.x, p.z);
    if (b >= 0) {
      const top = city.topOf(b);
      if (py >= top + 0.15) floor = top + LYING;
      else if (p.y < top) {
        // thrown against a wall: the part of the motion into it is lost, the rest slides along the facade
        city.wallNormal(b, px, pz, wall);
        const vn = v.x * wall.x + v.z * wall.z;
        p.x = px; p.z = pz;
        if (vn < 0) {
          this.hit(-vn);
          v.x -= 1.15 * vn * wall.x; v.z -= 1.15 * vn * wall.z;
          // friction against the wall is proportional to how hard the wind presses the body onto it
          const vt = Math.hypot(v.x, v.z), slow = Math.min(vt, 0.5 * -vn);
          if (vt > 1e-3) { v.x -= (v.x / vt) * slow; v.z -= (v.z / vt) * slow; }
        }
      }
    }
    this.onFloor = false;
    if (p.y <= floor) {
      const down = -v.y;
      p.y = floor;
      this.onFloor = true;
      this.hit(down);
      const vh = Math.hypot(v.x, v.z);
      // a body moving fast along the ground cartwheels: some of that speed is thrown upward
      v.y = down > 0 ? down * 0.22 + (vh > 7 && down > 1 ? vh * 0.1 * Math.random() : 0) : 0;
      // sliding friction
      const slow = Math.min(vh, MU * GRAV * dt + (down > 1 ? vh * 0.25 : 0));
      if (vh > 1e-3) { v.x -= (v.x / vh) * slow; v.z -= (v.z / vh) * slow; }
    }
    this.state = p.y > floor + 0.7 ? 'airborne' : 'down';

    // ---- rotation: spun by the shear when airborne, rolling when on the ground
    const speed = v.length();
    const want = this.onFloor ? Math.min(7, Math.hypot(v.x, v.z) / 0.5) : Math.min(5, 0.6 + rel * 0.06);
    const t = this.time * 0.37 + this.phase;
    vA.set(Math.sin(t * 1.7), 0.5 * Math.sin(t * 0.9 + 1.3), Math.cos(t * 1.3)).normalize().multiplyScalar(want);
    this.omega.lerp(vA, Math.min(1, dt * 1.5));
    const om = this.omega.length();
    if (om > 1e-4) this.quat.premultiply(qA.setFromAxisAngle(vA.copy(this.omega).multiplyScalar(1 / om), om * dt)).normalize();

    // ---- what the body feels: specific force in g
    const ax = (v.x - vx0) / dt, ay = (v.y - vy0) / dt + GRAV, az = (v.z - vz0) / dt;
    const load = Math.min(45, Math.hypot(ax, ay, az) / GRAV);
    this.load += (Math.max(load, 0) - this.load) * Math.min(1, dt * 6);

    const st = this.stats;
    st.carried += Math.hypot(p.x - px, p.z - pz);
    if (this.state === 'airborne') st.airTime += dt;
    if (p.y - LYING > st.peakHeight) st.peakHeight = p.y - LYING;
    if (speed > st.peakSpeed) st.peakSpeed = speed;
    if (this.load > st.peakLoad) st.peakLoad = this.load;

    // ---- it is over once the vortex has moved on and the body lies still
    const u2 = w3[0] * w3[0] + w3[2] * w3[2];
    const behind = (p.x - tornado.x) * tornado.dirX + (p.z - tornado.z) * tornado.dirZ < 0;
    if (this.onFloor && Math.hypot(v.x, v.z) < 1.2 && B_TUMBLE * u2 < MU * GRAV * 0.6 && (behind || tornado.intensity <= 0)) {
      this.restFor += dt;
      if (this.restFor > 2) { this.state = 'rest'; this.restAt = this.time; v.set(0, 0, 0); }
    } else this.restFor = 0;
  }

  /** Put the camera at the person's eyes. */
  applyTo(camera: THREE.PerspectiveCamera, dt: number, tornado: Tornado) {
    const p = this.pos;
    this.blackout = Math.max(0, this.blackout - dt * 1.4);
    camera.position.copy(p);
    let fov = 58;
    const toTornado = vA.set(tornado.x - p.x, Math.min(tornado.cfg.lcl * 0.3, 110) - p.y, tornado.z - p.z);
    if (this.state === 'waiting' || this.state === 'braced' || this.state === 'missed') {
      // watching it come, buffeted harder and harder
      const gust = Math.min(1.4, (this.wind / 30) ** 2);
      const t = this.time;
      camera.position.x += gust * 0.07 * Math.sin(t * 9.1);
      camera.position.y += gust * 0.05 * Math.sin(t * 12.7 + 1);
      camera.position.z += gust * 0.07 * Math.sin(t * 7.3 + 2);
      qA.setFromRotationMatrix(mLook.lookAt(p, vB.copy(p).add(toTornado), UP));
      qB.setFromAxisAngle(FWD, gust * 0.05 * Math.sin(t * 5.3) + gust * 0.025 * Math.sin(t * 17));
      camera.quaternion.slerp(qA.multiply(qB), Math.min(1, dt * 3));
    } else if (this.state === 'rest') {
      // lying on one side, looking after it
      toTornado.y = 0.6;
      qA.setFromRotationMatrix(mLook.lookAt(p, vB.copy(p).add(toTornado), UP));
      camera.quaternion.slerp(qA.multiply(qB.setFromAxisAngle(FWD, 1.25)), Math.min(1, dt * 1.2));
    } else {
      camera.quaternion.slerp(this.quat, Math.min(1, dt * 14));
      fov = 58 + 20 * Math.min(1, this.vel.length() / 55);
    }
    camera.fov += (fov - camera.fov) * Math.min(1, dt * 3);
    camera.updateProjectionMatrix();
  }

  /** How much of the view is closed in: tunnel vision under load, darkness after impacts and at the end. */
  get vignette() {
    const end = this.state === 'rest' ? Math.min(0.5, (this.time - this.restAt) * 0.12) : 0;
    return Math.min(0.95, 0.3 + 0.07 * Math.max(0, this.load - 1) + end);
  }

  get readout(): VictimReadout {
    return {
      state: this.state, speed: this.vel.length(), height: Math.max(0, this.pos.y - (this.state === 'waiting' || this.state === 'braced' || this.state === 'missed' ? this.pos.y : LYING)),
      wind: this.wind, load: this.load, range: 0, ...this.stats,
    };
  }
}
