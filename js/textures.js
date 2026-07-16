/*
 * textures.js — procedural pixel-art texture atlas drawn on a 2D canvas.
 *
 * No external image assets: every block tile is generated at runtime into a
 * 16x16-tile atlas (256x256). Tiles are drawn at the indices declared in
 * blocks.js so the atlas stays in sync with the registry. Also exposes helpers
 * to extract a single tile as a data URL for the HTML hotbar icons.
 */
(function (global) {
  "use strict";

  const Blocks = global.Blocks;
  const mulberry32 = global.mulberry32;
  const TILE = 16;
  const COLS = Blocks.ATLAS_COLS;

  function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

  function Painter(ctx, x0, y0, rng) {
    this.ctx = ctx; this.x0 = x0; this.y0 = y0; this.rng = rng;
  }
  Painter.prototype.px = function (x, y, r, g, b, a) {
    this.ctx.fillStyle = "rgba(" + clamp(r) + "," + clamp(g) + "," + clamp(b) + "," + (a === undefined ? 1 : a) + ")";
    this.ctx.fillRect(this.x0 + x, this.y0 + y, 1, 1);
  };
  // Fill the whole tile with a base colour plus per-pixel brightness noise.
  Painter.prototype.noisy = function (base, variance, a) {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const d = (this.rng() * 2 - 1) * variance;
        this.px(x, y, base[0] + d, base[1] + d, base[2] + d, a);
      }
    }
  };

  // Per-tile generators keyed by atlas tile name.
  const GEN = {
    grass_top(p) { p.noisy([86, 142, 62], 24); },
    grass_side(p) {
      p.noisy([134, 96, 62], 20); // dirt base
      for (let x = 0; x < TILE; x++) {
        const h = 3 + Math.floor(p.rng() * 2); // jagged grass fringe at top
        for (let y = 0; y < h; y++) { const d = (p.rng() * 2 - 1) * 22; p.px(x, y, 86 + d, 142 + d, 62 + d); }
      }
    },
    dirt(p) { p.noisy([134, 96, 62], 22); },
    stone(p) { p.noisy([130, 130, 132], 18); },
    cobblestone(p) {
      p.noisy([120, 120, 122], 14);
      for (let i = 0; i < 22; i++) { const x = (p.rng() * TILE) | 0, y = (p.rng() * TILE) | 0; p.px(x, y, 70, 70, 74); }
    },
    log_top(p) {
      p.noisy([150, 110, 66], 12);
      const cx = 7.5, cy = 7.5;
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const r = Math.hypot(x - cx, y - cy);
        if ((Math.round(r) % 2) === 0) { const d = -18; p.px(x, y, 150 + d, 110 + d, 66 + d); }
      }
    },
    log_side(p) {
      p.noisy([110, 78, 46], 16);
      for (let x = 2; x < TILE; x += 5) for (let y = 0; y < TILE; y++) { const d = -22 + (p.rng() * 8); p.px(x, y, 110 + d, 78 + d, 46 + d); }
    },
    leaves(p) {
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        if (p.rng() < 0.16) { p.px(x, y, 0, 0, 0, 0); continue; } // transparent gaps (alpha cutout)
        const d = (p.rng() * 2 - 1) * 30;
        p.px(x, y, 58 + d, 110 + d, 48 + d);
      }
    },
    sand(p) { p.noisy([218, 205, 150], 16); },
    water(p) {
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const d = (p.rng() * 2 - 1) * 14;
        p.px(x, y, 38 + d, 96 + d, 205 + d, 0.66);
      }
    },
    planks(p) {
      p.noisy([164, 124, 76], 14);
      for (let y = 0; y < TILE; y += 4) for (let x = 0; x < TILE; x++) p.px(x, y, 120, 88, 52);
      for (let y = 0; y < TILE; y++) { p.px((y < 8 ? 7 : 12), y, 120, 88, 52); }
    },
    glass(p) {
      // transparent centre (alpha cutout) with an opaque pale frame + highlight
      for (let i = 0; i < TILE; i++) { p.px(i, 0, 198, 224, 232); p.px(i, 15, 198, 224, 232); p.px(0, i, 198, 224, 232); p.px(15, i, 198, 224, 232); }
      for (let i = 1; i < 7; i++) p.px(i, i, 224, 244, 250);
    },
    brick(p) {
      p.noisy([170, 74, 56], 12);
      for (let y = 0; y < TILE; y += 4) for (let x = 0; x < TILE; x++) p.px(x, y, 200, 200, 196); // mortar rows
      for (let y = 0; y < TILE; y++) { const off = (Math.floor(y / 4) % 2) * 4; p.px((off + 7) % TILE, y, 200, 200, 196); }
    },
    bedrock(p) {
      p.noisy([74, 74, 78], 26);
      for (let i = 0; i < 18; i++) { const x = (p.rng() * TILE) | 0, y = (p.rng() * TILE) | 0; p.px(x, y, 30, 30, 32); }
    },
    snow(p) { p.noisy([236, 240, 248], 10); },
    gravel(p) {
      p.noisy([120, 112, 108], 22);
      for (let i = 0; i < 16; i++) { const x = (p.rng() * TILE) | 0, y = (p.rng() * TILE) | 0; p.px(x, y, 80, 74, 70); }
    },
    coal_ore(p) { ore(p, [30, 30, 32]); },
    iron_ore(p) { ore(p, [200, 170, 140]); },
    gold_ore(p) { ore(p, [240, 200, 70]); },
    diamond_ore(p) { ore(p, [110, 220, 220]); },
    chest(p) {
      p.noisy([150, 110, 60], 12);
      for (let x = 0; x < 16; x++) { p.px(x, 7, 90, 62, 30); p.px(x, 8, 90, 62, 30); }
      for (let y = 0; y < 16; y++) { p.px(0, y, 90, 62, 30); p.px(15, y, 90, 62, 30); }
      p.px(7, 7, 70, 70, 72); p.px(8, 7, 70, 70, 72); p.px(7, 8, 70, 70, 72); p.px(8, 8, 70, 70, 72);
    },
    craft_top(p) {
      p.noisy([164, 124, 76], 10);
      for (let i = 0; i < 16; i++) { p.px(i, 5, 110, 80, 46); p.px(i, 10, 110, 80, 46); p.px(5, i, 110, 80, 46); p.px(10, i, 110, 80, 46); }
    },
    craft_side(p) {
      p.noisy([150, 112, 68], 10);
      for (let y = 0; y < 16; y += 4) for (let x = 0; x < 16; x++) p.px(x, y, 110, 80, 46);
      for (let x = 2; x < 14; x += 2) p.px(x, 3, 90, 90, 92);
    },
    furnace_side(p) {
      p.noisy([120, 120, 122], 14);
      for (let i = 0; i < 18; i++) { const x = (p.rng() * 16) | 0, y = (p.rng() * 16) | 0; p.px(x, y, 80, 80, 84); }
    },
    furnace_top(p) {
      p.noisy([120, 120, 122], 12);
      for (let x = 5; x < 11; x++) for (let y = 5; y < 11; y++) p.px(x, y, 60, 60, 64);
      for (let x = 6; x < 10; x++) for (let y = 6; y < 10; y++) p.px(x, y, 30, 30, 34);
    },
    furnace_front(p) {
      p.noisy([120, 120, 122], 12);
      for (let x = 4; x < 12; x++) for (let y = 7; y < 14; y++) p.px(x, y, 30, 28, 26);
      for (let x = 5; x < 11; x++) p.px(x, 6, 44, 42, 40);
      for (let x = 4; x < 12; x++) p.px(x, 4, 80, 80, 84);
    },
    furnace_lit(p) {
      p.noisy([120, 120, 122], 12);
      for (let x = 4; x < 12; x++) for (let y = 7; y < 14; y++) { const g = (p.rng() * 60) | 0; p.px(x, y, 235, 120 + g, 30); }
      for (let x = 5; x < 11; x++) p.px(x, 6, 255, 205, 90);
      for (let x = 4; x < 12; x++) p.px(x, 4, 80, 80, 84);
    },
    door(p) {
      p.noisy([150, 110, 66], 8);
      for (let y = 0; y < 16; y++) { p.px(0, y, 100, 72, 36); p.px(15, y, 100, 72, 36); }
      for (let x = 3; x < 13; x++) { p.px(x, 2, 110, 80, 42); p.px(x, 7, 110, 80, 42); p.px(x, 13, 110, 80, 42); }
      for (let y = 2; y <= 13; y++) { p.px(3, y, 110, 80, 42); p.px(12, y, 110, 80, 42); }
      p.px(11, 9, 60, 60, 62); p.px(11, 10, 60, 60, 62);
    },
    door_open(p) {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        if (x < 3) { const d = (p.rng() * 2 - 1) * 10; p.px(x, y, 150 + d, 110 + d, 66 + d); }
        else p.px(x, y, 0, 0, 0, 0); // transparent (alpha cutout) -> open doorway
      }
    },
  };

  function ore(p, speck) {
    p.noisy([130, 130, 132], 18); // stone base
    for (let i = 0; i < 10; i++) {
      const x = 1 + ((p.rng() * (TILE - 2)) | 0), y = 1 + ((p.rng() * (TILE - 2)) | 0);
      p.px(x, y, speck[0], speck[1], speck[2]);
      p.px(x + 1, y, speck[0], speck[1], speck[2]);
      p.px(x, y + 1, speck[0], speck[1], speck[2]);
    }
  }

  let pack = null; // texture pack: tileName -> "#rgb" | {color} | {pixels:[256]}
  function setPack(map) { pack = map || null; }

  function hexRGB(h) {
    h = (h || "#000").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function drawSpec(p, spec) {
    if (typeof spec === "string") spec = { color: spec };
    if (spec.pixels) { for (let i = 0; i < 256 && i < spec.pixels.length; i++) { if (spec.pixels[i]) { const c = hexRGB(spec.pixels[i]); p.px(i % 16, (i / 16) | 0, c[0], c[1], c[2]); } } }
    else { const c = hexRGB(spec.color); p.noisy(c, 12); }
  }

  function buildAtlas() {
    const canvas = document.createElement("canvas");
    canvas.width = COLS * TILE;
    canvas.height = COLS * TILE;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    let seedCounter = 1;
    const extra = Blocks.EXTRA_TILES || {};
    for (const name in Blocks.TILES) {
      const tile = Blocks.TILES[name];
      const col = tile % COLS, row = (tile / COLS) | 0;
      const p = new Painter(ctx, col * TILE, row * TILE, mulberry32(0x9e37 + tile * 2654435761 + seedCounter++));
      const override = (pack && pack[name]) || extra[name]; // texture pack wins, then modded tiles
      if (override) drawSpec(p, override);
      else (GEN[name] || ((pp) => pp.noisy([200, 0, 200], 0)))(p);
    }
    return canvas;
  }

  // Extract one tile as a scaled data URL (used for hotbar icons in HTML).
  function tileDataURL(atlas, tile, size) {
    const col = tile % COLS, row = (tile / COLS) | 0;
    const c = document.createElement("canvas");
    c.width = size; c.height = size;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(atlas, col * TILE, row * TILE, TILE, TILE, 0, 0, size, size);
    return c.toDataURL();
  }

  function iconForBlock(atlas, blockId, size) {
    const b = Blocks.BLOCKS[blockId];
    return tileDataURL(atlas, b.top !== undefined ? b.top : b.side, size);
  }

  global.Textures = { buildAtlas, tileDataURL, iconForBlock, setPack, TILE };
})(typeof window !== "undefined" ? window : globalThis);
