import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import citiesJson from './data/cities.json';
import { PRESETS } from './data/presets';
import { Tornado, type TornadoConfig } from './physics/tornado';
import { DebrisField } from './physics/debris';
import { DamageModel } from './physics/damage';
import { applyLighting, env, LIGHTING } from './render/environment';
import { makeNoiseTexture } from './render/noise';
import { Pipeline } from './render/pipeline';
import { loadCity, type City, type CityMeta } from './world/city';
import { Trees, placeVehicles, placeYardObjects } from './world/props';
import { Bolt, Street } from './world/street';
import { Traffic, type EmergencyKind } from './world/traffic';
import { Victim } from './world/victim';
import { Rain } from './world/rain';
import { Sky } from './world/sky';
import { StormAudio } from './audio/sound';
import { Minimap } from './ui/minimap';
import { UI, type CameraMode, type ChangeKind } from './ui/ui';

const CITIES = citiesJson as CityMeta[];
const STEP = 1 / 45;
const DEBRIS_DENSITY = [0.45, 1, 1.9];
const DEBRIS_BUDGET = [7000, 15000, 30000];
const VOLUME_QUALITY: [number, number][] = [[0.34, 64], [0.5, 96], [0.75, 136]];

type Phase = 'setup' | 'running' | 'paused' | 'finished';

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
let pixelRatio = Math.min(window.devicePixelRatio, 2);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 1, 70000);
camera.position.set(900, 260, 1400);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.96; // allow looking up from street level; height is clamped in the loop
controls.minDistance = 4;
controls.maxDistance = 9000;
controls.zoomSpeed = 1.1;

const noise = makeNoiseTexture(64);
const pipeline = new Pipeline(renderer, noise);
const sky = new Sky(noise);
const rain = new Rain();
scene.add(sky.group, rain.mesh);

const debris = new DebrisField(60000);
const bolts = [new Bolt(), new Bolt(), new Bolt(), new Bolt()];
scene.add(debris.group, ...bolts.map((b) => b.line));

const tornado = new Tornado();
const victim = new Victim();
const EYE_FOV = 52;
const audio = new StormAudio();
// hard landings: vehicles crunch (and sometimes set off an alarm), roof sections break up
debris.onImpact = (kind, x, z, speed) => {
  if (kind === 'vehicle') {
    audio.play('vehicle', x, z, Math.min(1.5, speed / 18));
    if (Math.random() < 0.05) audio.play('alarm', x, z, 0.8);
  } else audio.play('collapse', x, z, 0.6);
};

// planned-track ribbon shown on the ground during setup
const trackUniforms = { uTime: env.uTime, uLen: { value: 1 }, uWidth: { value: 1 }, uOpacity: { value: 1 } };
const trackGeo = new THREE.PlaneGeometry(1, 1);
trackGeo.rotateX(-Math.PI / 2);
const track = new THREE.Mesh(
  trackGeo,
  new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: trackUniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uLen, uWidth, uOpacity;
      varying vec2 vUv;
      void main() {
        float x = (vUv.x - 0.5) * uWidth, y = vUv.y * uLen;
        float ax = abs(vUv.x - 0.5);
        float period = max(60.0, uWidth * 0.5);
        float chev = step(0.55, fract((y - abs(x) * 0.9) / period - uTime * 0.35));
        float border = smoothstep(0.455, 0.47, ax) * (1.0 - smoothstep(0.49, 0.5, ax));
        float centre = 1.0 - smoothstep(0.0, 1.5 / uWidth, ax);
        float ends = smoothstep(0.0, 0.04, vUv.y) * smoothstep(1.0, 0.96, vUv.y);
        float a = (0.07 + 0.13 * chev + 0.55 * border + 0.5 * centre) * ends * uOpacity;
        gl_FragColor = vec4(vec3(1.0, 0.62, 0.1) * 1.6, a);
      }`,
  }),
);
track.renderOrder = -3;
track.frustumCulled = false;
scene.add(track);

// ---------------------------------------------------------------- state
let city: City | null = null;
let trees: Trees | null = null;
let street: Street | null = null;
let traffic: Traffic | null = null;
let dispatched = 0;
let damage: DamageModel | null = null;
let phase: Phase = 'setup';
let timeScale = 1;
let cameraMode: CameraMode = 'overview';
let userMovedCamera = false;
let lastTx = 0, lastTz = 0;
let loadToken = 0;
let scourClock = 0;
let finishedAt = 0;
let reportShown = false;

const minimap = new Minimap(document.getElementById('minimap') as HTMLCanvasElement);
const ui = new UI(CITIES, {
  change: onChange,
  run: () => (phase === 'setup' ? start() : phase === 'finished' ? restart() : undefined),
  toggle: togglePlay,
  reset: () => reset(),
  speed: (s) => (timeScale = s),
  camera: (m) => setCameraMode(m, true),
  sound: (on) => audio.setMuted(!on),
});

controls.addEventListener('start', () => { userMovedCamera = true; });
minimap.onAim = (x, z) => {
  if (phase !== 'setup') return;
  // lateral distance of the clicked point from a centre-line through the city centre
  ui.setOffset(x * -tornado.dirZ + z * tornado.dirX);
  configureTornado();
};

function buildConfig(): TornadoConfig {
  const s = ui.settings;
  const preset = PRESETS.find((p) => p.id === s.presetId)!;
  const meta = ui.city();
  return {
    ...preset,
    vmax: s.vmax,
    rc: s.diameter / 2,
    speed: s.speed,
    lcl: s.lcl,
    heading: s.heading,
    offset: s.offset,
    rotation: meta.lat >= 0 ? 1 : -1,
  };
}

function configureTornado() {
  if (!city) return;
  tornado.configure(buildConfig(), city.half);
  pipeline.setProfile(tornado);
  ui.setProfileP0(tornado.p0);
  sky.setCloudBase(tornado.cfg.lcl);
  // ribbon
  const w = Math.max(30, tornado.cfg.rc * 2);
  track.scale.set(w, 1, tornado.pathLength);
  track.position.set(tornado.startX + tornado.dirX * tornado.pathLength * 0.5, 0.4, tornado.startZ + tornado.dirZ * tornado.pathLength * 0.5);
  track.rotation.y = -(tornado.cfg.heading * Math.PI) / 180;
  trackUniforms.uLen.value = tornado.pathLength;
  trackUniforms.uWidth.value = w;
  lastTx = tornado.x; lastTz = tornado.z;
  if (!userMovedCamera && phase === 'setup') setCameraMode('overview', false);
}

function applyEnvironment() {
  const s = ui.settings;
  const light = LIGHTING.find((l) => l.id === s.lighting)!;
  applyLighting(light, s.rain / 100);
  pipeline.exposure = light.exposure;
  trackUniforms.uOpacity.value = 1 - 0.7 * light.night; // the ribbon would glare in the dark
  if (city) pipeline.dustColor.set(city.meta.soil).lerp(new THREE.Color(0x4a4540), 0.5).multiplyScalar(0.8);
}

function applyQuality() {
  const s = ui.settings;
  const [scale, steps] = VOLUME_QUALITY[s.volume];
  pipeline.setQuality(scale, steps);
  damage?.setDensity(DEBRIS_DENSITY[s.debris], DEBRIS_BUDGET[s.debris]);
}

function onChange(kind: ChangeKind) {
  if (kind === 'city') void switchCity();
  else if (kind === 'tornado') { if (phase === 'setup') configureTornado(); }
  else if (kind === 'env') applyEnvironment();
  else applyQuality();
}

async function switchCity() {
  const token = ++loadToken;
  const meta = ui.city();
  ui.setRunEnabled(false);
  ui.loading(`Building ${meta.name}`, city !== null);
  await new Promise((r) => setTimeout(r, 30)); // let the overlay paint before the heavy work
  let next: City;
  try {
    next = await loadCity(meta);
  } catch (err) {
    console.error(err);
    ui.loading('Map tile failed to load — run “npm run fetch-cities”', true);
    return;
  }
  if (token !== loadToken) { next.dispose(); return; }
  city?.dispose();
  trees?.dispose();
  street?.dispose();
  traffic?.dispose();
  city = next;
  scene.add(city.group);
  trees = new Trees(city, debris);
  trees.onFall = (x, z) => audio.play('tree', x, z);
  street = new Street(city);
  street.onFlash = (x, z) => audio.play('transformer', x, z);
  syncViewport();
  traffic = new Traffic(city, debris, Boolean(meta.left));
  traffic.onHorn = (x, z) => audio.play('horn', x, z, 0.8);
  scene.add(trees.group, street.group, traffic.beams);
  damage = new DamageModel(city, debris, DEBRIS_DENSITY[ui.settings.debris]);
  damage.setDensity(DEBRIS_DENSITY[ui.settings.debris], DEBRIS_BUDGET[ui.settings.debris]);
  damage.onEvent = (kind, x, z, area) => {
    if (kind === 'collapse') { audio.play('collapse', x, z, 0.7 + Math.min(0.8, area / 500)); traffic?.setTarget(x, z); }
    else if (kind === 'roof') audio.play('collapse', x, z, 0.6);
    else audio.play(kind, x, z, 0.6 + Math.min(0.6, area / 1500));
  };
  minimap.setCity(city);
  let tallest = 0;
  for (let i = 0; i < city.count; i++) tallest = Math.max(tallest, city.height[i]);
  ui.setCityFacts(city.count, tallest, trees.count);
  phase = 'setup';
  userMovedCamera = false;
  applyEnvironment();
  reset();
  ui.setRunEnabled(true);
  ui.loading(null);
}

function reset() {
  if (!city || !damage || !trees || !street) return;
  phase = 'setup';
  reportShown = false;
  ui.report(null);
  damage.reset();
  trees.reset();
  street.reset();
  debris.clear();
  placeVehicles(city, debris);
  placeYardObjects(city, debris);
  traffic?.populate();
  dispatched = 0;
  minimap.resetDamage();
  configureTornado();
  track.visible = true;
  ui.setRunning(false, false);
  if (cameraMode !== 'overview') setCameraMode('overview', false);
}

function start() {
  if (!city) return;
  phase = 'running';
  tornado.active = true;
  track.visible = false;
  ui.setRunning(true, false);
  ui.autoSound();
  if (!userMovedCamera || cameraMode === 'overview') setCameraMode('follow', true);
}

function restart() {
  reset();
  start();
}

function togglePlay() {
  if (phase === 'setup') start();
  else if (phase === 'running') { phase = 'paused'; ui.setRunning(true, true); }
  else if (phase === 'paused') { phase = 'running'; ui.setRunning(true, false); }
  else if (phase === 'finished') restart();
}

// ---------------------------------------------------------------- cameras
function setCameraMode(mode: CameraMode, place: boolean) {
  if (mode === 'caught' && phase === 'setup') start();
  const was = cameraMode;
  cameraMode = mode;
  ui.setCameraMode(mode);
  if (!city) return;
  if (mode === 'caught') {
    // first person: the camera belongs to someone standing where the core will pass
    victim.place(city, tornado);
    controls.enabled = false;
    camera.near = 0.25; // the ground is centimetres from the eyes once they are down
    camera.position.copy(victim.pos);
    camera.lookAt(tornado.x, 60, tornado.z);
    camera.updateProjectionMatrix();
    ui.firstPerson(victim.readout);
    return;
  }
  if (was === 'caught') {
    controls.enabled = true;
    camera.near = 1;
    camera.fov = EYE_FOV;
    camera.up.set(0, 1, 0);
    camera.updateProjectionMatrix();
    ui.firstPerson(null);
    // step back from wherever the ride ended
    controls.target.copy(victim.pos);
    camera.position.set(victim.pos.x - tornado.dirX * 40, victim.pos.y + 18, victim.pos.z - tornado.dirZ * 40);
  }
  const c = tornado.cfg;
  const H = c.lcl;
  const rx = -tornado.dirZ, rz = tornado.dirX; // right of travel
  const tx = tornado.x, tz = tornado.z;
  if (mode === 'overview') {
    const d = city.half;
    camera.position.set(-tornado.dirX * d * 0.25 + rx * d * 1.25, Math.min(H * 0.55, 300), -tornado.dirZ * d * 0.25 + rz * d * 1.25);
    controls.target.set(tornado.startX * 0.3, H * 0.22, tornado.startZ * 0.3);
  } else if (mode === 'follow') {
    if (place) {
      const D = Math.min(2600, Math.max(650, 4.5 * c.rc + 520));
      camera.position.set(tx - tornado.dirX * D * 0.35 + rx * D, Math.min(H * 0.4, 170), tz - tornado.dirZ * D * 0.35 + rz * D);
    }
    controls.target.set(tx, H * 0.36, tz);
  } else if (mode === 'chase') {
    const D = Math.min(2400, Math.max(480, 5 * c.rc + 380));
    camera.position.set(tx - tornado.dirX * D + rx * D * 0.3, 2.4, tz - tornado.dirZ * D + rz * D * 0.3);
    controls.target.set(tx, H * 0.4, tz);
  } else {
    const ahead = Math.min(Math.max(700, 3 * c.rc + 500), Math.max(200, tornado.pathLength - tornado.travelled - 150));
    camera.position.set(tx + tornado.dirX * ahead + rx * 25, 1.9, tz + tornado.dirZ * ahead + rz * 25);
    controls.target.set(tx, H * 0.38, tz);
  }
  lastTx = tx; lastTz = tz;
  controls.update();
}

// ---------------------------------------------------------------- lightning
let flashTimer = 3;
let nextBolt = 0;
const strokes: number[] = [];
function updateLightning(dt: number) {
  let f = 0;
  if (ui.settings.lightning && phase !== 'paused') {
    flashTimer -= dt;
    if (flashTimer <= 0) {
      flashTimer = 0.5 + Math.random() * Math.random() * 5;
      const n = 1 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) strokes.push(env.uTime.value + i * (0.07 + Math.random() * 0.12));
      const a = Math.random() * 6.283, d = 500 + Math.random() * 5000;
      const fx = tornado.x + Math.cos(a) * d, fz = tornado.z + Math.sin(a) * d;
      sky.deckUniforms.uFlashPos.value.set(fx, fz);
      audio.thunder(fx, fz, tornado.cfg.lcl);
      // most flashes reach the ground as a visible channel; big ones fork to a second strike point
      if (Math.random() < 0.65 && d > Math.max(500, tornado.rc * 3)) {
        nextBolt = (nextBolt + 1) % bolts.length;
        bolts[nextBolt].strike(fx, fz, tornado.cfg.lcl);
        if (Math.random() < 0.3) {
          nextBolt = (nextBolt + 1) % bolts.length;
          bolts[nextBolt].strike(fx + (Math.random() - 0.5) * 900, fz + (Math.random() - 0.5) * 900, tornado.cfg.lcl);
        }
      }
    }
  }
  const now = env.uTime.value;
  for (let i = strokes.length - 1; i >= 0; i--) {
    const age = now - strokes[i];
    if (age > 0.6) strokes.splice(i, 1);
    else if (age >= 0) f = Math.max(f, Math.exp(-age * 11));
  }
  env.uFlash.value = f;
  for (const b of bolts) b.update(f);
}

// ---------------------------------------------------------------- loop
const wind = new Float32Array(3);
const EMERGENCY: EmergencyKind[] = ['police', 'ambulance', 'fire'];
const emitter = { x: 0, z: 0 };
let last = performance.now();
let hudClock = 0;
let fps = 60;
let visTime = 0;

// Drop the render resolution a notch whenever the frame rate stays low, so the
// simulation remains fluid on slower GPUs. (Frames from a throttled / hidden tab are ignored.)
let slowSince = 0;
function adaptResolution(now: number, rawDt: number) {
  if (rawDt > 0.1 || fps > 40 || pixelRatio <= 1) { slowSince = now; return; }
  if (now - slowSince < 2500) return;
  slowSince = now;
  pixelRatio = Math.max(1, pixelRatio - 0.25);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  pipeline.resize();
  syncViewport();
}

/** Point sprites (lamps, arcs) are sized in pixels: keep them in step with the drawing buffer. */
const bufferSize = new THREE.Vector2();
function syncViewport() {
  street?.setViewport(renderer.getDrawingBufferSize(bufferSize).y, camera.fov);
}

/** Advance the physics by simDt seconds of simulated time (fixed sub-steps). */
function simulate(simDt: number, now: number) {
  if (!city || !damage || !trees || !street || simDt <= 0) return;
  const n = Math.min(8, Math.max(1, Math.ceil(simDt / STEP)));
  const h = simDt / n;
  const bound = city.half * 2.2;
  for (let i = 0; i < n; i++) {
    if (phase === 'running') tornado.step(h);
    damage.step(h, tornado);
    trees.step(h, tornado);
    street.step(h, tornado);
    traffic?.step(h, tornado);
    debris.step(h, tornado, bound);
    if (cameraMode === 'caught') victim.step(h, tornado, city);
  }
  if (phase !== 'running') return;
  scourClock += simDt;
  if (scourClock > 0.12 && tornado.intensity > 0) {
    scourClock = 0;
    const r = Math.min(tornado.radiusOfWind(44), tornado.rc * 2.2 + 60);
    if (r > 0) city.stampScour(tornado.x, tornado.z, r, (x, z) => tornado.speedAt(x, z));
  }
  // emergency services roll as the damage reports come in
  const reports = damage.stats.affected;
  const plan: [number, EmergencyKind][] = [[3, 'police'], [8, 'police'], [12, 'ambulance'], [20, 'fire'], [40, 'police'], [60, 'ambulance'], [90, 'fire'], [140, 'police'], [200, 'ambulance'], [260, 'fire'], [340, 'police'], [450, 'ambulance']];
  while (traffic && dispatched < plan.length && reports >= plan[dispatched][0]) traffic.dispatch(plan[dispatched++][1], tornado);
  for (const i of damage.dirty) minimap.markDamage(i, damage.ef[i]);
  damage.dirty.length = 0;
  if (tornado.finished) {
    tornado.end();
    phase = 'finished';
    finishedAt = now;
  }
}

function frame(now: number) {
  requestAnimationFrame(frame);
  const rawDt = (now - last) / 1000;
  const dtReal = Math.min(0.05, rawDt);
  last = now;
  fps += (1 / Math.max(dtReal, 1e-3) - fps) * 0.05;
  adaptResolution(now, rawDt);
  if (!city || !damage || !trees) return;

  const running = phase === 'running' || phase === 'finished';
  const simDt = running ? dtReal * timeScale : 0;

  simulate(simDt, now);
  // before the storm the city goes about its business
  if (phase === 'setup' && traffic) { traffic.step(dtReal, tornado); debris.sync(); }
  if (phase === 'finished' && !reportShown && now - finishedAt > 2200) showReport();

  // ---- time for shaders: clouds drift slowly while idle, at sim speed while running
  visTime += phase === 'paused' ? 0 : running ? simDt : dtReal * 0.35;
  env.uTime.value = visTime;
  updateLightning(running ? simDt : dtReal);

  // ---- vortex uniforms for foliage / props
  const live = tornado.intensity > 0;
  env.uVortex.value.set(tornado.axisX(8), tornado.axisZ(8), Math.max(tornado.rc, 1), live ? (tornado.vmax + 0.5 * tornado.vsub) * tornado.cfg.rotation : 0);
  env.uVortexB.value.set(live ? tornado.dirX * tornado.cfg.speed : 0, live ? tornado.dirZ * tornado.cfg.speed : 0, tornado.cfg.alpha, tornado.cfg.lcl);

  // ---- camera
  if ((cameraMode === 'follow' || cameraMode === 'chase') && phase !== 'setup') {
    const dx = tornado.x - lastTx, dz = tornado.z - lastTz;
    camera.position.x += dx; camera.position.z += dz;
    controls.target.x += dx; controls.target.z += dz;
  }
  lastTx = tornado.x; lastTz = tornado.z;
  if (cameraMode === 'caught') {
    victim.applyTo(camera, dtReal, tornado);
    ui.firstPersonFx(victim.vignette, victim.blackout);
    controls.target.copy(victim.pos);
  } else {
    controls.update();
    const ceiling = tornado.cfg.lcl - 14;
    if (camera.position.y > ceiling) camera.position.y = ceiling;
    if (camera.position.y < 1.2) camera.position.y = 1.2;
  }

  // ---- weather at the camera
  tornado.sample(camera.position.x, camera.position.y, camera.position.z, wind);
  const rainAmt = ui.settings.rain / 100;
  rain.update(running ? simDt : dtReal, rainAmt, wind[0] + 3, wind[1], wind[2] + 2);
  sky.update(camera, tornado.x, tornado.z, tornado.cfg.rotation);
  const cm = camera.matrixWorld.elements;
  audio.update({
    x: camera.position.x, y: camera.position.y, z: camera.position.z, rightX: cm[0], rightZ: cm[2],
    tx: tornado.x, tz: tornado.z, rc: tornado.rc,
    intensity: live ? tornado.intensity * Math.min(1.3, tornado.cfg.vmax / 70) : 0,
    localWind: Math.hypot(wind[0], wind[1], wind[2]) + rainAmt * 8,
    rain: rainAmt,
    debris: debris.airborne / 5000,
    siren: phase === 'running' || phase === 'paused',
    paused: phase === 'paused',
  });
  for (const kind of EMERGENCY) {
    const on = traffic !== null && phase !== 'paused' && traffic.nearest(kind, camera.position.x, camera.position.z, emitter);
    audio.emitter(kind, emitter.x, emitter.z, on);
  }

  // ---- render
  const dust = live ? Math.min(1.25, tornado.intensity * (0.55 + 0.6 * Math.min(1, debris.airborne / 2500)) * Math.min(1.2, tornado.cfg.vmax / 60)) : 0;
  pipeline.render(scene, camera, tornado, dust);

  // ---- HUD + map
  hudClock += dtReal;
  if (hudClock > 0.16) {
    hudClock = 0;
    const st = damage.stats;
    const forming = tornado.time < 14;
    const label = phase === 'setup' ? 'Standby' : phase === 'paused' ? 'Paused' : phase === 'finished' ? 'Dissipated'
      : tornado.ropeOut > 0.05 ? 'Roping out' : forming ? 'Forming' : 'Mature';
    ui.hud({
      time: tornado.time,
      phase: label,
      phaseClass: phase === 'running' ? 'live' : phase === 'finished' ? 'done' : '',
      wind: live ? tornado.peakWind() : 0,
      diameter: tornado.rc * 2,
      speed: tornado.cfg.speed,
      pressure: tornado.pressureDeficit(),
      probe: tornado.speedAt(controls.target.x, controls.target.z),
      damaged: st.affected, total: city.count, byEF: st.byEF, destroyed: st.destroyed, power: st.powerOut,
      trees: trees.downed, cars: debris.vehiclesMoved, debris: debris.airborne, fps,
    });
    if (cameraMode === 'caught') {
      const r = victim.readout;
      r.range = Math.hypot(victim.pos.x - tornado.x, victim.pos.z - tornado.z);
      ui.firstPerson(r);
    }
    minimap.draw(tornado, camera.position.x, camera.position.z, controls.target.x, controls.target.z, phase === 'setup');
  }
}

function showReport() {
  if (!city || !damage || !trees) return;
  reportShown = true;
  const st = damage.stats;
  // damage-path width: lateral spread of damaged structures about the track
  const px = -tornado.dirZ, pz = tornado.dirX;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < city.count; i++) {
    if (damage.dod[i] === 0) continue;
    const lat = (city.cx[i] - tornado.startX) * px + (city.cz[i] - tornado.startZ) * pz;
    if (lat < lo) lo = lat;
    if (lat > hi) hi = lat;
  }
  ui.report({
    ef: st.maxEF, peak: st.peakWind, length: tornado.pathLength, width: hi > lo ? hi - lo : 0, duration: tornado.time,
    damaged: st.affected, destroyed: st.destroyed, trees: trees.downed, cars: debris.vehiclesMoved, worst: st.worstLabel,
    city: city.meta.name,
  }, undefined, restart);
}

// ---------------------------------------------------------------- events
window.addEventListener('resize', () => {
  if (!window.innerWidth || !window.innerHeight) return; // hidden or collapsed: keep the last good size
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  pipeline.resize();
  syncViewport();
});

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'SELECT' || tag === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'r' || e.key === 'R') reset();
  else if (e.key === 'h' || e.key === 'H') ui.toggleUI();
  else if (e.key === 'm' || e.key === 'M') ui.toggleSound();
  else if (e.key >= '1' && e.key <= '5') setCameraMode((['overview', 'follow', 'chase', 'path', 'caught'] as CameraMode[])[Number(e.key) - 1], true);
});

applyQuality();
void switchCity().then(() => requestAnimationFrame(frame));

// handy for debugging from the console (development builds only)
if (import.meta.env.DEV) Object.assign(window as object, {
  __sim: {
    tornado, camera, controls, debris, pipeline, env, audio,
    get street() { return street; },
    get traffic() { return traffic; },
    victim,
    get city() { return city; },
    get damage() { return damage; },
    get phase() { return phase; },
    /** fast-forward the simulation by a number of simulated seconds */
    advance(seconds: number) {
      for (let t = 0; t < seconds; t += 1 / 30) { simulate(1 / 30, performance.now()); visTime += 1 / 30; }
    },
    setCameraMode,
    /** average GPU-synchronised render time in ms over n frames */
    bench(n = 20) {
      const gl = renderer.getContext();
      const px = new Uint8Array(4);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        pipeline.render(scene, camera, tornado, 1);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      return (performance.now() - t0) / n;
    },
  },
});
