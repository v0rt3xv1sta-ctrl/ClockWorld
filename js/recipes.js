/*
 * recipes.js — crafting recipes and a matcher for the 2x2 / 3x3 grids.
 *
 * Shaped recipes match the minimal bounding box of the grid against a pattern;
 * shapeless recipes match the multiset of ingredients. Crafting consumes one
 * item from every non-empty input slot. Furnace smelting lives in items.js.
 * Pure logic, unit-tested under Node.
 */
(function (global) {
  "use strict";

  const Blocks = (typeof module !== "undefined" && module.exports) ? require("./blocks.js") : global.Blocks;
  const Items = (typeof module !== "undefined" && module.exports) ? require("./items.js") : global.Items;
  const B = Blocks.ID, I = Items.ITEM;

  function pattern(rows, key) {
    return rows.map((r) => Array.prototype.map.call(r, (ch) => (ch === " " ? 0 : key[ch])));
  }

  const SHAPED = [];
  function shaped(result, count, rows, key) {
    const pat = pattern(rows, key);
    SHAPED.push({ result: { id: result, count }, pat, h: pat.length, w: pat[0].length });
  }
  const SHAPELESS = [];
  function shapeless(result, count, ids) {
    const need = {};
    ids.forEach((id) => { need[id] = (need[id] || 0) + 1; });
    SHAPELESS.push({ result: { id: result, count }, need });
  }

  shapeless(B.PLANKS, 4, [B.LOG]);
  shaped(I.STICK, 4, ["P", "P"], { P: B.PLANKS });
  shaped(B.CRAFTING, 1, ["PP", "PP"], { P: B.PLANKS });
  shaped(B.CHEST, 1, ["PPP", "P P", "PPP"], { P: B.PLANKS });
  shaped(B.FURNACE, 1, ["CCC", "C C", "CCC"], { C: B.COBBLE });
  shaped(B.DOOR, 1, ["PP", "PP", "PP"], { P: B.PLANKS });
  shaped(I.BREAD, 1, ["WWW"], { W: I.WHEAT });
  shaped(I.GOLDEN_APPLE, 1, ["GGG", "GAG", "GGG"], { G: I.GOLD_INGOT, A: I.APPLE });

  // grid: flat array length n*n of item ids (0 = empty). Returns {id,count} or null.
  function match(grid, n) {
    // shapeless: compare ingredient multiset
    const counts = {};
    let total = 0;
    for (let i = 0; i < grid.length; i++) { const id = grid[i]; if (id) { counts[id] = (counts[id] || 0) + 1; total++; } }
    if (total === 0) return null;
    for (const r of SHAPELESS) {
      const keys = Object.keys(r.need);
      if (keys.length === Object.keys(counts).length && keys.every((k) => counts[k] === r.need[k])) return r.result;
    }
    // shaped: trim to bounding box, compare to pattern
    let minR = n, maxR = -1, minC = n, maxC = -1;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (grid[r * n + c]) {
      if (r < minR) minR = r; if (r > maxR) maxR = r; if (c < minC) minC = c; if (c > maxC) maxC = c;
    }
    const h = maxR - minR + 1, w = maxC - minC + 1;
    for (const rec of SHAPED) {
      if (rec.h !== h || rec.w !== w) continue;
      let ok = true;
      for (let r = 0; r < h && ok; r++) for (let c = 0; c < w; c++) {
        if ((grid[(minR + r) * n + (minC + c)] || 0) !== (rec.pat[r][c] || 0)) { ok = false; break; }
      }
      if (ok) return rec.result;
    }
    return null;
  }

  const api = { match, SHAPED, SHAPELESS, addShaped: shaped, addShapeless: shapeless };
  global.Recipes = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
