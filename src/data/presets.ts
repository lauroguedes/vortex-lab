export interface TornadoPreset {
  id: string;
  name: string;
  rating: string;
  desc: string;
  /** peak tangential (rotational) wind at 10 m AGL, m/s */
  vmax: number;
  /** radius of maximum wind at the ground, m */
  rc: number;
  /** forward speed, m/s */
  speed: number;
  /** decay exponent of the outer wind profile, V ∝ r^-alpha */
  alpha: number;
  /** near-surface radial inflow as a fraction of vmax */
  inflow: number;
  /** peak updraft as a fraction of vmax */
  updraft: number;
  /** 0 = one-cell vortex (axial jet), 1 = two-cell (central downdraft) */
  twoCell: number;
  subvortices: number;
  /** cloud-base (lifting condensation level) height, m */
  lcl: number;
  /** how much the core widens between ground and cloud base */
  flare: number;
  /** horizontal lean, metres per metre of height */
  tilt: number;
  /** amplitude of the centreline meander, m */
  sinuous: number;
}

export const PRESETS: TornadoPreset[] = [
  {
    id: 'rope',
    name: 'Rope',
    rating: 'EF1–EF2',
    desc: 'Thin, sinuous funnel only tens of metres wide. Narrow damage path, but winds in the core can still strip roofs.',
    vmax: 50, rc: 16, speed: 10, alpha: 0.72, inflow: 0.55, updraft: 0.6, twoCell: 0,
    subvortices: 0, lcl: 400, flare: 0.5, tilt: 0.22, sinuous: 26,
  },
  {
    id: 'cone',
    name: 'Cone',
    rating: 'EF2–EF3',
    desc: 'The classic shape: narrow at the ground, widening into the wall cloud. Destroys wood-frame houses along its track.',
    vmax: 63, rc: 55, speed: 13, alpha: 0.68, inflow: 0.5, updraft: 0.55, twoCell: 0.25,
    subvortices: 0, lcl: 600, flare: 0.9, tilt: 0.07, sinuous: 9,
  },
  {
    id: 'stovepipe',
    name: 'Stovepipe',
    rating: 'EF3–EF4',
    desc: 'A near-vertical cylinder with almost constant width from cloud base to ground. Intense, well-organised and long-lived.',
    vmax: 79, rc: 95, speed: 15, alpha: 0.66, inflow: 0.45, updraft: 0.62, twoCell: 0.5,
    subvortices: 0, lcl: 720, flare: 0.3, tilt: 0.035, sinuous: 5,
  },
  {
    id: 'wedge',
    name: 'Wedge',
    rating: 'EF4–EF5',
    desc: 'Wider than it is tall — a condensation funnel up to a kilometre across. The most destructive class of tornado.',
    vmax: 96, rc: 190, speed: 16, alpha: 0.7, inflow: 0.4, updraft: 0.6, twoCell: 0.85,
    subvortices: 0, lcl: 520, flare: 0.28, tilt: 0.015, sinuous: 0,
  },
  {
    id: 'multivortex',
    name: 'Multi-vortex',
    rating: 'EF3–EF4',
    desc: 'Several intense sub-vortices orbit a broad parent circulation, cutting cycloidal streaks of extreme damage.',
    vmax: 76, rc: 150, speed: 14, alpha: 0.66, inflow: 0.45, updraft: 0.58, twoCell: 1,
    subvortices: 4, lcl: 420, flare: 0.4, tilt: 0.03, sinuous: 3,
  },
];

/** Enhanced Fujita scale lower bounds, 3-second gust in m/s (65, 86, 111, 136, 166, 201 mph). */
export const EF_BOUNDS = [29.06, 38.45, 49.62, 60.8, 74.21, 89.85];

export function efRating(windMs: number): number {
  let ef = -1;
  for (let i = 0; i < EF_BOUNDS.length; i++) if (windMs >= EF_BOUNDS[i]) ef = i;
  return ef;
}

export const EF_COLORS = ['#7fd4e8', '#7fe08a', '#f2e35c', '#f5a742', '#ee5a3a', '#d83fd0'];
