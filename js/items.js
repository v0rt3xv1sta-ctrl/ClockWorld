/*
 * items.js — registry for items, unifying blocks and non-block items.
 *
 * Ids 1..255 are blocks (see blocks.js); ids >= 256 are items (materials, food).
 * Provides name/stack/placeable/food/fuel/smelt lookups over both, plus
 * procedurally-drawn icons for non-block items. No DOM needed for the logic, so
 * the lookups are unit-testable under Node (icon drawing is browser-only).
 */
(function (global) {
  "use strict";

  const Blocks = (typeof module !== "undefined" && module.exports)
    ? require("./blocks.js") : global.Blocks;

  const ITEM = {
    STICK: 256, COAL: 257, CHARCOAL: 258, IRON_INGOT: 259, GOLD_INGOT: 260,
    DIAMOND: 261, APPLE: 262, BREAD: 263, GOLDEN_APPLE: 264, WHEAT: 265,
  };

  const META = {};
  function item(id, name, opts) { META[id] = Object.assign({ name, maxStack: 64 }, opts || {}); }
  item(ITEM.STICK, "Stick", { fuel: 0.5 });
  item(ITEM.COAL, "Coal", { fuel: 8 });
  item(ITEM.CHARCOAL, "Charcoal", { fuel: 8 });
  item(ITEM.IRON_INGOT, "Iron Ingot");
  item(ITEM.GOLD_INGOT, "Gold Ingot");
  item(ITEM.DIAMOND, "Diamond");
  item(ITEM.APPLE, "Apple", { food: 4, sat: 2 });
  item(ITEM.BREAD, "Bread", { food: 6, sat: 4 });
  item(ITEM.GOLDEN_APPLE, "Golden Apple", { food: 8, sat: 8, heal: 8 });
  item(ITEM.WHEAT, "Wheat");

  function isBlock(id) { return id > 0 && id < 256 && !!Blocks.BLOCKS[id]; }
  function exists(id) { return isBlock(id) || !!META[id]; }
  function name(id) { return isBlock(id) ? Blocks.BLOCKS[id].name : (META[id] ? META[id].name : "?"); }
  function maxStack(id) { return isBlock(id) ? Blocks.maxStackOf(id) : (META[id] ? META[id].maxStack : 64); }
  // water sources are placeable (creative palette); flowing cells are sim-only
  function isPlaceable(id) { return isBlock(id) && id !== Blocks.ID.AIR && id < Blocks.FLOW_BASE; }
  function isFood(id) { return !!(META[id] && META[id].food); }
  function food(id) { const m = META[id]; return (m && m.food) ? { hunger: m.food, sat: m.sat || 0, heal: m.heal || 0 } : null; }
  function fuelTime(id) {
    if (isBlock(id)) return (id === Blocks.ID.PLANKS || id === Blocks.ID.LOG) ? 1.5 : 0;
    return META[id] && META[id].fuel ? META[id].fuel : 0;
  }

  const SMELT = {};
  SMELT[Blocks.ID.IRON_ORE] = ITEM.IRON_INGOT;
  SMELT[Blocks.ID.GOLD_ORE] = ITEM.GOLD_INGOT;
  SMELT[Blocks.ID.SAND] = Blocks.ID.GLASS;
  SMELT[Blocks.ID.COBBLE] = Blocks.ID.STONE;
  SMELT[Blocks.ID.LOG] = ITEM.CHARCOAL;
  function smeltResult(id) { return SMELT[id] || 0; }

  // ---- modding: register new items at runtime (ids 266+) ----
  const MOD_ICONS = {};
  let nextItemId = 266;
  function defineItem(spec) {
    spec = spec || {};
    const id = spec.id || nextItemId++;
    if (id >= nextItemId) nextItemId = id + 1;
    META[id] = { name: spec.name || ("Item " + id), maxStack: spec.stack || 64, food: spec.food, sat: spec.sat, heal: spec.heal, fuel: spec.fuel };
    MOD_ICONS[id] = spec.pixels ? { pixels: spec.pixels } : { color: spec.color || "#cccccc" };
    if (spec.smeltFrom) SMELT[spec.smeltFrom] = id;
    return id;
  }

  // ---- icons (browser only) ----
  const iconCache = {};
  function iconURL(id, atlas) {
    if (isBlock(id)) return global.Textures.iconForBlock(atlas, id, 48);
    if (iconCache[id]) return iconCache[id];
    return (iconCache[id] = drawItem(id));
  }

  function drawItem(id) {
    const c = document.createElement("canvas"); c.width = c.height = 16;
    const x = c.getContext("2d");
    const rect = (px, py, w, h, col) => { x.fillStyle = col; x.fillRect(px, py, w, h); };
    const mi = MOD_ICONS[id];
    if (mi) {
      if (mi.pixels) { for (let i = 0; i < 256; i++) { if (mi.pixels[i]) rect(i % 16, (i / 16) | 0, 1, 1, mi.pixels[i]); } }
      else rect(3, 3, 10, 10, mi.color);
      return c.toDataURL();
    }
    switch (id) {
      case ITEM.STICK:
        for (let i = 0; i < 7; i++) rect(10 - i, 3 + i, 2, 2, "#7a5326"); break;
      case ITEM.COAL: rect(4, 4, 8, 8, "#222"); rect(6, 6, 3, 2, "#444"); break;
      case ITEM.CHARCOAL: rect(4, 4, 8, 8, "#3a352f"); rect(6, 6, 3, 2, "#555"); break;
      case ITEM.IRON_INGOT: rect(3, 6, 10, 5, "#d8d8da"); rect(3, 6, 10, 1, "#fff"); rect(3, 10, 10, 1, "#9a9a9c"); break;
      case ITEM.GOLD_INGOT: rect(3, 6, 10, 5, "#f2c640"); rect(3, 6, 10, 1, "#ffe98a"); rect(3, 10, 10, 1, "#b88a18"); break;
      case ITEM.DIAMOND:
        x.fillStyle = "#5fe3e0"; x.beginPath(); x.moveTo(8, 2); x.lineTo(14, 8); x.lineTo(8, 14); x.lineTo(2, 8); x.closePath(); x.fill();
        rect(7, 5, 2, 2, "#bffcfb"); break;
      case ITEM.APPLE:
        x.fillStyle = "#d63a2f"; x.beginPath(); x.arc(8, 9, 5, 0, 7); x.fill();
        rect(8, 2, 1, 3, "#6a4322"); rect(9, 3, 3, 2, "#4caf50"); rect(6, 6, 2, 2, "#ff8a7a"); break;
      case ITEM.BREAD:
        x.fillStyle = "#c98a3c"; x.beginPath(); x.ellipse(8, 8, 6, 4, 0, 0, 7); x.fill();
        rect(5, 6, 2, 1, "#8a5a1e"); rect(8, 6, 2, 1, "#8a5a1e"); break;
      case ITEM.GOLDEN_APPLE:
        x.fillStyle = "#f2c640"; x.beginPath(); x.arc(8, 9, 5, 0, 7); x.fill();
        rect(8, 2, 1, 3, "#6a4322"); rect(9, 3, 3, 2, "#9bf08a"); rect(6, 6, 2, 2, "#fff0a0"); break;
      case ITEM.WHEAT:
        rect(7, 3, 2, 11, "#caa83a");
        for (let i = 0; i < 5; i++) { rect(5, 4 + i * 2, 2, 1, "#e3c552"); rect(9, 4 + i * 2, 2, 1, "#e3c552"); } break;
      default: rect(3, 3, 10, 10, "#c0c"); break;
    }
    return c.toDataURL();
  }

  const api = { ITEM, META, isBlock, exists, name, maxStack, isPlaceable, isFood, food, fuelTime, smeltResult, iconURL, SMELT, defineItem, MOD_ICONS };
  global.Items = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
