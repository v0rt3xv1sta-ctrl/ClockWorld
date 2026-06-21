#!/usr/bin/env node
/*
 * server.js — ClockWorld multiplayer host (zero dependencies).
 *
 * Serves the game's static files over HTTP and hosts a shared world over
 * WebSocket on the same port. The server is authoritative for the world seed,
 * mode and block edits, relays player movement and chat, and persists the
 * world to disk.
 *
 * Usage:  node server/server.js [port]
 *   PORT, CW_MODE (survival|creative), CW_SEED, CW_SAVE env vars are honoured.
 *
 * Protocol (JSON text frames):
 *   server -> client: welcome{id,seed,mode,edits,players}, player{...}, move{id,...},
 *                     set{x,y,z,id}, chat{id,name,text}, leave{id}
 *   client -> server: join{name}, move{pos,yaw,pitch}, set{x,y,z,id}, chat{text}
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const ws = require("./ws.js");
const { Accounts } = require("./accounts.js");

const accounts = new Accounts(process.env.CW_ACCOUNTS || path.join(__dirname, "accounts.json"));

const PORT = parseInt(process.argv[2] || process.env.PORT, 10) || 8080;
const ROOT = path.join(__dirname, "..");
const SAVE = process.env.CW_SAVE || path.join(__dirname, "world.json");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon",
};

// ---- world state (authoritative) ----
let world = loadWorld();
function loadWorld() {
  try {
    const w = JSON.parse(fs.readFileSync(SAVE, "utf8"));
    if (w && w.seed !== undefined) { console.log("Loaded world from " + SAVE); return w; }
  } catch (e) { /* none yet */ }
  return {
    seed: (process.env.CW_SEED ? parseInt(process.env.CW_SEED, 10) : (Math.random() * 1e9)) >>> 0,
    mode: process.env.CW_MODE === "creative" ? "creative" : "survival",
    edits: {},
  };
}
let dirty = false;
function saveWorld() {
  if (!dirty) return;
  try { fs.writeFileSync(SAVE, JSON.stringify(world)); dirty = false; }
  catch (e) { console.error("save failed:", e.message); }
}
setInterval(saveWorld, 30000);

// ---- players ----
const players = new Map(); // id -> { conn, name, pos, yaw, pitch }
let nextId = 1;
function broadcast(obj, exceptId) {
  const s = JSON.stringify(obj);
  players.forEach((p, id) => { if (id !== exceptId) p.conn.send(s); });
}

// ---- HTTP static ----
const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate", // always serve fresh game code
    });
    res.end(data);
  });
});

// ---- WebSocket multiplayer ----
ws.attach(httpServer, (conn) => {
  const id = nextId++;
  const player = { conn, name: "Player" + id, pos: [0, 80, 0], yaw: 0, pitch: 0 };
  players.set(id, player);

  conn.send(JSON.stringify({
    t: "welcome", id, seed: world.seed, mode: world.mode, edits: world.edits,
    players: [...players].filter(([pid]) => pid !== id).map(([pid, p]) => ({ id: pid, name: p.name, pos: p.pos, yaw: p.yaw, pitch: p.pitch })),
  }));
  console.log("+ player " + id + " (" + players.size + " online)");

  function authResult(r) {
    if (r.ok) {
      player.name = r.name;
      conn.send(JSON.stringify({ t: "authok", name: r.name, token: r.token }));
      broadcast({ t: "player", id, name: player.name, pos: player.pos, yaw: player.yaw, pitch: player.pitch }, id);
      console.log("  player " + id + " signed in as " + r.name);
    } else conn.send(JSON.stringify({ t: "authfail", msg: r.msg }));
  }

  conn.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === "join") {
      player.name = String(m.name || player.name).slice(0, 24);
      broadcast({ t: "player", id, name: player.name, pos: player.pos, yaw: player.yaw, pitch: player.pitch }, id);
    } else if (m.t === "register") {
      authResult(accounts.register(m.user, m.pass));
    } else if (m.t === "login") {
      authResult(accounts.login(m.user, m.pass));
    } else if (m.t === "token") {
      const name = accounts.verifyToken(m.token);
      if (name) authResult({ ok: true, name, token: m.token });
      else conn.send(JSON.stringify({ t: "authfail", msg: "Session expired — please log in" }));
    } else if (m.t === "move") {
      if (Array.isArray(m.pos)) player.pos = m.pos;
      player.yaw = m.yaw; player.pitch = m.pitch;
      broadcast({ t: "move", id, pos: player.pos, yaw: player.yaw, pitch: player.pitch }, id);
    } else if (m.t === "set") {
      const k = (m.x | 0) + "," + (m.y | 0) + "," + (m.z | 0);
      if (m.id === 0) delete world.edits[k]; else world.edits[k] = m.id | 0;
      dirty = true;
      broadcast({ t: "set", x: m.x | 0, y: m.y | 0, z: m.z | 0, id: m.id | 0 }, id);
    } else if (m.t === "chat") {
      const text = String(m.text || "").slice(0, 200);
      if (text) broadcast({ t: "chat", id, name: player.name, text });
    }
  });

  conn.on("close", () => {
    players.delete(id);
    broadcast({ t: "leave", id });
    console.log("- player " + id + " (" + players.size + " online)");
  });
});

httpServer.listen(PORT, () => {
  const os = require("os");
  const ips = [];
  const ifs = os.networkInterfaces();
  for (const name in ifs) for (const i of ifs[name]) if (i.family === "IPv4" && !i.internal) ips.push(i.address);
  console.log("\n  ClockWorld server running (mode: " + world.mode + ", seed: " + world.seed + ")");
  console.log("  ------------------------------------------------------------");
  console.log("  This machine:   http://localhost:" + PORT);
  ips.forEach((ip) => console.log("  Same network:   http://" + ip + ":" + PORT + "   (others on your Wi-Fi/LAN)"));
  console.log("  ------------------------------------------------------------");
  console.log("  Everyone opens one of those URLs and clicks \"Join This Server\".");
  console.log("  Over the internet? Tunnel this port and share the HTTPS link, e.g.:");
  console.log("      npx localtunnel --port " + PORT + "      (or: cloudflared tunnel --url http://localhost:" + PORT + ")");
  console.log("  The tunnel's https:// link works automatically (it becomes wss://).\n");
});

function shutdown() { console.log("\nsaving..."); dirty = true; saveWorld(); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = { httpServer }; // for tests
