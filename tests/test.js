/* Node unit tests for the dependency-free logic (math, noise, world). */
const assert = require("assert");
const { Vec3, Mat4, dirFromAngles } = require("../js/math.js");
const { Noise } = require("../js/noise.js");
const Blocks = require("../js/blocks.js");
const W = require("../js/world.js");

let passed = 0;
function ok(name) { passed++; console.log("  ok -", name); }
function approx(a, b, eps = 1e-4) { return Math.abs(a - b) <= eps; }

function transformPoint(m, p, w = 1) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] * w,
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13] * w,
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14] * w,
  ];
}

// ---- math ----
(function () {
  const I = Mat4.identity();
  const A = Mat4.perspective(Math.PI / 3, 1.5, 0.1, 100);
  const IA = Mat4.multiply(I, A);
  for (let i = 0; i < 16; i++) assert(approx(IA[i], A[i]), "I*A == A");
  ok("identity is multiplicative unit");

  const d = dirFromAngles(0, 0);
  assert(approx(d[0], 0) && approx(d[1], 0) && approx(d[2], -1), "yaw0 looks -Z");
  ok("dirFromAngles(0,0) == -Z");

  const view = Mat4.lookAt([0, 0, 5], [0, 0, 0], [0, 1, 0]);
  const e = transformPoint(view, [0, 0, 5]);
  assert(approx(e[0], 0) && approx(e[1], 0) && approx(e[2], 0), "eye -> origin");
  const c = transformPoint(view, [0, 0, 0]);
  assert(approx(c[2], -5), "center is in front (-Z)");
  ok("lookAt maps eye->origin, center to -Z");

  const cr = Vec3.cross([1, 0, 0], [0, 1, 0]);
  assert(approx(cr[0], 0) && approx(cr[1], 0) && approx(cr[2], 1), "x cross y == z");
  ok("vec3 cross product");
})();

// ---- noise ----
(function () {
  const n1 = new Noise(1234), n2 = new Noise(1234), n3 = new Noise(9999);
  let same = true, diff = false, inRange = true;
  for (let i = 0; i < 200; i++) {
    const a = n1.perlin2(i * 0.1, i * 0.07);
    const b = n2.perlin2(i * 0.1, i * 0.07);
    const c = n3.perlin2(i * 0.1, i * 0.07);
    if (a !== b) same = false;
    if (a !== c) diff = true;
    if (a < -1.5 || a > 1.5) inRange = false;
  }
  assert(same, "same seed -> same noise");
  assert(diff, "different seed -> different noise");
  assert(inRange, "perlin2 roughly in [-1,1]");
  ok("perlin2 deterministic + bounded");

  let h = n1.hash2(7, 13);
  assert(h >= 0 && h < 1, "hash2 in [0,1)");
  assert(n1.hash2(7, 13) === n1.hash2(7, 13), "hash2 deterministic");
  ok("hash2 range + determinism");
})();

// ---- world generation & blocks ----
(function () {
  const w = new W.World(42);
  const chunk = w.getOrCreateChunk(0, 0);
  assert(w.getBlock(0, 0, 0) === Blocks.ID.BEDROCK, "bedrock at y=0");
  ok("bedrock floor generated");

  // there is solid ground and air above it somewhere in the chunk
  let foundColumn = false;
  for (let x = 0; x < 16 && !foundColumn; x++) {
    for (let z = 0; z < 16 && !foundColumn; z++) {
      const h = w.heightAt(x, z);
      if (Blocks.isSolid(w.getBlock(x, h, z)) && w.getBlock(x, h + 30, z) === 0) foundColumn = true;
    }
  }
  assert(foundColumn, "surface column has solid ground + air above");
  ok("terrain has a sensible surface");

  // set/get round trip + edit persistence
  w.setBlock(3, 70, 3, Blocks.ID.PLANKS);
  assert(w.getBlock(3, 70, 3) === Blocks.ID.PLANKS, "setBlock then getBlock");
  assert(w.edits["3,70,3"] === Blocks.ID.PLANKS, "edit recorded");
  ok("setBlock/getBlock + edit log");
})();

// ---- raycast ----
(function () {
  const w = new W.World(7);
  w.getOrCreateChunk(0, 0);
  w.setBlock(2, 70, 2, Blocks.ID.STONE);
  const down = w.raycast([2.5, 80, 2.5], [0, -1, 0], 30);
  assert(down, "ray hits the placed block");
  assert(down.hit[0] === 2 && down.hit[1] === 70 && down.hit[2] === 2, "hit coords");
  assert(down.normal[1] === 1, "top-face normal");
  assert(down.place[1] === 71, "place position above block");
  ok("raycast down hits block, correct normal/place");

  const miss = w.raycast([2.5, 80, 2.5], [1, 0, 0], 5);
  assert(miss === null, "ray into empty air misses");
  ok("raycast miss returns null");
})();

// ---- meshing ----
(function () {
  const w = new W.World(5);
  const c = new W.Chunk(0, 0);
  w.chunks.set("0,0", c);
  c.data[W.idx(8, 70, 8)] = Blocks.ID.STONE;
  c.maxY = 71;
  const geo = w.buildGeometry(c);
  // isolated block, all neighbours air -> 6 faces
  assert(geo.opaque.data.length === 6 * 4 * 6, "6 faces * 4 verts * 6 floats");
  assert(geo.opaque.indices.length === 6 * 6, "6 faces * 6 indices");
  assert(geo.water.data.length === 0, "no water geometry");
  // every light value within (0,1]
  let lightsOk = true;
  for (let i = 5; i < geo.opaque.data.length; i += 6) {
    const L = geo.opaque.data[i];
    if (L <= 0 || L > 1.001) lightsOk = false;
  }
  assert(lightsOk, "vertex light in (0,1]");
  ok("isolated block meshes to 6 faces with valid lighting");

  // a buried block emits nothing
  const c2 = new W.Chunk(10, 10);
  w.chunks.set("10,10", c2);
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        c2.data[W.idx(8 + dx, 70 + dy, 8 + dz)] = Blocks.ID.STONE;
  c2.maxY = 72;
  const geo2 = w.buildGeometry(c2);
  // center block fully surrounded contributes 0 of its faces; outer shell still emits outward faces
  let centerHidden = true;
  // crude check: total faces less than 27*6 (lots culled internally)
  const faces = geo2.opaque.indices.length / 6;
  assert(faces < 27 * 6, "interior faces culled");
  ok("interior faces are removed (" + faces + " faces for 3x3x3 cube)");
})();

// ---- player physics ----
(function () {
  require("../js/player.js");
  const Player = global.Player;
  const w = new W.World(99);
  w.getOrCreateChunk(0, 0);
  let sy = W.HEIGHT - 1;
  while (sy > 0 && !Blocks.isSolid(w.getBlock(0, sy, 0))) sy--;

  const still = { f: 0, b: 0, l: 0, r: 0, jump: 0, descend: 0, sprint: 0, sneak: 0 };
  const p = new Player([0.5, sy + 6, 0.5]);
  for (let i = 0; i < 240; i++) p.update(1 / 60, w, still);
  assert(p.onGroundPrev, "player ends on ground");
  assert(approx(p.pos[1], sy + 1, 0.25), "feet rest on block top (y=" + p.pos[1].toFixed(2) + ")");
  assert(Math.abs(p.vel[1]) < 0.6, "vertical velocity settled");
  ok("gravity + ground collision");

  // build a wall just east and strafe into it
  p.yaw = 0; // right == +X
  const wallX = Math.floor(p.pos[0]) + 1;
  for (let yy = 0; yy < 3; yy++)
    for (let zz = -1; zz <= 1; zz++)
      w.setBlock(wallX, Math.floor(p.pos[1]) + yy, Math.floor(p.pos[2]) + zz, Blocks.ID.STONE);
  const moveR = { f: 0, b: 0, l: 0, r: 1, jump: 0, descend: 0, sprint: 0, sneak: 0 };
  for (let i = 0; i < 120; i++) p.update(1 / 60, w, moveR);
  assert(p.pos[0] < wallX - Player.HALF + 0.02, "did not pass through wall (x=" + p.pos[0].toFixed(2) + ")");
  assert(p.pos[0] > wallX - Player.HALF - 0.1, "advanced up against wall");
  ok("horizontal collision stops at wall");

  // fly mode: no gravity, ascends on jump (creative flies by default)
  const f = new Player([0.5, sy + 6, 0.5], "creative");
  const up = { f: 0, b: 0, l: 0, r: 0, jump: 1, descend: 0, sprint: 0, sneak: 0 };
  const y0 = f.pos[1];
  for (let i = 0; i < 60; i++) f.update(1 / 60, w, up);
  assert(f.pos[1] > y0 + 2, "fly ascends (dy=" + (f.pos[1] - y0).toFixed(2) + ")");
  ok("fly mode ascends without gravity");

  // look direction: mouse-right turns toward the camera's right (+X), mouse-down looks down
  const look = new Player([0, 70, 0]); // yaw 0 faces -Z
  look.applyMouse(100, 0);
  assert(look.getDir()[0] > 0, "mouse-right turns toward +X (not inverted), dir.x=" + look.getDir()[0].toFixed(2));
  const look2 = new Player([0, 70, 0]);
  look2.applyMouse(0, 100);
  assert(look2.getDir()[1] < 0, "mouse-down looks downward, dir.y=" + look2.getDir()[1].toFixed(2));
  ok("mouse look orientation (yaw not inverted, pitch correct)");

  assert(p.intersectsBlock(Math.floor(p.pos[0]), Math.floor(p.pos[1]), Math.floor(p.pos[2])),
    "AABB intersects own cell (blocks self-placement)");
  ok("intersectsBlock self-placement guard");
})();

// ---- inventory ----
(function () {
  const { Inventory } = require("../js/inventory.js");
  const DIRT = Blocks.ID.DIRT, STONE = Blocks.ID.STONE;
  const inv = new Inventory(36);
  assert(inv.add(DIRT, 100) === 0, "100 dirt fits");
  assert(inv.countOf(DIRT) === 100, "counts 100 dirt");
  assert(inv.get(0).count === 64 && inv.get(1).count === 36, "stacks split at 64");
  inv.add(DIRT, 30);
  assert(inv.countOf(DIRT) === 130 && inv.get(1).count === 64, "tops up existing stack first");
  inv.removeAt(0, 10);
  assert(inv.get(0).count === 54, "removeAt reduces stack");
  ok("inventory add/stack/remove");

  const small = new Inventory(1);
  assert(small.add(STONE, 100) === 100 - 64, "overflow returned when full");
  assert(small.countOf(STONE) === 64, "full slot holds one max stack");
  ok("inventory overflow handling");

  const j = inv.toJSON();
  const inv2 = Inventory.fromJSON(j, 36);
  assert(inv2.countOf(DIRT) === inv.countOf(DIRT), "serialize round-trip");
  ok("inventory serialization");
})();

// ---- saves ----
(function () {
  const { Saves } = require("../js/saves.js");
  const mem = (() => {
    const m = {};
    return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
  })();
  const sv = new Saves(mem);
  const meta = sv.create("Test", 123, "creative");
  assert(meta.id && meta.mode === "creative" && meta.seed === 123, "create returns meta");
  assert(sv.list().length === 1 && sv.list()[0].name === "Test", "world listed");
  const loaded = sv.load(meta.id);
  assert(loaded.data.seed === 123 && loaded.data.mode === "creative", "load returns data");
  loaded.data.edits["1,2,3"] = 5; loaded.data.time = 0.7;
  sv.save(meta.id, loaded.data);
  assert(sv.load(meta.id).data.edits["1,2,3"] === 5, "edits persisted");
  sv.rename(meta.id, "Renamed");
  assert(sv.load(meta.id).meta.name === "Renamed", "rename works");
  ok("saves create/load/save/rename");

  const json = sv.exportWorld(meta.id);
  const imp = sv.importWorld(json);
  assert(imp && imp.id !== meta.id, "import creates a new world");
  assert(sv.list().length === 2, "two worlds after import");
  assert(sv.load(imp.id).data.edits["1,2,3"] === 5, "imported edits carried over");
  assert(sv.importWorld("garbage") === null, "bad import rejected");
  sv.remove(meta.id);
  assert(sv.list().length === 1 && !sv.load(meta.id), "remove deletes world");
  ok("saves export/import/remove");
})();

// ---- modes, health & damage ----
(function () {
  const Player = global.Player;
  const w = new W.World(321);
  w.getOrCreateChunk(0, 0);
  let sy = W.HEIGHT - 1;
  while (sy > 0 && !Blocks.isSolid(w.getBlock(0, sy, 0))) sy--;
  const still = { f: 0, b: 0, l: 0, r: 0, jump: 0, descend: 0, sprint: 0, sneak: 0 };

  // survival fall damage
  const sp = new Player([0.5, sy + 25, 0.5], "survival");
  assert(!sp.flying, "survival starts grounded (not flying)");
  for (let i = 0; i < 400; i++) sp.update(1 / 60, w, still);
  assert(sp.health < sp.maxHealth, "survival took fall damage (hp=" + sp.health + ")");
  ok("survival fall damage on big drop");

  // creative invulnerability + flying default
  const cp = new Player([0.5, sy + 25, 0.5], "creative");
  assert(cp.flying, "creative starts flying");
  cp.flying = false; // drop it
  for (let i = 0; i < 400; i++) cp.update(1 / 60, w, still);
  assert(cp.health === cp.maxHealth, "creative immune to fall damage");
  ok("creative invulnerability");

  // drowning: submerge the head and drain air -> damage
  const dp = new Player([0.5, sy + 1, 0.5], "survival");
  for (let y = sy + 1; y <= sy + 6; y++) w.setBlock(0, y, 0, Blocks.ID.WATER);
  for (let i = 0; i < 60 * 20; i++) dp.update(1 / 60, w, still); // 20s underwater
  assert(dp.air === 0, "air depleted underwater");
  assert(dp.health < dp.maxHealth, "drowning dealt damage (hp=" + dp.health + ")");
  ok("survival drowning");

  // mode switch disables flying
  const mp = new Player([0.5, sy + 5, 0.5], "creative");
  mp.setMode("survival");
  assert(!mp.creative && !mp.flying, "switching to survival disables fly");
  mp.toggleFly();
  assert(!mp.flying, "cannot fly in survival");
  ok("mode switching");

  // death + respawn
  const xp = new Player([0.5, sy + 5, 0.5], "survival");
  xp.hurt(100);
  assert(xp.dead && xp.health === 0, "lethal damage kills");
  xp.respawn([0.5, sy + 3, 0.5]);
  assert(!xp.dead && xp.health === xp.maxHealth, "respawn restores health");
  ok("death and respawn");
})();

// ---- water physics: swimming out ----
(function () {
  const Player = global.Player;
  const w = new W.World(555);
  w.getOrCreateChunk(0, 0);
  // carve a pool with a bank one block above the water surface
  for (let x = -1; x <= 6; x++) for (let z = -1; z <= 1; z++) for (let y = 63; y <= 76; y++) w.setBlock(x, y, z, Blocks.ID.AIR);
  for (let x = -1; x <= 6; x++) for (let z = -1; z <= 1; z++) w.setBlock(x, 63, z, Blocks.ID.STONE);
  for (let x = 0; x <= 2; x++) for (let z = -1; z <= 1; z++) for (let y = 64; y <= 67; y++) w.setBlock(x, y, z, Blocks.ID.WATER);
  for (let x = 3; x <= 6; x++) for (let z = -1; z <= 1; z++) for (let y = 64; y <= 67; y++) w.setBlock(x, y, z, Blocks.ID.STONE); // shoreline at water level (top = 68)

  const p = new Player([1.0, 64.2, 1.0], "survival");
  p.yaw = -Math.PI / 2; // makes forward point toward +X (the bank)
  const swim = { f: 1, b: 0, l: 0, r: 0, jump: 1, descend: 0, sprint: 0, sneak: 0 };
  let everInWater = false, onBank = false;
  for (let i = 0; i < 600 && !onBank; i++) {
    p.update(1 / 60, w, swim);
    if (p.inWater) everInWater = true;
    if (!p.inWater && p.onGroundPrev && p.pos[0] > 3.2 && p.pos[1] > 67.4) onBank = true;
  }
  assert(everInWater, "player was swimming at some point");
  assert(onBank, "climbed out of the water and stood on the bank (x=" + p.pos[0].toFixed(2) + ", y=" + p.pos[1].toFixed(2) + ")");
  ok("water physics: can swim up and climb out onto a higher bank");
})();

console.log("\nAll " + passed + " test groups passed.");
