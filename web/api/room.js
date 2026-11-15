// POST /api/room: online games between two friends (see _rooms.js).
// A Vercel Function; the room store is the Upstash Redis database connected
// to the project (Storage tab), see _store.js.

import { handle } from "./_rooms.js";
import { redisStore } from "./_store.js";

// The Android app (Capacitor) runs the same pages from https://localhost and
// calls this endpoint across origins; capacitor://localhost is the iOS
// equivalent. Browsers on the website itself are same-origin and need nothing.
const APP_ORIGINS = new Set(["https://localhost", "capacitor://localhost"]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const origin = req.headers?.origin;
  if (origin && APP_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "use POST" });
    return;
  }
  const store = redisStore();
  if (!store) {
    res.status(503).json({ ok: false, error: "Online play is not set up on this server." });
    return;
  }
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  const r = await handle(store, body);
  res.status(r.status).json(r.body);
}
