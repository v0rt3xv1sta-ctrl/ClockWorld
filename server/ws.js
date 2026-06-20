/*
 * ws.js — a minimal, dependency-free WebSocket (RFC 6455) server.
 *
 * Implements just enough of the protocol to host ClockWorld: the HTTP upgrade
 * handshake (SHA-1 accept key) and text-frame encode/decode with client mask
 * removal, ping/pong and close. Built on Node's http/net/crypto only.
 */
"use strict";
const crypto = require("crypto");
const { EventEmitter } = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class WSConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    socket.on("data", (d) => { this.buf = Buffer.concat([this.buf, d]); this._parse(); });
    socket.on("close", () => this._closed());
    socket.on("error", () => this._closed());
  }

  _closed() { if (!this.closed) { this.closed = true; this.emit("close"); } }

  _parse() {
    while (true) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); offset = 10; }
      let mask;
      if (masked) { if (this.buf.length < offset + 4) return; mask = this.buf.subarray(offset, offset + 4); offset += 4; }
      if (this.buf.length < offset + len) return; // need the full payload
      let payload = this.buf.subarray(offset, offset + len);
      if (masked) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      this.buf = this.buf.subarray(offset + len);
      this._frame(opcode, payload);
    }
  }

  _frame(op, payload) {
    if (op === 0x8) { this.close(); return; }       // close
    if (op === 0x9) { this._send(0xA, payload); return; } // ping -> pong
    if (op === 0x1) { this.emit("message", payload.toString("utf8")); } // text
  }

  _send(opcode, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x80 | opcode;
    try { this.socket.write(Buffer.concat([header, payload])); } catch (e) { /* peer gone */ }
  }

  send(str) { this._send(0x1, Buffer.from(str, "utf8")); }

  close() {
    if (this.closed) return;
    try { this._send(0x8, Buffer.alloc(0)); this.socket.end(); } catch (e) { /* ignore */ }
    this._closed();
  }
}

function handshake(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  return new WSConn(socket);
}

// Attach to an http.Server: calls onConnection(conn, req) per upgraded socket.
function attach(httpServer, onConnection) {
  httpServer.on("upgrade", (req, socket) => {
    const conn = handshake(req, socket);
    if (conn) onConnection(conn, req);
  });
}

module.exports = { attach, handshake, WSConn };
