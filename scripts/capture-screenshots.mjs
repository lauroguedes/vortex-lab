// Captures the README images from the running app with headless Chrome (no
// dependencies: it speaks the DevTools protocol over Node's built-in WebSocket).
//
//   npm run dev                      # in one terminal
//   npm run screenshots              # in another: writes docs/images/*.jpg
//   npm run screenshots -- cover night    # only the named shots
//
// Chrome is looked up at CHROME_PATH or the default macOS / Linux locations.
// The app's development build exposes `window.__sim`, which the shots use to
// fast-forward the storm and place the camera.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'images');
const URL = process.env.APP_URL ?? 'http://localhost:5173/';
const PORT = 9333;
const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => p && existsSync(p));

// Helpers injected into the page.
const HELPERS = `
window.__cap = {
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  frames: (n = 4) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }),
  async city(id) {
    const sel = document.getElementById('city');
    if (!__sim.city || __sim.city.meta.id !== id) { sel.value = id; sel.dispatchEvent(new Event('change')); }
    for (;;) {
      await this.wait(300);
      if (__sim.city && __sim.city.meta.id === id && getComputedStyle(document.getElementById('loading')).display === 'none') break;
    }
    await this.wait(600);
  },
  key: (key, code) => window.dispatchEvent(new KeyboardEvent('keydown', { key, code })),
  reset() { this.key('r'); },
  pick: (group, name) => [...document.querySelectorAll('#' + group + ' button')].find((b) => new RegExp(name, 'i').test(b.textContent)).click(),
  run(seconds) { document.getElementById('run').click(); __sim.advance(seconds); },
  pause() { if (__sim.phase === 'running') this.key(' ', 'Space'); },
  /** show or hide the whole interface (toolbar included) */
  ui(on) {
    document.body.classList.toggle('ui-hidden', !on);
    let s = document.getElementById('cap-style');
    if (!s) { s = document.createElement('style'); s.id = 'cap-style'; document.head.append(s); }
    s.textContent = on ? '' : '#transport, #fp-read { display: none !important; }';
  },
  look(px, py, pz, tx, ty, tz) {
    __sim.setCameraMode('overview', false);
    __sim.camera.position.set(px, py, pz);
    __sim.controls.target.set(tx, ty, tz);
    __sim.controls.update();
  },
  /** camera relative to the tornado: back along the track, to its right, up; looking at a height on the axis */
  orbit(back, right, height, lookY) {
    const t = __sim.tornado;
    this.look(t.x - t.dirX * back - t.dirZ * right, height, t.z - t.dirZ * back + t.dirX * right, t.x, lookY, t.z);
  },
};`;

const cityShot = (id) => ({
  name: `city-${id}`, width: 1200, height: 675,
  js: `await __cap.city('${id}'); __cap.reset(); __cap.pick('lighting', 'afternoon'); __cap.pick('presets', 'cone');
       __cap.run(0.2); __cap.pause(); __cap.ui(false); __cap.look(430, 170, 540, -60, 20, -80);`,
});

const SHOTS = [
  {
    name: 'cover', width: 1600, height: 800,
    js: `await __cap.city('paris'); __cap.reset(); __cap.pick('lighting', 'afternoon'); __cap.pick('presets', 'stovepipe');
         __cap.run(72); __cap.pause(); __cap.ui(false); __cap.orbit(560, 430, 90, 170);`,
  },
  {
    name: 'setup', width: 1600, height: 900,
    js: `await __cap.city('new-york'); __cap.reset(); __cap.pick('lighting', 'afternoon'); __cap.pick('presets', 'cone'); __cap.ui(true); await __cap.wait(2500);`,
  },
  {
    name: 'running', width: 1600, height: 900,
    js: `await __cap.city('new-york'); __cap.reset(); __cap.pick('presets', 'cone'); __cap.ui(true); __cap.run(58); __sim.setCameraMode('follow', true); await __cap.wait(1200);`,
  },
  {
    name: 'first-person', width: 1600, height: 900,
    js: `await __cap.city('new-york'); __cap.reset(); __cap.pick('lighting', 'afternoon'); __cap.pick('presets', 'stovepipe'); __cap.ui(true); __cap.run(18);
         __sim.setCameraMode('caught', true);
         for (let i = 0; i < 400 && __sim.victim.readout.wind < 25; i++) __sim.advance(0.1);
         __cap.pause(); await __cap.wait(1500);`,
  },
  {
    name: 'first-person-down', width: 1600, height: 900,
    js: `await __cap.city('new-york'); __cap.reset(); __cap.pick('presets', 'stovepipe'); __cap.ui(true); __cap.run(18);
         __sim.setCameraMode('caught', true);
         for (let i = 0; i < 900 && __sim.victim.readout.knockWind === 0; i++) __sim.advance(0.05);
         __sim.advance(0.45); __cap.pause(); await __cap.wait(700);`,
  },
  {
    name: 'night', width: 1600, height: 900,
    js: `await __cap.city('new-york'); __cap.reset(); __cap.pick('lighting', 'night'); __cap.pick('presets', 'cone'); __cap.run(62); __cap.pause(); __cap.ui(false);
         const tr = __sim.traffic, t = __sim.tornado; let e = -1, best = 1e9;
         for (let pass = 0; pass < 2 && e < 0; pass++) for (let i = 0; i < tr.n; i++) {
           if (!tr.alive[i] || (pass === 0 && tr.kind[i] === 0) || Math.abs(tr.px[i]) > 650 || Math.abs(tr.pz[i]) > 650 || tr.v[i] < 2) continue;
           const d = Math.abs(Math.hypot(tr.px[i] - t.x, tr.pz[i] - t.z) - 350);
           if (d < best) { best = d; e = i; }
         }
         const c = Math.cos(tr.yaw[e]), s = Math.sin(tr.yaw[e]);
         __cap.look(tr.px[e] + c * 24 + s * 3.5, 3.4, tr.pz[e] - s * 24 + c * 3.5, tr.px[e] - c * 30, 9, tr.pz[e] + s * 30);`,
  },
  {
    name: 'damage', width: 1600, height: 900,
    js: `await __cap.city('rome'); __cap.reset(); __cap.pick('lighting', 'afternoon'); __cap.pick('presets', 'stovepipe'); __cap.run(80); __cap.pause(); __cap.ui(false);
         __cap.orbit(640, 70, 150, 10);`,
  },
  {
    name: 'report', width: 1600, height: 900,
    js: `await __cap.city('rome'); __cap.reset(); __cap.pick('lighting', 'afternoon'); __cap.pick('presets', 'cone'); __cap.ui(true); __cap.run(40);
         for (let i = 0; i < 40 && __sim.phase === 'running'; i++) { __sim.advance(10); await __cap.wait(50); }
         __sim.setCameraMode('overview', true); await __cap.wait(4000);`,
  },
  ...['new-york', 'london', 'paris', 'rome', 'tokyo', 'rio'].map(cityShot),
];

// ---------------------------------------------------------------- DevTools plumbing
if (!CHROME) {
  console.error('Chrome not found. Set CHROME_PATH to a Chrome or Chromium binary.');
  process.exit(1);
}
try {
  await fetch(URL);
} catch {
  console.error(`The app is not reachable at ${URL}. Start it with "npm run dev" first.`);
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'vortex-shots-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
  '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal', '--window-size=1600,900', 'about:blank',
], { stdio: 'ignore' });
const quit = () => { chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ } };
process.on('exit', quit);

let wsUrl;
for (let i = 0; i < 60 && !wsUrl; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = pages.find((p) => p.type === 'page')?.webSocketDebuggerUrl;
  } catch { /* not up yet */ }
}
if (!wsUrl) { console.error('Could not connect to Chrome.'); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const run = async (body) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 500));
  if (await run('return typeof __sim !== "undefined" && !!__sim.city;').catch(() => false)) break;
}
await run(HELPERS);
console.log('renderer:', await run(`const gl = document.createElement('canvas').getContext('webgl2'); const x = gl.getExtension('WEBGL_debug_renderer_info'); return x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'unknown';`));

mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
let failed = 0;
for (const shot of SHOTS) {
  if (only.length && !only.includes(shot.name)) continue;
  try {
    await send('Emulation.setDeviceMetricsOverride', { width: shot.width, height: shot.height, deviceScaleFactor: 1, mobile: false });
    // let interface fades finish before the frame is taken
    await run(`${shot.js}\nawait __cap.wait(700); await __cap.frames(6);`);
    const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 86 });
    const file = join(OUT, `${shot.name}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`  ✓ ${shot.name}.jpg  ${shot.width}×${shot.height}  ${(Buffer.byteLength(data, 'base64') / 1024).toFixed(0)} kB`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${shot.name}: ${err.message.split('\n')[0]}`);
  }
}
ws.close();
quit();
process.exit(failed ? 1 : 0);
