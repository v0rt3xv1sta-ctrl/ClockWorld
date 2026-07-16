#!/usr/bin/env node
/*
 * serve.js — a tiny zero-dependency static file server for local play.
 * Usage: node serve.js [port]   (defaults to 8080)
 *
 * The game also runs by opening index.html directly (file://), but some
 * browsers restrict a few APIs there, so a real origin is recommended.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const port = parseInt(process.argv[2], 10) || 8080;
const root = __dirname;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(root, urlPath));
  if (!filePath.startsWith(root)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate", // always serve fresh game code
    });
    res.end(data);
  });
}).listen(port, () => {
  console.log("ClockWorld running at  http://localhost:" + port + "  (Ctrl+C to stop)");
});
