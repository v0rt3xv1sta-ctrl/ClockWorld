/*
 * accounts.js — user accounts for the multiplayer server (zero dependencies).
 *
 * Passwords are salted and hashed with PBKDF2 (Node crypto); sessions are
 * HMAC-signed, expiring tokens. Users persist to a JSON file. Pure Node logic,
 * unit-tested. Guests (no account) are still allowed by the server.
 */
"use strict";
const crypto = require("crypto");
const fs = require("fs");

function Accounts(file, secret) {
  this.file = file || null;
  this.secret = secret || process.env.CW_SECRET || "clockworld-dev-secret";
  this.users = this._load();
}

Accounts.prototype._load = function () {
  if (!this.file) return {};
  try { return JSON.parse(fs.readFileSync(this.file, "utf8")) || {}; } catch (e) { return {}; }
};
Accounts.prototype._save = function () {
  if (!this.file) return;
  try { fs.writeFileSync(this.file, JSON.stringify(this.users)); } catch (e) { /* ignore */ }
};

Accounts.prototype.validName = function (u) { return typeof u === "string" && /^[a-zA-Z0-9_]{3,20}$/.test(u); };
Accounts.prototype._hash = function (pass, salt) { return crypto.pbkdf2Sync(pass, salt, 100000, 32, "sha256").toString("hex"); };
Accounts.prototype.exists = function (user) { return !!this.users[(user || "").toLowerCase()]; };

Accounts.prototype.register = function (user, pass) {
  if (!this.validName(user)) return { ok: false, msg: "Username must be 3–20 letters, digits or _" };
  if (typeof pass !== "string" || pass.length < 4) return { ok: false, msg: "Password must be at least 4 characters" };
  const key = user.toLowerCase();
  if (this.users[key]) return { ok: false, msg: "That username is taken" };
  const salt = crypto.randomBytes(16).toString("hex");
  this.users[key] = { name: user, salt, hash: this._hash(pass, salt), created: Date.now() };
  this._save();
  return { ok: true, name: user, token: this.token(user) };
};

Accounts.prototype.verify = function (user, pass) {
  const u = this.users[(user || "").toLowerCase()];
  if (!u) return false;
  const a = Buffer.from(this._hash(pass || "", u.salt), "hex");
  const b = Buffer.from(u.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

Accounts.prototype.login = function (user, pass) {
  if (!this.verify(user, pass)) return { ok: false, msg: "Wrong username or password" };
  const u = this.users[user.toLowerCase()];
  return { ok: true, name: u.name, token: this.token(u.name) };
};

Accounts.prototype.token = function (name) {
  const payload = name + "." + (Date.now() + 30 * 24 * 3600 * 1000); // 30-day expiry
  const sig = crypto.createHmac("sha256", this.secret).update(payload).digest("hex").slice(0, 32);
  return Buffer.from(payload + "." + sig).toString("base64");
};

Accounts.prototype.verifyToken = function (tok) {
  try {
    const s = Buffer.from(String(tok), "base64").toString("utf8");
    const i = s.lastIndexOf(".");
    if (i < 0) return null;
    const payload = s.slice(0, i), sig = s.slice(i + 1);
    const j = payload.lastIndexOf(".");
    const name = payload.slice(0, j), exp = +payload.slice(j + 1);
    const good = crypto.createHmac("sha256", this.secret).update(payload).digest("hex").slice(0, 32);
    if (sig !== good || !(Date.now() < exp)) return null;
    return name;
  } catch (e) { return null; }
};

module.exports = { Accounts };
