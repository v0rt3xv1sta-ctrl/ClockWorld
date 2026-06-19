/*
 * world.js — chunk storage, terrain generation, meshing and voxel raycasting.
 *
 * The world is an effectively infinite grid of 16x16 columns, WORLD_HEIGHT
 * tall. Chunks are generated lazily and meshed with hidden-face removal plus
 * per-vertex ambient occlusion. No DOM access here so the generation/meshing
 * logic is unit-testable under Node.
 */
(function (global) {
  "use strict";

  const Blocks = (typeof module !== "undefined" && module.exports)
    ? require("./blocks.js") : global.Blocks;
  const NoiseMod = (typeof module !== "undefined" && module.exports)
    ? require("./noise.js") : { Noise: global.Noise };
  const Noise = NoiseMod.Noise;

  const SX = 16, SZ = 16, HEIGHT = 128, SEA_LEVEL = 32, SNOW_LINE = SEA_LEVEL + 34;
  const ID = Blocks.ID;

  function idx(lx, y, lz) { return lx + lz * SX + y * SX * SZ; }
  function key(cx, cz) { return cx + "," + cz; }
  function floorDiv(a, b) { return Math.floor(a / b); }

  // ---- Per-face geometry + ambient-occlusion sampling table ------------------
  // For each face: outward normal, the in-plane u/v axes (v chosen as world-up
  // for side faces so textures stay upright), and which cube tile to use.
  const FACE_DEFS = [
    { name: "px", normal: [1, 0, 0], ua: [0, 0, 1], va: [0, 1, 0], tile: "side" },
    { name: "nx", normal: [-1, 0, 0], ua: [0, 0, 1], va: [0, 1, 0], tile: "side" },
    { name: "pz", normal: [0, 0, 1], ua: [1, 0, 0], va: [0, 1, 0], tile: "side" },
    { name: "nz", normal: [0, 0, -1], ua: [1, 0, 0], va: [0, 1, 0], tile: "side" },
    { name: "py", normal: [0, 1, 0], ua: [1, 0, 0], va: [0, 0, 1], tile: "top" },
    { name: "ny", normal: [0, -1, 0], ua: [1, 0, 0], va: [0, 0, 1], tile: "bottom" },
  ];

  // Directional face shading (before AO and day/night) — fakes a sun.
  const FACE_SHADE = { px: 0.72, nx: 0.72, pz: 0.86, nz: 0.86, py: 1.0, ny: 0.5 };
  const AO_LEVELS = [0.42, 0.62, 0.82, 1.0];

  // Expand each face into 4 vertices with positions, uv flags and AO offsets.
  const FACES = FACE_DEFS.map((f) => {
    const n = f.normal;
    const ni = n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2; // normal axis index
    const layer = n.slice(); // neighbour layer offset (= normal direction)
    const verts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([uu, vv]) => {
      const pos = [0, 0, 0];
      pos[ni] = n[ni] > 0 ? 1 : 0;
      for (let k = 0; k < 3; k++) pos[k] += f.ua[k] * uu + f.va[k] * vv;
      const su = uu === 0 ? -1 : 1, sv = vv === 0 ? -1 : 1;
      const side1 = [layer[0] + f.ua[0] * su, layer[1] + f.ua[1] * su, layer[2] + f.ua[2] * su];
      const side2 = [layer[0] + f.va[0] * sv, layer[1] + f.va[1] * sv, layer[2] + f.va[2] * sv];
      const corner = [
        layer[0] + f.ua[0] * su + f.va[0] * sv,
        layer[1] + f.ua[1] * su + f.va[1] * sv,
        layer[2] + f.ua[2] * su + f.va[2] * sv,
      ];
      return { pos, uu, vv, side1, side2, corner };
    });
    return { name: f.name, normal: n, layer, tile: f.tile, verts, shade: FACE_SHADE[f.name] };
  });

  const TS = 1 / Blocks.ATLAS_COLS;
  const INSET = 0.5 / (Blocks.ATLAS_COLS * 16); // half-texel, prevents atlas bleed
  function tileUV(tile, uu, vv) {
    const col = tile % Blocks.ATLAS_COLS;
    const row = (tile / Blocks.ATLAS_COLS) | 0;
    const s = col * TS + (uu === 0 ? INSET : TS - INSET);
    // vv=1 is world-up; map it to the top of the tile (no UNPACK_FLIP_Y on upload)
    const t = row * TS + (vv === 1 ? INSET : TS - INSET);
    return [s, t];
  }

  function Chunk(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.data = new Uint8Array(SX * SZ * HEIGHT);
    this.maxY = 0;
    this.dirty = true;
  }
  Chunk.prototype.get = function (lx, y, lz) {
    if (y < 0 || y >= HEIGHT) return 0;
    return this.data[idx(lx, y, lz)];
  };

  function World(seed) {
    this.seed = (seed >>> 0) || 1;
    this.noise = new Noise(this.seed);
    this.chunks = new Map();
    this.edits = {}; // "wx,wy,wz" -> id, persisted player edits
  }

  World.prototype.heightAt = function (wx, wz) {
    const n = this.noise;
    const cont = n.fbm2(wx * 0.0035, wz * 0.0035, 4, 0.5, 2.0);
    const hills = n.fbm2(wx * 0.013, wz * 0.013, 4, 0.5, 2.0);
    let h = SEA_LEVEL + 3 + cont * 22 + hills * 8;
    h = Math.floor(h);
    if (h < 3) h = 3;
    if (h > HEIGHT - 24) h = HEIGHT - 24;
    return h;
  };

  World.prototype.oreAt = function (x, y, z) {
    const n = this.noise.perlin3(x * 0.1, y * 0.1, z * 0.1);
    if (n > 0.78) {
      if (y < 12) return ID.DIAMOND_ORE;
      if (y < 20) return ID.GOLD_ORE;
      if (y < 40) return ID.IRON_ORE;
      return ID.COAL_ORE;
    }
    return 0;
  };

  World.prototype.isCave = function (x, y, z) {
    return this.noise.perlin3(x * 0.06, y * 0.09, z * 0.06) > 0.62;
  };

  World.prototype.generateChunk = function (cx, cz) {
    const chunk = new Chunk(cx, cz);
    const data = chunk.data;
    let maxY = 0;
    for (let lx = 0; lx < SX; lx++) {
      for (let lz = 0; lz < SZ; lz++) {
        const wx = cx * SX + lx, wz = cz * SZ + lz;
        const h = this.heightAt(wx, wz);
        const top = Math.max(h, SEA_LEVEL);
        for (let y = 0; y <= top; y++) {
          let id = ID.AIR;
          if (y === 0) id = ID.BEDROCK;
          else if (y < h - 4) id = ID.STONE;
          else if (y < h) id = ID.DIRT;
          else if (y === h) {
            if (h < SEA_LEVEL) id = (h >= SEA_LEVEL - 2) ? ID.SAND : ID.DIRT;
            else if (h <= SEA_LEVEL + 1) id = ID.SAND;
            else if (h > SNOW_LINE) id = ID.SNOW;
            else id = ID.GRASS;
          }
          if (id === ID.STONE) {
            const ore = this.oreAt(wx, y, wz);
            if (ore) id = ore;
          }
          if (id !== ID.AIR && id !== ID.BEDROCK && y > 1 && y < h - 1 && this.isCave(wx, y, wz)) {
            id = ID.AIR;
          }
          if (id === ID.AIR && y > h && y <= SEA_LEVEL) id = ID.WATER;
          if (id !== ID.AIR) {
            data[idx(lx, y, lz)] = id;
            if (y > maxY) maxY = y;
          }
        }
      }
    }
    chunk.maxY = Math.min(maxY + 1, HEIGHT - 1);
    this.generateTrees(chunk);
    this.applyEdits(chunk);
    return chunk;
  };

  World.prototype.generateTrees = function (chunk) {
    const margin = 3;
    for (let lx = -margin; lx < SX + margin; lx++) {
      for (let lz = -margin; lz < SZ + margin; lz++) {
        const wx = chunk.cx * SX + lx, wz = chunk.cz * SZ + lz;
        if (this.noise.hash2(wx, wz) < 0.011) {
          const h = this.heightAt(wx, wz);
          if (h > SEA_LEVEL + 1 && h < SNOW_LINE) this.stampTree(chunk, wx, h, wz);
        }
      }
    }
  };

  World.prototype.stampTree = function (chunk, wx, baseH, wz) {
    const th = 4 + Math.floor(this.noise.hash2(wx * 7, wz * 13) * 3);
    const topY = baseH + th;
    for (let dy = -2; dy <= 1; dy++) {
      const y = topY + dy;
      const r = dy <= 0 ? 2 : 1;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) === r && Math.abs(dz) === r) continue; // round the canopy
          this.setGen(chunk, wx + dx, y, wz + dz, ID.LEAVES, true);
        }
      }
    }
    for (let i = 1; i <= th; i++) this.setGen(chunk, wx, baseH + i, wz, ID.LOG, false);
  };

  // Write a block during generation, clipped to the chunk. onlyAir=true keeps
  // existing solids (leaves); otherwise trunk overwrites air/leaves.
  World.prototype.setGen = function (chunk, wx, y, wz, id, onlyAir) {
    const lx = wx - chunk.cx * SX, lz = wz - chunk.cz * SZ;
    if (lx < 0 || lx >= SX || lz < 0 || lz >= SZ || y < 0 || y >= HEIGHT) return;
    const i = idx(lx, y, lz);
    const cur = chunk.data[i];
    if (onlyAir) { if (cur !== ID.AIR) return; }
    else if (cur !== ID.AIR && cur !== ID.LEAVES) return;
    chunk.data[i] = id;
    if (y > chunk.maxY) chunk.maxY = Math.min(y + 1, HEIGHT - 1);
  };

  World.prototype.applyEdits = function (chunk) {
    const x0 = chunk.cx * SX, z0 = chunk.cz * SZ;
    for (const k in this.edits) {
      const c = k.split(",");
      const wx = +c[0], wy = +c[1], wz = +c[2];
      if (wx >= x0 && wx < x0 + SX && wz >= z0 && wz < z0 + SZ && wy >= 0 && wy < HEIGHT) {
        const id = this.edits[k];
        chunk.data[idx(wx - x0, wy, wz - z0)] = id;
        if (id !== ID.AIR && wy > chunk.maxY) chunk.maxY = Math.min(wy + 1, HEIGHT - 1);
      }
    }
  };

  World.prototype.getChunk = function (cx, cz) { return this.chunks.get(key(cx, cz)); };

  World.prototype.getOrCreateChunk = function (cx, cz) {
    const k = key(cx, cz);
    let c = this.chunks.get(k);
    if (!c) {
      c = this.generateChunk(cx, cz);
      this.chunks.set(k, c);
      // neighbours' border faces may now be hidden — re-mesh them.
      this.markDirty(cx + 1, cz); this.markDirty(cx - 1, cz);
      this.markDirty(cx, cz + 1); this.markDirty(cx, cz - 1);
    }
    return c;
  };

  World.prototype.markDirty = function (cx, cz) {
    const c = this.chunks.get(key(cx, cz));
    if (c) c.dirty = true;
  };

  World.prototype.getBlock = function (wx, wy, wz) {
    if (wy < 0 || wy >= HEIGHT) return 0;
    const cx = floorDiv(wx, SX), cz = floorDiv(wz, SZ);
    const c = this.chunks.get(key(cx, cz));
    if (!c) return 0;
    return c.data[idx(wx - cx * SX, wy, wz - cz * SZ)];
  };

  World.prototype.setBlock = function (wx, wy, wz, id) {
    if (wy < 0 || wy >= HEIGHT) return;
    const cx = floorDiv(wx, SX), cz = floorDiv(wz, SZ);
    const c = this.getOrCreateChunk(cx, cz);
    const lx = wx - cx * SX, lz = wz - cz * SZ;
    c.data[idx(lx, wy, lz)] = id;
    if (id !== 0 && wy > c.maxY) c.maxY = Math.min(wy + 1, HEIGHT - 1);
    this.edits[wx + "," + wy + "," + wz] = id;
    c.dirty = true;
    // edits on a border change the neighbour chunk's culling too
    if (lx === 0) this.markDirty(cx - 1, cz);
    if (lx === SX - 1) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    if (lz === SZ - 1) this.markDirty(cx, cz + 1);
  };

  // Should face of `self` toward neighbour `nb` be emitted?
  function shouldDrawFace(selfId, nbId) {
    const self = Blocks.BLOCKS[selfId];
    if (self.liquid) return nbId === 0; // water: only show surface against air
    const nb = Blocks.BLOCKS[nbId];
    if (!nb || nb.opaque) return false; // hidden behind opaque
    if (nbId === selfId && self.cullSelf) return false; // merge glass etc.
    return true;
  }

  // Build interleaved geometry for a chunk. Returns opaque + water buffers,
  // each as {data: Float32Array(x,y,z,u,v,light per vertex), indices}.
  World.prototype.buildGeometry = function (chunk) {
    const opaque = { pos: [], idx: [] };
    const water = { pos: [], idx: [] };
    const cx0 = chunk.cx * SX, cz0 = chunk.cz * SZ;
    const get = (x, y, z) => this.getBlock(x, y, z);

    for (let y = 0; y <= chunk.maxY; y++) {
      for (let lz = 0; lz < SZ; lz++) {
        for (let lx = 0; lx < SX; lx++) {
          const id = chunk.data[idx(lx, y, lz)];
          if (id === 0) continue;
          const block = Blocks.BLOCKS[id];
          const wx = cx0 + lx, wz = cz0 + lz;
          const target = block.liquid ? water : opaque;
          for (let fi = 0; fi < FACES.length; fi++) {
            const face = FACES[fi];
            const nx = wx + face.layer[0], ny = y + face.layer[1], nz = wz + face.layer[2];
            const nbId = get(nx, ny, nz);
            if (!shouldDrawFace(id, nbId)) continue;
            const tile = block[face.tile];
            const base = target.pos.length / 6;
            for (let vi = 0; vi < 4; vi++) {
              const v = face.verts[vi];
              const px = wx + v.pos[0], py = y + v.pos[1], pz = wz + v.pos[2];
              const uv = tileUV(tile, v.uu, v.vv);
              let light = face.shade;
              if (!block.liquid) {
                const s1 = Blocks.isOpaque(get(wx + v.side1[0], y + v.side1[1], wz + v.side1[2])) ? 1 : 0;
                const s2 = Blocks.isOpaque(get(wx + v.side2[0], y + v.side2[1], wz + v.side2[2])) ? 1 : 0;
                const co = Blocks.isOpaque(get(wx + v.corner[0], y + v.corner[1], wz + v.corner[2])) ? 1 : 0;
                const ao = (s1 && s2) ? 0 : 3 - (s1 + s2 + co);
                light *= AO_LEVELS[ao];
              }
              target.pos.push(px, py, pz, uv[0], uv[1], light);
            }
            target.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
          }
        }
      }
    }
    return {
      opaque: { data: new Float32Array(opaque.pos), indices: new Uint32Array(opaque.idx) },
      water: { data: new Float32Array(water.pos), indices: new Uint32Array(water.idx) },
    };
  };

  // Voxel DDA raycast. Returns {hit:[x,y,z], normal:[..], place:[x,y,z]} or null.
  World.prototype.raycast = function (origin, dir, maxDist) {
    let x = Math.floor(origin[0]), y = Math.floor(origin[1]), z = Math.floor(origin[2]);
    const stepX = dir[0] > 0 ? 1 : -1, stepY = dir[1] > 0 ? 1 : -1, stepZ = dir[2] > 0 ? 1 : -1;
    const tDeltaX = dir[0] !== 0 ? Math.abs(1 / dir[0]) : Infinity;
    const tDeltaY = dir[1] !== 0 ? Math.abs(1 / dir[1]) : Infinity;
    const tDeltaZ = dir[2] !== 0 ? Math.abs(1 / dir[2]) : Infinity;
    const distBound = (i, s, o, d) => d === 0 ? Infinity
      : (s > 0 ? (i + 1 - o) : (o - i)) / Math.abs(d);
    let tMaxX = distBound(x, stepX, origin[0], dir[0]);
    let tMaxY = distBound(y, stepY, origin[1], dir[1]);
    let tMaxZ = distBound(z, stepZ, origin[2], dir[2]);
    let nx = 0, ny = 0, nz = 0;
    let t = 0;
    while (t <= maxDist) {
      const id = this.getBlock(x, y, z);
      if (id !== 0 && !Blocks.BLOCKS[id].liquid) {
        return { hit: [x, y, z], normal: [nx, ny, nz], place: [x + nx, y + ny, z + nz] };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      }
    }
    return null;
  };

  const api = { World, Chunk, SX, SZ, HEIGHT, SEA_LEVEL, SNOW_LINE, FACES, tileUV, shouldDrawFace, idx };
  global.WorldMod = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
