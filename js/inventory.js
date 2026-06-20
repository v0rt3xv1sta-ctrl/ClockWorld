/*
 * inventory.js — a stack-based inventory.
 *
 * Slots are { id, count } or null. The first HOTBAR slots double as the hotbar.
 * Pure data + primitives (add / remove / count / serialize); UI-level cursor
 * swap & merge live in main.js on top of get()/set(). No DOM access, so this is
 * unit-tested under Node.
 */
(function (global) {
  "use strict";

  const Blocks = (typeof module !== "undefined" && module.exports)
    ? require("./blocks.js") : global.Blocks;

  const HOTBAR = 9;

  function Inventory(size) {
    this.size = size || 36; // 9 hotbar + 27 main
    this.slots = new Array(this.size).fill(null);
  }

  Inventory.prototype.get = function (i) { return this.slots[i] || null; };
  Inventory.prototype.set = function (i, stack) {
    this.slots[i] = (stack && stack.count > 0) ? { id: stack.id, count: stack.count } : null;
  };

  // Add `count` of `id`. Returns the amount that did NOT fit.
  Inventory.prototype.add = function (id, count) {
    if (!id || count <= 0) return 0;
    const max = Blocks.maxStackOf(id) || 64;
    // top up existing stacks of the same id first
    for (let i = 0; i < this.size && count > 0; i++) {
      const s = this.slots[i];
      if (s && s.id === id && s.count < max) {
        const room = max - s.count;
        const take = Math.min(room, count);
        s.count += take; count -= take;
      }
    }
    // then fill empty slots
    for (let i = 0; i < this.size && count > 0; i++) {
      if (!this.slots[i]) {
        const take = Math.min(max, count);
        this.slots[i] = { id, count: take };
        count -= take;
      }
    }
    return count;
  };

  // Remove up to `n` from slot `i`. Returns how many were actually removed.
  Inventory.prototype.removeAt = function (i, n) {
    const s = this.slots[i];
    if (!s) return 0;
    const took = Math.min(n === undefined ? s.count : n, s.count);
    s.count -= took;
    if (s.count <= 0) this.slots[i] = null;
    return took;
  };

  Inventory.prototype.countOf = function (id) {
    let n = 0;
    for (let i = 0; i < this.size; i++) {
      const s = this.slots[i];
      if (s && s.id === id) n += s.count;
    }
    return n;
  };

  Inventory.prototype.isEmpty = function () {
    return this.slots.every((s) => !s);
  };

  Inventory.prototype.clear = function () { this.slots = new Array(this.size).fill(null); };

  Inventory.prototype.toJSON = function () {
    return this.slots.map((s) => (s ? [s.id, s.count] : 0));
  };

  Inventory.fromJSON = function (arr, size) {
    const inv = new Inventory(size || (arr ? arr.length : 36));
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length && i < inv.size; i++) {
        const e = arr[i];
        if (Array.isArray(e) && e[0]) inv.slots[i] = { id: e[0], count: e[1] };
      }
    }
    return inv;
  };

  const api = { Inventory, HOTBAR };
  global.InventoryMod = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
