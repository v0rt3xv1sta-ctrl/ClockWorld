/*
 * net.js — multiplayer client. Thin wrapper over the browser WebSocket that
 * speaks the ClockWorld server protocol and dispatches messages to handlers.
 */
(function (global) {
  "use strict";

  function Client() { this.ws = null; this.id = null; this.handlers = {}; this.open = false; }

  Client.prototype.connect = function (url, name, handlers) {
    this.handlers = handlers || {};
    this.name = name;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { if (this.handlers.error) this.handlers.error(e.message); return; }
    this.ws = ws;
    ws.onopen = () => { this.open = true; this.send({ t: "join", name: this.name }); if (this.handlers.connected) this.handlers.connected(); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.t === "welcome") this.id = m.id;
      const h = this.handlers[m.t];
      if (h) h(m);
    };
    ws.onclose = () => { this.open = false; if (this.handlers.closed) this.handlers.closed(); };
    ws.onerror = () => { if (this.handlers.error) this.handlers.error("connection error"); };
  };

  Client.prototype.send = function (o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); };
  Client.prototype.move = function (pos, yaw, pitch) { this.send({ t: "move", pos, yaw, pitch }); };
  Client.prototype.set = function (x, y, z, id) { this.send({ t: "set", x, y, z, id }); };
  Client.prototype.chat = function (text) { this.send({ t: "chat", text }); };
  Client.prototype.disconnect = function () { try { if (this.ws) this.ws.close(); } catch (e) { /* ignore */ } this.ws = null; };

  global.Net = { Client, available: typeof WebSocket !== "undefined" };
})(typeof window !== "undefined" ? window : globalThis);
