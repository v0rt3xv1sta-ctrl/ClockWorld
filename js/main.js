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
  const Items = window.Items;
  const Recipes = window.Recipes;
  const Furnace = window.Furnace;
  const W = window.WorldMod;
  const ID = Blocks.ID;
  const Inventory = window.InventoryMod.Inventory;
  const Saves = window.SavesMod.Saves;
  const Net = window.Net;
  const Mods = window.Mods;
  const VR = window.VR;
  const emitMod = (ev, data) => { if (Mods) Mods.emit(ev, data); };

  const $ = (id) => document.getElementById(id);
  const canvas = $("game");

  // ---- state ----
  let renderer, atlas, saves, world, player, inv;
  let worldId = null, meta = null, mode = "survival", creativeHotbar = null;
  let selectedIndex = 0;
  let time = 0.3, timeFrozen = false;
  let sim = null;       // liquid flow simulation (single-player only)
  let shaderTime = 0;   // monotonic clock for water waves / sky animation
  let wasUnderwater = false;
  let running = false, locked = false, invOpen = false, dead = false;
  let cursor = null, mouseX = 0, mouseY = 0;
  let mineKey = null, mineProgress = 0, mineTime = 0;
  let breakTimer = 0, placeTimer = 0, eatTimer = 0, lastW = 0, wSprint = false;
  const mouseDown = [false, false, false];
  const keys = {};
  let last = 0, fps = 0;
  const iconCache = {}, hearts = {}, drum = {};
  let bubbleURL = "";
  let lastHeartHP = -1, lastAirN = -1, lastHungerH = -1;

  // interactable containers (per block position), persisted with the world
  const chests = new Map();   // "x,y,z" -> Inventory(27)
  const furnaces = new Map(); // "x,y,z" -> furnace state
  let containerOpen = false, containerKind = null, containerPos = null;
  let chestInv = null, furnaceState = null, craftGrid = [], craftN = 0;

  // multiplayer
  let online = false, net = null, moveAcc = 0;
  const remotePlayers = new Map(); // id -> { pos, yaw, pitch, name, color }
  const chatLog = [];
  let chatOpen = false, chatBuf = "";

  // VR (WebXR)
  let vrActive = false, vrSession = null, rigYaw = 0, vrFloor = true;
  let vrTarget = null, vrHeadDir = [0, 0, -1], vrTurned = false, vrPrevBrk = false, vrPrevPlace = false;

  const anyUIOpen = () => invOpen || containerOpen || dead;

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
    loadModsAndPacks(); // register modded blocks/items + texture pack before the atlas is built
    atlas = window.Textures.buildAtlas();
    renderer.setAtlas(atlas);
    saves = new Saves(window.localStorage);
    buildIcons();
    buildHotbarDOM();
    migrateLegacy();
    renderWorldList();
    const origin = sameOriginWS();
    $("mpUrl").value = origin || "ws://localhost:8080";
    if (!origin) { $("joinHereBtn").style.display = "none"; $("mpHint").textContent = "Open the game from a running server to use one-click Join, or type a ws:// address."; }
    if (VR) VR.isSupported().then((ok) => { if (!ok) $("vrBtn").style.display = "none"; });
    else $("vrBtn").style.display = "none";
    wireInput();
    // give the modding SDK live world access (routes through applyEdit so
    // multiplayer sync and the liquid sim both see mod edits)
    if (Mods && Mods.bind) Mods.bind({
      setBlock: (x, y, z, id) => { if (running) applyEdit(x, y, z, id | 0); },
      getBlock: (x, y, z) => (running ? world.getBlock(x, y, z) : 0),
      getTime: () => time,
      setTime: (t) => { time = ((t % 1) + 1) % 1; },
      playerPos: () => (running ? player.pos.slice() : null),
      teleport: (x, y, z) => { if (running) { player.pos = [x, y, z]; player.vel = [0, 0, 0]; player.fallPeak = y; } },
    });
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

    chests.clear(); furnaces.clear();
    if (data.chests) for (const k in data.chests) chests.set(k, Inventory.fromJSON(data.chests[k], 27));
    if (data.furnaces) for (const k in data.furnaces) furnaces.set(k, Object.assign(Furnace.create(), data.furnaces[k]));

    const spawn = (data.player && data.player.pos) ? data.player.pos.slice() : computeSpawn();
    player = new window.Player(spawn, mode);
    if (data.player) {
      player.yaw = data.player.yaw || 0;
      player.pitch = data.player.pitch || 0;
      if (data.player.health !== undefined) player.health = data.player.health;
      if (data.player.air !== undefined) player.air = data.player.air;
      if (data.player.hunger !== undefined) player.hunger = data.player.hunger;
      if (mode === "creative") player.flying = data.player.flying !== false;
    }
    player.spawn = (data.spawn || spawn).slice();

    sim = new window.Liquids.LiquidSim(world);
    generateInitialArea();
    running = true; dead = false; invOpen = false; containerOpen = false; cursor = null;
    lastHeartHP = -1; lastAirN = -1; lastHungerH = -1;
    $("menu").classList.add("hidden");
    $("vitals").removeAttribute("aria-hidden");
    renderHotbar();
    updateVitals();
    emitMod("worldStart", { mode, seed: world.seed, online: false });
    canvas.requestPointerLock();
  }

  // ====================================================== multiplayer
  function avatarColor(id) {
    const h = (id * 2654435761) >>> 0;
    return [0.35 + 0.6 * ((h & 255) / 255), 0.35 + 0.6 * (((h >> 8) & 255) / 255), 0.35 + 0.6 * (((h >> 16) & 255) / 255)];
  }
  function addRemote(id, p) { remotePlayers.set(id, { pos: p.pos || [0, 80, 0], yaw: p.yaw || 0, pitch: p.pitch || 0, name: p.name || ("Player" + id), color: avatarColor(id) }); }
  function addChat(line) {
    chatLog.push(line); if (chatLog.length > 8) chatLog.shift();
    $("chatLog").innerHTML = chatLog.map(escapeHtml).join("<br>");
  }

  // The WebSocket address of the server that served this page (if any).
  function sameOriginWS() {
    const loc = window.location;
    if (!loc || !loc.host) return null; // opened from file:// — no server origin
    return (loc.protocol === "https:" ? "wss://" : "ws://") + loc.host;
  }
  // Make a user-typed address into a valid ws/wss URL; a page served over HTTPS
  // may only open wss:// (browsers block insecure ws:// from https pages).
  function normalizeWsUrl(url) {
    url = (url || "").trim();
    if (!url) return sameOriginWS() || "ws://localhost:8080";
    const https = !!(window.location && window.location.protocol === "https:");
    if (!/^wss?:\/\//i.test(url)) url = (https ? "wss://" : "ws://") + url.replace(/^\/+/, "");
    if (https && /^ws:\/\//i.test(url)) url = url.replace(/^ws:\/\//i, "wss://"); // auto-upgrade
    return url;
  }

  let pendingAuth = null;
  function sendAuth() {
    if (!net || !pendingAuth) return;
    const a = pendingAuth;
    if (a.token) net.send({ t: "token", token: a.token });
    else if (a.user && a.pass) net.send({ t: a.register ? "register" : "login", user: a.user, pass: a.pass });
  }

  function connectMP(url, name) {
    if (!Net || !Net.available) { $("menuStatus").textContent = "WebSocket is not supported here."; return; }
    url = normalizeWsUrl(url);
    const user = $("acctUser").value.trim(), pass = $("acctPass").value, register = !!$("acctRegister").checked;
    let stored = ""; try { stored = localStorage.getItem("cw_token_" + url) || ""; } catch (e) { /* ignore */ }
    pendingAuth = { user, pass, register, token: (!user && stored) ? stored : null, url };
    $("menuStatus").textContent = "Connecting to " + url + " …";
    net = new Net.Client();
    net.connect(url, name || "Player", {
      welcome: (w) => { startOnlineWorld(w); sendAuth(); },
      authok: (m) => { try { localStorage.setItem("cw_token_" + pendingAuth.url, m.token); } catch (e) { /* ignore */ } addChat("✓ Signed in as " + m.name); $("acctStatus").textContent = "Signed in as " + m.name; },
      authfail: (m) => { addChat("Account: " + m.msg); $("acctStatus").textContent = m.msg; },
      player: (m) => addRemote(m.id, m),
      move: (m) => { const r = remotePlayers.get(m.id); if (r) { r.pos = m.pos; r.yaw = m.yaw; r.pitch = m.pitch; } else addRemote(m.id, m); },
      set: (m) => world.setBlock(m.x, m.y, m.z, m.id),
      leave: (m) => remotePlayers.delete(m.id),
      chat: (m) => addChat(m.name + ": " + m.text),
      closed: () => { if (online) { online = false; if (running) quitToMenu(); $("menuStatus").textContent = "Disconnected from server."; } },
      error: () => { $("menuStatus").textContent = "Could not connect to " + url + ". Is the server running, and reachable over " + (url.startsWith("wss") ? "wss (HTTPS)" : "ws") + "?"; },
    });
  }

  function startOnlineWorld(w) {
    online = true; worldId = null;
    sim = null; // the server is authoritative for blocks; no local flow sim
    meta = { name: "Multiplayer", mode: w.mode };
    mode = w.mode === "creative" ? "creative" : "survival";
    world = new W.World(w.seed);
    world.edits = Object.assign({}, w.edits || {});
    time = 0.3;
    inv = new Inventory(36);
    creativeHotbar = Blocks.HOTBAR.slice();
    selectedIndex = 0;
    chests.clear(); furnaces.clear(); remotePlayers.clear(); chatLog.length = 0;
    if (w.players) w.players.forEach((p) => addRemote(p.id, p));
    const spawn = computeSpawn();
    player = new window.Player(spawn, mode);
    player.spawn = spawn.slice();
    generateInitialArea();
    running = true; dead = false; invOpen = false; containerOpen = false; cursor = null;
    lastHeartHP = -1; lastAirN = -1; lastHungerH = -1;
    $("menu").classList.add("hidden");
    $("chat").classList.remove("hidden");
    $("chatLog").innerHTML = "";
    $("vitals").removeAttribute("aria-hidden");
    renderHotbar(); updateVitals();
    emitMod("worldStart", { mode, seed: w.seed, online: true });
    canvas.requestPointerLock();
  }

  function openChat() { if (!online) return; chatOpen = true; chatBuf = ""; renderChatInput(); }
  function closeChat(send) {
    if (send && chatBuf.trim() && net) net.chat(chatBuf.trim());
    chatOpen = false; chatBuf = ""; $("chatInput").classList.add("hidden");
  }
  function renderChatInput() {
    const el = $("chatInput");
    el.classList.toggle("hidden", !chatOpen);
    el.textContent = "> " + chatBuf;
  }

  // ====================================================== VR (WebXR)
  function enterVR() {
    if (!running || !VR || vrActive) return;
    rigYaw = 0; vrPrevBrk = vrPrevPlace = false;
    VR.start({
      gl: renderer.gl,
      onReady: (floor) => { vrFloor = floor; },
      beginFrame: () => renderer.clearView(skyAndLight().sky),
      getRig: () => ({ pos: [player.pos[0], player.pos[1] + (vrFloor ? 0 : window.Player.EYE), player.pos[2]], yaw: rigYaw }),
      update: vrUpdate,
      renderEye: vrRenderEye,
      onEnd: () => { vrActive = false; vrSession = null; if (running) $("pause").classList.remove("hidden"); },
    }).then((c) => {
      vrActive = true; vrSession = c;
      ["pause", "inventory", "container"].forEach((s) => $(s).classList.add("hidden"));
    }).catch((e) => { $("vrBtn").textContent = "VR unavailable"; });
  }

  function vrUpdate(dt, input) {
    if (!vrTurned && input.turn > 0.7) { rigYaw -= Math.PI / 4; vrTurned = true; }
    else if (!vrTurned && input.turn < -0.7) { rigYaw += Math.PI / 4; vrTurned = true; }
    else if (Math.abs(input.turn) < 0.3) vrTurned = false;

    player.yaw = input.headYaw + rigYaw;
    const cy = Math.cos(rigYaw), sy = Math.sin(rigYaw), hd = input.headDir;
    vrHeadDir = [cy * hd[0] + sy * hd[2], hd[1], -sy * hd[0] + cy * hd[2]];

    player.update(dt, world, {
      f: input.moveZ < -0.3, b: input.moveZ > 0.3, l: input.moveX < -0.3, r: input.moveX > 0.3,
      jump: input.jump, descend: false, sneak: false, sprint: input.sprint,
    });
    if (!timeFrozen) time = (time + dt / DAY_LENGTH) % 1;
    shaderTime += dt;
    if (sim) sim.step(dt);
    furnaces.forEach((f) => Furnace.tick(f, dt));
    manageWorld();
    if (online && net) { moveAcc += dt; if (moveAcc >= 0.08) { net.move(player.pos, player.yaw, player.pitch); moveAcc = 0; } }

    vrTarget = world.raycast(player.getEye(), vrHeadDir, REACH);
    if (input.brk) { if (player.creative) { if (!vrPrevBrk) breakInstant(vrTarget); } else mine(dt, vrTarget); } else resetMine();
    if (input.place && !vrPrevPlace && vrTarget) {
      const tid = world.getBlock(vrTarget.hit[0], vrTarget.hit[1], vrTarget.hit[2]);
      if (tid === ID.DOOR || tid === ID.DOOR_OPEN) interactBlock(tid, vrTarget.hit); else place(vrTarget);
    }
    vrPrevBrk = input.brk; vrPrevPlace = input.place;
    if (player.dead) player.respawn(player.spawn); // auto-respawn in VR
  }

  function vrRenderEye(proj, view, camPos) {
    const scene = Object.assign(sceneCommon(skyAndLight(), camPos), {
      proj, view, camPos, highlight: vrTarget ? vrTarget.hit : null,
    });
    renderer.drawWorld(scene);
    if (online && remotePlayers.size) renderer.drawAvatars([...remotePlayers.values()], scene);
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
    const chestsJSON = {}; chests.forEach((c, k) => { if (!c.isEmpty()) chestsJSON[k] = c.toJSON(); });
    const furnacesJSON = {}; furnaces.forEach((f, k) => { furnacesJSON[k] = f; });
    saves.save(worldId, {
      seed: world.seed, mode, edits: world.edits, time,
      player: {
        pos: player.pos, yaw: player.yaw, pitch: player.pitch,
        health: player.health, air: player.air, hunger: player.hunger, flying: player.flying,
      },
      inventory: inv.toJSON(), creativeHotbar, selected: selectedIndex, spawn: player.spawn,
      chests: chestsJSON, furnaces: furnacesJSON,
    });
  }

  function quitToMenu() {
    if (online) { if (net) net.disconnect(); online = false; net = null; remotePlayers.clear(); }
    else saveCurrent();
    running = false; chatOpen = false; sim = null;
    if (document.pointerLockElement) document.exitPointerLock();
    ["pause", "death", "inventory", "container", "chat", "chatInput"].forEach((s) => $(s).classList.add("hidden"));
    invOpen = false; containerOpen = false; cursor = null; updateCursor();
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
    if (vrActive) { requestAnimationFrame(frame); return; } // the XR session drives its own loop
    let dt = (now - last) / 1000; last = now;
    if (dt > 0.05) dt = 0.05;
    fps += (1 / Math.max(dt, 1e-4) - fps) * 0.1;

    shaderTime += dt;
    if (running && locked && !anyUIOpen() && !chatOpen) {
      player.update(dt, world, buildCmd());
      emitMod("tick", { dt });
      if (!timeFrozen) time = (time + dt / DAY_LENGTH) % 1;
      if (online && net) { moveAcc += dt; if (moveAcc >= 0.08) { net.move(player.pos, player.yaw, player.pitch); moveAcc = 0; } }
    }
    if (running && sim) sim.step(dt); // water keeps flowing even in menus

    if (running) {
      furnaces.forEach((f) => Furnace.tick(f, dt)); // smelting runs even when closed
      const eye = player.getEye(), dir = player.getDir();
      const target = world.raycast(eye, dir, REACH);
      if (locked && !anyUIOpen() && !chatOpen) {
        handleHold(dt, target);
        if (player.dead && !dead) onDeath();
      }
      if (containerOpen && containerKind === "furnace") renderContainer(); // live progress
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
    const a = time * Math.PI * 2;
    const sun = Math.sin(a);
    // sun path: rises east, arcs over with a southward tilt
    const sm = Math.hypot(Math.cos(a), sun, 0.35) || 1;
    const sunDir = [Math.cos(a) / sm, sun / sm, 0.35 / sm];
    const k = Math.max(0, Math.min(1, (sun + 0.2) / 0.5));
    const dayLight = 0.16 + 0.84 * k;
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
    // sunlight colour: cool blue night -> warm dawn/dusk -> near-white noon
    const dusk = Math.max(0, 1 - Math.abs(sun) / 0.28);
    const lightColor = [
      dayLight * (0.62 + 0.38 * k + 0.34 * dusk),
      dayLight * (0.68 + 0.32 * k - 0.05 * dusk),
      dayLight * (1.0 - 0.12 * dusk),
    ];
    return { dayLight, sky, sunDir, lightColor, glint: k };
  }

  // Shared scene fields for both desktop and VR eyes.
  function sceneCommon(sl, eye) {
    const fogFar = RENDER_DIST * 16 * 0.92;
    const s = {
      dayLight: sl.dayLight, fogColor: sl.sky, sunDir: sl.sunDir,
      lightColor: sl.lightColor, glint: sl.glint, time: shaderTime,
      fogNear: fogFar * 0.55, fogFar, underwater: false,
    };
    // eye below the surface: short blue fog, dimmer light, no sky
    const eyeId = world.getBlock(Math.floor(eye[0]), Math.floor(eye[1]), Math.floor(eye[2]));
    if (Blocks.isLiquid(eyeId)) {
      s.underwater = true;
      const d = sl.dayLight;
      s.fogColor = [0.05 * d, 0.19 * d, 0.34 * d];
      s.fogNear = 2;
      s.fogFar = 24;
      s.lightColor = [sl.lightColor[0] * 0.45, sl.lightColor[1] * 0.62, sl.lightColor[2] * 0.9];
      s.glint = 0;
    }
    if (s.underwater !== wasUnderwater) {
      wasUnderwater = s.underwater;
      const ov = $("underwater");
      if (ov) ov.classList.toggle("hidden", !s.underwater);
    }
    return s;
  }

  function renderScene(eye, dir, target) {
    const aspect = renderer.resize();
    const proj = window.Mat4.perspective(FOV, aspect, 0.08, RENDER_DIST * 16 + 48);
    const view = window.Mat4.lookAt(eye, window.Vec3.add(eye, dir), [0, 1, 0]);
    const scene = Object.assign(sceneCommon(skyAndLight(), eye), {
      proj, view, camPos: eye, highlight: target ? target.hit : null,
    });
    renderer.render(scene);
    if (online && remotePlayers.size) renderer.drawAvatars([...remotePlayers.values()], scene);
  }

  // ====================================================== mining / placing
  function currentPlaceable() {
    const id = mode === "creative" ? (creativeHotbar[selectedIndex] || 0) : (inv.get(selectedIndex) ? inv.get(selectedIndex).id : 0);
    return Items.isPlaceable(id) ? id : 0;
  }

  function resetMine() { mineKey = null; mineProgress = 0; mineTime = 0; }

  function heldSelectedId() {
    return mode === "creative" ? creativeHotbar[selectedIndex] : (inv.get(selectedIndex) ? inv.get(selectedIndex).id : 0);
  }
  function heldFood() { const id = heldSelectedId(); return Items.isFood(id) ? Items.food(id) : null; }

  function handleHold(dt, target) {
    breakTimer -= dt; placeTimer -= dt;
    if (mouseDown[0]) {
      if (player.creative) { if (breakTimer <= 0) { breakInstant(target); breakTimer = 0.2; } resetMine(); }
      else mine(dt, target);
    } else resetMine();

    if (mouseDown[2]) {
      const food = heldFood();
      if (food && mode === "survival" && player.hunger < player.maxHunger) {
        eatTimer += dt;
        if (eatTimer >= 1.2) { const fid = heldSelectedId(); player.eat(food); inv.removeAt(selectedIndex, 1); renderHotbar(); emitMod("eat", { id: fid }); eatTimer = 0; }
      } else if (placeTimer <= 0) { place(target); placeTimer = 0.22; }
    } else eatTimer = 0;
  }

  function getChest(hit) { const k = hit.join(","); if (!chests.has(k)) chests.set(k, new Inventory(27)); return chests.get(k); }
  function getFurnace(hit) { const k = hit.join(","); if (!furnaces.has(k)) furnaces.set(k, Furnace.create()); return furnaces.get(k); }
  function removeContainerAt(hit, id) {
    const k = hit.join(",");
    if (id === ID.CHEST) chests.delete(k);
    if (id === ID.FURNACE || id === ID.FURNACE_LIT) furnaces.delete(k);
  }

  // Apply a block change locally and, when online, push it to the server.
  function applyEdit(x, y, z, id) {
    world.setBlock(x, y, z, id);
    if (sim) sim.disturb(x, y, z);
    if (online && net) net.set(x, y, z, id);
  }

  function interactBlock(id, hit) {
    const kind = Blocks.interactOf(id);
    if (kind === "door") {
      applyEdit(hit[0], hit[1], hit[2], id === ID.DOOR_OPEN ? ID.DOOR : ID.DOOR_OPEN);
    } else if (kind === "chest") { chestInv = getChest(hit); openContainer("chest", hit); }
    else if (kind === "craft") { craftN = 3; craftGrid = new Array(9).fill(null); openContainer("craft", hit); }
    else if (kind === "furnace") { furnaceState = getFurnace(hit); openContainer("furnace", hit); }
  }

  function mine(dt, target) {
    if (!target) { resetMine(); return; }
    const id = world.getBlock(target.hit[0], target.hit[1], target.hit[2]);
    if (!Blocks.isBreakable(id)) { resetMine(); return; }
    const key = target.hit.join(",");
    if (key !== mineKey) { mineKey = key; mineProgress = 0; mineTime = Blocks.hardnessOf(id); }
    mineProgress += dt;
    if (mineProgress >= mineTime) { breakSurvival(target.hit, id); resetMine(); }
  }

  function breakSurvival(hit, id) {
    removeContainerAt(hit, id);
    applyEdit(hit[0], hit[1], hit[2], ID.AIR);
    emitMod("blockBreak", { x: hit[0], y: hit[1], z: hit[2], id });
    const drop = Blocks.dropOf(id);
    if (drop) inv.add(drop, 1);
    if (id === ID.LEAVES && Math.random() < 0.06) inv.add(Items.ITEM.APPLE, 1);   // food from trees
    if (id === ID.GRASS && Math.random() < 0.18) inv.add(Items.ITEM.WHEAT, 1);    // wheat for bread
    renderHotbar();
  }

  function breakInstant(target) {
    if (!target) return;
    const id = world.getBlock(target.hit[0], target.hit[1], target.hit[2]);
    if (id === ID.AIR || Blocks.isLiquid(id)) return; // creative may remove bedrock
    removeContainerAt(target.hit, id);
    applyEdit(target.hit[0], target.hit[1], target.hit[2], ID.AIR);
    emitMod("blockBreak", { x: target.hit[0], y: target.hit[1], z: target.hit[2], id });
  }

  function place(target) {
    if (!target) return;
    const [x, y, z] = target.place;
    const cur = world.getBlock(x, y, z);
    if (cur !== ID.AIR && !Blocks.isLiquid(cur)) return;
    if (player.intersectsBlock(x, y, z)) return;
    const sel = currentPlaceable();
    if (!sel) return;
    applyEdit(x, y, z, sel);
    emitMod("blockPlace", { x, y, z, id: sel });
    if (mode === "survival") { inv.removeAt(selectedIndex, 1); renderHotbar(); }
  }

  function pickBlock(target) {
    if (!target || mode !== "creative") return;
    const id = world.getBlock(target.hit[0], target.hit[1], target.hit[2]);
    if (id && id !== ID.AIR) { creativeHotbar[selectedIndex] = id; renderHotbar(); }
  }

  // ====================================================== icons
  function iconFor(id) {
    if (!iconCache[id]) iconCache[id] = Items.iconURL(id, atlas);
    return iconCache[id];
  }
  function buildIcons() {
    hearts.full = heartURL("#ff3b3b", 1);
    hearts.half = heartURL("#ff3b3b", 0.5);
    hearts.empty = heartURL("#3a1414", 1);
    drum.full = drumURL("#c98a3c", 1);
    drum.half = drumURL("#c98a3c", 0.5);
    drum.empty = drumURL("#2e2418", 1);
    bubbleURL = bubble();
  }
  function drumURL(color, fill) {
    const c = document.createElement("canvas"); c.width = c.height = 18;
    const x = c.getContext("2d");
    const draw = (col) => {
      x.fillStyle = col;
      x.beginPath(); x.arc(10, 7, 5, 0, 7); x.fill();          // meat
      x.fillRect(3, 11, 6, 3); x.fillRect(2, 12, 2, 4);         // bone
    };
    draw("#2e2418");
    if (fill < 1) { x.save(); x.beginPath(); x.rect(9, 0, 9, 18); x.clip(); draw(color); x.restore(); }
    else draw(color);
    return c.toDataURL();
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

  function rowHTML(value, full, half, empty) {
    let html = "";
    for (let i = 0; i < 10; i++) {
      const v = value - i * 2;
      html += "<img src='" + (v >= 2 ? full : v >= 1 ? half : empty) + "'>";
    }
    return html;
  }
  function updateVitals(force) {
    const heartsEl = $("hearts"), airEl = $("air"), hungerEl = $("hunger");
    if (!player || mode !== "survival") {
      if (heartsEl.childElementCount) heartsEl.innerHTML = "";
      if (airEl.childElementCount) airEl.innerHTML = "";
      if (hungerEl.childElementCount) hungerEl.innerHTML = "";
      lastHeartHP = -1; lastAirN = -1; lastHungerH = -1;
      return;
    }
    const hp = Math.max(0, Math.min(player.maxHealth, player.health));
    if (force || hp !== lastHeartHP) { lastHeartHP = hp; heartsEl.innerHTML = rowHTML(hp, hearts.full, hearts.half, hearts.empty); }
    const hg = Math.max(0, Math.min(player.maxHunger, player.hunger));
    if (force || hg !== lastHungerH) { lastHungerH = hg; hungerEl.innerHTML = rowHTML(hg, drum.full, drum.half, drum.empty); }
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
      (mode === "survival" ? "HP     " + player.health + "/" + player.maxHealth + "   Food " + Math.round(player.hunger) + "/" + player.maxHunger + "\n" : "") +
      "Time   " + hour.toFixed(1) + "h" + (timeFrozen ? " (frozen)" : "") + "\n" +
      "Chunks " + world.chunks.size + "\n" +
      "Look   " + facing(player.getDir()) + " · " + look;
  }

  // ====================================================== inventory / containers
  // Generic cursor-vs-slot interaction over get()/set() accessors.
  function clickSlot(get, set, right, opts) {
    opts = opts || {};
    const slot = get();
    if (opts.takeOnly) {
      if (!slot) return;
      if (!cursor) { cursor = { id: slot.id, count: slot.count }; set(null); }
      else if (cursor.id === slot.id) {
        const mv = Math.min(Items.maxStack(slot.id) - cursor.count, slot.count);
        if (mv > 0) { cursor.count += mv; const rem = slot.count - mv; set(rem > 0 ? { id: slot.id, count: rem } : null); }
      }
      return;
    }
    const accept = opts.accept || (() => true);
    if (!right) {
      if (!cursor) { if (slot) { cursor = { id: slot.id, count: slot.count }; set(null); } }
      else if (!slot) { if (accept(cursor.id)) { set({ id: cursor.id, count: cursor.count }); cursor = null; } }
      else if (slot.id === cursor.id) {
        const mv = Math.min(Items.maxStack(slot.id) - slot.count, cursor.count);
        set({ id: slot.id, count: slot.count + mv }); cursor.count -= mv; if (cursor.count <= 0) cursor = null;
      } else if (accept(cursor.id)) { set({ id: cursor.id, count: cursor.count }); cursor = { id: slot.id, count: slot.count }; }
    } else {
      if (!cursor) { if (slot) { const half = Math.ceil(slot.count / 2); cursor = { id: slot.id, count: half }; const rem = slot.count - half; set(rem > 0 ? { id: slot.id, count: rem } : null); } }
      else if (!slot) { if (accept(cursor.id)) { set({ id: cursor.id, count: 1 }); if (--cursor.count <= 0) cursor = null; } }
      else if (slot.id === cursor.id && slot.count < Items.maxStack(slot.id)) { set({ id: slot.id, count: slot.count + 1 }); if (--cursor.count <= 0) cursor = null; }
    }
  }

  function makeSlot(stack) {
    const d = document.createElement("div"); d.className = "slot";
    const cnt = document.createElement("span"); cnt.className = "count";
    d.appendChild(cnt); paintSlot(d, stack);
    d.addEventListener("contextmenu", (e) => e.preventDefault());
    return d;
  }
  function cursorSlot(get, set, opts) {
    const d = makeSlot(get());
    d.addEventListener("mousedown", (e) => { e.preventDefault(); clickSlot(get, set, e.button === 2, opts); renderOpen(); });
    return d;
  }
  function actionSlot(stack, onClick) {
    const d = makeSlot(stack);
    d.addEventListener("mousedown", (e) => { e.preventDefault(); onClick(e.button === 2); renderOpen(); });
    return d;
  }
  const invGet = (i) => () => inv.get(i);
  const invSet = (i) => (s) => inv.set(i, s);

  function renderOpen() {
    if (invOpen) renderInventory();
    else if (containerOpen) renderContainer();
    renderHotbar(); updateCursor();
  }

  function openInventory() {
    if (!running || dead || containerOpen) return;
    invOpen = true; craftN = 2; craftGrid = new Array(4).fill(null);
    renderInventory(); $("inventory").classList.remove("hidden");
    if (document.pointerLockElement) document.exitPointerLock();
  }
  function closeInventory() {
    returnCraft();
    if (cursor) { inv.add(cursor.id, cursor.count); cursor = null; }
    invOpen = false; updateCursor(); renderHotbar();
    $("inventory").classList.add("hidden");
    if (running && !dead) canvas.requestPointerLock();
  }
  function openContainer(kind, pos) {
    if (!running || dead) return;
    containerOpen = true; containerKind = kind; containerPos = pos;
    renderContainer(); $("container").classList.remove("hidden");
    if (document.pointerLockElement) document.exitPointerLock();
  }
  function closeContainer() {
    if (containerKind === "craft") returnCraft();
    if (cursor) { inv.add(cursor.id, cursor.count); cursor = null; }
    containerOpen = false; containerKind = null; chestInv = null; furnaceState = null;
    updateCursor(); renderHotbar();
    $("container").classList.add("hidden");
    if (running && !dead) canvas.requestPointerLock();
  }
  function returnCraft() {
    for (let i = 0; i < craftGrid.length; i++) if (craftGrid[i]) { inv.add(craftGrid[i].id, craftGrid[i].count); craftGrid[i] = null; }
  }

  function gridIds() { return craftGrid.map((s) => (s ? s.id : 0)); }
  function craftResultStack() { const r = Recipes.match(gridIds(), craftN); return r ? { id: r.id, count: r.count } : null; }
  function takeCraftResult() {
    const r = Recipes.match(gridIds(), craftN);
    if (!r) return;
    if (cursor && (cursor.id !== r.id || cursor.count + r.count > Items.maxStack(r.id))) return;
    if (cursor) cursor.count += r.count; else cursor = { id: r.id, count: r.count };
    for (let i = 0; i < craftGrid.length; i++) if (craftGrid[i] && --craftGrid[i].count <= 0) craftGrid[i] = null;
  }
  function craftGridDOM(host, n) {
    host.className = "grid craftgrid n" + n;
    host.innerHTML = ""; // clear first — this element persists across re-renders
    for (let i = 0; i < n * n; i++) host.appendChild(cursorSlot(() => craftGrid[i], (s) => { craftGrid[i] = s; }));
  }

  function renderInventory() {
    const palette = $("invPalette"), mainG = $("invMain"), hotG = $("invHotbar"), craft = $("invCraft");
    $("invTitle").textContent = mode === "creative" ? "Creative Inventory" : "Inventory";
    palette.innerHTML = ""; mainG.innerHTML = ""; hotG.innerHTML = "";
    if (mode === "creative") {
      palette.style.display = "flex"; mainG.style.display = "none"; craft.style.display = "none";
      $("invHint").innerHTML = "Click a block to bind it to the selected hotbar slot · right-click a slot to clear";
      Blocks.CREATIVE.forEach((id) => palette.appendChild(actionSlot({ id, count: Infinity }, () => {
        creativeHotbar[selectedIndex] = id;
      })));
      for (let i = 0; i < 9; i++) {
        const slot = actionSlot(hotStack(i), (right) => { if (right) creativeHotbar[i] = 0; else selectedIndex = i; });
        if (i === selectedIndex) slot.classList.add("selected");
        hotG.appendChild(slot);
      }
    } else {
      palette.style.display = "none"; mainG.style.display = "flex"; craft.style.display = "flex";
      $("invHint").innerHTML = "Click to pick up / place · right-click for one · <span class='k'>E</span>/<span class='k'>Esc</span> to close";
      craftGridDOM($("invCraftGrid"), 2);
      $("invCraftResult").innerHTML = "";
      $("invCraftResult").appendChild(actionSlot(craftResultStack(), takeCraftResult));
      for (let i = 9; i < 36; i++) mainG.appendChild(cursorSlot(invGet(i), invSet(i)));
      for (let i = 0; i < 9; i++) {
        const slot = cursorSlot(invGet(i), invSet(i));
        if (i === selectedIndex) slot.classList.add("selected");
        hotG.appendChild(slot);
      }
    }
  }

  function renderContainer() {
    const panel = $("ctPanel"), mainG = $("ctMain"), hotG = $("ctHotbar");
    panel.innerHTML = ""; mainG.innerHTML = ""; hotG.innerHTML = "";
    if (containerKind === "chest") {
      $("ctTitle").textContent = "Chest";
      const g = document.createElement("div"); g.className = "grid";
      for (let i = 0; i < 27; i++) g.appendChild(cursorSlot(() => chestInv.get(i), (s) => chestInv.set(i, s)));
      panel.appendChild(g);
    } else if (containerKind === "craft") {
      $("ctTitle").textContent = "Crafting Table";
      const wrap = document.createElement("div"); wrap.className = "craftarea";
      const grid = document.createElement("div"); craftGridDOM(grid, 3);
      const arrow = document.createElement("div"); arrow.className = "arrow"; arrow.textContent = "➜";
      const res = document.createElement("div"); res.className = "grid resultgrid";
      res.appendChild(actionSlot(craftResultStack(), takeCraftResult));
      wrap.append(grid, arrow, res); panel.appendChild(wrap);
    } else if (containerKind === "furnace") {
      $("ctTitle").textContent = "Furnace";
      const wrap = document.createElement("div"); wrap.className = "furnace-layout";
      const col = document.createElement("div"); col.className = "furnace-col";
      col.appendChild(cursorSlot(() => furnaceState.input, (s) => { furnaceState.input = s; }));
      const burn = document.createElement("div"); burn.className = "furnace-burn" + (Furnace.lit(furnaceState) ? " lit" : ""); burn.textContent = "🔥";
      col.appendChild(burn);
      col.appendChild(cursorSlot(() => furnaceState.fuel, (s) => { furnaceState.fuel = s; }, { accept: (id) => Items.fuelTime(id) > 0 }));
      const ar = document.createElement("div"); ar.className = "cook-arrow";
      ar.innerHTML = "<div class='cook-bar'><div class='cook-fill' style='width:" + Math.min(100, furnaceState.cook / Furnace.COOK_TIME * 100) + "%'></div></div>";
      const out = cursorSlot(() => furnaceState.output, (s) => { furnaceState.output = s; }, { takeOnly: true });
      wrap.append(col, ar, out); panel.appendChild(wrap);
    }
    for (let i = 9; i < 36; i++) mainG.appendChild(cursorSlot(invGet(i), invSet(i)));
    for (let i = 0; i < 9; i++) {
      const slot = cursorSlot(invGet(i), invSet(i));
      if (i === selectedIndex) slot.classList.add("selected");
      hotG.appendChild(slot);
    }
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

  // ====================================================== mods & texture packs
  const MODS_KEY = "clockworld_mods", PACKS_KEY = "clockworld_packs", ACTIVEPACK_KEY = "clockworld_activepack";
  const BUILTIN_PACKS = {
    Grayscale: { grass_top: "#9a9a9a", grass_side: "#8a8a8a", dirt: "#777", stone: "#9b9b9b", cobblestone: "#888", sand: "#cfcfcf", water: "#6f8aa0", leaves: "#888", log_side: "#6b6b6b", log_top: "#7a7a7a", planks: "#a0a0a0" },
    Candy: { grass_top: "#7ee0a0", grass_side: "#e89ad0", dirt: "#c98ad0", stone: "#f2c6e0", sand: "#fff0b0", water: "#7ad0ff", leaves: "#a0f0c0", planks: "#ffb0d0", log_side: "#d080b0" },
  };
  function getMods() { try { return JSON.parse(localStorage.getItem(MODS_KEY) || "[]"); } catch (e) { return []; } }
  function setMods(a) { try { localStorage.setItem(MODS_KEY, JSON.stringify(a)); } catch (e) { /* ignore */ } }
  function getPacks() { try { return JSON.parse(localStorage.getItem(PACKS_KEY) || "[]"); } catch (e) { return []; } }
  function setPacks(a) { try { localStorage.setItem(PACKS_KEY, JSON.stringify(a)); } catch (e) { /* ignore */ } }
  function getActivePack() { try { return localStorage.getItem(ACTIVEPACK_KEY) || ""; } catch (e) { return ""; } }
  function setActivePack(n) { try { if (n) localStorage.setItem(ACTIVEPACK_KEY, n); else localStorage.removeItem(ACTIVEPACK_KEY); } catch (e) { /* ignore */ } }
  function allPacks() { const m = Object.assign({}, BUILTIN_PACKS); getPacks().forEach((p) => { m[p.name] = p.map; }); return m; }

  function loadModsAndPacks() {
    const active = getActivePack();
    if (active) { const packs = allPacks(); if (packs[active]) window.Textures.setPack(packs[active]); }
    getMods().forEach((mo) => { if (mo.enabled) window.Mods.run(mo.code, mo.name); });
  }

  function mkModRow(label, on, onToggle, onDelete) {
    const row = document.createElement("div"); row.className = "world-row" + (on ? " on" : "");
    const info = document.createElement("div"); info.className = "winfo";
    info.innerHTML = "<div class='wname'>" + escapeHtml(label) + "</div>";
    const use = document.createElement("button"); use.className = "iconbtn"; use.textContent = on ? "✓ on" : "Use";
    use.addEventListener("click", onToggle);
    row.append(info, use);
    if (onDelete) { const del = document.createElement("button"); del.className = "iconbtn danger"; del.textContent = "✕"; del.addEventListener("click", onDelete); row.append(del); }
    return row;
  }
  function renderMods() {
    const active = getActivePack(), packs = allPacks();
    const pl = $("packList"); pl.innerHTML = "";
    pl.appendChild(mkModRow("None (procedural default)", active === "", () => { setActivePack(""); renderMods(); }, null));
    Object.keys(packs).forEach((name) => {
      const builtin = name in BUILTIN_PACKS;
      pl.appendChild(mkModRow(name + (builtin ? " · built-in" : ""), active === name,
        () => { setActivePack(name); renderMods(); },
        builtin ? null : () => { setPacks(getPacks().filter((p) => p.name !== name)); if (active === name) setActivePack(""); renderMods(); }));
    });
    const ml = $("modList"); ml.innerHTML = "";
    const mods = getMods();
    if (!mods.length) ml.innerHTML = "<p class='muted'>No mods installed.</p>";
    mods.forEach((mo, i) => {
      ml.appendChild(mkModRow(mo.name + (mo.enabled ? "" : " · disabled"), mo.enabled,
        () => { mods[i].enabled = !mods[i].enabled; setMods(mods); renderMods(); },
        () => { mods.splice(i, 1); setMods(mods); renderMods(); }));
    });
  }
  function openMods() { renderMods(); $("menu").classList.add("hidden"); $("mods").classList.remove("hidden"); }
  function closeMods() { $("mods").classList.add("hidden"); $("menu").classList.remove("hidden"); }

  // ====================================================== input
  function wireInput() {
    $("createBtn").addEventListener("click", () => {
      const m = saves.create($("wName").value || "World", parseSeed($("wSeed").value),
        document.querySelector("input[name=mode]:checked").value);
      renderWorldList(); startWorld(m);
    });
    $("joinHereBtn").addEventListener("click", () => connectMP(sameOriginWS(), $("mpName").value.trim()));
    $("connectBtn").addEventListener("click", () => connectMP($("mpUrl").value.trim(), $("mpName").value.trim()));

    $("modsBtn").addEventListener("click", openMods);
    $("modsBack").addEventListener("click", closeMods);
    $("modsApply").addEventListener("click", () => window.location.reload());
    $("modAdd").addEventListener("click", () => {
      const code = $("modCode").value; if (!code.trim()) return;
      const mods = getMods();
      mods.push({ name: $("modName").value.trim() || ("Mod " + (mods.length + 1)), code, enabled: true });
      setMods(mods); $("modName").value = ""; $("modCode").value = ""; renderMods();
    });
    $("modImport").addEventListener("click", () => $("modFile").click());
    $("modFile").addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => { const mods = getMods(); mods.push({ name: f.name.replace(/\.js$/, ""), code: String(r.result), enabled: true }); setMods(mods); renderMods(); };
      r.readAsText(f); e.target.value = "";
    });
    $("packImport").addEventListener("click", () => $("packFile").click());
    $("packFile").addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const j = JSON.parse(r.result);
          const name = j.name || f.name.replace(/\.json$/, "");
          const map = j.tiles || j.map || j;
          const packs = getPacks().filter((p) => p.name !== name);
          packs.push({ name, map }); setPacks(packs); setActivePack(name); renderMods();
        } catch (err) { /* ignore bad pack */ }
      };
      r.readAsText(f); e.target.value = "";
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
    $("vrBtn").addEventListener("click", enterVR);
    $("pSaveBtn").addEventListener("click", () => { saveCurrent(); $("pSaveBtn").textContent = "Saved ✓"; setTimeout(() => ($("pSaveBtn").textContent = "Save"), 1200); });
    $("pModeBtn").addEventListener("click", switchMode);
    $("pExportBtn").addEventListener("click", exportCurrent);
    $("quitBtn").addEventListener("click", quitToMenu);
    $("respawnBtn").addEventListener("click", respawn);
    $("dQuitBtn").addEventListener("click", quitToMenu);

    canvas.addEventListener("click", () => { if (running && !anyUIOpen()) canvas.requestPointerLock(); });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("pointerlockchange", () => {
      locked = document.pointerLockElement === canvas;
      if (locked) { $("pause").classList.add("hidden"); }
      else if (running) {
        mouseDown[0] = mouseDown[2] = false; resetMine();
        if (dead) $("death").classList.remove("hidden");
        else if (invOpen) $("inventory").classList.remove("hidden");
        else if (containerOpen) $("container").classList.remove("hidden");
        else { $("pModeBtn").textContent = "Mode: " + mode; $("pause").classList.remove("hidden"); saveCurrent(); }
      }
    });

    document.addEventListener("mousemove", (e) => {
      if (locked && !chatOpen) player.applyMouse(e.movementX || 0, e.movementY || 0);
      else if (invOpen || containerOpen) { mouseX = e.clientX; mouseY = e.clientY; updateCursor(); }
    });
    document.addEventListener("mousedown", (e) => {
      if (!locked) return;
      e.preventDefault();
      const eye = player.getEye(), dir = player.getDir();
      const target = world.raycast(eye, dir, REACH);
      if (e.button === 0) { mouseDown[0] = true; if (player.creative) { breakInstant(target); breakTimer = 0.2; } else breakTimer = 0; }
      else if (e.button === 2) {
        const tid = target ? world.getBlock(target.hit[0], target.hit[1], target.hit[2]) : 0;
        if (tid && Blocks.interactOf(tid)) { interactBlock(tid, target.hit); }   // open/toggle, don't place
        else { mouseDown[2] = true; eatTimer = 0; if (!heldFood()) { place(target); placeTimer = 0.22; } }
      } else if (e.button === 1) pickBlock(target);
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
      if (chatOpen) {
        e.preventDefault();
        if (e.code === "Enter") closeChat(true);
        else if (e.code === "Escape") closeChat(false);
        else if (e.code === "Backspace") { chatBuf = chatBuf.slice(0, -1); renderChatInput(); }
        else if (e.key && e.key.length === 1 && chatBuf.length < 100) { chatBuf += e.key; renderChatInput(); }
        return;
      }
      if (online && locked && e.code === "Enter" && !anyUIOpen()) { openChat(); e.preventDefault(); return; }
      if (e.code === "KeyE") {
        if (locked) openInventory(); else if (invOpen) closeInventory(); else if (containerOpen) closeContainer();
        return;
      }
      if (e.code === "Escape") { if (invOpen) closeInventory(); else if (containerOpen) closeContainer(); return; }
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
