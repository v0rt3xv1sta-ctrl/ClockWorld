/*
 * Headless smoke test. Stubs the browser APIs (DOM, WebGL, 2D canvas,
 * localStorage, rAF) and runs the actual game scripts through init() and a
 * number of frames — including the pointer-locked path (look, move, break,
 * place, fly) — to surface wiring/reference errors without a real browser.
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

// ---- WebGL stub: no-op methods, integer constants, truthy resource handles --
function makeGL() {
  const fns = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    createShader: () => ({}),
    createProgram: () => ({}),
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    createBuffer: () => ({}),
    createTexture: () => ({}),
    getExtension: () => ({}),
  };
  return new Proxy(fns, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === "string" && /^[A-Z0-9_]+$/.test(prop)) return 1; // GL constant
      return () => {}; // any other method is a no-op
    },
  });
}
const gl = makeGL();

function make2D() {
  return { imageSmoothingEnabled: false, fillStyle: "", fillRect() {}, drawImage() {} };
}

function makeEl() {
  const el = {
    style: {}, _children: [], _t: "", _h: "",
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild(c) { this._children.push(c); return c; },
    addEventListener() {},
    removeEventListener() {},
    requestPointerLock() {},
    getContext(type) { return type === "2d" ? make2D() : gl; },
    toDataURL() { return "data:,"; },
    querySelector() { return makeEl(); },
    width: 256, height: 256, clientWidth: 800, clientHeight: 600,
  };
  Object.defineProperty(el, "children", { get() { return this._children; } });
  Object.defineProperty(el, "textContent", { get() { return this._t; }, set(v) { this._t = v; } });
  Object.defineProperty(el, "innerHTML", { get() { return this._h; }, set(v) { this._h = v; } });
  return el;
}

const els = {};
const docListeners = {};
const sandbox = {};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.console = console;
sandbox.devicePixelRatio = 1;
sandbox.performance = { now: () => Date.now() };
sandbox.WebGL2RenderingContext = function () {};
sandbox.setInterval = () => 0;
sandbox.clearInterval = () => {};
sandbox.setTimeout = (fn) => { fn(); return 0; };
sandbox.addEventListener = () => {};          // window.addEventListener
sandbox.removeEventListener = () => {};
let rafCb = null;
sandbox.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
sandbox.document = {
  readyState: "complete",
  pointerLockElement: null,
  getElementById(id) { return els[id] || (els[id] = makeEl()); },
  createElement() { return makeEl(); },
  addEventListener(t, cb) { (docListeners[t] = docListeners[t] || []).push(cb); },
  removeEventListener() {},
  querySelector() { return makeEl(); },
};
function dispatch(type, ev) { (docListeners[type] || []).forEach((cb) => cb(ev || {})); }
const NOOP_EVENT = { preventDefault() {}, stopPropagation() {} };

// ---- load and run the real game scripts in one shared context --------------
const ctx = vm.createContext(sandbox);
const files = ["math", "noise", "blocks", "textures", "world", "renderer", "player", "main"];
for (const f of files) {
  const p = path.join(__dirname, "..", "js", f + ".js");
  vm.runInContext(fs.readFileSync(p, "utf8"), ctx, { filename: f + ".js" });
}

// init() runs synchronously because document.readyState === "complete".
let frames = 0;
function runFrame(ts) {
  if (!rafCb) throw new Error("no animation frame scheduled");
  const cb = rafCb; rafCb = null;
  cb(ts);
  frames++;
}

let t = 1000;
// a few unlocked frames (menu visible, world rendering behind it)
for (let i = 0; i < 3; i++) runFrame((t += 16));

// enter pointer lock and exercise the gameplay path
sandbox.document.pointerLockElement = els.game;
dispatch("pointerlockchange");
dispatch("mousemove", Object.assign({ movementX: 12, movementY: -4 }, NOOP_EVENT));
dispatch("keydown", Object.assign({ code: "KeyW", repeat: false }, NOOP_EVENT));
dispatch("wheel", Object.assign({ deltaY: 1 }, NOOP_EVENT));
dispatch("keydown", Object.assign({ code: "Digit3", repeat: false }, NOOP_EVENT));
dispatch("mousedown", Object.assign({ button: 0 }, NOOP_EVENT)); // break
for (let i = 0; i < 20; i++) runFrame((t += 16));
dispatch("mouseup", Object.assign({ button: 0 }, NOOP_EVENT));

dispatch("mousedown", Object.assign({ button: 2 }, NOOP_EVENT)); // place
for (let i = 0; i < 10; i++) runFrame((t += 16));
dispatch("mouseup", Object.assign({ button: 2 }, NOOP_EVENT));

dispatch("mousedown", Object.assign({ button: 1 }, NOOP_EVENT)); // pick block
dispatch("keydown", Object.assign({ code: "KeyF", repeat: false }, NOOP_EVENT)); // fly
dispatch("keydown", Object.assign({ code: "Space", repeat: false }, NOOP_EVENT));
for (let i = 0; i < 30; i++) runFrame((t += 16));
dispatch("keydown", Object.assign({ code: "KeyT", repeat: false }, NOOP_EVENT)); // freeze time
for (let i = 0; i < 5; i++) runFrame((t += 16));

// leave pointer lock -> triggers a save
sandbox.document.pointerLockElement = null;
dispatch("pointerlockchange");

if (frames < 60) throw new Error("expected to run many frames, got " + frames);
console.log("Smoke test OK — ran " + frames + " frames through init + locked gameplay with no errors.");
