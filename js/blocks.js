/*
 * blocks.js — block type registry and atlas tile layout.
 *
 * Kept deliberately free of any DOM/canvas access so the world logic that
 * depends on it can be unit-tested under Node. textures.js draws each tile at
 * the index named here, keeping the atlas and the registry in sync.
 */
(function (global) {
  "use strict";

  const ATLAS_COLS = 16; // tiles per row/column in the texture atlas

  // Named atlas tiles -> tile index (col = i % COLS, row = floor(i / COLS)).
  const TILES = {
    grass_top: 0,
    grass_side: 1,
    dirt: 2,
    stone: 3,
    cobblestone: 4,
    log_top: 5,
    log_side: 6,
    leaves: 7,
    sand: 8,
    water: 9,
    planks: 10,
    glass: 11,
    brick: 12,
    bedrock: 13,
    snow: 14,
    gravel: 15,
    coal_ore: 16,
    iron_ore: 17,
    gold_ore: 18,
    diamond_ore: 19,
  };

  // Block ids.
  const AIR = 0, GRASS = 1, DIRT = 2, STONE = 3, COBBLE = 4, LOG = 5,
    LEAVES = 6, SAND = 7, WATER = 8, PLANKS = 9, GLASS = 10, BRICK = 11,
    BEDROCK = 12, SNOW = 13, GRAVEL = 14, COAL_ORE = 15, IRON_ORE = 16,
    GOLD_ORE = 17, DIAMOND_ORE = 18;

  const ID = {
    AIR, GRASS, DIRT, STONE, COBBLE, LOG, LEAVES, SAND, WATER, PLANKS,
    GLASS, BRICK, BEDROCK, SNOW, GRAVEL, COAL_ORE, IRON_ORE, GOLD_ORE, DIAMOND_ORE,
  };

  function def(id, name, opts) {
    opts = opts || {};
    const side = opts.side !== undefined ? opts.side : TILES[name.toLowerCase()];
    return {
      id,
      name,
      top: opts.top !== undefined ? opts.top : side,
      bottom: opts.bottom !== undefined ? opts.bottom : side,
      side,
      solid: opts.solid !== undefined ? opts.solid : true,
      opaque: opts.opaque !== undefined ? opts.opaque : true,
      liquid: !!opts.liquid,
      // cullSelf: hide the shared face between two identical non-opaque blocks
      cullSelf: opts.cullSelf !== undefined ? opts.cullSelf : true,
    };
  }

  // Indexed by block id.
  const BLOCKS = [];
  BLOCKS[AIR] = { id: AIR, name: "Air", solid: false, opaque: false, liquid: false };
  BLOCKS[GRASS] = def(GRASS, "Grass", { top: TILES.grass_top, side: TILES.grass_side, bottom: TILES.dirt });
  BLOCKS[DIRT] = def(DIRT, "Dirt", { side: TILES.dirt });
  BLOCKS[STONE] = def(STONE, "Stone", { side: TILES.stone });
  BLOCKS[COBBLE] = def(COBBLE, "Cobblestone", { side: TILES.cobblestone });
  BLOCKS[LOG] = def(LOG, "Wood Log", { top: TILES.log_top, bottom: TILES.log_top, side: TILES.log_side });
  BLOCKS[LEAVES] = def(LEAVES, "Leaves", { side: TILES.leaves, opaque: false, cullSelf: false });
  BLOCKS[SAND] = def(SAND, "Sand", { side: TILES.sand });
  BLOCKS[WATER] = def(WATER, "Water", { side: TILES.water, solid: false, opaque: false, liquid: true });
  BLOCKS[PLANKS] = def(PLANKS, "Planks", { side: TILES.planks });
  BLOCKS[GLASS] = def(GLASS, "Glass", { side: TILES.glass, opaque: false, cullSelf: true });
  BLOCKS[BRICK] = def(BRICK, "Bricks", { side: TILES.brick });
  BLOCKS[BEDROCK] = def(BEDROCK, "Bedrock", { side: TILES.bedrock });
  BLOCKS[SNOW] = def(SNOW, "Snow", { side: TILES.snow });
  BLOCKS[GRAVEL] = def(GRAVEL, "Gravel", { side: TILES.gravel });
  BLOCKS[COAL_ORE] = def(COAL_ORE, "Coal Ore", { side: TILES.coal_ore });
  BLOCKS[IRON_ORE] = def(IRON_ORE, "Iron Ore", { side: TILES.iron_ore });
  BLOCKS[GOLD_ORE] = def(GOLD_ORE, "Gold Ore", { side: TILES.gold_ore });
  BLOCKS[DIAMOND_ORE] = def(DIAMOND_ORE, "Diamond Ore", { side: TILES.diamond_ore });

  function isOpaque(id) { const b = BLOCKS[id]; return b ? b.opaque : false; }
  function isSolid(id) { const b = BLOCKS[id]; return b ? b.solid : false; }
  function isLiquid(id) { const b = BLOCKS[id]; return b ? b.liquid : false; }

  // Default hotbar contents (block ids).
  const HOTBAR = [GRASS, DIRT, STONE, COBBLE, LOG, PLANKS, LEAVES, GLASS, SAND];

  const api = { ATLAS_COLS, TILES, ID, BLOCKS, HOTBAR, isOpaque, isSolid, isLiquid };
  global.Blocks = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
