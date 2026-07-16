/*
 * liquids.js — cellular water flow simulation.
 *
 * WATER (id 8) is a still, infinite source. Flowing cells (FLOW_BASE+1..7)
 * carry a depth level: falling water is level 7, horizontal spread loses one
 * level per block and dies at 0, and water prefers to fall before it spreads
 * sideways — dig a trench next to a lake and it pours in, remove the source
 * and the flow drains away. Change-driven: nothing ticks until a block edit
 * disturbs a cell, so still oceans cost nothing.
 *
 * No DOM access — unit-testable under Node like world.js.
 */
(function (global) {
  "use strict";

  const Blocks = (typeof module !== "undefined" && module.exports)
    ? require("./blocks.js") : global.Blocks;

  const ID = Blocks.ID;
  const FLOW_BASE = Blocks.FLOW_BASE;
  const level = Blocks.liquidLevel;

  const TICK = 0.18;       // seconds between flow steps
  const BUDGET = 600;      // max cell updates per step (spread across frames)
  const MAX_QUEUE = 40000; // hard cap so a griefed ocean can't eat the heap

  const H4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function LiquidSim(world) {
    this.world = world;
    this.queue = [];
    this.queued = new Set();
    this.acc = 0;
  }

  LiquidSim.prototype.schedule = function (x, y, z) {
    if (this.queue.length >= MAX_QUEUE) return;
    const k = x + "," + y + "," + z;
    if (this.queued.has(k)) return;
    this.queued.add(k);
    this.queue.push([x, y, z]);
  };

  // Wake a cell and everything that could flow into/out of it.
  LiquidSim.prototype.disturb = function (x, y, z) {
    this.schedule(x, y, z);
    this.schedule(x, y + 1, z);
    this.schedule(x, y - 1, z);
    for (const [dx, dz] of H4) this.schedule(x + dx, y, z + dz);
  };

  LiquidSim.prototype.pending = function () { return this.queue.length; };

  LiquidSim.prototype.step = function (dt) {
    this.acc += dt;
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.tick();
    }
  };

  // One flow generation: process the current wave of cells; changes wake
  // their neighbours into the next wave.
  LiquidSim.prototype.tick = function () {
    if (!this.queue.length) return;
    const wave = this.queue;
    this.queue = [];
    this.queued.clear();
    const n = Math.min(wave.length, BUDGET);
    for (let i = 0; i < n; i++) this.updateCell(wave[i][0], wave[i][1], wave[i][2]);
    // anything over budget carries into the next tick
    for (let i = n; i < wave.length; i++) this.schedule(wave[i][0], wave[i][1], wave[i][2]);
  };

  // Can water sitting at (x,y,z) spread sideways? Only when it rests on
  // something — solid ground or still water. Cells above flowing water are
  // mid-fall and pour straight down instead.
  LiquidSim.prototype.supported = function (x, y, z) {
    const below = this.world.getBlock(x, y - 1, z);
    return Blocks.isSolid(below) || below === ID.WATER;
  };

  // Recompute what this cell's water level should be from its neighbours.
  LiquidSim.prototype.updateCell = function (x, y, z) {
    const w = this.world;
    if (y < 0) return;
    const id = w.getBlock(x, y, z);
    if (id === ID.WATER) return;                       // sources are permanent
    if (id !== ID.AIR && !Blocks.isLiquid(id)) return; // solids don't flow

    let lvl = 0;
    if (level(w.getBlock(x, y + 1, z)) > 0) {
      lvl = 7; // fed from above: a falling column
    } else {
      for (const [dx, dz] of H4) {
        const nl = level(w.getBlock(x + dx, y, z + dz));
        // a neighbour only spreads sideways if it can't fall from its own cell
        if (nl > 1 && this.supported(x + dx, y, z + dz)) {
          if (nl - 1 > lvl) lvl = nl - 1;
        }
      }
      if (lvl > 7) lvl = 7;
    }

    const curLvl = id === ID.AIR ? 0 : level(id);
    if (lvl === curLvl) return;
    w.setBlock(x, y, z, lvl <= 0 ? ID.AIR : FLOW_BASE + lvl);
    this.disturb(x, y, z);
  };

  // Direction the water at a cell is moving, from the level gradient.
  // Returns [x, z] (unnormalised; zero for still water/sources) — used to
  // push swimmers along with the current.
  function flowVector(world, x, y, z) {
    const L = level(world.getBlock(x, y, z));
    let fx = 0, fz = 0;
    if (L > 0 && L < 8) {
      for (const [dx, dz] of H4) {
        const nid = world.getBlock(x + dx, y, z + dz);
        if (Blocks.isSolid(nid)) continue;
        const nl = level(nid);
        fx += dx * (L - nl);
        fz += dz * (L - nl);
      }
      const m = Math.hypot(fx, fz);
      if (m > 1e-6) { fx /= m; fz /= m; }
    }
    return [fx, fz];
  }

  const api = { LiquidSim, flowVector, TICK };
  global.Liquids = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
