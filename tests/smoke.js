/*
 * Headless smoke test. Stubs the browser (DOM, WebGL, 2D canvas, localStorage,
 * pointer lock, rAF) and runs the real game scripts end to end: world menu ->
 * create world -> survival play (move/mine/place) -> inventory -> switch to
 * creative -> fly/break -> pause/resume -> quit. Surfaces wiring/reference
 * errors without a real browser.
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

// ---- WebGL stub ----
function makeGL() {
  const fns = {
    getShaderParameter: () => true, getProgramParameter: () => true,
    getShaderInfoLog: () => "", getProgramInfoLog: () => "",
    createShader: () => ({}), createProgram: () => ({}),
    getAttribLocation: () => 0, getUniformLocation: () => ({}),
    createBuffer: () => ({}), createTexture: () => ({}), getExtension: () => ({}),
  };
  return new Proxy(fns, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === "string" && /^[A-Z0-9_]+$/.test(p)) return 1;
      return () => {};
    },
  });
}
const gl = makeGL();

// 2D context: no-op methods, settable props.
function make2D() {
  return new Proxy({}, {
    get(t, p) { return /Style$|imageSmoothingEnabled|lineWidth|globalAlpha|font|width|height/.test(p) ? "" : () => {}; },
    set() { return true; },
  });
}

// ---- DOM ----
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
    dispatch(t, ev) { (this._l[t] || []).forEach((cb) => cb(ev || { preventDefault() {} })); },
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
function mem() {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
}

const sandbox = {};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
sandbox.console = console;
sandbox.devicePixelRatio = 1;
sandbox.performance = { now: () => Date.now() };
sandbox.WebGL2RenderingContext = function () {};
sandbox.setInterval = () => 0; sandbox.clearInterval = () => {};
sandbox.setTimeout = (fn) => { if (typeof fn === "function") fn(); return 0; };
sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
sandbox.confirm = () => true; sandbox.alert = () => {};
sandbox.Blob = function () {};
sandbox.URL = { createObjectURL: () => "blob:x", revokeObjectURL() {} };
sandbox.FileReader = function () { this.readAsText = () => { this.result = '{"format":"clockworld","version":1,"meta":{"name":"x","seed":1,"mode":"survival"},"data":{"seed":1,"mode":"survival","edits":{}}}'; if (this.onload) this.onload(); }; };
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

// ---- load scripts ----
const ctx = vm.createContext(sandbox);
["math", "noise", "blocks", "inventory", "saves", "textures", "world", "renderer", "player", "main"]
  .forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", f + ".js"), "utf8"), ctx, { filename: f + ".js" }));

let frames = 0, t = 1000;
function run(n) { for (let i = 0; i < n; i++) { if (!rafCb) throw new Error("no frame scheduled"); const cb = rafCb; rafCb = null; cb((t += 16)); frames++; } }

// menu visible, world rendering behind it
run(2);

// create a survival world and start playing
els.createBtn.dispatch("click", EV);
if (sandbox.document.pointerLockElement !== els.game) throw new Error("world did not lock pointer on start");
run(3);

// look + move + mine + place (survival)
dispatch("mousemove", Object.assign({ movementX: 15, movementY: -5 }, EV));
dispatch("keydown", Object.assign({ code: "KeyW", repeat: false }, EV));
dispatch("mousedown", Object.assign({ button: 0 }, EV)); // start mining
run(30);
dispatch("mouseup", Object.assign({ button: 0 }, EV));
dispatch("keydown", Object.assign({ code: "Digit2", repeat: false }, EV));
dispatch("mousedown", Object.assign({ button: 2 }, EV)); // place
run(8);
dispatch("mouseup", Object.assign({ button: 2 }, EV));

// open inventory, click a couple of slots, close
dispatch("keydown", Object.assign({ code: "KeyE", repeat: false }, EV));
if (els.inventory.classList.contains("hidden")) throw new Error("inventory did not open");
if (els.invMain._children[0]) els.invMain._children[0].dispatch("mousedown", Object.assign({ button: 0 }, EV));
if (els.invHotbar._children[0]) els.invHotbar._children[0].dispatch("mousedown", Object.assign({ button: 0 }, EV));
dispatch("mousemove", Object.assign({ clientX: 100, clientY: 100 }, EV));
dispatch("keydown", Object.assign({ code: "KeyE", repeat: false }, EV)); // close -> relock
run(3);

// switch to creative via pause, then fly + instant break
els.pModeBtn.dispatch("click", EV);
dispatch("keydown", Object.assign({ code: "KeyF", repeat: false }, EV));
dispatch("keydown", Object.assign({ code: "Space", repeat: false }, EV));
dispatch("mousedown", Object.assign({ button: 0 }, EV));
run(20);
dispatch("mousedown", Object.assign({ button: 1 }, EV)); // pick block
dispatch("mouseup", Object.assign({ button: 0 }, EV));

// creative inventory (palette) open/close
dispatch("keydown", Object.assign({ code: "KeyE", repeat: false }, EV));
if (els.invPalette._children[0]) els.invPalette._children[0].dispatch("mousedown", Object.assign({ button: 0 }, EV));
dispatch("keydown", Object.assign({ code: "Escape" }, EV));
run(3);

// pause (esc -> unlock) then resume
sandbox.document.exitPointerLock();
if (els.pause.classList.contains("hidden")) throw new Error("pause did not show on unlock");
els.resumeBtn.dispatch("click", EV);
run(3);

// respawn button path (harmless when alive) + quit to menu
els.respawnBtn.dispatch("click", EV);
run(2);
els.quitBtn.dispatch("click", EV);
if (els.menu.classList.contains("hidden")) throw new Error("quit did not return to menu");
run(2);

// the world we created should be persisted and listed
const reg = JSON.parse(sandbox.localStorage.getItem("clockworld_worlds") || "{}");
if (Object.keys(reg).length < 1) throw new Error("world was not saved to storage");

if (frames < 70) throw new Error("too few frames: " + frames);
console.log("Smoke test OK — ran " + frames + " frames through menu, survival, inventory, creative, pause and quit.");
