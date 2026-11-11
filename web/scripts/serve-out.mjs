// Serve the static export (web/out, made by "npm run build") locally, with
// the right content types for .mjs (module worker) and .wasm, plus the online
// room endpoint (POST /api/room) with rooms kept in memory.
//   node scripts/serve-out.mjs [port]     -> http://localhost:8080/
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../out");
const port = Number(process.argv[2] || 8080);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
};

// Online rooms (api/room.js on Vercel) with an in-memory store: rooms last
// until this server stops.
const { handle } = await import("../api/_rooms.js");
const { memoryStore } = await import("../api/_store.js");
const rooms = memoryStore();

createServer(async (req, res) => {
  if (req.url.startsWith("/api/room")) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {}
    const r = req.method === "POST" ? await handle(rooms, body) : { status: 405, body: { ok: false, error: "use POST" } };
    res.writeHead(r.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(r.body));
    return;
  }
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = path.join(root, p);
    if (!file.startsWith(root)) throw new Error("outside root");
    const exists = async (f) => !!(await stat(f).catch(() => null))?.isFile();
    // A route like /analysis is exported as analysis.html next to a folder
    // "analysis/" (Next's route data): prefer the page, as the host does (cleanUrls).
    if (!path.extname(file) && (await exists(file + ".html"))) file += ".html";
    else if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, () => console.log(`Serving ${root} at http://localhost:${port}/`));
