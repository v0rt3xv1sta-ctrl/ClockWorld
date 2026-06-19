/*
 * noise.js — seeded Perlin noise + fractal helpers used for terrain shaping.
 * Self-contained: a seedable permutation table drives classic 2D/3D Perlin
 * noise, plus an fbm() octave sum and a cheap deterministic hash for scatter
 * features (tree placement etc.).
 */
(function (global) {
  "use strict";

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  function lerp(a, b, t) { return a + t * (b - a); }

  function grad2(h, x, y) {
    switch (h & 3) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      default: return -x - y;
    }
  }

  function grad3(h, x, y, z) {
    const u = (h & 1) === 0 ? x : -x;
    const v = (h & 2) === 0 ? y : -y;
    const w = (h & 4) === 0 ? z : -z;
    return u + v + w;
  }

  function Noise(seed) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    const rng = mulberry32(seed >>> 0);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    const perm = new Uint16Array(512);
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    this.perm = perm;
    this.seed = seed >>> 0;
  }

  Noise.prototype.perlin2 = function (x, y) {
    const perm = this.perm;
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const aa = perm[perm[X] + Y], ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y], bb = perm[perm[X + 1] + Y + 1];
    return lerp(
      lerp(grad2(aa, x, y), grad2(ba, x - 1, y), u),
      lerp(grad2(ab, x, y - 1), grad2(bb, x - 1, y - 1), u),
      v
    );
  };

  Noise.prototype.perlin3 = function (x, y, z) {
    const perm = this.perm;
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);
    const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z;
    const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;
    return lerp(
      lerp(
        lerp(grad3(perm[AA], x, y, z), grad3(perm[BA], x - 1, y, z), u),
        lerp(grad3(perm[AB], x, y - 1, z), grad3(perm[BB], x - 1, y - 1, z), u),
        v
      ),
      lerp(
        lerp(grad3(perm[AA + 1], x, y, z - 1), grad3(perm[BA + 1], x - 1, y, z - 1), u),
        lerp(grad3(perm[AB + 1], x, y - 1, z - 1), grad3(perm[BB + 1], x - 1, y - 1, z - 1), u),
        v
      ),
      w
    );
  };

  // Fractal Brownian motion: summed octaves, returns roughly [-1, 1].
  Noise.prototype.fbm2 = function (x, y, octaves, persistence, lacunarity) {
    octaves = octaves || 4;
    persistence = persistence === undefined ? 0.5 : persistence;
    lacunarity = lacunarity === undefined ? 2.0 : lacunarity;
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.perlin2(x * freq, y * freq);
      norm += amp;
      amp *= persistence;
      freq *= lacunarity;
    }
    return sum / norm;
  };

  // Deterministic hash of two integers + seed -> [0, 1). Used for scatter features.
  Noise.prototype.hash2 = function (x, y) {
    let h = (x * 374761393 + y * 668265263 + this.seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };

  const api = { Noise, mulberry32 };
  global.Noise = Noise;
  global.mulberry32 = mulberry32;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
