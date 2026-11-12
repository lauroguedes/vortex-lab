import { EF_COLORS } from '../data/presets';
import type { Tornado } from '../physics/tornado';
import type { City } from '../world/city';

const SIZE = 480;

/** Top-down survey map: static city layer + accumulating damage layer + live overlay. */
export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private base = document.createElement('canvas');
  private dmg = document.createElement('canvas');
  private city: City | null = null;
  private ext = 1;
  private trail: number[] = [];
  onAim: ((x: number, z: number) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    canvas.width = canvas.height = SIZE;
    this.base.width = this.base.height = this.dmg.width = this.dmg.height = SIZE;
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('click', (ev) => {
      const r = canvas.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * 2 - 1;
      const z = ((ev.clientY - r.top) / r.height) * 2 - 1;
      this.onAim?.(x * this.ext, z * this.ext);
    });
    const legend = document.getElementById('map-legend')!;
    legend.innerHTML = EF_COLORS.map((c, i) => `<span style="background:${c}">EF${i}</span>`).join('');
  }

  private px(v: number) { return (v / this.ext + 1) * (SIZE / 2); }

  private poly(ctx: CanvasRenderingContext2D, pts: ArrayLike<number>, start: number, len: number, scale: number) {
    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const x = this.px(pts[(start + i) * 2] * scale), y = this.px(pts[(start + i) * 2 + 1] * scale);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  setCity(city: City) {
    this.city = city;
    this.ext = city.half * 1.03;
    const c = this.base.getContext('2d')!;
    const t = city.tile;
    c.fillStyle = '#12161a';
    c.fillRect(0, 0, SIZE, SIZE);
    c.fillStyle = '#17231b';
    for (const g of t.green) { this.poly(c, g, 0, g.length / 2, 0.1); c.fill(); }
    c.fillStyle = '#1b3644';
    for (const w of t.water) { this.poly(c, w, 0, w.length / 2, 0.1); c.fill(); }
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const s = SIZE / (2 * this.ext);
    for (const r of t.roads) {
      c.strokeStyle = r.k >= 3 ? '#3b4247' : '#2a3035';
      c.lineWidth = Math.max(0.8, (r.w / 10) * s);
      c.beginPath();
      for (let i = 0; i < r.p.length; i += 2) {
        const x = this.px(r.p[i] / 10), y = this.px(r.p[i + 1] / 10);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
    }
    c.fillStyle = '#566068';
    for (let i = 0; i < city.count; i++) {
      this.poly(c, city.polyPts, city.polyStart[i], city.polyLen[i], 1);
      c.fill();
    }
    document.getElementById('map-scale')!.textContent = `${((city.half * 2) / 1000).toFixed(1)} × ${((city.half * 2) / 1000).toFixed(1)} km`;
    this.resetDamage();
  }

  resetDamage() {
    this.dmg.getContext('2d')!.clearRect(0, 0, SIZE, SIZE);
    this.trail.length = 0;
  }

  markDamage(index: number, ef: number) {
    const city = this.city;
    if (!city) return;
    const c = this.dmg.getContext('2d')!;
    c.fillStyle = ef < 0 ? '#a9bcc4' : EF_COLORS[ef];
    c.strokeStyle = c.fillStyle;
    c.lineWidth = 1;
    this.poly(c, city.polyPts, city.polyStart[index], city.polyLen[index], 1);
    c.fill();
    c.stroke();
  }

  draw(tornado: Tornado, camX: number, camZ: number, tgtX: number, tgtZ: number, showPlan: boolean) {
    const c = this.ctx;
    c.drawImage(this.base, 0, 0);
    c.drawImage(this.dmg, 0, 0);
    const s = SIZE / (2 * this.ext);
    const sx = this.px(tornado.startX), sy = this.px(tornado.startZ);
    const ex = this.px(tornado.startX + tornado.dirX * tornado.pathLength);
    const ey = this.px(tornado.startZ + tornado.dirZ * tornado.pathLength);

    if (showPlan) {
      // planned swath: core width band + centreline
      c.strokeStyle = 'rgba(255,178,36,0.16)';
      c.lineWidth = Math.max(3, tornado.cfg.rc * 2 * s);
      c.lineCap = 'butt';
      c.beginPath(); c.moveTo(sx, sy); c.lineTo(ex, ey); c.stroke();
      c.strokeStyle = 'rgba(255,178,36,0.9)';
      c.lineWidth = 1.5;
      c.setLineDash([7, 6]);
      c.beginPath(); c.moveTo(sx, sy); c.lineTo(ex, ey); c.stroke();
      c.setLineDash([]);
      // arrow head at the centre of the map-facing end
      const mx = this.px(tornado.startX + tornado.dirX * tornado.pathLength * 0.5);
      const my = this.px(tornado.startZ + tornado.dirZ * tornado.pathLength * 0.5);
      const a = Math.atan2(ey - sy, ex - sx);
      c.fillStyle = '#ffb224';
      c.beginPath();
      c.moveTo(mx + Math.cos(a) * 11, my + Math.sin(a) * 11);
      c.lineTo(mx + Math.cos(a + 2.5) * 9, my + Math.sin(a + 2.5) * 9);
      c.lineTo(mx + Math.cos(a - 2.5) * 9, my + Math.sin(a - 2.5) * 9);
      c.fill();
    } else {
      const tx = this.px(tornado.x), ty = this.px(tornado.z);
      const last = this.trail.length;
      if (last === 0 || Math.hypot(tx - this.trail[last - 2], ty - this.trail[last - 1]) > 2) this.trail.push(tx, ty);
      c.strokeStyle = 'rgba(255,255,255,0.75)';
      c.lineWidth = 1.2;
      c.beginPath();
      for (let i = 0; i < this.trail.length; i += 2) {
        if (i === 0) c.moveTo(this.trail[i], this.trail[i + 1]); else c.lineTo(this.trail[i], this.trail[i + 1]);
      }
      c.stroke();
      if (tornado.intensity > 0) {
        const r = Math.max(4, tornado.rc * s);
        c.strokeStyle = '#ff5c3d';
        c.lineWidth = 2;
        c.beginPath(); c.arc(tx, ty, r, 0, 6.283); c.stroke();
        c.fillStyle = 'rgba(255,92,61,0.25)';
        c.fill();
        for (let k = 0; k < tornado.cfg.subvortices; k++) {
          c.fillStyle = '#ff5c3d';
          c.beginPath();
          c.arc(tx + tornado.subCos[k] * r * 0.8, ty + tornado.subSin[k] * r * 0.8, 2.2, 0, 6.283);
          c.fill();
        }
      }
    }

    // camera marker with view direction
    const cx = this.px(camX), cy = this.px(camZ);
    if (cx > -20 && cy > -20 && cx < SIZE + 20 && cy < SIZE + 20) {
      const a = Math.atan2(tgtZ - camZ, tgtX - camX);
      c.fillStyle = 'rgba(120,200,255,0.2)';
      c.beginPath();
      c.moveTo(cx, cy);
      c.arc(cx, cy, 46, a - 0.45, a + 0.45);
      c.closePath();
      c.fill();
      c.fillStyle = '#7fd0ff';
      c.beginPath(); c.arc(cx, cy, 4, 0, 6.283); c.fill();
    }
  }
}
