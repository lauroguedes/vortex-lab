import * as THREE from 'three';

/** Tileable 3-octave value-noise volume used for cloud, funnel and dust detail. */
export function makeNoiseTexture(size = 64): THREE.Data3DTexture {
  const data = new Uint8Array(size * size * size);
  const acc = new Float32Array(size * size * size);
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const octaves = [
    { cells: 4, amp: 0.5 },
    { cells: 8, amp: 0.3 },
    { cells: 16, amp: 0.2 },
  ];
  for (const { cells, amp } of octaves) {
    const lat = new Float32Array(cells * cells * cells);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    const scale = cells / size;
    const at = (x: number, y: number, z: number) => lat[((z % cells) * cells + (y % cells)) * cells + (x % cells)];
    for (let z = 0; z < size; z++) {
      const fz = z * scale, z0 = Math.floor(fz), tz = fz - z0, wz = tz * tz * (3 - 2 * tz);
      for (let y = 0; y < size; y++) {
        const fy = y * scale, y0 = Math.floor(fy), ty = fy - y0, wy = ty * ty * (3 - 2 * ty);
        for (let x = 0; x < size; x++) {
          const fx = x * scale, x0 = Math.floor(fx), tx = fx - x0, wx = tx * tx * (3 - 2 * tx);
          const a = at(x0, y0, z0) + (at(x0 + 1, y0, z0) - at(x0, y0, z0)) * wx;
          const b = at(x0, y0 + 1, z0) + (at(x0 + 1, y0 + 1, z0) - at(x0, y0 + 1, z0)) * wx;
          const c = at(x0, y0, z0 + 1) + (at(x0 + 1, y0, z0 + 1) - at(x0, y0, z0 + 1)) * wx;
          const d = at(x0, y0 + 1, z0 + 1) + (at(x0 + 1, y0 + 1, z0 + 1) - at(x0, y0 + 1, z0 + 1)) * wx;
          const e = a + (b - a) * wy, f = c + (d - c) * wy;
          acc[(z * size + y) * size + x] += (e + (f - e) * wz) * amp;
        }
      }
    }
  }
  let lo = 1, hi = 0;
  for (const v of acc) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (let i = 0; i < acc.length; i++) data[i] = Math.round(((acc[i] - lo) / (hi - lo)) * 255);
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
