/*
 * furnace.js — furnace smelting state machine (pure logic, unit-tested).
 *
 * State: { input, fuel, output } stacks ({id,count}|null) plus timers
 * { cook, cookNeed, burn, burnMax }. tick() consumes fuel to smelt the input
 * into the output over COOK_TIME seconds. lit() reports whether it's burning.
 */
(function (global) {
  "use strict";

  const Items = (typeof module !== "undefined" && module.exports) ? require("./items.js") : global.Items;
  const COOK_TIME = 6; // seconds per item

  function create() {
    return { input: null, fuel: null, output: null, cook: 0, cookNeed: COOK_TIME, burn: 0, burnMax: 0 };
  }

  function canSmelt(s) {
    if (!s.input || s.input.count <= 0) return false;
    const r = Items.smeltResult(s.input.id);
    if (!r) return false;
    if (!s.output) return true;
    return s.output.id === r && s.output.count < Items.maxStack(r);
  }

  function tick(s, dt) {
    const smeltable = canSmelt(s);
    // light the furnace from fuel if needed and there's something to smelt
    if (s.burn <= 0 && smeltable && s.fuel && s.fuel.count > 0) {
      const ft = Items.fuelTime(s.fuel.id);
      if (ft > 0) {
        s.burn = ft; s.burnMax = ft;
        s.fuel.count--; if (s.fuel.count <= 0) s.fuel = null;
      }
    }
    if (s.burn > 0) {
      s.burn -= dt;
      if (s.burn < 0) s.burn = 0;
      if (smeltable) {
        s.cook += dt;
        if (s.cook >= COOK_TIME) {
          s.cook -= COOK_TIME;
          const r = Items.smeltResult(s.input.id);
          if (!s.output) s.output = { id: r, count: 1 }; else s.output.count++;
          s.input.count--; if (s.input.count <= 0) s.input = null;
        }
      } else {
        s.cook = 0;
      }
    } else {
      s.cook = 0;
    }
    s.cookNeed = COOK_TIME;
    return s;
  }

  function lit(s) { return s.burn > 0; }

  const api = { create, tick, lit, canSmelt, COOK_TIME };
  global.Furnace = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
