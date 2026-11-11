// Where online rooms live: Upstash Redis over its REST API (connected to the
// Vercel project under Storage, which sets KV_REST_API_URL and
// KV_REST_API_TOKEN), or an in-memory store for local testing
// (scripts/serve-out.mjs, tests/online_rooms.mjs).
//
// A room is two keys:
//   bg:room:<id>  its details as JSON (settings, names, the players' tokens, next room)
//   bg:log:<id>   a list with one JSON entry per action (rolls, moves, cube actions, ...)
// Both expire ROOM_TTL seconds after the last write.
//
// Every operation is one Redis command (a short Lua script where several
// steps must happen atomically), so a poll costs one command whatever the
// room's size, and two players can never both append "the next" entry: an
// append only succeeds if the list still has the length the client saw.
//
// (Files in api/ whose names start with "_" are helpers, not endpoints.)

export const ROOM_TTL = 7 * 24 * 3600; // a week

const metaKey = (id) => `bg:room:${id}`;
const logKey = (id) => `bg:log:${id}`;

// Read the room's details, the log length, and the log from `since` on.
const POLL = `
local m = redis.call('GET', KEYS[1])
if not m then return false end
local n = redis.call('LLEN', KEYS[2])
local since = tonumber(ARGV[1])
local e = {}
if n > since then e = redis.call('LRANGE', KEYS[2], since, -1) end
return {m, n, e}`;

// Append one entry if the log still has `expect` entries: returns -1 when
// appended, -2 when the room does not exist, else the current length.
const APPEND = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -2 end
local n = redis.call('LLEN', KEYS[2])
if n ~= tonumber(ARGV[1]) then return n end
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return -1`;

// Replace the room's details only if they are still `old` (compare-and-set).
const SWAP = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1`;

/** The Upstash store, or null when the environment has no credentials. */
export function redisStore(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const cmd = async (...args) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args.map(String)),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(`store: ${j.error || r.status}`);
    return j.result;
  };
  return {
    async getMeta(id) {
      return (await cmd("GET", metaKey(id))) ?? null;
    },
    async createMeta(id, json) {
      return (await cmd("SET", metaKey(id), json, "NX", "EX", ROOM_TTL)) === "OK";
    },
    async swapMeta(id, old, json) {
      return (await cmd("EVAL", SWAP, 1, metaKey(id), old, json, ROOM_TTL)) === 1;
    },
    async poll(id, since) {
      const r = await cmd("EVAL", POLL, 2, metaKey(id), logKey(id), since);
      if (!r) return null;
      return { meta: r[0], length: Number(r[1]), entries: r[2] ?? [] };
    },
    async append(id, expect, json) {
      const r = Number(await cmd("EVAL", APPEND, 2, metaKey(id), logKey(id), expect, json, ROOM_TTL));
      return r === -1 ? { ok: true } : r === -2 ? null : { ok: false, length: r };
    },
  };
}

/** The same operations in memory (local testing; rooms are lost on restart). */
export function memoryStore() {
  const meta = new Map();
  const logs = new Map();
  return {
    async getMeta(id) {
      return meta.get(id) ?? null;
    },
    async createMeta(id, json) {
      if (meta.has(id)) return false;
      meta.set(id, json);
      logs.set(id, []);
      return true;
    },
    async swapMeta(id, old, json) {
      if (meta.get(id) !== old) return false;
      meta.set(id, json);
      return true;
    },
    async poll(id, since) {
      if (!meta.has(id)) return null;
      const log = logs.get(id);
      return { meta: meta.get(id), length: log.length, entries: log.slice(since) };
    },
    async append(id, expect, json) {
      if (!meta.has(id)) return null;
      const log = logs.get(id);
      if (log.length !== expect) return { ok: false, length: log.length };
      log.push(json);
      return { ok: true };
    },
  };
}
