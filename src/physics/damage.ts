// Structural damage model based on the Enhanced Fujita scale's Damage
// Indicators (DI) and Degrees of Damage (DOD). Each building tracks the peak
// 3-second gust it has experienced; damage progresses through the DOD ladder
// for its construction class. Wind speeds are the "expected" values from the
// EF-scale documentation (Texas Tech WISE, 2006), in mph.

import { BClass, type City } from '../world/city';
import { DebrisField, DebrisType } from './debris';
import { efRating } from '../data/presets';
import type { Tornado } from './tornado';

const MPH = 0.44704;

interface Step {
  mph: number;
  /** cumulative visual state after this degree of damage */
  roof: number; collapse: number; glass: number;
  label: string;
}

const LADDER: Record<number, Step[]> = {
  // DI 2 — one- and two-family residences (FR12)
  [BClass.House]: [
    { mph: 65, roof: 0.06, collapse: 0, glass: 0, label: 'Threshold of visible damage' },
    { mph: 79, roof: 0.22, collapse: 0, glass: 0.1, label: 'Loss of roof covering (<20%), gutters, siding' },
    { mph: 96, roof: 0.3, collapse: 0, glass: 0.6, label: 'Broken glass in doors and windows' },
    { mph: 97, roof: 0.52, collapse: 0, glass: 0.7, label: 'Roof deck uplift, garage doors collapse' },
    { mph: 121, roof: 0.6, collapse: 0.04, glass: 0.9, label: 'House shifted off foundation' },
    { mph: 122, roof: 1, collapse: 0.08, glass: 1, label: 'Roof structure removed, most walls standing' },
    { mph: 132, roof: 1, collapse: 0.45, glass: 1, label: 'Exterior walls collapsed' },
    { mph: 152, roof: 1, collapse: 0.8, glass: 1, label: 'Most walls collapsed' },
    { mph: 170, roof: 1, collapse: 1, glass: 1, label: 'All walls collapsed' },
    { mph: 200, roof: 1, collapse: 2, glass: 1, label: 'Slab swept clean' },
  ],
  // DI 17 — low-rise building, 1–4 storeys (LRB)
  [BClass.LowRise]: [
    { mph: 68, roof: 0.06, collapse: 0, glass: 0, label: 'Threshold of visible damage' },
    { mph: 86, roof: 0.25, collapse: 0, glass: 0.1, label: 'Loss of roof covering (<20%)' },
    { mph: 101, roof: 0.55, collapse: 0, glass: 0.3, label: 'Uplift of roof decking' },
    { mph: 114, roof: 0.65, collapse: 0, glass: 0.8, label: 'Broken glass / curtain wall damage' },
    { mph: 133, roof: 1, collapse: 0.06, glass: 0.95, label: 'Roof structure uplift or collapse' },
    { mph: 143, roof: 1, collapse: 0.35, glass: 1, label: 'Top-storey exterior walls collapsed' },
    { mph: 188, roof: 1, collapse: 1, glass: 1, label: 'Total destruction of the building' },
  ],
  // DI 18 — mid-rise building, 5–20 storeys (MRB)
  [BClass.MidRise]: [
    { mph: 70, roof: 0.05, collapse: 0, glass: 0, label: 'Threshold of visible damage' },
    { mph: 88, roof: 0.25, collapse: 0, glass: 0.08, label: 'Loss of roof covering (<20%)' },
    { mph: 101, roof: 0.55, collapse: 0, glass: 0.2, label: 'Uplift of roof decking' },
    { mph: 119, roof: 0.6, collapse: 0, glass: 0.55, label: 'Broken glass in curtain walls' },
    { mph: 133, roof: 1, collapse: 0.02, glass: 0.7, label: 'Roof structure uplift' },
    { mph: 149, roof: 1, collapse: 0.04, glass: 0.9, label: 'Significant curtain-wall and interior damage' },
    { mph: 164, roof: 1, collapse: 0.07, glass: 1, label: 'Top-storey walls collapsed' },
    { mph: 222, roof: 1, collapse: 0.18, glass: 1, label: 'Permanent structural deformation' },
  ],
  // DI 19 — high-rise building, more than 20 storeys (HRB)
  [BClass.HighRise]: [
    { mph: 70, roof: 0.05, collapse: 0, glass: 0, label: 'Threshold of visible damage' },
    { mph: 86, roof: 0.2, collapse: 0, glass: 0.06, label: 'Loss of roof covering (<20%)' },
    { mph: 101, roof: 0.5, collapse: 0, glass: 0.15, label: 'Damage to penthouse and rooftop plant' },
    { mph: 118, roof: 0.6, collapse: 0, glass: 0.45, label: 'Broken glass in curtain walls' },
    { mph: 131, roof: 0.8, collapse: 0, glass: 0.6, label: 'Broken curtain-wall panel anchorage' },
    { mph: 145, roof: 1, collapse: 0, glass: 0.8, label: 'Significant loss of curtain wall' },
    { mph: 160, roof: 1, collapse: 0.01, glass: 0.95, label: 'Interior walls damaged on upper floors' },
    { mph: 228, roof: 1, collapse: 0.04, glass: 1, label: 'Permanent structural deformation' },
  ],
  // DI 21 — metal building system / large warehouse (MBS)
  [BClass.Industrial]: [
    { mph: 67, roof: 0.05, collapse: 0, glass: 0, label: 'Threshold of visible damage' },
    { mph: 83, roof: 0.15, collapse: 0, glass: 0.4, label: 'Overhead doors collapsed' },
    { mph: 95, roof: 0.45, collapse: 0, glass: 0.6, label: 'Metal roof / wall panels pulled off' },
    { mph: 99, roof: 0.65, collapse: 0, glass: 0.7, label: 'Column anchorage failed' },
    { mph: 118, roof: 0.85, collapse: 0.05, glass: 0.9, label: 'Buckling of roof purlins' },
    { mph: 119, roof: 1, collapse: 0.12, glass: 1, label: 'Failure of X-braces, frames racked' },
    { mph: 138, roof: 1, collapse: 0.6, glass: 1, label: 'Progressive collapse of rigid frames' },
    { mph: 155, roof: 1, collapse: 1.4, glass: 1, label: 'Total destruction' },
  ],
};

export interface DamageStats {
  affected: number;
  destroyed: number;
  /** buildings whose worst damage rates EF0..EF5 */
  byEF: number[];
  maxEF: number;
  powerOut: number;
  peakWind: number;
  worstLabel: string;
}

export type DamageEvent = 'roof' | 'collapse' | 'glass' | 'metal';

// What a typical 140 m² house holds, thrown out as its walls come down
const CONTENTS: [DebrisType, number][] = [
  [DebrisType.Sofa, 2], [DebrisType.Bed, 2.5], [DebrisType.Fridge, 1], [DebrisType.Washer, 1.6],
  [DebrisType.Table, 2], [DebrisType.Chair, 6], [DebrisType.Bathtub, 1], [DebrisType.Cabinet, 3], [DebrisType.Door, 5],
];
// shops and offices
const FITTINGS: [DebrisType, number][] = [[DebrisType.Table, 2.5], [DebrisType.Chair, 5], [DebrisType.Cabinet, 2.5], [DebrisType.Door, 2]];

const w3 = new Float32Array(3);

export class DamageModel {
  readonly maxWind: Float32Array;
  readonly dod: Uint8Array;
  readonly ef: Int8Array;
  private strength: Float32Array;
  private target: Float32Array; // roof, collapse, glass per building
  private animating = new Set<number>();
  private worstMph = 0;
  stats: DamageStats = { affected: 0, destroyed: 0, byEF: [0, 0, 0, 0, 0, 0], maxEF: -1, powerOut: 0, peakWind: 0, worstLabel: '—' };
  /** buildings whose rating changed since the minimap last drew them */
  readonly dirty: number[] = [];

  /** audible failures: (kind, x, z, building footprint area) */
  onEvent: ((kind: DamageEvent, x: number, z: number, area: number) => void) | null = null;

  constructor(private city: City, private debris: DebrisField, private density: number) {
    const n = city.count;
    this.maxWind = new Float32Array(n);
    this.dod = new Uint8Array(n);
    this.ef = new Int8Array(n).fill(-1);
    this.strength = new Float32Array(n);
    this.target = new Float32Array(n * 3);
    // construction quality varies: ±~15 % in failure wind speed (EF lower/upper bounds)
    for (let i = 0; i < n; i++) {
      const r = (city.rand() + city.rand() + city.rand()) / 3;
      this.strength[i] = 0.84 + r * 0.32;
    }
  }

  /** target ceiling for simultaneously airborne pieces */
  private budget = 16000;
  setDensity(d: number, budget = this.budget) { this.density = d; this.budget = budget; }

  reset() {
    this.maxWind.fill(0);
    this.dod.fill(0);
    this.ef.fill(-1);
    this.target.fill(0);
    this.animating.clear();
    this.dirty.length = 0;
    this.worstMph = 0;
    this.stats = { affected: 0, destroyed: 0, byEF: [0, 0, 0, 0, 0, 0], maxEF: -1, powerOut: 0, peakWind: 0, worstLabel: '—' };
    this.city.resetDamage();
  }

  step(dt: number, tornado: Tornado) {
    const city = this.city;
    const data = city.damageData;
    let texDirty = false;
    if (tornado.intensity > 0) {
      const reach = tornado.radiusOfWind(26) + 80;
      const tx = tornado.x, tz = tornado.z;
      const n = city.count;
      const time = tornado.time;
      for (let i = 0; i < n; i++) {
        const dx = city.cx[i] - tx, dz = city.cz[i] - tz;
        const d2 = dx * dx + dz * dz;
        // large footprints are sampled at their centroid; extend reach by their size
        const ext = reach + Math.sqrt(city.area[i]) * 0.5;
        if (d2 > ext * ext) continue;
        // wind at eave height, with a small gust factor
        const h = Math.min(city.height[i], 30);
        tornado.sample(city.cx[i], Math.max(6, h * 0.7), city.cz[i], w3);
        let sp = Math.hypot(w3[0], w3[2]);
        sp *= 1 + 0.07 * Math.sin(time * 2.3 + i * 1.37);
        if (sp > this.stats.peakWind) this.stats.peakWind = sp;
        if (sp <= this.maxWind[i]) continue;
        this.maxWind[i] = sp;
        if (sp > 27 && data[i * 4 + 3] === 0) {
          // overhead lines and transformers fail well before structures do
          data[i * 4 + 3] = 1;
          this.stats.powerOut++;
          texDirty = true;
        }
        const ladder = LADDER[city.cls[i]];
        const eff = sp / this.strength[i] / MPH;
        let d = this.dod[i];
        while (d < ladder.length && eff >= ladder[d].mph) d++;
        if (d > this.dod[i]) this.advance(i, this.dod[i], d, ladder, w3);
      }
    }
    // ease the visible state toward its target so failures take a moment to unfold
    if (this.animating.size) {
      const k = Math.min(1, dt * 2.6);
      for (const i of this.animating) {
        let settled = true;
        for (let c = 0; c < 3; c++) {
          const o = i * 4 + c, t = this.target[i * 3 + c];
          const dv = t - data[o];
          if (dv > 0.004) { data[o] += Math.max(dv * k, Math.min(dv, dt * 0.25)); settled = false; }
          else data[o] = t;
        }
        if (settled) this.animating.delete(i);
      }
      texDirty = true;
    }
    if (texDirty) city.damageTex.needsUpdate = true;
  }

  private advance(i: number, from: number, to: number, ladder: Step[], wind: Float32Array) {
    const city = this.city;
    const s = ladder[to - 1];
    this.dod[i] = to;
    this.target[i * 3] = s.roof;
    this.target[i * 3 + 1] = s.collapse;
    this.target[i * 3 + 2] = s.glass;
    this.animating.add(i);
    this.dirty.push(i);

    const st = this.stats;
    if (from === 0) st.affected++;
    const wasDestroyed = from > 0 && ladder[from - 1].collapse >= 0.8;
    if (!wasDestroyed && s.collapse >= 0.8) st.destroyed++;
    const ef = efRating(s.mph * MPH + 0.01);
    if (ef !== this.ef[i]) {
      if (this.ef[i] >= 0) st.byEF[this.ef[i]]--;
      if (ef >= 0) st.byEF[ef]++;
      this.ef[i] = ef;
    }
    if (ef > st.maxEF) st.maxEF = ef;
    if (s.mph > this.worstMph) {
      this.worstMph = s.mph;
      st.worstLabel = s.label;
    }

    // ---- shed debris for the damage that just occurred
    const cls = city.cls[i];
    const prev = from > 0 ? ladder[from - 1] : { roof: 0, collapse: 0, glass: 0 };
    const area = Math.min(city.area[i], 6000);
    const dRoof = s.roof - prev.roof;
    const dCol = Math.min(s.collapse, 1) - Math.min(prev.collapse, 1);
    const dGlass = s.glass - prev.glass;
    // keep the airborne population within budget: shed proportionally less once it fills up
    const load = this.debris.airborne / this.budget;
    const throttle = load < 0.5 ? 1 : Math.max(0.02, 2 * (1 - load));
    const k = this.density * throttle * (cls === BClass.House ? 1 : 0.55);
    const roofUnits = dRoof * area * 0.075 * k;
    const wallUnits = dCol * Math.sqrt(area) * Math.min(city.height[i], 14) * 0.32 * k;
    const h = city.height[i];
    const metal = cls === BClass.Industrial || cls === BClass.LowRise;
    if (roofUnits > 0) {
      const cover = cls === BClass.House ? DebrisType.Shingle : metal ? DebrisType.SheetMetal : DebrisType.Light;
      this.emit(i, cover, roofUnits * (s.roof < 0.9 ? 1 : 0.4), h, wind);
      if (s.roof >= 0.5) {
        this.emit(i, cls === BClass.House ? DebrisType.Plywood : DebrisType.SheetMetal, roofUnits * 0.55, h, wind);
        this.emit(i, DebrisType.Lumber, roofUnits * (cls === BClass.House ? 0.5 : 0.2), h, wind);
        this.emit(i, DebrisType.Light, roofUnits * 0.5, h, wind);
      }
    }
    if (wallUnits > 0) {
      this.emit(i, DebrisType.Lumber, wallUnits * (cls === BClass.House ? 0.9 : 0.35), h * 0.5, wind);
      this.emit(i, cls === BClass.House ? DebrisType.Plywood : DebrisType.SheetMetal, wallUnits * 0.6, h * 0.5, wind);
      this.emit(i, DebrisType.Masonry, wallUnits * (cls === BClass.House ? 0.5 : 0.9), h * 0.4, wind);
      this.emit(i, DebrisType.Light, wallUnits * 0.7, h * 0.6, wind);
    }
    if (dCol > 0.2 && h * (1 - Math.min(s.collapse, 1) * 0.86) < 6) {
      // the collapsed structure itself: a pile of framing and sheathing left on the foundation
      const pile = dCol * Math.min(area, 1500) * 0.05 * this.density * Math.max(throttle, 0.3);
      this.pile(i, DebrisType.Lumber, pile);
      this.pile(i, cls === BClass.House ? DebrisType.Plywood : DebrisType.SheetMetal, pile * 0.6);
      this.pile(i, DebrisType.Masonry, pile * 0.35);
    }
    if (dGlass > 0 && cls !== BClass.House) {
      const facade = Math.sqrt(area) * Math.min(h, 120) * 0.012 * this.density * throttle;
      this.emit(i, DebrisType.Glass, dGlass * facade, h * 0.6, wind);
    }

    // ---- whole objects: roof sections, wall panels, furniture, rooftop plant
    const obj = Math.min(1, this.density) * Math.max(throttle, 0.08);
    const house = cls === BClass.House;
    const roofOff = s.roof >= 1 && prev.roof < 1;
    if (house) {
      if (s.roof >= 0.5 && prev.roof < 0.5) this.emit(i, DebrisType.RoofSection, 0.7 * obj, h + 1, wind, city.roofHex[i]);
      if (roofOff) {
        this.emit(i, DebrisType.RoofSection, Math.min(5, Math.max(1, area / 55)) * obj, h + 1, wind, city.roofHex[i]);
        // with the roof gone the wind reaches into the rooms
        this.emit(i, DebrisType.Chair, 2 * obj, h * 0.5, wind);
        this.emit(i, DebrisType.Bed, 0.6 * obj, h * 0.5, wind);
        this.emit(i, DebrisType.Table, 0.5 * obj, h * 0.5, wind);
      }
      if (dCol > 0) {
        const rooms = Math.min(2.5, area / 140) * dCol * obj;
        for (const [type, per] of CONTENTS) this.emit(i, type, per * rooms, Math.min(h, 6) * 0.5, wind);
        this.emit(i, DebrisType.WallPanel, Math.sqrt(area) * 1.1 * dCol * obj, h * 0.6, wind, city.wallHex[i]);
      }
    } else {
      if (s.roof >= 0.5 && prev.roof < 0.5) this.emit(i, DebrisType.RoofPanel, Math.min(8, area / 120) * obj, h + 0.5, wind);
      if (roofOff && cls !== BClass.HighRise) this.emit(i, DebrisType.Hvac, Math.min(4, area / 400) * obj, h + 1, wind);
      if (dCol > 0 && cls !== BClass.Industrial) {
        const floors = Math.min(6, area / 180) * dCol * obj;
        for (const [type, per] of FITTINGS) this.emit(i, type, per * floors, Math.min(h, 12) * 0.6, wind);
      }
    }

    if (this.onEvent) {
      const x = city.cx[i], z = city.cz[i];
      if (dCol > 0.2) this.onEvent('collapse', x, z, area);
      else if (dRoof > 0.25) this.onEvent(house ? 'roof' : 'metal', x, z, area);
      else if (dGlass > 0.25) this.onEvent('glass', x, z, area);
    }
  }

  private pile(i: number, type: DebrisType, units: number) {
    let count = Math.floor(units);
    if (Math.random() < units - count) count++;
    const city = this.city;
    const start = city.polyStart[i], len = city.polyLen[i];
    const cx = city.cx[i], cz = city.cz[i];
    // lie on top of the heap the building settles into (see the building vertex shader)
    const c = this.target[i * 3 + 1];
    const top = city.height[i] * (1 - Math.min(c, 1) * 0.86) * (1 - 0.95 * Math.max(0, c - 1));
    for (let k = 0; k < count; k++) {
      const e = (Math.random() * len) | 0, e2 = (e + 1) % len;
      const t = Math.random(), s = Math.sqrt(Math.random()) * 1.15;
      const ex = city.polyPts[(start + e) * 2], ez = city.polyPts[(start + e) * 2 + 1];
      const fx = city.polyPts[(start + e2) * 2], fz = city.polyPts[(start + e2) * 2 + 1];
      this.debris.spawn(type, cx + (ex + (fx - ex) * t - cx) * s, top + 0.1 + Math.random() * 0.5, cz + (ez + (fz - ez) * t - cz) * s,
        0, 0, 0, true, Math.random() * 6.283);
    }
  }

  private emit(i: number, type: DebrisType, units: number, y: number, wind: Float32Array, color = -1) {
    // hard ceiling: once the sky is full, almost nothing more is released
    if (this.debris.airborne > this.budget * 1.25) units *= 0.1;
    let count = Math.floor(units);
    if (Math.random() < units - count) count++;
    if (count <= 0) return;
    const city = this.city;
    const start = city.polyStart[i], len = city.polyLen[i];
    const cx = city.cx[i], cz = city.cz[i];
    for (let k = 0; k < count; k++) {
      // random point inside the footprint: between the centroid and a point on the outline
      const e = (Math.random() * len) | 0, e2 = (e + 1) % len;
      const t = Math.random(), s = Math.sqrt(Math.random());
      const ex = city.polyPts[(start + e) * 2], ez = city.polyPts[(start + e) * 2 + 1];
      const fx = city.polyPts[(start + e2) * 2], fz = city.polyPts[(start + e2) * 2 + 1];
      const x = cx + (ex + (fx - ex) * t - cx) * s;
      const z = cz + (ez + (fz - ez) * t - cz) * s;
      const yy = Math.max(0.4, y * (0.5 + Math.random() * 0.6));
      // pieces start slow: they are torn loose, then accelerated by the wind
      this.debris.spawn(type, x, yy, z, wind[0] * 0.15, 1 + Math.random() * 4, wind[2] * 0.15, false, 0, color);
    }
  }
}
