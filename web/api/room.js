// POST /api/room: online games between two friends (see _rooms.js).
// A Vercel Function; the room store is the Upstash Redis database connected
// to the project (Storage tab), see _store.js.

import { handle } from "./_rooms.js";
import { redisStore } from "./_store.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
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
