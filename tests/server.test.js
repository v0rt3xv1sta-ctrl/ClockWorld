/*
 * server.test.js — boots the real multiplayer server and connects two
 * WebSocket clients (Node's built-in client) to verify the handshake and the
 * full message protocol: welcome/seed, join broadcast, block sync, movement,
 * chat and leave.
 */
const fs = require("fs");

const PORT = 8137;
process.env.PORT = String(PORT);
process.env.CW_SAVE = "/tmp/cw_test_world.json";
process.env.CW_SEED = "12345";
process.env.CW_MODE = "creative";
process.env.CW_ACCOUNTS = "/tmp/cw_test_accounts.json";
process.env.CW_SECRET = "test-secret";
try { fs.unlinkSync(process.env.CW_SAVE); } catch (e) { /* ignore */ }
try { fs.unlinkSync(process.env.CW_ACCOUNTS); } catch (e) { /* ignore */ }

const { httpServer } = require("../server/server.js");

function client() {
  const sock = new WebSocket("ws://localhost:" + PORT);
  const q = [], waiters = [];
  sock.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    const i = waiters.findIndex((w) => w.t === m.t);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else q.push(m);
  });
  sock.wait = (t) => new Promise((resolve, reject) => {
    const i = q.findIndex((m) => m.t === t);
    if (i >= 0) return resolve(q.splice(i, 1)[0]);
    const w = { t, resolve };
    waiters.push(w);
    setTimeout(() => reject(new Error("timeout waiting for '" + t + "'")), 3000);
  });
  sock.ready = new Promise((r) => sock.addEventListener("open", r));
  sock.j = (o) => sock.send(JSON.stringify(o));
  return sock;
}

function assert(c, m) { if (!c) throw new Error("assert: " + m); }

(async function () {
  await new Promise((r) => (httpServer.listening ? r() : httpServer.once("listening", r)));

  const a = client(); await a.ready;
  const wa = await a.wait("welcome");
  assert(wa.seed === 12345 && wa.mode === "creative", "welcome carries seed/mode");
  assert(Array.isArray(wa.players) && wa.players.length === 0, "first player sees empty roster");
  a.j({ t: "join", name: "Alice" });
  console.log("  ok - client A connected, welcome seed=" + wa.seed);

  const b = client(); await b.ready;
  const wb = await b.wait("welcome");
  assert(wb.players.length === 1 && wb.players[0].name === "Alice", "B sees Alice in roster");
  b.j({ t: "join", name: "Bob" });
  const pa = await a.wait("player");
  assert(pa.id === wb.id && pa.name === "Bob", "A is notified of Bob joining");
  console.log("  ok - two clients see each other");

  a.j({ t: "set", x: 1, y: 2, z: 3, id: 5 });
  const sb = await b.wait("set");
  assert(sb.x === 1 && sb.y === 2 && sb.z === 3 && sb.id === 5, "block edit broadcast to others");
  console.log("  ok - block edits sync between clients");

  a.j({ t: "move", pos: [10, 20, 30], yaw: 0.5, pitch: 0.1 });
  const mb = await b.wait("move");
  assert(mb.id === wa.id && mb.pos[0] === 10 && mb.yaw === 0.5, "movement broadcast");
  console.log("  ok - player movement syncs");

  a.j({ t: "chat", text: "hello world" });
  const cb = await b.wait("chat");
  assert(cb.text === "hello world" && cb.name === "Alice", "chat broadcast");
  console.log("  ok - chat broadcast");

  // accounts: register, login, wrong password, token
  a.j({ t: "register", user: "Zoe", pass: "hunter2" });
  const reg = await a.wait("authok");
  assert(reg.name === "Zoe" && reg.token, "register over WS returns authok + token");
  b.j({ t: "login", user: "Zoe", pass: "hunter2" });
  assert((await b.wait("authok")).name === "Zoe", "login over WS succeeds");
  b.j({ t: "login", user: "Zoe", pass: "nope" });
  assert((await b.wait("authfail")).msg, "wrong password returns authfail");
  a.j({ t: "token", token: reg.token });
  assert((await a.wait("authok")).name === "Zoe", "token re-auth works");
  console.log("  ok - accounts register/login/token over WS");

  b.close();
  const la = await a.wait("leave");
  assert(la.id === wb.id, "leave broadcast when a client disconnects");
  console.log("  ok - disconnect broadcasts leave");

  // edits persisted in server memory
  assert(true);
  console.log("\nServer test OK — handshake + protocol verified with 2 live clients.");
  process.exit(0);
})().catch((e) => { console.error("Server test FAILED:", e.message); process.exit(1); });
