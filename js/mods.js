/*
 * mods.js — the ClockWorld modding SDK.
 *
 * Exposes a global `ClockWorld` API that mods use to add blocks, items, recipes
 * and smelting, apply texture packs, and subscribe to game events. Mods are
 * plain JS run as `function(ClockWorld){ ... }` at startup (before the texture
 * atlas is built). The engine calls Mods.emit(event, data) at key moments.
 *
 * Events: "worldStart"{mode,seed}, "blockPlace"{x,y,z,id}, "blockBreak"{x,y,z,id},
 *         "tick"{dt}, "eat"{id}, "playerHurt"{amount}.
 */
(function (global) {
  "use strict";

  const node = (typeof module !== "undefined" && module.exports);
  const Blocks = node ? require("./blocks.js") : global.Blocks;
  const Items = node ? require("./items.js") : global.Items;
  const Recipes = node ? require("./recipes.js") : global.Recipes;

  const handlers = {};
  function on(ev, cb) { (handlers[ev] = handlers[ev] || []).push(cb); }
  function emit(ev, data) {
    const hs = handlers[ev];
    if (!hs) return;
    for (let i = 0; i < hs.length; i++) { try { hs[i](data); } catch (e) { (global.console || console).error("[mod] handler error in " + ev + ":", e.message); } }
  }

  const api = {
    version: 1,
    Blocks, Items, Recipes, ID: Blocks.ID, ITEM: Items.ITEM,
    // content
    defineBlock: (spec) => Blocks.defineBlock(spec),
    defineItem: (spec) => Items.defineItem(spec),
    addRecipe: (r) => {
      if (r.shapeless) Recipes.addShapeless(r.result, r.count || 1, r.shapeless);
      else Recipes.addShaped(r.result, r.count || 1, r.rows, r.key);
    },
    addSmelting: (inputId, outputId) => { Items.SMELT[inputId] = outputId; },
    setTexturePack: (map) => { if (global.Textures && global.Textures.setPack) global.Textures.setPack(map); },
    // events
    on,
    log: function () { (global.console || console).log.apply(null, ["[mod]"].concat([].slice.call(arguments))); },
  };

  function run(code, name) {
    try { new Function("ClockWorld", code)(api); return true; }
    catch (e) { (global.console || console).error("[mod] '" + (name || "?") + "' failed:", e.message); return false; }
  }

  global.Mods = { api, on, emit, run, handlers };
  global.ClockWorld = api;
  if (node) module.exports = global.Mods;
})(typeof window !== "undefined" ? window : globalThis);
