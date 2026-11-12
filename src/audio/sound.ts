// Storm audio. Recorded-quality layers (generated with ElevenLabs by
// scripts/generate-sounds.mjs and listed in public/audio/manifest.json) are mixed
// by the physics: distance to the vortex, wind at the listener, airborne debris,
// individual structural failures. Anything missing falls back to synthesised
// noise, so the simulator is never silent just because a file is absent.

export type OneShot = 'thunder_near' | 'thunder_far' | 'collapse' | 'glass' | 'metal' | 'vehicle' | 'transformer' | 'tree' | 'alarm' | 'horn';
export type Emitter = 'police' | 'ambulance' | 'fire';
type Loop = 'roar_far' | 'roar_near' | 'wind' | 'rain' | 'debris' | 'siren' | 'siren_police' | 'siren_ambulance' | 'siren_fire';

const LOOPS: Loop[] = ['roar_far', 'roar_near', 'wind', 'rain', 'debris', 'siren', 'siren_police', 'siren_ambulance', 'siren_fire'];
const EMITTERS: Emitter[] = ['police', 'ambulance', 'fire'];
const SPEED_OF_SOUND = 343;
/** minimum seconds between two sounds of the same kind */
const COOLDOWN: Record<OneShot, number> = {
  thunder_near: 0.5, thunder_far: 0.5, collapse: 0.22, glass: 0.3, metal: 0.4, vehicle: 0.5, transformer: 0.3, tree: 0.5, alarm: 6, horn: 0.9,
};
const MAX_VOICES = 14;

export interface AudioState {
  /** listener position and unit vector pointing to the listener's right */
  x: number; y: number; z: number; rightX: number; rightZ: number;
  /** vortex position at the ground and core radius */
  tx: number; tz: number; rc: number;
  /** life-cycle factor × normalised wind (0..1.3); 0 when there is no tornado */
  intensity: number;
  /** wind speed at the listener, m/s */
  localWind: number;
  /** 0..1 */
  rain: number;
  /** airborne debris as a fraction of a "full" sky */
  debris: number;
  /** warning sirens sounding */
  siren: boolean;
  /** simulation paused: hold everything but the weather */
  paused: boolean;
}

interface LoopVoice { gain: GainNode; started: boolean }
interface EmitterVoice { pan: StereoPannerNode; filter: BiquadFilterNode }

export class StormAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private samples = new Map<string, AudioBuffer[]>();
  private loops = {} as Record<Loop, LoopVoice>;
  private roarPan!: StereoPannerNode;
  private roarFilter!: BiquadFilterNode;
  private sirenFilter!: BiquadFilterNode;
  private moving = {} as Record<Emitter, EmitterVoice>;
  // synthesised fallbacks
  private synthRoar!: GainNode;
  private synthRoarFilter!: BiquadFilterNode;
  private synthHiss!: GainNode;
  private synthHissFilter!: BiquadFilterNode;
  private lastPlayed = new Map<string, number>();
  private voices = 0;
  private listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0 };
  private loading = false;
  muted = true;
  /** true once at least one generated sample has been decoded */
  hasSamples = false;

  private ensure() {
    if (this.ctx) return;
    const ctx = (this.ctx = new AudioContext());
    const len = ctx.sampleRate * 4;
    this.noise = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = this.noise.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < len; i++) {
        // brown noise (integrated white), faded at the loop seam
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        d[i] = last * 3.5;
      }
      const fade = 2048;
      for (let i = 0; i < fade; i++) {
        const k = i / fade;
        d[i] *= k;
        d[len - 1 - i] *= k;
      }
    }
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 18;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.3;
    this.master.connect(comp).connect(ctx.destination);

    // the vortex is a directional source: panned toward it, dulled by distance
    this.roarPan = ctx.createStereoPanner();
    this.roarFilter = ctx.createBiquadFilter();
    this.roarFilter.type = 'lowpass';
    this.roarFilter.frequency.value = 400;
    this.roarFilter.Q.value = 0.5;
    this.roarFilter.connect(this.roarPan).connect(this.master);
    this.sirenFilter = ctx.createBiquadFilter();
    this.sirenFilter.type = 'lowpass';
    this.sirenFilter.frequency.value = 2600;
    this.sirenFilter.connect(this.master);

    // emergency vehicles: each kind is a moving point source with its own pan and distance filter
    for (const kind of EMITTERS) {
      const pan = ctx.createStereoPanner();
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 8000;
      filter.connect(pan).connect(this.master);
      this.moving[kind] = { pan, filter };
    }
    for (const name of LOOPS) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const moving = name.startsWith('siren_') ? this.moving[name.slice(6) as Emitter] : null;
      gain.connect(moving ? moving.filter : name === 'roar_far' || name === 'roar_near' || name === 'debris' ? this.roarFilter : name === 'siren' ? this.sirenFilter : this.master);
      this.loops[name] = { gain, started: false };
    }

    const src = (rate: number) => {
      const s = ctx.createBufferSource();
      s.buffer = this.noise;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start();
      return s;
    };
    this.synthRoarFilter = ctx.createBiquadFilter();
    this.synthRoarFilter.type = 'lowpass';
    this.synthRoarFilter.frequency.value = 120;
    this.synthRoarFilter.Q.value = 0.7;
    this.synthRoar = ctx.createGain();
    this.synthRoar.gain.value = 0;
    src(0.55).connect(this.synthRoarFilter).connect(this.synthRoar).connect(this.roarPan);
    this.synthHissFilter = ctx.createBiquadFilter();
    this.synthHissFilter.type = 'bandpass';
    this.synthHissFilter.frequency.value = 900;
    this.synthHissFilter.Q.value = 0.6;
    this.synthHiss = ctx.createGain();
    this.synthHiss.gain.value = 0;
    src(2.6).connect(this.synthHissFilter).connect(this.synthHiss).connect(this.master);
  }

  /** Fetch and decode whatever the manifest lists; loops start as they arrive. */
  private async load() {
    if (this.loading || !this.ctx) return;
    this.loading = true;
    const ctx = this.ctx;
    const base = `${import.meta.env.BASE_URL}audio/`;
    let groups: Record<string, string[]>;
    try {
      const res = await fetch(`${base}manifest.json`, { cache: 'no-cache' });
      if (!res.ok) return;
      groups = ((await res.json()) as { groups: Record<string, string[]> }).groups ?? {};
    } catch {
      return; // no generated audio: stay on the synthesised fallback
    }
    // loops first, they carry the scene
    const names = Object.keys(groups).sort((a, b) => Number(LOOPS.includes(b as Loop)) - Number(LOOPS.includes(a as Loop)));
    for (const name of names) {
      const isLoop = LOOPS.includes(name as Loop);
      await Promise.all(groups[name].map(async (file) => {
        try {
          const data = await (await fetch(base + file)).arrayBuffer();
          let buf = await ctx.decodeAudioData(data);
          if (isLoop) buf = seamless(ctx, buf);
          normalise(buf, isLoop);
          const list = this.samples.get(name) ?? [];
          list.push(buf);
          this.samples.set(name, list);
          this.hasSamples = true;
        } catch (err) {
          console.warn(`audio: could not load ${file}`, err);
        }
      }));
      if (isLoop) this.startLoop(name as Loop);
    }
  }

  private startLoop(name: Loop) {
    const buf = this.samples.get(name)?.[0];
    const voice = this.loops[name];
    if (!buf || voice.started || !this.ctx) return;
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.connect(voice.gain);
    s.start(0, Math.random() * buf.duration);
    voice.started = true;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (!m) {
      this.ensure();
      void this.ctx!.resume();
      void this.load();
    }
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.15);
  }

  update(s: AudioState) {
    this.listener.x = s.x; this.listener.y = s.y; this.listener.z = s.z;
    this.listener.rx = s.rightX; this.listener.rz = s.rightZ;
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const set = (p: AudioParam, v: number, tc = 0.2) => p.setTargetAtTime(v, t, tc);
    const L = this.loops;

    const dx = s.tx - s.x, dz = s.tz - s.z;
    const dist = Math.hypot(dx, dz);
    // 0 far away … 1 inside the core
    const ref = 140 + s.rc * 2;
    const near = Math.pow(ref / (dist + ref), 1.3);
    const live = s.paused ? 0 : s.intensity;
    set(this.roarPan.pan, dist > 1 ? Math.max(-1, Math.min(1, ((dx * s.rightX + dz * s.rightZ) / dist) * (1 - near * near))) : 0, 0.1);
    // air absorbs the highs: a mile away only the rumble arrives
    set(this.roarFilter.frequency, 220 + 15000 * near * near * near);

    const far = live * (0.12 + 0.9 * Math.sqrt(near)) * (1 - 0.55 * near);
    const close = live * Math.min(1.5, near * near * 2.4);
    if (L.roar_far.started || L.roar_near.started) {
      set(L.roar_far.gain.gain, L.roar_far.started ? far : 0);
      set(L.roar_near.gain.gain, L.roar_near.started ? close : 0);
      set(this.synthRoar.gain, (L.roar_far.started ? 0 : far) + (L.roar_near.started ? 0 : close * 0.8));
    } else {
      set(this.synthRoar.gain, Math.min(1.4, live * (0.08 + 1.5 * near)));
    }
    set(this.synthRoarFilter.frequency, 70 + 700 * near * near);

    const w = Math.min(1, s.localWind / 55);
    const windGain = 0.05 + 0.95 * w * w;
    if (L.wind.started) { set(L.wind.gain.gain, windGain * 0.9, 0.15); set(this.synthHiss.gain, 0.25 * w * w * w); }
    else set(this.synthHiss.gain, 0.03 + 0.55 * w * w, 0.15);
    set(this.synthHissFilter.frequency, 500 + 1800 * w);

    set(L.rain.gain.gain, s.rain * (0.25 + 0.5 * s.rain), 0.4);
    set(L.debris.gain.gain, live > 0 ? Math.min(1, s.debris) * Math.min(1, near * 1.8) * 0.9 : 0, 0.3);
    // the siren is drowned out as the roar arrives
    set(L.siren.gain.gain, s.siren && !s.paused ? 0.2 * (1 - Math.min(1, near * 1.6)) : 0, 0.8);
  }

  /** Place (or silence) the siren of the nearest emergency vehicle of a kind. */
  emitter(kind: Emitter, x: number, z: number, on: boolean) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const voice = this.loops[`siren_${kind}` as Loop], m = this.moving[kind];
    const dx = x - this.listener.x, dz = z - this.listener.z;
    const d = Math.hypot(dx, dz, this.listener.y);
    voice.gain.gain.setTargetAtTime(on && voice.started ? Math.min(1, 55 / (55 + d)) * 0.85 : 0, t, 0.25);
    if (!on) return;
    m.pan.pan.setTargetAtTime(d > 1 ? Math.max(-1, Math.min(1, ((dx * this.listener.rx + dz * this.listener.rz) / d) * 0.9)) : 0, t, 0.1);
    m.filter.frequency.setTargetAtTime(Math.max(700, 15000 * Math.exp(-d / 500)), t, 0.2);
  }

  /**
   * A one-off sound at a point in the world: delayed by its travel time, panned,
   * attenuated and dulled by distance.
   * @param loudness 1 = an ordinary event of its kind
   */
  play(kind: OneShot, x: number, z: number, loudness = 1) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const list = this.samples.get(kind);
    if (!list || !list.length) {
      if (kind === 'thunder_near' || kind === 'thunder_far') this.synthThunder(Math.hypot(x - this.listener.x, z - this.listener.z));
      return;
    }
    const now = ctx.currentTime;
    if (now - (this.lastPlayed.get(kind) ?? -99) < COOLDOWN[kind] || this.voices >= MAX_VOICES) return;
    const dx = x - this.listener.x, dz = z - this.listener.z;
    const d = Math.hypot(dx, dz, this.listener.y);
    const thunder = kind === 'thunder_near' || kind === 'thunder_far';
    const ref = thunder ? 900 : 70;
    const gain = Math.min(1.2, loudness * (ref / (ref + d)) * (thunder ? 1.5 : 1.2));
    // when it gets busy, keep the voices for what is close and loud
    if (gain < 0.02 || (this.voices > 8 && gain < 0.12)) return;
    this.lastPlayed.set(kind, now);

    const s = ctx.createBufferSource();
    s.buffer = list[(Math.random() * list.length) | 0];
    s.playbackRate.value = 0.9 + Math.random() * 0.2;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = Math.max(450, 17000 * Math.exp(-d / (thunder ? 2600 : 700)));
    const g = ctx.createGain();
    g.gain.value = gain;
    const pan = ctx.createStereoPanner();
    pan.pan.value = d > 1 ? Math.max(-1, Math.min(1, ((dx * this.listener.rx + dz * this.listener.rz) / d) * 0.9)) : 0;
    s.connect(f).connect(g).connect(pan).connect(this.master);
    this.voices++;
    s.onended = () => { this.voices--; };
    s.start(now + Math.min(9, d / SPEED_OF_SOUND));
  }

  /** Thunder for a lightning stroke at (x, z); the cloud base height sets the minimum distance. */
  thunder(x: number, z: number, height: number) {
    const d = Math.hypot(x - this.listener.x, z - this.listener.z, height);
    this.play(d < 1700 ? 'thunder_near' : 'thunder_far', x, z, 1);
  }

  private synthThunder(distance: number) {
    const ctx = this.ctx!;
    const when = ctx.currentTime + Math.min(12, distance / SPEED_OF_SOUND);
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = 0.35 + Math.random() * 0.2;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = Math.max(90, 600 - distance * 0.12);
    const g = ctx.createGain();
    const peak = Math.min(1, 1500 / (distance + 600)) * 1.3;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.08);
    g.gain.exponentialRampToValueAtTime(peak * 0.35, when + 0.9);
    g.gain.exponentialRampToValueAtTime(0.001, when + 4.5);
    s.connect(f).connect(g).connect(this.master);
    s.start(when, Math.random() * 2);
    s.stop(when + 4.6);
  }
}

/**
 * Turn a clip into a seamless loop: strip the silence MP3 encoding pads onto both
 * ends, then cross-fade the tail into the head with equal power.
 */
function seamless(ctx: AudioContext, src: AudioBuffer): AudioBuffer {
  const rate = src.sampleRate, ch = src.numberOfChannels;
  const ref = src.getChannelData(0);
  let a = 0, b = src.length - 1;
  while (a < b && Math.abs(ref[a]) < 0.004) a++;
  while (b > a && Math.abs(ref[b]) < 0.004) b--;
  const len = b - a + 1;
  const xf = Math.min(Math.floor(rate * 2), Math.floor(len / 4));
  if (xf < 64) return src;
  const out = ctx.createBuffer(ch, len - xf, rate);
  for (let c = 0; c < ch; c++) {
    const i = src.getChannelData(c), o = out.getChannelData(c);
    for (let k = 0; k < len - xf; k++) o[k] = i[a + k];
    for (let k = 0; k < xf; k++) {
      const t = (k / xf) * (Math.PI / 2);
      o[k] = i[a + k] * Math.sin(t) + i[a + len - xf + k] * Math.cos(t);
    }
  }
  return out;
}

/**
 * Generated clips come back at very different levels. Bring loops to a common RMS and
 * one-shots to a common peak, so the mix is set by the physics and not by the luck of the take.
 */
function normalise(buf: AudioBuffer, loop: boolean) {
  let peak = 0, sum = 0, n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
      sum += v * v;
    }
    n += d.length;
  }
  if (peak < 1e-4) return;
  const rms = Math.sqrt(sum / n);
  // loops: -17 dBFS RMS, never clipping; one-shots: peak at 0.9, boosted at most 8x
  const gain = loop ? Math.min(0.141 / rms, 0.97 / peak) : Math.min(0.9 / peak, 8);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= gain;
  }
}
