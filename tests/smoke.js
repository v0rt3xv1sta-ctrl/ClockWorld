/*
 * Headless smoke test. Stubs the browser (DOM, WebGL, 2D canvas, localStorage,
 * pointer lock, rAF) and runs the real game scripts end to end: world menu ->
 * survival play (move/mine, inventory + crafting grid) -> creative (fly, bind
 * blocks, place & open a chest / crafting table / furnace, toggle a door) ->
 * quit. Surfaces wiring/reference errors without a real browser.
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

// a thenable that resolves synchronously, so VR.start's promise chain runs inline
function syncThenable(v) {
  return { then: (res) => { const r = res(v); return (r && r.then) ? r : syncThenable(r); }, catch: () => syncThenable(v) };
}
function makeGL() {
  const fns = {
    getShaderParameter: () => true, getProgramParameter: () => true,
    getShaderInfoLog: () => "", getProgramInfoLog: () => "",
    createShader: () => ({}), createProgram: () => ({}),
    getAttribLocation: () => 0, getUniformLocation: () => ({}),
    createBuffer: () => ({}), createTexture: () => ({}), getExtension: () => ({}),
    makeXRCompatible: () => syncThenable(),
  };
  return new Proxy(fns, {
    get(t, p) { if (p in t) return t[p]; if (typeof p === "string" && /^[A-Z0-9_]+$/.test(p)) return 1; return () => {}; },
  });
}
const gl = makeGL();
function make2D() {
  return new Proxy({}, {
    get(t, p) { return /Style$|imageSmoothingEnabled|lineWidth|globalAlpha|font|width|height/.test(p) ? "" : () => {}; },
    set() { return true; },
  });
}

const docListeners = {};
function dispatch(type, ev) { (docListeners[type] || []).forEach((cb) => cb(ev || {})); }

function makeEl() {
  const el = {
    style: {}, _children: [], _t: "", _h: "", _l: {}, value: "", files: [],
    classList: { _s: new Set(), toggle(c, f) { f === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (f ? this._s.add(c) : this._s.delete(c)); }, add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    appendChild(c) { this._children.push(c); return c; },
    append(...cs) { cs.forEach((c) => this._children.push(c)); },
    addEventListener(t, cb) { (this._l[t] = this._l[t] || []).push(cb); },
    removeEventListener() {},
    dispatch(t, ev) { (this._l[t] || []).forEach((cb) => cb(ev || { preventDefault() {}, button: 0 })); },
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    requestPointerLock() { sandbox.document.pointerLockElement = this; dispatch("pointerlockchange"); },
    click() { this.dispatch("click", { preventDefault() {} }); },
    getContext(type) { return type === "2d" ? make2D() : gl; },
    toDataURL() { return "data:,"; },
    querySelector() { return makeEl(); },
    width: 256, height: 256, clientWidth: 800, clientHeight: 600,
  };
  Object.defineProperty(el, "children", { get() { return this._children; } });
  Object.defineProperty(el, "childElementCount", { get() { return this._children.length; } });
  Object.defineProperty(el, "textContent", { get() { return this._t; }, set(v) { this._t = v; } });
  Object.defineProperty(el, "innerHTML", { get() { return this._h; }, set(v) { this._h = v; this._children = []; } });
  return el;
}

const els = {};
function mem() { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }; }

const sandbox = {};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
sandbox.console = console; sandbox.devicePixelRatio = 1;
sandbox.performance = { now: () => Date.now() };
sandbox.WebGL2RenderingContext = function () {};
sandbox.setInterval = () => 0; sandbox.clearInterval = () => {};
sandbox.setTimeout = (fn) => { if (typeof fn === "function") fn(); return 0; };
sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
sandbox.confirm = () => true; sandbox.alert = () => {};
sandbox.Blob = function () {}; sandbox.URL = { createObjectURL: () => "blob:x", revokeObjectURL() {} };
sandbox.FileReader = function () { this.readAsText = () => { this.result = "{}"; if (this.onload) this.onload(); }; };
let lastWS = null;
sandbox.WebSocket = function (url) {
  this.url = url; this.readyState = 1; this.sent = [];
  this.onopen = this.onmessage = this.onclose = this.onerror = null;
  this.send = (s) => this.sent.push(s);
  this.close = () => { this.readyState = 3; if (this.onclose) this.onclose(); };
  lastWS = this;
};
// fake WebXR so the VR session loop can be driven synchronously
let xrFrameCb = null;
const fakeSession = {
  updateRenderState() {}, requestReferenceSpace: () => syncThenable({}),
  requestAnimationFrame: (cb) => { xrFrameCb = cb; }, end() {},
  addEventListener: (t, cb) => { if (t === "end") fakeSession._end = cb; },
  inputSources: [
    { handedness: "right", gamepad: { axes: [0, 0, 0, -1], buttons: [{ pressed: false }, { pressed: false }, {}, {}, { pressed: false }] } },
    { handedness: "left", gamepad: { axes: [0, 0, 0, 0], buttons: [] } },
  ],
};
sandbox.navigator = { xr: { isSessionSupported: () => Promise.resolve(true), requestSession: () => syncThenable(fakeSession) } };
sandbox.XRWebGLLayer = function () { this.framebuffer = null; this.getViewport = () => ({ x: 0, y: 0, width: 64, height: 64 }); };
function fakeFrame() {
  return {
    session: fakeSession,
    getViewerPose: () => ({
      transform: { orientation: { x: 0, y: 0, z: 0, w: 1 } },
      views: [{ transform: { inverse: { matrix: sandbox.Mat4.identity() }, position: { x: 0, y: 1.6, z: 0 } }, projectionMatrix: sandbox.Mat4.identity() }],
    }),
  };
}

sandbox.localStorage = mem();
// pre-seed a mod and an active texture pack so startup mod/pack loading is exercised
sandbox.localStorage.setItem("clockworld_mods", JSON.stringify([{ name: "smoke", code: "ClockWorld.defineBlock({ name: 'SmokeBlock', color: '#00ff00', hardness: 1 }); ClockWorld.on('blockPlace', function () {});", enabled: true }]));
sandbox.localStorage.setItem("clockworld_activepack", "Candy");
let rafCb = null;
sandbox.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
sandbox.document = {
  readyState: "complete", pointerLockElement: null,
  getElementById(id) { return els[id] || (els[id] = makeEl()); },
  createElement() { return makeEl(); },
  addEventListener(t, cb) { (docListeners[t] = docListeners[t] || []).push(cb); },
  removeEventListener() {},
  querySelector() { return makeEl(); },
  exitPointerLock() { sandbox.document.pointerLockElement = null; dispatch("pointerlockchange"); },
};
const EV = { preventDefault() {}, stopPropagation() {} };

const ctx = vm.createContext(sandbox);
["math", "noise", "blocks", "liquids", "items", "recipes", "furnace", "mods", "inventory", "saves", "textures", "world", "renderer", "player", "net", "vr", "main"]
  .forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", f + ".js"), "utf8"), ctx, { filename: f + ".js" }));

const B = sandbox.Blocks;
let frames = 0, t = 1000;
function run(n) { for (let i = 0; i < n; i++) { if (!rafCb) throw new Error("no frame scheduled"); const cb = rafCb; rafCb = null; cb((t += 16)); frames++; } }
function key(code, extra) { dispatch("keydown", Object.assign({ code, repeat: false }, EV, extra)); }
function keyUp(code) { dispatch("keyup", Object.assign({ code }, EV)); }
function mdown(button) { dispatch("mousedown", Object.assign({ button }, EV)); }
function mup(button) { dispatch("mouseup", Object.assign({ button }, EV)); }
function assert(c, m) { if (!c) throw new Error("assert: " + m); }

// startup mod ran and registered a block; texture pack was applied
assert(B.BLOCKS.some((b) => b && b.name === "SmokeBlock"), "startup mod defined a block");

// menu -> Mods & texture packs screen
run(2);
els.modsBtn.dispatch("click", EV);
assert(!els.mods.classList.contains("hidden"), "mods screen opens");
assert(els.packList._children.length >= 1 && els.modList._children.length >= 1, "packs and mods listed");
sandbox.document.getElementById("modCode").value = "ClockWorld.log('hi');";
sandbox.document.getElementById("modName").value = "added";
els.modAdd.dispatch("click", EV);
els.modsBack.dispatch("click", EV);
assert(!els.menu.classList.contains("hidden"), "returned to menu from mods");

// menu -> create a survival world
els.createBtn.dispatch("click", EV);
assert(sandbox.document.pointerLockElement === els.game, "world locked pointer");
run(3);

// survival: look, move, mine
dispatch("mousemove", Object.assign({ movementX: 12, movementY: -3 }, EV));
key("KeyW"); mdown(0); run(25); mup(0); keyUp("KeyW");

// inventory + 2x2 crafting grid open/click/close
key("KeyE");
assert(!els.inventory.classList.contains("hidden"), "inventory opened");
assert(els.invCraftGrid._children.length === 4, "2x2 craft grid has exactly 4 slots");
// click the craft grid / result / main repeatedly — none of these may grow the DOM
for (let i = 0; i < 12; i++) {
  els.invCraftGrid._children[0].dispatch("mousedown", { button: 0, preventDefault() {} });
  els.invCraftResult._children[0].dispatch("mousedown", { button: 0, preventDefault() {} });
  els.invMain._children[0].dispatch("mousedown", { button: 2, preventDefault() {} });
  assert(els.invCraftGrid._children.length === 4, "craft grid stays 4 slots (click " + (i + 1) + ")");
  assert(els.invCraftResult._children.length === 1, "craft result stays 1 slot (click " + (i + 1) + ")");
  assert(els.invMain._children.length === 27, "main inventory stays 27 slots (click " + (i + 1) + ")");
}
key("KeyE");
run(2);

// switch to creative
els.pModeBtn.dispatch("click", EV);
run(2);

// helper: bind a creative block to hotbar slot 0, then place & interact below
function bind(blockId) {
  key("KeyE"); // creative inventory (palette)
  const idx = B.CREATIVE.indexOf(blockId);
  els.invPalette._children[idx].dispatch("mousedown", { button: 0, preventDefault() {} });
  key("KeyE");
}
function lookDownAndRise() {
  key("Space"); run(14); keyUp("Space");          // fly up a couple of blocks
  dispatch("mousemove", Object.assign({ movementX: 0, movementY: 1200 }, EV)); // look straight down
}

lookDownAndRise();

// chest: place then open
bind(B.ID.CHEST);
mdown(2); mup(2);              // places chest below
run(2);
mdown(2);                     // right-click the chest -> open container
let openedChest = !els.container.classList.contains("hidden");
if (openedChest && els.ctMain._children[0]) els.ctMain._children[0].dispatch("mousedown", { button: 0, preventDefault() {} });
if (openedChest) { key("KeyE"); run(2); }

// crafting table
bind(B.ID.CRAFTING);
mdown(2); mup(2); run(2);
mdown(2);
let openedCraft = !els.container.classList.contains("hidden");
if (openedCraft) { key("KeyE"); run(2); }

// furnace (let it tick a few frames while open)
bind(B.ID.FURNACE);
mdown(2); mup(2); run(2);
mdown(2);
let openedFurnace = !els.container.classList.contains("hidden");
if (openedFurnace) { run(8); key("KeyE"); run(2); }

// door: place and toggle (no UI)
bind(B.ID.DOOR);
mdown(2); mup(2); run(2);
mdown(2); run(2); // toggles door open/closed

assert(openedChest, "chest container opened");
assert(openedCraft, "crafting table container opened");
assert(openedFurnace, "furnace container opened");

// quit to menu and confirm persistence
els.quitBtn.dispatch("click", EV);
assert(!els.menu.classList.contains("hidden"), "returned to menu");
const reg = JSON.parse(sandbox.localStorage.getItem("clockworld_worlds") || "{}");
assert(Object.keys(reg).length >= 1, "world saved to storage");

// ---- multiplayer client (stubbed socket) ----
sandbox.document.getElementById("acctUser").value = "Tester";
sandbox.document.getElementById("acctPass").value = "pw12";
els.connectBtn.dispatch("click", EV);
assert(lastWS, "websocket created on connect");
lastWS.onopen();
assert(lastWS.sent.some((s) => s.includes("join")), "client sends join on open");
lastWS.onmessage({ data: JSON.stringify({ t: "welcome", id: 1, seed: 7, mode: "creative", edits: {}, players: [{ id: 2, name: "Bob", pos: [3, 70, 3], yaw: 0, pitch: 0 }] }) });
assert(lastWS.sent.some((s) => s.includes("login")), "client sends account login after welcome");
lastWS.onmessage({ data: JSON.stringify({ t: "authok", name: "Tester", token: "tok123" }) });
assert(sandbox.document.pointerLockElement === els.game, "online world locked pointer");
assert(!els.chat.classList.contains("hidden"), "chat shown when online");
run(6); // renders remote avatar + sends movement
assert(lastWS.sent.some((s) => s.includes("move")), "client streams movement");
lastWS.onmessage({ data: JSON.stringify({ t: "move", id: 2, pos: [4, 70, 4], yaw: 1, pitch: 0 }) });
lastWS.onmessage({ data: JSON.stringify({ t: "set", x: 1, y: 65, z: 1, id: 3 }) });
lastWS.onmessage({ data: JSON.stringify({ t: "chat", id: 2, name: "Bob", text: "hi there" }) });
lastWS.onmessage({ data: JSON.stringify({ t: "player", id: 5, name: "Cara", pos: [2, 70, 2] }) });
lastWS.onmessage({ data: JSON.stringify({ t: "leave", id: 5 }) });
run(4);
// open chat, type, send
key("Enter");
dispatch("keydown", Object.assign({ code: "KeyH", key: "h" }, EV));
dispatch("keydown", Object.assign({ code: "KeyI", key: "i" }, EV));
key("Enter");
assert(lastWS.sent.some((s) => s.includes("chat")), "client sends chat");
run(2);
els.quitBtn.dispatch("click", EV);
assert(!els.menu.classList.contains("hidden"), "multiplayer quit returns to menu");

// ---- VR: enter a world, drive XR frames with the fake headset, then exit ----
els.createBtn.dispatch("click", EV);
els.vrBtn.dispatch("click", EV); // enterVR -> sync-thenable fake XR session
assert(xrFrameCb, "VR session started and scheduled an XR frame");
xrFrameCb(1000, fakeFrame()); // drives vrUpdate + per-eye vrRenderEye
xrFrameCb(1016, fakeFrame());
assert(fakeSession._end, "VR session registered an end handler");
fakeSession._end(); // simulate taking the headset off
assert(!els.pause.classList.contains("hidden"), "VR exit returns to the pause menu");

if (frames < 80) throw new Error("too few frames: " + frames);
console.log("Smoke test OK — " + frames + " frames: survival, crafting, interactables, multiplayer, VR, quit.");
