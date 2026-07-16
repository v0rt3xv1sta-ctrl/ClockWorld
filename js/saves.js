/*
 * saves.js — multiple named worlds persisted to a storage backend.
 *
 * A registry maps world id -> metadata { id, name, seed, mode, created,
 * updated }. Each world's full data lives under its own key. Export/import
 * round-trips a world as JSON. The storage backend is injected (localStorage in
 * the browser, a stub in tests).
 */
(function (global) {
  "use strict";

  const REG = "clockworld_worlds";
  const PREFIX = "clockworld_world_";

  function Saves(storage) { this.s = storage; }

  Saves.prototype._readReg = function () {
    try { return JSON.parse(this.s.getItem(REG) || "{}") || {}; }
    catch (e) { return {}; }
  };
  Saves.prototype._writeReg = function (reg) {
    try { this.s.setItem(REG, JSON.stringify(reg)); return true; }
    catch (e) { return false; }
  };

  Saves.prototype.genId = function () {
    return "w" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  };

  // Newest-first list of world metadata.
  Saves.prototype.list = function () {
    const reg = this._readReg();
    return Object.keys(reg).map((k) => reg[k]).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  };

  Saves.prototype.create = function (name, seed, mode) {
    const id = this.genId();
    const now = Date.now();
    const meta = {
      id,
      name: (name || "New World").slice(0, 40),
      seed: seed >>> 0,
      mode: mode === "creative" ? "creative" : "survival",
      created: now,
      updated: now,
    };
    const reg = this._readReg();
    reg[id] = meta;
    this._writeReg(reg);
    this.save(id, { seed: meta.seed, mode: meta.mode, edits: {}, time: 0.3 });
    return meta;
  };

  Saves.prototype.load = function (id) {
    const reg = this._readReg();
    const meta = reg[id];
    if (!meta) return null;
    let data;
    try { data = JSON.parse(this.s.getItem(PREFIX + id) || "null"); }
    catch (e) { data = null; }
    if (!data) data = { seed: meta.seed, mode: meta.mode, edits: {}, time: 0.3 };
    return { meta, data };
  };

  Saves.prototype.save = function (id, data) {
    const reg = this._readReg();
    if (reg[id]) {
      reg[id].updated = Date.now();
      if (data.mode) reg[id].mode = data.mode;
      this._writeReg(reg);
    }
    try { this.s.setItem(PREFIX + id, JSON.stringify(data)); return true; }
    catch (e) { return false; }
  };

  Saves.prototype.rename = function (id, name) {
    const reg = this._readReg();
    if (!reg[id]) return false;
    reg[id].name = (name || reg[id].name).slice(0, 40);
    return this._writeReg(reg);
  };

  Saves.prototype.remove = function (id) {
    const reg = this._readReg();
    delete reg[id];
    this._writeReg(reg);
    try { this.s.removeItem(PREFIX + id); } catch (e) { /* ignore */ }
  };

  Saves.prototype.exportWorld = function (id) {
    const loaded = this.load(id);
    if (!loaded) return null;
    return JSON.stringify({ format: "clockworld", version: 1, meta: loaded.meta, data: loaded.data }, null, 0);
  };

  Saves.prototype.importWorld = function (json) {
    let obj;
    try { obj = JSON.parse(json); } catch (e) { return null; }
    if (!obj || obj.format !== "clockworld" || !obj.data) return null;
    const src = obj.meta || {};
    const meta = this.create(
      (src.name ? src.name + " (imported)" : "Imported World"),
      (src.seed >>> 0) || (obj.data.seed >>> 0) || 1,
      src.mode || obj.data.mode || "survival"
    );
    // overwrite the freshly created blank data with the imported payload
    const data = obj.data;
    data.seed = meta.seed; data.mode = meta.mode;
    this.save(meta.id, data);
    return meta;
  };

  const api = { Saves, REG, PREFIX };
  global.SavesMod = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
