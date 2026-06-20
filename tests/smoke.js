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

function makeGL() {
  const fns = {
    getShaderParameter: () => true, getProgramParameter: () => true,
    getShaderInfoLog: () => "", getProgramInfoLog: () => "",
    createShader: () => ({}), createProgram: () => ({}),
    getAttribLocation: () => 0, getUniformLocation: () => ({}),
    createBuffer: () => ({}), createTexture: () => ({}), getExtension: () => ({}),
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
sandbox.localStorage = mem();
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
["math", "noise", "blocks", "items", "recipes", "furnace", "inventory", "saves", "textures", "world", "renderer", "player", "net", "main"]
  .forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", f + ".js"), "utf8"), ctx, { filename: f + ".js" }));

const B = sandbox.Blocks;
let frames = 0, t = 1000;
function run(n) { for (let i = 0; i < n; i++) { if (!rafCb) throw new Error("no frame scheduled"); const cb = rafCb; rafCb = null; cb((t += 16)); frames++; } }
function key(code, extra) { dispatch("keydown", Object.assign({ code, repeat: false }, EV, extra)); }
function keyUp(code) { dispatch("keyup", Object.assign({ code }, EV)); }
function mdown(button) { dispatch("mousedown", Object.assign({ button }, EV)); }
function mup(button) { dispatch("mouseup", Object.assign({ button }, EV)); }
function assert(c, m) { if (!c) throw new Error("assert: " + m); }

// menu -> create a survival world
run(2);
els.createBtn.dispatch("click", EV);
assert(sandbox.document.pointerLockElement === els.game, "world locked pointer");
run(3);

// survival: look, move, mine
dispatch("mousemove", Object.assign({ movementX: 12, movementY: -3 }, EV));
key("KeyW"); mdown(0); run(25); mup(0); keyUp("KeyW");

// inventory + 2x2 crafting grid open/click/close
key("KeyE");
assert(!els.inventory.classList.contains("hidden"), "inventory opened");
if (els.invCraftGrid._children[0]) els.invCraftGrid._children[0].dispatch("mousedown", { button: 0, preventDefault() {} });
if (els.invCraftResult._children[0]) els.invCraftResult._children[0].dispatch("mousedown", { button: 0, preventDefault() {} });
if (els.invMain._children[0]) els.invMain._children[0].dispatch("mousedown", { button: 2, preventDefault() {} });
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

if (frames < 70) throw new Error("too few frames: " + frames);
console.log("Smoke test OK — " + frames + " frames: survival, crafting, chest/table/furnace/door, quit.");
