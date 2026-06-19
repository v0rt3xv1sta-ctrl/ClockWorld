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

  // fly mode: no gravity, ascends on jump
  const f = new Player([0.5, sy + 6, 0.5]);
  f.toggleFly();
  const up = { f: 0, b: 0, l: 0, r: 0, jump: 1, descend: 0, sprint: 0, sneak: 0 };
  const y0 = f.pos[1];
  for (let i = 0; i < 60; i++) f.update(1 / 60, w, up);
  assert(f.pos[1] > y0 + 2, "fly ascends (dy=" + (f.pos[1] - y0).toFixed(2) + ")");
  ok("fly mode ascends without gravity");

  assert(p.intersectsBlock(Math.floor(p.pos[0]), Math.floor(p.pos[1]), Math.floor(p.pos[2])),
    "AABB intersects own cell (blocks self-placement)");
  ok("intersectsBlock self-placement guard");
})();

console.log("\nAll " + passed + " test groups passed.");
