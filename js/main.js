/*
 * main.js — game bootstrap and loop.
 *
 * Owns the DOM, input, chunk streaming around the player, the day/night cycle,
 * the hotbar/HUD, block break & place, and localStorage save/load. All the
 * heavy lifting lives in the other modules; this file just orchestrates them.
 */
(function () {
  "use strict";

  const FOV = 70 * Math.PI / 180;
  const RENDER_DIST = 8;     // chunks streamed around the player
  const INIT_DIST = 4;       // chunks generated up-front at spawn
  const REACH = 6;           // block interaction distance
  const DAY_LENGTH = 600;    // seconds for a full day/night cycle
  const GEN_PER_FRAME = 2;
  const MESH_PER_FRAME = 3;
  const SAVE_KEY = "clockworld_save_v1";

  const W = window.WorldMod;
  const ID = window.Blocks.ID;
  const Blocks = window.Blocks;

  // ---- DOM ----
  const canvas = document.getElementById("game");
  const overlay = document.getElementById("overlay");
  const hud = document.getElementById("hud");
  const hotbarEl = document.getElementById("hotbar");
  const statusEl = document.getElementById("status");

  let renderer, atlas, world, player;
  let time = 0.3, timeFrozen = false;
  let locked = false;
  let hotbarBlocks, selectedIndex = 0;
  const iconCache = {};

  // chunk offsets within RENDER_DIST, sorted nearest-first
  const OFFSETS = [];
  for (let dx = -RENDER_DIST; dx <= RENDER_DIST; dx++)
    for (let dz = -RENDER_DIST; dz <= RENDER_DIST; dz++)
      if (dx * dx + dz * dz <= RENDER_DIST * RENDER_DIST) OFFSETS.push([dx, dz]);
  OFFSETS.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));

  // ---------------------------------------------------------------- init
  function init() {
    try {
      renderer = new window.Renderer(canvas);
    } catch (e) {
      overlay.querySelector(".card").innerHTML =
        "<h1>ClockWorld</h1><p class='tagline'>" + e.message +
        "</p><p class='tagline'>This game needs a browser with WebGL support.</p>";
      return;
    }
    atlas = window.Textures.buildAtlas();
    renderer.setAtlas(atlas);

    const saved = loadSave();
    const seed = saved ? saved.seed : (Math.random() * 1e9) >>> 0;
    world = new W.World(seed);
    if (saved && saved.edits) world.edits = saved.edits;

    hotbarBlocks = saved && saved.hotbar ? saved.hotbar.slice() : Blocks.HOTBAR.slice();
    selectedIndex = saved && saved.selected ? saved.selected : 0;
    time = saved && saved.time !== undefined ? saved.time : 0.3;

    let spawn;
    if (saved && saved.player) {
      spawn = saved.player.pos.slice();
    } else {
      world.getOrCreateChunk(0, 0);
      let sy = W.HEIGHT - 1;
      while (sy > 0 && !Blocks.isSolid(world.getBlock(0, sy, 0))) sy--;
      spawn = [0.5, sy + 1.2, 0.5];
    }
    player = new window.Player(spawn);
    if (saved && saved.player) {
      player.yaw = saved.player.yaw || 0;
      player.pitch = saved.player.pitch || 0;
      player.flying = !!saved.player.flying;
    }

    buildHotbarDOM();
    renderHotbar();
    generateInitialArea();
    wireInput();

    setInterval(save, 10000);
    window.addEventListener("beforeunload", save);

    last = performance.now();
    requestAnimationFrame(frame);
  }

  function generateInitialArea() {
    const pcx = Math.floor(player.pos[0] / W.SX), pcz = Math.floor(player.pos[2] / W.SZ);
    const created = [];
    for (const [dx, dz] of OFFSETS) {
      if (dx * dx + dz * dz > INIT_DIST * INIT_DIST) continue;
      created.push(world.getOrCreateChunk(pcx + dx, pcz + dz));
    }
    for (const c of created) {
      renderer.uploadChunk(c.cx + "," + c.cz, world.buildGeometry(c));
      c.dirty = false;
    }
  }

  // ---------------------------------------------------------------- streaming
  function manageWorld() {
    const pcx = Math.floor(player.pos[0] / W.SX), pcz = Math.floor(player.pos[2] / W.SZ);

    // unload distant chunks (edits stay in world.edits and are reapplied later)
    const unloadR2 = (RENDER_DIST + 2) * (RENDER_DIST + 2);
    world.chunks.forEach((c, k) => {
      const dx = c.cx - pcx, dz = c.cz - pcz;
      if (dx * dx + dz * dz > unloadR2) {
        renderer.removeChunk(k);
        world.chunks.delete(k);
      }
    });

    // generate nearest missing chunks (budgeted)
    let gen = GEN_PER_FRAME;
    for (let i = 0; i < OFFSETS.length && gen > 0; i++) {
      const cx = pcx + OFFSETS[i][0], cz = pcz + OFFSETS[i][1];
      if (!world.getChunk(cx, cz)) { world.getOrCreateChunk(cx, cz); gen--; }
    }

    // mesh nearest dirty chunks (budgeted)
    let mesh = MESH_PER_FRAME;
    for (let i = 0; i < OFFSETS.length && mesh > 0; i++) {
      const c = world.getChunk(pcx + OFFSETS[i][0], pcz + OFFSETS[i][1]);
      if (c && c.dirty) {
        renderer.uploadChunk(c.cx + "," + c.cz, world.buildGeometry(c));
        c.dirty = false;
        mesh--;
      }
    }
  }

  // ---------------------------------------------------------------- loop
  let last = 0, fps = 0;
  const mouseDown = [false, false, false];
  let breakTimer = 0, placeTimer = 0;
  let lastW = 0, wSprint = false;
  const keys = {};

  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.05) dt = 0.05;
    fps = fps + (1 / Math.max(dt, 1e-4) - fps) * 0.1;

    if (locked) {
      const cmd = {
        f: !!keys.KeyW, b: !!keys.KeyS, l: !!keys.KeyA, r: !!keys.KeyD,
        jump: !!keys.Space,
        descend: !!keys.ShiftLeft || !!keys.ShiftRight,
        sneak: !!keys.ShiftLeft || !!keys.ShiftRight,
        sprint: !!keys.ControlLeft || !!keys.ControlRight || wSprint,
      };
      player.update(dt, world, cmd);

      breakTimer -= dt; placeTimer -= dt;
      if (mouseDown[0] && breakTimer <= 0) { doBreak(); breakTimer = 0.18; }
      if (mouseDown[2] && placeTimer <= 0) { doPlace(); placeTimer = 0.20; }

      if (!timeFrozen) time = (time + dt / DAY_LENGTH) % 1;
    }

    manageWorld();

    const eye = player.getEye(), dir = player.getDir();
    const target = world.raycast(eye, dir, REACH);
    renderScene(eye, dir, target);
    updateHud(target);

    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- render
  function skyAndLight() {
    const sun = Math.sin(time * Math.PI * 2);          // peaks at time=0.25
    const k = Math.max(0, Math.min(1, (sun + 0.2) / 0.5)); // 0 night .. 1 day
    const dayLight = 0.2 + 0.8 * k;
    const night = [0.02, 0.03, 0.08], day = [0.49, 0.71, 0.97];
    const sky = [
      night[0] + (day[0] - night[0]) * k,
      night[1] + (day[1] - night[1]) * k,
      night[2] + (day[2] - night[2]) * k,
    ];
    // warm dawn/dusk tint near the horizon
    const horizon = Math.max(0, 1 - Math.abs(sun) / 0.22) * 0.4;
    sky[0] += (0.95 - sky[0]) * horizon;
    sky[1] += (0.5 - sky[1]) * horizon;
    sky[2] += (0.25 - sky[2]) * horizon;
    return { dayLight, sky };
  }

  function renderScene(eye, dir, target) {
    const aspect = renderer.resize();
    const proj = window.Mat4.perspective(FOV, aspect, 0.08, RENDER_DIST * 16 + 48);
    const view = window.Mat4.lookAt(eye, window.Vec3.add(eye, dir), [0, 1, 0]);
    const { dayLight, sky } = skyAndLight();
    const fogFar = RENDER_DIST * 16 * 0.92;
    renderer.render({
      proj, view, camPos: eye, dayLight,
      fogColor: sky, fogNear: fogFar * 0.55, fogFar,
      highlight: target ? target.hit : null,
    });
  }

  // ---------------------------------------------------------------- actions
  function doBreak() {
    const r = world.raycast(player.getEye(), player.getDir(), REACH);
    if (!r) return;
    const id = world.getBlock(r.hit[0], r.hit[1], r.hit[2]);
    if (id === ID.BEDROCK || id === ID.AIR) return;
    world.setBlock(r.hit[0], r.hit[1], r.hit[2], ID.AIR);
  }

  function doPlace() {
    const r = world.raycast(player.getEye(), player.getDir(), REACH);
    if (!r) return;
    const [x, y, z] = r.place;
    const cur = world.getBlock(x, y, z);
    if (cur !== ID.AIR && !Blocks.isLiquid(cur)) return;
    if (player.intersectsBlock(x, y, z)) return;
    const block = hotbarBlocks[selectedIndex];
    if (block && block !== ID.AIR) world.setBlock(x, y, z, block);
  }

  function pickBlock() {
    const r = world.raycast(player.getEye(), player.getDir(), REACH);
    if (!r) return;
    const id = world.getBlock(r.hit[0], r.hit[1], r.hit[2]);
    if (id && id !== ID.AIR) { hotbarBlocks[selectedIndex] = id; renderHotbar(); }
  }

  // ---------------------------------------------------------------- hotbar
  function iconFor(id) {
    if (!iconCache[id]) iconCache[id] = window.Textures.iconForBlock(atlas, id, 48);
    return iconCache[id];
  }
  function buildHotbarDOM() {
    hotbarEl.innerHTML = "";
    for (let i = 0; i < 9; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = i + 1;
      slot.appendChild(num);
      hotbarEl.appendChild(slot);
    }
  }
  function renderHotbar() {
    const slots = hotbarEl.children;
    for (let i = 0; i < 9; i++) {
      const id = hotbarBlocks[i];
      slots[i].style.backgroundImage = id ? "url(" + iconFor(id) + ")" : "none";
      slots[i].classList.toggle("selected", i === selectedIndex);
    }
  }

  // ---------------------------------------------------------------- HUD
  function facing(dir) {
    if (Math.abs(dir[0]) > Math.abs(dir[2])) return dir[0] > 0 ? "East (+X)" : "West (-X)";
    return dir[2] > 0 ? "South (+Z)" : "North (-Z)";
  }
  let hudThrottle = 0;
  function updateHud(target) {
    hudThrottle++;
    if (hudThrottle % 8 !== 0) return; // ~7-8 updates/sec
    const p = player.pos, dir = player.getDir();
    const hour = ((time * 24) + 6) % 24;
    const lookName = target ? Blocks.BLOCKS[world.getBlock(target.hit[0], target.hit[1], target.hit[2])].name : "—";
    hud.textContent =
      "ClockWorld\n" +
      "FPS     " + fps.toFixed(0) + "\n" +
      "XYZ     " + p[0].toFixed(1) + " " + p[1].toFixed(1) + " " + p[2].toFixed(1) + "\n" +
      "Chunks  " + world.chunks.size + "\n" +
      "Facing  " + facing(dir) + "\n" +
      "Time    " + hour.toFixed(1) + "h" + (timeFrozen ? " (frozen)" : "") + "\n" +
      "Mode    " + (player.flying ? "Fly" : "Walk") + (player.inWater ? " · swimming" : player.onGroundPrev ? "" : " · falling") + "\n" +
      "Holding " + (hotbarBlocks[selectedIndex] ? Blocks.BLOCKS[hotbarBlocks[selectedIndex]].name : "—") + "\n" +
      "Looking " + lookName;
  }

  // ---------------------------------------------------------------- input
  function wireInput() {
    const requestLock = () => canvas.requestPointerLock();
    canvas.addEventListener("click", requestLock);
    document.getElementById("playBtn").addEventListener("click", requestLock);
    document.getElementById("saveBtn").addEventListener("click", () => {
      save(); statusEl.textContent = "Saved.";
    });
    document.getElementById("newBtn").addEventListener("click", () => {
      localStorage.removeItem(SAVE_KEY);
      location.reload();
    });

    document.addEventListener("pointerlockchange", () => {
      locked = document.pointerLockElement === canvas;
      overlay.classList.toggle("hidden", locked);
      if (!locked) { mouseDown[0] = mouseDown[2] = false; save(); }
    });

    document.addEventListener("mousemove", (e) => {
      if (locked) player.applyMouse(e.movementX || 0, e.movementY || 0);
    });

    document.addEventListener("mousedown", (e) => {
      if (!locked) return;
      e.preventDefault();
      if (e.button === 0) { mouseDown[0] = true; breakTimer = 0; }
      else if (e.button === 2) { mouseDown[2] = true; placeTimer = 0; }
      else if (e.button === 1) pickBlock();
    });
    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) mouseDown[0] = false;
      if (e.button === 2) mouseDown[2] = false;
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("wheel", (e) => {
      if (!locked) return;
      e.preventDefault();
      selectedIndex = (selectedIndex + (e.deltaY > 0 ? 1 : -1) + 9) % 9;
      renderHotbar();
    }, { passive: false });

    const GAME_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space",
      "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight"]);
    document.addEventListener("keydown", (e) => {
      keys[e.code] = true;
      if (locked && GAME_KEYS.has(e.code)) e.preventDefault();
      if (!locked) return;
      if (e.code === "KeyW" && !e.repeat) {
        const t = performance.now();
        if (t - lastW < 260) wSprint = true;
        lastW = t;
      }
      if (e.code.startsWith("Digit")) {
        const n = parseInt(e.code.slice(5), 10);
        if (n >= 1 && n <= 9) { selectedIndex = n - 1; renderHotbar(); }
      }
      if (e.code === "KeyF") player.toggleFly();
      if (e.code === "KeyT") timeFrozen = !timeFrozen;
    });
    document.addEventListener("keyup", (e) => {
      keys[e.code] = false;
      if (e.code === "KeyW") wSprint = false;
    });
  }

  // ---------------------------------------------------------------- save/load
  function save() {
    if (!world || !player) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        seed: world.seed,
        edits: world.edits,
        time,
        hotbar: hotbarBlocks,
        selected: selectedIndex,
        player: { pos: player.pos, yaw: player.yaw, pitch: player.pitch, flying: player.flying },
      }));
    } catch (e) { /* storage full or disabled — ignore */ }
  }
  function loadSave() {
    try { return JSON.parse(localStorage.getItem(SAVE_KEY) || "null"); }
    catch (e) { return null; }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
