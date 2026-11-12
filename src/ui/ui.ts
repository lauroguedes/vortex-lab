import { PRESETS, EF_COLORS, efRating, type TornadoPreset } from '../data/presets';
import { LIGHTING } from '../render/environment';
import { GRAV } from '../physics/tornado';
import type { CityMeta } from '../world/city';

export interface Settings {
  cityId: string;
  presetId: string;
  vmax: number;
  diameter: number;
  speed: number;
  heading: number;
  offset: number;
  lcl: number;
  rain: number;
  lighting: string;
  lightning: boolean;
  debris: number;
  volume: number;
}

export type CameraMode = 'overview' | 'follow' | 'chase' | 'path' | 'caught';
export type ChangeKind = 'city' | 'tornado' | 'env' | 'quality';

export interface UIHandlers {
  change(kind: ChangeKind): void;
  run(): void;
  toggle(): void;
  reset(): void;
  speed(scale: number): void;
  camera(mode: CameraMode): void;
  sound(on: boolean): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ICONS: Record<string, string> = {
  rope: 'M5 4h16M13 4c-3 5 4 8 1 13s-4 5-2 10',
  cone: 'M3 4h20M6 4l6 23h2l6-23',
  stovepipe: 'M3 4h20M8 4c1 8 1 15 0 23M18 4c-1 8-1 15 0 23',
  wedge: 'M1 4h24M3 4l3 23h14l3-23',
  multivortex: 'M1 4h24M4 4l3 9h12l3-9M9 13l-2 14M13 13v14M17 13l2 14',
};

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const DIAM_MIN = 20, DIAM_RATIO = 50;

export const kmh = (ms: number) => ms * 3.6;
export const mph = (ms: number) => ms * 2.23694;

function seg<T extends string | number>(
  host: HTMLElement, options: { value: T; label: string; title?: string }[], initial: T, onPick: (v: T) => void,
) {
  host.innerHTML = '';
  const buttons = options.map((o) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = o.label;
    if (o.title) b.title = o.title;
    b.setAttribute('aria-pressed', String(o.value === initial));
    b.addEventListener('click', () => { set(o.value); onPick(o.value); });
    host.appendChild(b);
    return b;
  });
  const set = (v: T) => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i].value === v)));
  return set;
}

export class UI {
  settings: Settings;
  private setCamera: (m: CameraMode) => void;
  private setSpeed: (s: number) => void;
  private soundOn = false;
  private loadingTimer = 0;
  private bars: { bar: HTMLElement; num: HTMLElement }[] = [];

  constructor(private cities: CityMeta[], private handlers: UIHandlers) {
    const preset = PRESETS[1];
    this.settings = {
      cityId: cities[0].id, presetId: preset.id,
      vmax: preset.vmax, diameter: preset.rc * 2, speed: preset.speed,
      heading: cities[0].heading, offset: 0, lcl: preset.lcl,
      rain: 20, lighting: LIGHTING[0].id, lightning: true, debris: 1, volume: 1,
    };
    const s = this.settings;

    // ---- city
    const citySel = $<HTMLSelectElement>('city');
    for (const c of cities) citySel.add(new Option(`${c.name}, ${c.region.split(',')[0]}`, c.id));
    citySel.addEventListener('change', () => {
      s.cityId = citySel.value;
      const meta = this.city();
      s.heading = meta.heading;
      s.offset = 0;
      this.syncSliders();
      this.showCity(meta);
      handlers.change('city');
    });

    // ---- presets
    const host = $('presets');
    for (const p of PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.id = p.id;
      b.innerHTML = `<svg viewBox="0 0 26 30"><path d="${ICONS[p.id]}"/></svg><span>${p.name}</span><small>${p.rating}</small>`;
      b.addEventListener('click', () => { this.applyPreset(p); handlers.change('tornado'); });
      host.appendChild(b);
    }

    // ---- sliders
    const bind = (id: string, apply: (v: number) => void, kind: ChangeKind) => {
      const el = $<HTMLInputElement>(id);
      el.addEventListener('input', () => { apply(Number(el.value)); this.refreshReadouts(); handlers.change(kind); });
    };
    bind('s-vmax', (v) => (s.vmax = v), 'tornado');
    bind('s-diam', (v) => (s.diameter = Math.round(DIAM_MIN * Math.pow(DIAM_RATIO, v / 1000))), 'tornado');
    bind('s-speed', (v) => (s.speed = v), 'tornado');
    bind('s-heading', (v) => (s.heading = v), 'tornado');
    bind('s-offset', (v) => (s.offset = v), 'tornado');
    bind('s-lcl', (v) => (s.lcl = v), 'tornado');
    bind('s-rain', (v) => (s.rain = v), 'env');

    seg($('lighting'), LIGHTING.map((l) => ({ value: l.id, label: l.name })), s.lighting, (v) => { s.lighting = v; handlers.change('env'); });
    $<HTMLInputElement>('c-lightning').addEventListener('change', (e) => { s.lightning = (e.target as HTMLInputElement).checked; handlers.change('env'); });
    const q = [{ value: 0, label: 'Low' }, { value: 1, label: 'Medium' }, { value: 2, label: 'High' }];
    seg($('q-debris'), q, s.debris, (v) => { s.debris = v; handlers.change('quality'); });
    seg($('q-volume'), q, s.volume, (v) => { s.volume = v; handlers.change('quality'); });

    // ---- transport
    $('run').addEventListener('click', () => handlers.run());
    $('t-play').addEventListener('click', () => handlers.toggle());
    $('t-reset').addEventListener('click', () => handlers.reset());
    this.setSpeed = seg($('t-speed'), [0.25, 0.5, 1, 2, 4].map((v) => ({ value: v, label: `${v}×`, title: 'Simulation speed' })), 1, (v) => handlers.speed(v));
    this.setCamera = seg<CameraMode>($('t-camera'), [
      { value: 'overview', label: 'Overview', title: 'Fixed view of the whole tile (1)' },
      { value: 'follow', label: 'Follow', title: 'Move with the tornado (2)' },
      { value: 'chase', label: 'Chase', title: 'Ground-level storm chaser (3)' },
      { value: 'path', label: 'In the path', title: 'Street level, directly ahead of the tornado (4)' },
      { value: 'caught', label: 'Caught in it', title: 'First person: on foot where the core will pass (5)' },
    ], 'overview', (v) => handlers.camera(v));
    $('t-sound').addEventListener('click', () => this.toggleSound());
    $('t-ui').addEventListener('click', () => this.toggleUI());

    // ---- EF bars
    const bars = $('hud-bars');
    for (let i = 0; i < 6; i++) {
      const d = document.createElement('div');
      d.innerHTML = `<i style="background:${EF_COLORS[i]};height:2px"></i><span>0</span><b>EF${i}</b>`;
      bars.appendChild(d);
      this.bars.push({ bar: d.firstElementChild as HTMLElement, num: d.children[1] as HTMLElement });
    }

    this.syncSliders();
    this.markPreset();
    this.showCity(this.city());
  }

  city() { return this.cities.find((c) => c.id === this.settings.cityId)!; }
  preset() { return PRESETS.find((p) => p.id === this.settings.presetId)!; }

  private applyPreset(p: TornadoPreset) {
    const s = this.settings;
    s.presetId = p.id;
    s.vmax = p.vmax; s.diameter = p.rc * 2; s.speed = p.speed; s.lcl = p.lcl;
    this.syncSliders();
    this.markPreset();
  }

  private markPreset() {
    for (const b of Array.from($('presets').children) as HTMLElement[])
      b.setAttribute('aria-checked', String(b.dataset.id === this.settings.presetId));
    $('preset-desc').textContent = this.preset().desc;
  }

  private showCity(meta: CityMeta) {
    $('city-blurb').textContent = meta.blurb;
  }

  setCityFacts(buildings: number, tallest: number, trees: number) {
    $('city-facts').innerHTML =
      `<div><dt>Buildings</dt><dd>${buildings.toLocaleString()}</dd></div>` +
      `<div><dt>Tallest</dt><dd>${tallest.toFixed(0)} m</dd></div>` +
      `<div><dt>Trees</dt><dd>${trees.toLocaleString()}</dd></div>`;
  }

  syncSliders() {
    const s = this.settings;
    $<HTMLInputElement>('s-vmax').value = String(s.vmax);
    $<HTMLInputElement>('s-diam').value = String(Math.round((Math.log(s.diameter / DIAM_MIN) / Math.log(DIAM_RATIO)) * 1000));
    $<HTMLInputElement>('s-speed').value = String(s.speed);
    $<HTMLInputElement>('s-heading').value = String(s.heading);
    $<HTMLInputElement>('s-offset').value = String(s.offset);
    $<HTMLInputElement>('s-lcl').value = String(s.lcl);
    $<HTMLInputElement>('s-rain').value = String(s.rain);
    this.refreshReadouts();
  }

  private refreshReadouts() {
    const s = this.settings;
    $('o-vmax').textContent = `${s.vmax} m/s`;
    const peak = s.vmax + s.speed * 0.9;
    const ef = efRating(peak);
    $('h-vmax').innerHTML = `${kmh(s.vmax).toFixed(0)} km/h · ${mph(s.vmax).toFixed(0)} mph rotation. With forward motion the peak is about <em>${kmh(peak).toFixed(0)} km/h (${ef < 0 ? 'sub-EF0' : 'EF' + ef})</em>`;
    $('o-diam').textContent = `${s.diameter} m`;
    $('o-speed').textContent = `${s.speed} m/s · ${kmh(s.speed).toFixed(0)} km/h`;
    $('o-heading').textContent = `${COMPASS[Math.round(s.heading / 22.5) % 16]} ${s.heading}°`;
    $('o-offset').textContent = s.offset === 0 ? 'centre' : `${Math.abs(s.offset)} m ${s.offset > 0 ? 'right' : 'left'}`;
    $('o-lcl').textContent = `${s.lcl} m`;
    $('o-rain').textContent = s.rain === 0 ? 'none' : `${s.rain}%`;
    // will the condensation funnel reach the ground? Δp/ρg at the axis vs. cloud-base height
    const multi = this.preset().subvortices > 0;
    const v2 = multi ? 2 * (0.55 * s.vmax) ** 2 : s.vmax ** 2;
    const lift = (this.p0 * v2) / GRAV;
    $('h-lcl').innerHTML = lift >= s.lcl
      ? `Core pressure drop ≈ ${((this.p0 * v2 * 1.2) / 100).toFixed(0)} hPa — the condensation funnel <em>reaches the ground</em>`
      : `Core pressure drop ≈ ${((this.p0 * v2 * 1.2) / 100).toFixed(0)} hPa — funnel stays <em>${(s.lcl - lift).toFixed(0)} m aloft</em>; only a debris whirl marks the surface`;
    for (const el of Array.from(document.querySelectorAll<HTMLInputElement>('#panel input[type=range]'))) {
      const f = ((Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100;
      el.style.setProperty('--fill', `${f}%`);
    }
  }

  /** normalised central pressure deficit of the current wind profile (set by main) */
  p0 = 1.8;
  setProfileP0(p0: number) { this.p0 = p0; this.refreshReadouts(); }

  setOffset(offset: number) {
    this.settings.offset = Math.max(-1000, Math.min(1000, Math.round(offset / 20) * 20));
    this.syncSliders();
  }

  // ------------------------------------------------------------ state

  setRunning(running: boolean, paused: boolean) {
    document.body.classList.toggle('running', running);
    $('t-play').textContent = running && !paused ? '❚❚' : '▶';
  }

  setRunEnabled(on: boolean) { $<HTMLButtonElement>('run').disabled = !on; }
  setCameraMode(m: CameraMode) { this.setCamera(m); }

  /** First-person overlay: tunnel vision / blackout every frame. */
  firstPersonFx(vignette: number, blackout: number) {
    $('fp-vignette').style.opacity = vignette.toFixed(3);
    $('fp-black').style.opacity = blackout.toFixed(3);
  }

  /** First-person readout, or null to leave the mode. */
  firstPerson(r: import('../world/victim').VictimReadout | null) {
    const el = $('fp');
    el.hidden = r === null;
    if (!r) return;
    const kmh = (v: number) => `${Math.round(v * 3.6)} km/h`;
    const status: Record<string, string> = {
      waiting: r.range > 0 ? `On foot · tornado ${Math.round(r.range)} m away` : 'On foot',
      braced: `Bracing against ${kmh(r.wind)} wind`,
      down: 'Knocked down · dragged along the ground',
      airborne: 'Airborne',
      rest: 'It has passed',
      missed: 'It passed you by',
    };
    $('fp-status').textContent = status[r.state];
    $('fp-status').className = `label ${r.state === 'down' || r.state === 'airborne' ? 'hot' : ''}`;
    $('fp-speed').textContent = kmh(r.speed);
    $('fp-height').textContent = `${r.height.toFixed(r.height < 10 ? 1 : 0)} m`;
    $('fp-wind').textContent = kmh(r.wind);
    $('fp-load').textContent = `${r.load.toFixed(1)} g`;
    const moved = r.knockWind > 0;
    $('fp-note').textContent = r.state === 'missed' ? 'The damaging winds never reached you. Reset and try a wider or stronger tornado.'
      : !moved ? 'A person is blown off their feet at about 110 km/h.'
      : `Off your feet at ${kmh(r.knockWind)} · carried ${Math.round(r.carried)} m · ${r.airTime.toFixed(1)} s in the air · up to ${r.peakHeight.toFixed(r.peakHeight < 10 ? 1 : 0)} m high, ${kmh(r.peakSpeed)}, ${r.peakLoad.toFixed(0)} g · ${r.impacts} impact${r.impacts === 1 ? '' : 's'}`;
  }
  setSpeedScale(v: number) { this.setSpeed(v); }

  /** Sound comes on with the first run (a click or key press, so the browser allows it) unless the user chose otherwise. */
  autoSound() {
    if (!this.soundTouched && !this.soundOn) this.toggleSound(false);
  }

  private soundTouched = false;

  toggleSound(byUser = true) {
    if (byUser) this.soundTouched = true;
    this.soundOn = !this.soundOn;
    $('t-sound').textContent = this.soundOn ? 'Sound on' : 'Sound off';
    this.handlers.sound(this.soundOn);
  }

  toggleUI() {
    const hidden = document.body.classList.toggle('ui-hidden');
    $('t-ui').textContent = hidden ? 'Show UI' : 'Hide UI';
  }

  loading(text: string | null, soft = false) {
    const el = $('loading');
    window.clearTimeout(this.loadingTimer);
    if (text === null) {
      el.classList.add('hidden');
      // remove it outright once the fade is over (transitions can stall in a background tab)
      this.loadingTimer = window.setTimeout(() => { el.style.display = 'none'; }, 500);
      return;
    }
    el.style.display = '';
    $('loading-text').textContent = text;
    el.classList.toggle('soft', soft);
    el.classList.remove('hidden');
  }

  // ------------------------------------------------------------ HUD

  hud(d: {
    time: number; phase: string; phaseClass: string; wind: number; diameter: number; speed: number; pressure: number;
    probe: number; damaged: number; total: number; byEF: number[]; destroyed: number; power: number; trees: number;
    cars: number; debris: number; fps: number;
  }) {
    const mm = Math.floor(d.time / 60), ss = Math.floor(d.time % 60);
    $('hud-time').textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    const ph = $('hud-phase');
    ph.textContent = d.phase;
    ph.className = `phase ${d.phaseClass}`;
    $('hud-wind').textContent = kmh(d.wind).toFixed(0);
    $('hud-wind2').textContent = `${d.wind.toFixed(0)} m/s · ${mph(d.wind).toFixed(0)} mph`;
    const ef = efRating(d.wind);
    const chip = $('hud-ef');
    chip.textContent = ef < 0 ? '—' : `EF${ef}`;
    chip.style.background = ef < 0 ? '' : EF_COLORS[ef];
    chip.style.color = ef < 0 ? '' : '#111';
    $('hud-diam').textContent = d.wind > 0 ? `${d.diameter.toFixed(0)} m` : '—';
    $('hud-speed').textContent = d.wind > 0 ? `${kmh(d.speed).toFixed(0)} km/h` : '—';
    $('hud-press').textContent = d.wind > 0 ? `−${(d.pressure / 100).toFixed(0)} hPa` : '—';
    $('hud-probe').textContent = `${kmh(d.probe).toFixed(0)} km/h`;
    $('hud-damaged').textContent = d.damaged.toLocaleString();
    $('hud-total').textContent = `of ${d.total.toLocaleString()}`;
    const max = Math.max(1, ...d.byEF);
    d.byEF.forEach((n, i) => {
      this.bars[i].bar.style.height = `${Math.max(2, (n / max) * 100)}%`;
      this.bars[i].num.textContent = String(n);
    });
    $('hud-destroyed').textContent = d.destroyed.toLocaleString();
    $('hud-power').textContent = d.power.toLocaleString();
    $('hud-trees').textContent = d.trees.toLocaleString();
    $('hud-cars').textContent = d.cars.toLocaleString();
    $('hud-debris').textContent = d.debris.toLocaleString();
    $('hud-fps').textContent = `${d.fps.toFixed(0)} fps`;
  }

  report(r: {
    ef: number; peak: number; length: number; width: number; duration: number; damaged: number; destroyed: number;
    trees: number; cars: number; worst: string; city: string;
  } | null, onClose?: () => void, onAgain?: () => void) {
    const el = $('report');
    if (!r) { el.hidden = true; return; }
    const title = $('rep-title');
    title.textContent = r.ef < 0 ? 'EF—' : `EF${r.ef}`;
    title.style.color = r.ef < 0 ? '' : EF_COLORS[r.ef];
    $('rep-sub').textContent = r.ef < 0
      ? `No rateable structural damage in ${r.city}.`
      : `Rated from the worst structural damage found in ${r.city}, as a survey team would.`;
    $('rep-grid').innerHTML = [
      ['Peak wind', `${kmh(r.peak).toFixed(0)} km/h`],
      ['Path length', `${(r.length / 1000).toFixed(2)} km`],
      ['Damage width', `${r.width.toFixed(0)} m`],
      ['Duration', `${Math.floor(r.duration / 60)}m ${Math.floor(r.duration % 60)}s`],
      ['Damaged', r.damaged.toLocaleString()],
      ['Destroyed', r.destroyed.toLocaleString()],
      ['Trees downed', r.trees.toLocaleString()],
      ['Vehicles thrown', r.cars.toLocaleString()],
      ['Peak wind (mph)', mph(r.peak).toFixed(0)],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    $('rep-worst').textContent = r.ef < 0 ? '' : `Worst degree of damage observed: ${r.worst.toLowerCase()}.`;
    el.hidden = false;
    $('rep-close').onclick = () => { el.hidden = true; onClose?.(); };
    $('rep-again').onclick = () => { el.hidden = true; onAgain?.(); };
  }
}
