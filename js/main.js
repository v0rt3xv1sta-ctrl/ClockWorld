/*
 * main.js — game bootstrap, UI and loop.
 *
 * Owns the DOM, input, world streaming, the day/night cycle, game modes
 * (survival/creative), inventory + hotbar, mining/placing, vitals (health,
 * air, damage flash) and the multi-world save system.
 */
(function () {
  "use strict";

  const FOV = 70 * Math.PI / 180;
  const RENDER_DIST = 8, INIT_DIST = 4, REACH = 6, DAY_LENGTH = 600;
  const GEN_PER_FRAME = 2, MESH_PER_FRAME = 3;
  const LEGACY_KEY = "clockworld_save_v1";

  const Blocks = window.Blocks;
  const W = window.WorldMod;
  const ID = Blocks.ID;
  const Inventory = window.InventoryMod.Inventory;
  const Saves = window.SavesMod.Saves;

  const $ = (id) => document.getElementById(id);
  const canvas = $("game");

  // ---- state ----
  let renderer, atlas, saves, world, player, inv;
  let worldId = null, meta = null, mode = "survival", creativeHotbar = null;
  let selectedIndex = 0;
  let time = 0.3, timeFrozen = false;
  let running = false, locked = false, invOpen = false, dead = false;
  let cursor = null, mouseX = 0, mouseY = 0;
  let mineKey = null, mineProgress = 0, mineTime = 0;
  let breakTimer = 0, placeTimer = 0, lastW = 0, wSprint = false;
  const mouseDown = [false, false, false];
  const keys = {};
  let last = 0, fps = 0;
  const iconCache = {}, hearts = {};
  let bubbleURL = "";
  let lastHeartHP = -1, lastAirN = -1;

  const OFFSETS = [];
  for (let dx = -RENDER_DIST; dx <= RENDER_DIST; dx++)
    for (let dz = -RENDER_DIST; dz <= RENDER_DIST; dz++)
      if (dx * dx + dz * dz <= RENDER_DIST * RENDER_DIST) OFFSETS.push([dx, dz]);
  OFFSETS.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));

  // ====================================================== init
  function init() {
    try {
      renderer = new window.Renderer(canvas);
    } catch (e) {
      document.querySelector("#menu .card").innerHTML =
        "<h1>ClockWorld</h1><p class='tagline'>" + e.message +
        "</p><p class='tagline'>This game needs a browser with WebGL.</p>";
      return;
    }
    atlas = window.Textures.buildAtlas();
    renderer.setAtlas(atlas);
    saves = new Saves(window.localStorage);
    buildIcons();
    buildHotbarDOM();
    migrateLegacy();
    renderWorldList();
    wireInput();
    setInterval(() => { if (running) saveCurrent(); }, 10000);
    window.addEventListener("beforeunload", () => { if (running) saveCurrent(); });
    last = performance.now();
    requestAnimationFrame(frame);
  }

  function migrateLegacy() {
    if (saves.list().length) return;
    let legacy;
    try { legacy = JSON.parse(window.localStorage.getItem(LEGACY_KEY) || "null"); } catch (e) { legacy = null; }
    if (!legacy || legacy.seed === undefined) return;
    const m = saves.create("My World", legacy.seed, "creative");
    const data = saves.load(m.id).data;
    data.edits = legacy.edits || {};
    data.time = legacy.time || 0.3;
    if (legacy.player) data.player = {
      pos: legacy.player.pos, yaw: legacy.player.yaw, pitch: legacy.player.pitch,
      flying: legacy.player.flying, health: 20, air: 10,
    };
    data.creativeHotbar = legacy.hotbar || null;
    data.selected = legacy.selected || 0;
    saves.save(m.id, data);
    try { window.localStorage.removeItem(LEGACY_KEY); } catch (e) { /* ignore */ }
  }

  // ====================================================== world lifecycle
  function parseSeed(str) {
    str = (str || "").trim();
    if (!str) return (Math.random() * 1e9) >>> 0;
    if (/^\d+$/.test(str)) return parseInt(str, 10) >>> 0;
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function computeSpawn() {
    world.getOrCreateChunk(0, 0);
    let sy = W.HEIGHT - 1;
    while (sy > 0 && !Blocks.isSolid(world.getBlock(0, sy, 0))) sy--;
    return [0.5, sy + 1.2, 0.5];
  }

  function startWorld(m) {
    const loaded = saves.load(m.id);
    if (!loaded) return;
    const data = loaded.data;
    worldId = m.id; meta = loaded.meta; mode = data.mode === "creative" ? "creative" : "survival";
    world = new W.World(data.seed);
    world.edits = data.edits || {};
    time = data.time !== undefined ? data.time : 0.3;
    inv = Inventory.fromJSON(data.inventory || null, 36);
    creativeHotbar = (data.creativeHotbar && data.creativeHotbar.slice()) || Blocks.HOTBAR.slice();
    selectedIndex = data.selected || 0;

    const spawn = (data.player && data.player.pos) ? data.player.pos.slice() : computeSpawn();
    player = new window.Player(spawn, mode);
    if (data.player) {
      player.yaw = data.player.yaw || 0;
      player.pitch = data.player.pitch || 0;
      if (data.player.health !== undefined) player.health = data.player.health;
      if (data.player.air !== undefined) player.air = data.player.air;
      if (mode === "creative") player.flying = data.player.flying !== false;
    }
    player.spawn = (data.spawn || spawn).slice();

    generateInitialArea();
    running = true; dead = false; invOpen = false; cursor = null;
    lastHeartHP = -1; lastAirN = -1;
    $("menu").classList.add("hidden");
    $("vitals").removeAttribute("aria-hidden");
    renderHotbar();
    updateVitals();
    canvas.requestPointerLock();
  }

  function generateInitialArea() {
    const pcx = Math.floor(player.pos[0] / W.SX), pcz = Math.floor(player.pos[2] / W.SZ);
    const created = [];
    for (const [dx, dz] of OFFSETS) {
      if (dx * dx + dz * dz > INIT_DIST * INIT_DIST) continue;
      created.push(world.getOrCreateChunk(pcx + dx, pcz + dz));
    }
    for (const c of created) { renderer.uploadChunk(c.cx + "," + c.cz, world.buildGeometry(c)); c.dirty = false; }
  }

  function saveCurrent() {
    if (!worldId || !world || !player) return;
    saves.save(worldId, {
      seed: world.seed, mode, edits: world.edits, time,
      player: {
        pos: player.pos, yaw: player.yaw, pitch: player.pitch,
        health: player.health, air: player.air, flying: player.flying,
      },
      inventory: inv.toJSON(), creativeHotbar, selected: selectedIndex, spawn: player.spawn,
    });
  }

  function quitToMenu() {
    saveCurrent();
    running = false;
    if (document.pointerLockElement) document.exitPointerLock();
    ["pause", "death", "inventory"].forEach((s) => $(s).classList.add("hidden"));
    $("vitals").setAttribute("aria-hidden", "true");
    renderWorldList();
    $("menu").classList.remove("hidden");
  }

  function exportCurrent() {
    if (!worldId) return;
    saveCurrent();
    const json = saves.exportWorld(worldId);
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (meta.name || "world").replace(/[^\w-]+/g, "_") + ".clockworld.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function switchMode() {
    mode = mode === "survival" ? "creative" : "survival";
    player.setMode(mode);
    meta.mode = mode;
    if (mode === "creative" && !creativeHotbar) creativeHotbar = Blocks.HOTBAR.slice();
    renderHotbar(); updateVitals(); saveCurrent();
    $("pModeBtn").textContent = "Mode: " + mode;
  }

  // ====================================================== loop
  function frame(now) {
    let dt = (now - last) / 1000; last = now;
    if (dt > 0.05) dt = 0.05;
    fps += (1 / Math.max(dt, 1e-4) - fps) * 0.1;

    if (running && locked && !invOpen && !dead) {
      player.update(dt, world, buildCmd());
      if (!timeFrozen) time = (time + dt / DAY_LENGTH) % 1;
    }

    if (running) {
      const eye = player.getEye(), dir = player.getDir();
      const target = world.raycast(eye, dir, REACH);
      if (locked && !invOpen && !dead) {
        handleHold(dt, target);
        if (player.dead && !dead) onDeath();
      }
      manageWorld();
      renderScene(eye, dir, target);
      updateHud(target); updateMineBar(); updateVitals(); updateDamageFlash();
    } else {
      renderer.clear(skyAndLight().sky);
    }
    requestAnimationFrame(frame);
  }

  function buildCmd() {
    const shift = !!keys.ShiftLeft || !!keys.ShiftRight;
    return {
      f: !!keys.KeyW, b: !!keys.KeyS, l: !!keys.KeyA, r: !!keys.KeyD,
      jump: !!keys.Space, descend: shift, sneak: shift,
      sprint: !!keys.ControlLeft || !!keys.ControlRight || wSprint,
    };
  }

  function manageWorld() {
    const pcx = Math.floor(player.pos[0] / W.SX), pcz = Math.floor(player.pos[2] / W.SZ);
    const unloadR2 = (RENDER_DIST + 2) * (RENDER_DIST + 2);
    world.chunks.forEach((c, k) => {
      const dx = c.cx - pcx, dz = c.cz - pcz;
      if (dx * dx + dz * dz > unloadR2) { renderer.removeChunk(k); world.chunks.delete(k); }
    });
    let gen = GEN_PER_FRAME;
    for (let i = 0; i < OFFSETS.length && gen > 0; i++) {
      const cx = pcx + OFFSETS[i][0], cz = pcz + OFFSETS[i][1];
      if (!world.getChunk(cx, cz)) { world.getOrCreateChunk(cx, cz); gen--; }
    }
    let mesh = MESH_PER_FRAME;
    for (let i = 0; i < OFFSETS.length && mesh > 0; i++) {
      const c = world.getChunk(pcx + OFFSETS[i][0], pcz + OFFSETS[i][1]);
      if (c && c.dirty) { renderer.uploadChunk(c.cx + "," + c.cz, world.buildGeometry(c)); c.dirty = false; mesh--; }
    }
  }

  function skyAndLight() {
    const sun = Math.sin(time * Math.PI * 2);
    const k = Math.max(0, Math.min(1, (sun + 0.2) / 0.5));
    const dayLight = 0.2 + 0.8 * k;
    const night = [0.02, 0.03, 0.08], day = [0.49, 0.71, 0.97];
    const sky = [
      night[0] + (day[0] - night[0]) * k,
      night[1] + (day[1] - night[1]) * k,
      night[2] + (day[2] - night[2]) * k,
    ];
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
      proj, view, camPos: eye, dayLight, fogColor: sky,
      fogNear: fogFar * 0.55, fogFar, highlight: target ? target.hit : null,
    });
  }

  // ====================================================== mining / placing
  function currentPlaceable() {
    if (mode === "creative") return creativeHotbar[selectedIndex] || 0;
    const s = inv.get(selectedIndex);
    return s ? s.id : 0;
  }

  function resetMine() { mineKey = null; mineProgress = 0; mineTime = 0; }

  function handleHold(dt, target) {
    breakTimer -= dt; placeTimer -= dt;
    if (mouseDown[0]) {
      if (player.creative) {
        if (breakTimer <= 0) { breakInstant(target); breakTimer = 0.2; }
        resetMine();
      } else { mine(dt, target); }
    } else resetMine();
    if (mouseDown[2] && placeTimer <= 0) { place(target); placeTimer = 0.22; }
  }

  function mine(dt, target) {
    if (!target) { resetMine(); return; }
    const id = world.getBlock(target.hit[0], target.hit[1], target.hit[2]);
    if (!Blocks.isBreakable(id)) { resetMine(); return; }
    const key = target.hit.join(",");
    if (key !== mineKey) { mineKey = key; mineProgress = 0; mineTime = Blocks.hardnessOf(id); }
    mineProgress += dt;
    if (mineProgress >= mineTime) {
      world.setBlock(target.hit[0], target.hit[1], target.hit[2], ID.AIR);
      const drop = Blocks.dropOf(id);
      if (drop) { inv.add(drop, 1); renderHotbar(); }
      resetMine();
    }
  }

  function breakInstant(target) {
    if (!target) return;
    const id = world.getBlock(target.hit[0], target.hit[1], target.hit[2]);
    if (id === ID.AIR || Blocks.isLiquid(id)) return; // creative may remove bedrock
    world.setBlock(target.hit[0], target.hit[1], target.hit[2], ID.AIR);
  }

  function place(target) {
    if (!target) return;
    const [x, y, z] = target.place;
    const cur = world.getBlock(x, y, z);
    if (cur !== ID.AIR && !Blocks.isLiquid(cur)) return;
    if (player.intersectsBlock(x, y, z)) return;
    const sel = currentPlaceable();
    if (!sel) return;
    world.setBlock(x, y, z, sel);
    if (mode === "survival") { inv.removeAt(selectedIndex, 1); renderHotbar(); }
  }

  function pickBlock(target) {
    if (!target || mode !== "creative") return;
    const id = world.getBlock(target.hit[0], target.hit[1], target.hit[2]);
    if (id && id !== ID.AIR) { creativeHotbar[selectedIndex] = id; renderHotbar(); }
  }

  // ====================================================== icons
  function iconFor(id) {
    if (!iconCache[id]) iconCache[id] = window.Textures.iconForBlock(atlas, id, 48);
    return iconCache[id];
  }
  function buildIcons() {
    hearts.full = heartURL("#ff3b3b", 1);
    hearts.half = heartURL("#ff3b3b", 0.5);
    hearts.empty = heartURL("#3a1414", 1);
    bubbleURL = bubble();
  }
  function heartURL(color, fill) {
    const c = document.createElement("canvas"); c.width = c.height = 18;
    const x = c.getContext("2d");
    const draw = (col) => {
      x.fillStyle = col; x.beginPath();
      x.moveTo(9, 16); x.bezierCurveTo(0, 9.5, 2, 2.5, 9, 6.5);
      x.bezierCurveTo(16, 2.5, 18, 9.5, 9, 16); x.fill();
    };
    draw("#3a1414"); // dark backing
    if (fill < 1) { x.save(); x.beginPath(); x.rect(0, 0, 9, 18); x.clip(); draw(color); x.restore(); }
    else draw(color);
    return c.toDataURL();
  }
  function bubble() {
    const c = document.createElement("canvas"); c.width = c.height = 18;
    const x = c.getContext("2d");
    x.fillStyle = "rgba(180,220,255,0.95)"; x.beginPath(); x.arc(9, 9, 7, 0, 7); x.fill();
    x.fillStyle = "rgba(255,255,255,0.9)"; x.beginPath(); x.arc(6.5, 6.5, 2, 0, 7); x.fill();
    return c.toDataURL();
  }

  // ====================================================== hotbar + vitals
  function hotStack(i) {
    if (mode === "creative") return creativeHotbar[i] ? { id: creativeHotbar[i], count: Infinity } : null;
    return inv.get(i);
  }
  function buildHotbarDOM() {
    const hb = $("hotbar"); hb.innerHTML = "";
    for (let i = 0; i < 9; i++) {
      const slot = document.createElement("div"); slot.className = "slot";
      const num = document.createElement("span"); num.className = "num"; num.textContent = i + 1;
      const cnt = document.createElement("span"); cnt.className = "count";
      slot.appendChild(num); slot.appendChild(cnt); hb.appendChild(slot);
    }
  }
  function paintSlot(slot, stack) {
    const cnt = slot.querySelector(".count");
    if (stack && stack.id) {
      slot.style.backgroundImage = "url(" + iconFor(stack.id) + ")";
      cnt.textContent = (stack.count === Infinity || stack.count <= 1) ? "" : stack.count;
    } else { slot.style.backgroundImage = "none"; cnt.textContent = ""; }
  }
  function renderHotbar() {
    const slots = $("hotbar").children;
    for (let i = 0; i < 9; i++) {
      paintSlot(slots[i], hotStack(i));
      slots[i].classList.toggle("selected", i === selectedIndex);
    }
  }

  function updateVitals(force) {
    const heartsEl = $("hearts"), airEl = $("air");
    if (!player || mode !== "survival") {
      if (heartsEl.childElementCount) heartsEl.innerHTML = "";
      if (airEl.childElementCount) airEl.innerHTML = "";
      lastHeartHP = -1; lastAirN = -1;
      return;
    }
    const hp = Math.max(0, Math.min(player.maxHealth, player.health));
    if (force || hp !== lastHeartHP) {
      lastHeartHP = hp;
      let html = "";
      for (let i = 0; i < 10; i++) {
        const v = hp - i * 2;
        const src = v >= 2 ? hearts.full : v >= 1 ? hearts.half : hearts.empty;
        html += "<img src='" + src + "'>";
      }
      heartsEl.innerHTML = html;
    }
    const airN = (player.air < player.maxAir - 0.01) ? Math.ceil(player.air) : 0;
    if (force || airN !== lastAirN) {
      lastAirN = airN;
      let html = "";
      for (let i = 0; i < airN; i++) html += "<img src='" + bubbleURL + "'>";
      airEl.innerHTML = html;
    }
  }

  function updateMineBar() {
    const el = $("mine-progress"), bar = $("mine-bar");
    if (!player.creative && mouseDown[0] && mineKey && mineTime > 0) {
      el.style.display = "block";
      bar.style.width = Math.min(100, (mineProgress / mineTime) * 100) + "%";
    } else el.style.display = "none";
  }

  function updateDamageFlash() {
    $("damage-flash").style.opacity = player._hurtFlash > 0
      ? Math.min(0.8, (player._hurtFlash / 0.35) * 0.8) : 0;
  }

  function facing(dir) {
    if (Math.abs(dir[0]) > Math.abs(dir[2])) return dir[0] > 0 ? "East" : "West";
    return dir[2] > 0 ? "South" : "North";
  }
  let hudThrottle = 0;
  function updateHud(target) {
    if (++hudThrottle % 8 !== 0) return;
    const p = player.pos;
    const hour = ((time * 24) + 6) % 24;
    const look = target ? Blocks.BLOCKS[world.getBlock(target.hit[0], target.hit[1], target.hit[2])].name : "—";
    $("hud").textContent =
      "ClockWorld · " + meta.name + "\n" +
      "FPS    " + fps.toFixed(0) + "\n" +
      "XYZ    " + p[0].toFixed(1) + " " + p[1].toFixed(1) + " " + p[2].toFixed(1) + "\n" +
      "Mode   " + mode + (player.flying ? " · fly" : "") + (player.inWater ? " · water" : "") + "\n" +
      (mode === "survival" ? "HP     " + player.health + "/" + player.maxHealth + "\n" : "") +
      "Time   " + hour.toFixed(1) + "h" + (timeFrozen ? " (frozen)" : "") + "\n" +
      "Chunks " + world.chunks.size + "\n" +
      "Look   " + facing(player.getDir()) + " · " + look;
  }

  // ====================================================== inventory UI
  function openInventory() {
    if (!running || dead) return;
    invOpen = true;
    renderInventory();
    $("inventory").classList.remove("hidden");
    if (document.pointerLockElement) document.exitPointerLock();
  }
  function closeInventory() {
    // return any held stack to the inventory so it isn't lost
    if (cursor && mode === "survival") inv.add(cursor.id, cursor.count);
    invOpen = false; cursor = null; updateCursor(); renderHotbar();
    $("inventory").classList.add("hidden");
    if (running && !dead) canvas.requestPointerLock();
  }

  function makeInvSlot(stack, onClick) {
    const d = document.createElement("div");
    d.className = "slot";
    const cnt = document.createElement("span"); cnt.className = "count";
    d.appendChild(cnt); paintSlot(d, stack);
    d.addEventListener("mousedown", (e) => { e.preventDefault(); onClick(e.button === 2); });
    d.addEventListener("contextmenu", (e) => e.preventDefault());
    return d;
  }

  function renderInventory() {
    const palette = $("invPalette"), mainG = $("invMain"), hotG = $("invHotbar");
    $("invTitle").textContent = mode === "creative" ? "Creative Inventory" : "Inventory";
    palette.innerHTML = ""; mainG.innerHTML = ""; hotG.innerHTML = "";

    if (mode === "creative") {
      palette.style.display = "flex"; mainG.style.display = "none";
      $("invHint").innerHTML = "Click a block to assign it to the selected hotbar slot · right-click a slot to clear";
      Blocks.CREATIVE.forEach((id) => {
        palette.appendChild(makeInvSlot({ id, count: Infinity }, () => {
          creativeHotbar[selectedIndex] = id; renderHotbar(); renderInventory();
        }));
      });
      for (let i = 0; i < 9; i++) {
        const slot = makeInvSlot(hotStack(i), (right) => {
          if (right) creativeHotbar[i] = 0; else selectedIndex = i;
          renderHotbar(); renderInventory();
        });
        if (i === selectedIndex) slot.classList.add("selected");
        hotG.appendChild(slot);
      }
    } else {
      palette.style.display = "none"; mainG.style.display = "flex";
      $("invHint").innerHTML = "Click to pick up / place · right-click for one · <span class='k'>E</span>/<span class='k'>Esc</span> to close";
      for (let i = 9; i < 36; i++) mainG.appendChild(makeInvSlot(inv.get(i), (r) => invClick(i, r)));
      for (let i = 0; i < 9; i++) {
        const slot = makeInvSlot(inv.get(i), (r) => invClick(i, r));
        if (i === selectedIndex) slot.classList.add("selected");
        hotG.appendChild(slot);
      }
    }
  }

  function invClick(i, right) {
    const slot = inv.get(i);
    const max = slot ? Blocks.maxStackOf(slot.id) : 64;
    if (!right) {
      if (!cursor) { if (slot) { cursor = { id: slot.id, count: slot.count }; inv.set(i, null); } }
      else if (!slot) { inv.set(i, cursor); cursor = null; }
      else if (slot.id === cursor.id) {
        const mv = Math.min(max - slot.count, cursor.count);
        slot.count += mv; cursor.count -= mv; inv.set(i, slot);
        if (cursor.count <= 0) cursor = null;
      } else { inv.set(i, cursor); cursor = slot; }
    } else {
      if (!cursor) { if (slot) { const half = Math.ceil(slot.count / 2); cursor = { id: slot.id, count: half }; inv.removeAt(i, half); } }
      else if (!slot) { inv.set(i, { id: cursor.id, count: 1 }); if (--cursor.count <= 0) cursor = null; }
      else if (slot.id === cursor.id && slot.count < Blocks.maxStackOf(slot.id)) {
        slot.count++; inv.set(i, slot); if (--cursor.count <= 0) cursor = null;
      }
    }
    renderInventory(); renderHotbar(); updateCursor();
  }

  function updateCursor() {
    const el = $("cursorStack");
    if (cursor && cursor.id) {
      el.style.display = "block";
      el.style.backgroundImage = "url(" + iconFor(cursor.id) + ")";
      el.style.left = mouseX + "px"; el.style.top = mouseY + "px";
      let c = el.querySelector(".count");
      if (!c) { c = document.createElement("span"); c.className = "count"; el.appendChild(c); }
      c.textContent = cursor.count > 1 ? cursor.count : "";
    } else el.style.display = "none";
  }

  // ====================================================== death / pause
  function onDeath() {
    dead = true;
    if (document.pointerLockElement) document.exitPointerLock();
    $("death").classList.remove("hidden");
  }
  function respawn() {
    player.respawn(player.spawn);
    dead = false; updateVitals(true);
    $("death").classList.add("hidden");
    canvas.requestPointerLock();
  }

  // ====================================================== world list UI
  function renderWorldList() {
    const list = saves.list(), el = $("worldList");
    el.innerHTML = "";
    if (!list.length) { el.innerHTML = "<p class='muted'>No worlds yet — create one below.</p>"; return; }
    list.forEach((m) => {
      const row = document.createElement("div"); row.className = "world-row";
      const info = document.createElement("div"); info.className = "winfo";
      const when = new Date(m.updated || m.created).toLocaleString();
      info.innerHTML = "<div class='wname'>" + escapeHtml(m.name) + "</div>" +
        "<div class='wmeta'>seed " + m.seed + " · " + when + "</div>";
      const badge = document.createElement("span");
      badge.className = "badge " + m.mode; badge.textContent = m.mode;
      const play = document.createElement("button"); play.className = "iconbtn"; play.textContent = "Play";
      play.addEventListener("click", () => startWorld(m));
      const del = document.createElement("button"); del.className = "iconbtn danger"; del.textContent = "✕";
      del.title = "Delete world";
      del.addEventListener("click", () => {
        if (window.confirm("Delete \"" + m.name + "\"? This cannot be undone.")) { saves.remove(m.id); renderWorldList(); }
      });
      row.append(info, badge, play, del);
      el.appendChild(row);
    });
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ====================================================== input
  function wireInput() {
    $("createBtn").addEventListener("click", () => {
      const m = saves.create($("wName").value || "World", parseSeed($("wSeed").value),
        document.querySelector("input[name=mode]:checked").value);
      renderWorldList(); startWorld(m);
    });
    $("importBtn").addEventListener("click", () => $("importFile").click());
    $("importFile").addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        const m = saves.importWorld(r.result);
        $("menuStatus").textContent = m ? ("Imported \"" + m.name + "\".") : "Import failed — not a ClockWorld file.";
        renderWorldList();
      };
      r.readAsText(f); e.target.value = "";
    });

    $("resumeBtn").addEventListener("click", () => canvas.requestPointerLock());
    $("pSaveBtn").addEventListener("click", () => { saveCurrent(); $("pSaveBtn").textContent = "Saved ✓"; setTimeout(() => ($("pSaveBtn").textContent = "Save"), 1200); });
    $("pModeBtn").addEventListener("click", switchMode);
    $("pExportBtn").addEventListener("click", exportCurrent);
    $("quitBtn").addEventListener("click", quitToMenu);
    $("respawnBtn").addEventListener("click", respawn);
    $("dQuitBtn").addEventListener("click", quitToMenu);

    canvas.addEventListener("click", () => { if (running && !invOpen && !dead) canvas.requestPointerLock(); });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("pointerlockchange", () => {
      locked = document.pointerLockElement === canvas;
      if (locked) { $("pause").classList.add("hidden"); }
      else if (running) {
        mouseDown[0] = mouseDown[2] = false; resetMine();
        if (dead) $("death").classList.remove("hidden");
        else if (invOpen) $("inventory").classList.remove("hidden");
        else { $("pModeBtn").textContent = "Mode: " + mode; $("pause").classList.remove("hidden"); saveCurrent(); }
      }
    });

    document.addEventListener("mousemove", (e) => {
      if (locked) player.applyMouse(e.movementX || 0, e.movementY || 0);
      else if (invOpen) { mouseX = e.clientX; mouseY = e.clientY; updateCursor(); }
    });
    document.addEventListener("mousedown", (e) => {
      if (!locked) return;
      e.preventDefault();
      const eye = player.getEye(), dir = player.getDir();
      const target = world.raycast(eye, dir, REACH);
      if (e.button === 0) { mouseDown[0] = true; if (player.creative) { breakInstant(target); breakTimer = 0.2; } else breakTimer = 0; }
      else if (e.button === 2) { mouseDown[2] = true; place(target); placeTimer = 0.22; }
      else if (e.button === 1) pickBlock(target);
    });
    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) { mouseDown[0] = false; resetMine(); }
      if (e.button === 2) mouseDown[2] = false;
    });

    document.addEventListener("wheel", (e) => {
      if (!locked) return;
      e.preventDefault();
      selectedIndex = (selectedIndex + (e.deltaY > 0 ? 1 : -1) + 9) % 9;
      renderHotbar();
    }, { passive: false });

    const GAME_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "KeyE"]);
    document.addEventListener("keydown", (e) => {
      keys[e.code] = true;
      if (locked && GAME_KEYS.has(e.code)) e.preventDefault();
      if (!running) return;
      if (e.code === "KeyE") { if (locked) openInventory(); else if (invOpen) closeInventory(); return; }
      if (e.code === "Escape") { if (invOpen) closeInventory(); return; }
      if (!locked) return;
      if (e.code === "KeyW" && !e.repeat) { const t = performance.now(); if (t - lastW < 260) wSprint = true; lastW = t; }
      if (e.code.startsWith("Digit")) { const n = parseInt(e.code.slice(5), 10); if (n >= 1 && n <= 9) { selectedIndex = n - 1; renderHotbar(); } }
      if (e.code === "KeyF") player.toggleFly();
      if (e.code === "KeyT") timeFrozen = !timeFrozen;
    });
    document.addEventListener("keyup", (e) => { keys[e.code] = false; if (e.code === "KeyW") wSprint = false; });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
