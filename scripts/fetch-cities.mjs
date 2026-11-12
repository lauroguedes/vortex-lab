// Downloads real building footprints, roads and land cover from OpenStreetMap
// (Overpass API) for every city in src/data/cities.json and writes compact
// local-metre tiles to public/cities/<id>.json.
//
//   node scripts/fetch-cities.mjs            # all cities
//   node scripts/fetch-cities.mjs moore      # one city
//
// Coordinates: x = east, z = south (north is -z), metres from the tile centre.
// Values are stored as integer decimetres to keep the files small.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HALF = 1200; // half-size of the simulated tile (m)
const FETCH_HALF = 1320; // fetch a little more so roads run off the edge
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const ROAD_WIDTH = {
  motorway: 15, trunk: 14, primary: 13, secondary: 11, tertiary: 9.5,
  motorway_link: 8, trunk_link: 8, primary_link: 7.5, secondary_link: 7,
  residential: 7.5, unclassified: 7.5, living_street: 6, service: 4,
};
const ROAD_RANK = {
  service: 0, living_street: 1, residential: 1, unclassified: 1,
  tertiary: 2, secondary_link: 2, secondary: 3, primary_link: 3, primary: 4,
  trunk_link: 4, trunk: 5, motorway_link: 5, motorway: 6,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'tornado-sim-tile-builder/1.0',
          Accept: 'application/json',
        },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.warn(`   retry (${err.message})`);
      await sleep(4000 + attempt * 3000);
    }
  }
  throw lastErr;
}

function parseHeight(tags) {
  const raw = tags.height ?? tags['building:height'];
  if (raw) {
    const m = String(raw).match(/-?\d+(\.\d+)?/);
    if (m) {
      let v = parseFloat(m[0]);
      if (/ft|'/.test(String(raw))) v *= 0.3048;
      if (v > 1.5 && v < 900) return v;
    }
  }
  const lv = parseFloat(tags['building:levels']);
  if (lv > 0 && lv < 200) return lv * 3.4 + 1.2;
  return 0;
}

function ringArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function simplify(pts, tol) {
  // Douglas–Peucker on an open polyline
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const ax = pts[a][0], az = pts[a][1];
    const dx = pts[b][0] - ax, dz = pts[b][1] - az;
    const len2 = dx * dx + dz * dz || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - az) * dz) / len2));
      const ex = pts[i][0] - (ax + t * dx), ez = pts[i][1] - (az + t * dz);
      const d = ex * ex + ez * ez;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol * tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Douglas–Peucker that never drops the flagged vertices (street junctions). */
function simplifyKeep(pts, tol, keep) {
  const out = [];
  let a = 0;
  for (let i = 1; i < pts.length; i++) {
    if (!keep[i] && i !== pts.length - 1) continue;
    const piece = simplify(pts.slice(a, i + 1), tol);
    for (let k = out.length ? 1 : 0; k < piece.length; k++) out.push(piece[k]);
    a = i;
  }
  return out.length ? out : pts;
}

function cleanRing(pts, tol) {
  let ring = pts.slice();
  const f = ring[0], l = ring[ring.length - 1];
  if (ring.length > 1 && Math.abs(f[0] - l[0]) < 0.05 && Math.abs(f[1] - l[1]) < 0.05) ring.pop();
  if (ring.length < 3) return null;
  // simplify as a closed loop: run DP on the ring opened at its first vertex
  const open = simplify([...ring, ring[0]], tol);
  open.pop();
  if (open.length < 3) return null;
  return open;
}

/** Join multipolygon member ways into closed rings. */
function assembleRings(ways) {
  const rings = [];
  const pool = ways.map((w) => w.slice());
  const key = (p) => p[0].toFixed(2) + ',' + p[1].toFixed(2);
  while (pool.length) {
    let cur = pool.pop();
    let guard = 0;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 500) {
      const end = key(cur[cur.length - 1]);
      const i = pool.findIndex((w) => key(w[0]) === end || key(w[w.length - 1]) === end);
      if (i < 0) break;
      let next = pool.splice(i, 1)[0];
      if (key(next[0]) !== end) next = next.reverse();
      cur = cur.concat(next.slice(1));
    }
    if (cur.length >= 4) rings.push(cur);
  }
  return rings;
}

const D = (v) => Math.round(v * 10);

function classify(tags, area, h) {
  const b = tags.building;
  if (h >= 60) return 3;
  if (h >= 17) return 2;
  if (['industrial', 'warehouse', 'hangar', 'manufacture'].includes(b)) return 4;
  if (area > 2600 && h < 15) return 4;
  const houseLike = ['house', 'residential', 'detached', 'semidetached_house', 'bungalow',
    'garage', 'garages', 'shed', 'hut', 'cabin', 'static_caravan', 'terrace', 'carport', 'yes'];
  if (area < 430 && h < 10.5 && houseLike.includes(b)) return 0;
  return 1;
}

function guessHeight(tags, area, rnd, levels) {
  const b = tags.building;
  // dense city centres: untagged buildings are multi-storey blocks, taller on bigger plots
  if (levels && !['garage', 'garages', 'shed', 'carport', 'hut', 'roof', 'kiosk'].includes(b)) {
    if (area < 28) return 3 + rnd;
    const span = levels[1] - levels[0];
    const big = Math.min(1, area / 900);
    return (levels[0] + span * Math.min(1, rnd * 0.75 + big * 0.35)) * 3.3 + 1;
  }
  if (['garage', 'garages', 'shed', 'carport', 'hut'].includes(b)) return 2.6 + rnd * 0.6;
  if (['house', 'detached', 'residential', 'bungalow', 'semidetached_house', 'terrace'].includes(b))
    return rnd < 0.25 ? 5.8 + rnd * 2 : 3.0 + rnd * 0.9;
  if (b === 'apartments' || b === 'dormitory' || b === 'hotel') return 10 + rnd * 9;
  if (['church', 'cathedral', 'chapel'].includes(b)) return 9 + rnd * 6;
  if (['industrial', 'warehouse'].includes(b)) return 7 + rnd * 4;
  if (['school', 'university', 'hospital', 'civic', 'public'].includes(b)) return 7 + rnd * 7;
  if (['retail', 'commercial', 'supermarket', 'office'].includes(b))
    return area > 1500 ? 6.5 + rnd * 3 : 4.5 + rnd * 5;
  if (area < 60) return 2.7 + rnd * 0.5;
  if (area < 330) return rnd < 0.2 ? 6 + rnd * 2 : 3.0 + rnd * 1.0;
  if (area < 1500) return 4.5 + rnd * 5;
  return 6.5 + rnd * 5;
}

// small deterministic PRNG so re-runs give identical tiles
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function buildCity(city) {
  const { lat, lon } = city;
  const mLat = 110540, mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const dLat = FETCH_HALF / mLat, dLon = FETCH_HALF / mLon;
  const bbox = `${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon}`;
  const hw = Object.keys(ROAD_WIDTH).join('|');
  const query = `[out:json][timeout:120][maxsize:536870912];
(
  way["building"](${bbox});
  relation["building"]["type"="multipolygon"](${bbox});
  way["highway"~"^(${hw})$"](${bbox});
  way["natural"~"^(water|wood|scrub)$"](${bbox});
  relation["natural"="water"](${bbox});
  way["waterway"="riverbank"](${bbox});
  way["leisure"~"^(park|garden|pitch|golf_course|playground)$"](${bbox});
  way["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery|village_green|farmland)$"](${bbox});
  way["amenity"="parking"](${bbox});
);
out geom;`;
  const data = await overpass(query);

  // a vertex used by two or more streets is a junction: keep it through simplification
  // so the traffic simulation can turn there
  const uses = new Map();
  for (const el of data.elements) {
    if (el.type !== 'way' || !el.geometry || !el.tags?.highway) continue;
    const seen = new Set();
    for (const g of el.geometry) {
      const k = g.lat + ',' + g.lon;
      if (seen.has(k)) continue;
      seen.add(k);
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  }

  const proj = (g) => [(g.lon - lon) * mLon, -(g.lat - lat) * mLat];
  const rnd = mulberry32(Math.round(Math.abs(lat * 1000) + Math.abs(lon * 1000)));

  const buildings = [], roads = [], water = [], green = [], parking = [];
  const pushBuilding = (pts, tags) => {
    const ring = cleanRing(pts, 0.35);
    if (!ring) return;
    let cx = 0, cz = 0;
    for (const p of ring) { cx += p[0]; cz += p[1]; }
    cx /= ring.length; cz /= ring.length;
    if (Math.abs(cx) > HALF || Math.abs(cz) > HALF) return;
    const area = Math.abs(ringArea(ring));
    if (area < 14) return;
    if (['roof', 'carport'].includes(tags.building) && area > 800) return;
    let h = parseHeight(tags);
    const r = rnd();
    if (!h) h = guessHeight(tags, area, r, city.levels);
    h = Math.max(2.4, h);
    const cls = classify(tags, area, h);
    if (ringArea(ring) < 0) ring.reverse(); // enforce a consistent winding
    buildings.push({ p: ring.flatMap((q) => [D(q[0]), D(q[1])]), h: D(h), c: cls });
  };
  const pushArea = (list, pts, minArea) => {
    const ring = cleanRing(pts, 1.2);
    if (!ring || Math.abs(ringArea(ring)) < minArea) return;
    list.push(ring.flatMap((q) => [D(q[0]), D(q[1])]));
  };

  for (const el of data.elements) {
    const tags = el.tags ?? {};
    if (el.type === 'way' && el.geometry) {
      const pts = el.geometry.map(proj);
      if (tags.building) pushBuilding(pts, tags);
      else if (tags.highway) {
        if (tags.tunnel === 'yes' || tags.area === 'yes') continue;
        if (tags.highway === 'service' && ['parking_aisle', 'driveway'].includes(tags.service) && rnd() < 0.5) continue;
        const inside = pts.some((p) => Math.abs(p[0]) < FETCH_HALF && Math.abs(p[1]) < FETCH_HALF);
        if (!inside) continue;
        let w = ROAD_WIDTH[tags.highway];
        const lanes = parseFloat(tags.lanes);
        if (lanes > 0 && lanes < 12) w = Math.max(w * 0.6, lanes * 3.5 + 1);
        const line = simplifyKeep(pts, 0.5, el.geometry.map((g) => uses.get(g.lat + ',' + g.lon) > 1));
        roads.push({ p: line.flatMap((q) => [D(q[0]), D(q[1])]), w: D(w), k: ROAD_RANK[tags.highway] });
      } else if (tags.natural === 'water' || tags.waterway === 'riverbank') pushArea(water, pts, 60);
      else if (tags.amenity === 'parking') pushArea(parking, pts, 150);
      else if (tags.natural || tags.leisure || tags.landuse) pushArea(green, pts, 120);
    } else if (el.type === 'relation' && el.members) {
      const outers = el.members
        .filter((m) => m.type === 'way' && m.geometry && m.role !== 'inner')
        .map((m) => m.geometry.map(proj));
      for (const ring of assembleRings(outers)) {
        if (tags.building) pushBuilding(ring, tags);
        else if (tags.natural === 'water') pushArea(water, ring, 60);
      }
    }
  }

  if (city.infill) infillHouses(buildings, roads, water, green, parking, rnd);
  // keep the scene tractable in the densest districts: drop the smallest outbuildings first
  const MAX_BUILDINGS = 14000;
  if (buildings.length > MAX_BUILDINGS) {
    const areaOf = (b) => { let a = 0; for (let i = 0, n = b.p.length; i < n; i += 2) { const j = (i + 2) % n; a += b.p[i] * b.p[j + 1] - b.p[j] * b.p[i + 1]; } return Math.abs(a); };
    const cut = buildings.map(areaOf).sort((a, b) => b - a)[MAX_BUILDINGS];
    const kept = buildings.filter((b) => areaOf(b) > cut);
    console.log(`(trimmed ${buildings.length - kept.length} smallest of ${buildings.length}) `);
    buildings.length = 0;
    buildings.push(...kept);
  }
  roads.sort((a, b) => a.k - b.k);
  return { id: city.id, half: HALF, buildings, roads, water, green, parking };
}

/**
 * Where OpenStreetMap has streets but few mapped buildings, line the residential
 * streets with typical detached houses so the neighbourhood density is realistic.
 */
function infillHouses(buildings, roads, water, green, parking, rnd) {
  const CELL = 3, N = Math.ceil((HALF * 2) / CELL);
  const grid = new Uint8Array(N * N);
  const gi = (v) => Math.floor((v + HALF) / CELL);
  const mark = (x0, z0, x1, z1) => {
    for (let j = Math.max(0, gi(z0)); j <= Math.min(N - 1, gi(z1)); j++)
      for (let i = Math.max(0, gi(x0)); i <= Math.min(N - 1, gi(x1)); i++) grid[j * N + i] = 1;
  };
  const free = (x0, z0, x1, z1) => {
    if (x0 < -HALF || z0 < -HALF || x1 > HALF || z1 > HALF) return false;
    for (let j = gi(z0); j <= gi(z1); j++)
      for (let i = gi(x0); i <= gi(x1); i++) if (grid[j * N + i]) return false;
    return true;
  };
  const bboxOf = (p) => {
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (let i = 0; i < p.length; i += 2) {
      x0 = Math.min(x0, p[i] / 10); x1 = Math.max(x1, p[i] / 10);
      z0 = Math.min(z0, p[i + 1] / 10); z1 = Math.max(z1, p[i + 1] / 10);
    }
    return [x0, z0, x1, z1];
  };
  for (const b of buildings) { const [a, c, d, e] = bboxOf(b.p); mark(a - 4, c - 4, d + 4, e + 4); }
  for (const list of [water, green, parking]) for (const p of list) mark(...bboxOf(p));
  for (const r of roads) {
    const w = r.w / 20 + 2;
    for (let i = 0; i + 3 < r.p.length; i += 2) {
      const ax = r.p[i] / 10, az = r.p[i + 1] / 10, bx = r.p[i + 2] / 10, bz = r.p[i + 3] / 10;
      const len = Math.hypot(bx - ax, bz - az), steps = Math.ceil(len / 2);
      for (let s = 0; s <= steps; s++) {
        const x = ax + ((bx - ax) * s) / steps, z = az + ((bz - az) * s) / steps;
        mark(x - w, z - w, x + w, z + w);
      }
    }
  }
  let added = 0;
  for (const r of roads) {
    if (r.k !== 1 && r.k !== 2) continue;
    let carry = rnd() * 20;
    for (let i = 0; i + 3 < r.p.length; i += 2) {
      const ax = r.p[i] / 10, az = r.p[i + 1] / 10, bx = r.p[i + 2] / 10, bz = r.p[i + 3] / 10;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1) continue;
      const dx = (bx - ax) / len, dz = (bz - az) / len;
      let s = carry;
      while (s < len) {
        for (const side of [-1, 1]) {
          const wid = 11 + rnd() * 6, dep = 8 + rnd() * 4;
          const set = r.w / 20 + 9 + rnd() * 4 + dep / 2;
          const cx = ax + dx * s + -dz * side * set, cz = az + dz * s + dx * side * set;
          const ext = Math.max(wid, dep) / 2 + 2.5;
          if (!free(cx - ext, cz - ext, cx + ext, cz + ext)) continue;
          const hw = wid / 2, hd = dep / 2;
          const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => [cx + dx * u - dz * v, cz + dz * u + dx * v]);
          if (ringArea(corners) < 0) corners.reverse();
          const h = rnd() < 0.2 ? 6 + rnd() * 1.5 : 3 + rnd() * 0.9;
          buildings.push({ p: corners.flatMap((q) => [D(q[0]), D(q[1])]), h: D(h), c: 0 });
          mark(cx - ext, cz - ext, cx + ext, cz + ext);
          added++;
        }
        s += 19 + rnd() * 7;
      }
      carry = s - len;
    }
  }
  return added;
}

const only = process.argv.slice(2);
const cities = JSON.parse(await readFile(path.join(ROOT, 'src/data/cities.json'), 'utf8'));
await mkdir(path.join(ROOT, 'public/cities'), { recursive: true });

for (const city of cities) {
  if (only.length && !only.includes(city.id)) continue;
  process.stdout.write(`• ${city.name} … `);
  try {
    const tile = await buildCity(city);
    const json = JSON.stringify(tile);
    await writeFile(path.join(ROOT, 'public/cities', `${city.id}.json`), json);
    const cls = [0, 0, 0, 0, 0];
    let maxH = 0;
    for (const b of tile.buildings) { cls[b.c]++; maxH = Math.max(maxH, b.h / 10); }
    console.log(
      `${tile.buildings.length} buildings [house ${cls[0]}, low ${cls[1]}, mid ${cls[2]}, high ${cls[3]}, ind ${cls[4]}], ` +
      `tallest ${maxH.toFixed(0)} m, ${tile.roads.length} roads, ${tile.water.length} water, ${tile.green.length} green, ` +
      `${(json.length / 1024).toFixed(0)} KB`,
    );
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    process.exitCode = 1;
  }
  await sleep(2500);
}
