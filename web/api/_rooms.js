// Online rooms for two friends: the logic behind POST /api/room.
//
// The server is a relay with a memory. It does not know the rules of
// backgammon: each browser replays the room's log through the same match
// state machine (web/src/game/match.ts, via web/src/game/online.ts) and
// rejects anything illegal, including moves checked against gnubg's legal
// moves. The server's jobs are to
//   - seat two players (the host in seat 1, the friend who opens the link in
//     seat 0) and give each a secret token that proves their seat;
//   - keep the log of actions, appending one only when the sender's log is
//     up to date (so two clicks can never both become "the next action");
//   - roll every die, with a cryptographic random generator, so neither
//     browser can choose its dice.
//
// Request: {"op": "create" | "join" | "poll" | "act" | "rematch", ...}
// Reply:   {"ok": true, ...} or {"ok": false, "error": "..."} with an HTTP status.
// A room as the browser sees it ("view"): settings, the two names (by seat),
// whether the friend has joined, the log length, log entries from `since`, and
// the next room after a rematch. Tokens are never sent back except to their owner.

import { randomBytes, randomInt } from "node:crypto";

const ID_CHARS = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i: easy to read aloud
const MAX_LOG = 5000; // far more than any match needs
const MAX_NAME = 16;

const fail = (status, error) => ({ status, body: { ok: false, error } });
const ok = (body) => ({ status: 200, body: { ok: true, ...body } });

const die = () => randomInt(1, 7);
/** An opening roll: one die each, re-rolled while tied. [seat 0's die, seat 1's die]. */
function openingDice() {
  for (;;) {
    const d = [die(), die()];
    if (d[0] !== d[1]) return d;
  }
}
const newId = () => Array.from({ length: 6 }, () => ID_CHARS[randomInt(ID_CHARS.length)]).join("");
const newToken = () => randomBytes(16).toString("hex");

/** A display name: printable, one word (it goes into .mat files), at most MAX_NAME characters. */
function cleanName(x) {
  if (typeof x !== "string") return "";
  return x.normalize("NFKC").replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, MAX_NAME);
}

function cleanSettings(s) {
  if (!s || typeof s !== "object") return null;
  const n = s.matchLength;
  if (!Number.isInteger(n) || n < 0 || n > 25) return null;
  return { matchLength: n, jacoby: !!s.jacoby, beavers: !!s.beavers, hints: !!s.hints };
}

const validId = (id) => typeof id === "string" && /^[a-z0-9]{6}$/.test(id);

function view(meta, length, entries, since) {
  return {
    room: meta.id,
    settings: meta.settings,
    names: meta.names,
    joined: !!meta.tokens[0],
    length,
    since,
    log: entries.map((e) => JSON.parse(e)),
    next: meta.next ?? null,
  };
}

/** The seat (0 or 1) that `token` holds in the room, or -1. */
const seatOf = (meta, token) => (typeof token === "string" && token ? meta.tokens.indexOf(token) : -1);

/** One action from a player, checked for shape (the rules are checked by the browsers). */
function entryFor(action, seat, n) {
  if (!action || typeof action !== "object") return null;
  const e = { n, seat, t: action.t, at: Date.now() };
  switch (action.t) {
    case "roll":
      return { ...e, dice: [die(), die()] };
    case "next":
      return { ...e, dice: openingDice() };
    case "move": {
      const p = action.pairs;
      if (!Array.isArray(p) || p.length > 4) return null;
      for (const q of p) {
        if (!Array.isArray(q) || q.length !== 2) return null;
        const [from, to] = q;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > 24 || to < -1 || to > 23) return null;
      }
      if (typeof action.text !== "string" || action.text.length > 60) return null;
      return { ...e, pairs: p, text: action.text };
    }
    case "double":
    case "take":
    case "drop":
    case "beaver":
      return e;
    case "resign":
      if (![1, 2, 3].includes(action.value)) return null;
      return { ...e, value: action.value };
    default:
      return null;
  }
}

/** Create a room with a fresh id (retried in the unlikely case of a clash). */
async function createRoom(store, settings, names, tokens) {
  for (let k = 0; k < 5; k++) {
    const meta = { v: 1, id: newId(), created: Date.now(), settings, names, tokens, next: null };
    if (await store.createMeta(meta.id, JSON.stringify(meta))) return meta;
  }
  throw new Error("could not create a room");
}

/** Handle one request body; returns {status, body}. */
export async function handle(store, req) {
  if (!req || typeof req !== "object") return fail(400, "expected a JSON object");
  try {
    switch (req.op) {
      case "create": {
        const settings = cleanSettings(req.settings);
        if (!settings) return fail(400, "bad match settings");
        const token = newToken();
        const meta = await createRoom(store, settings, ["", cleanName(req.name)], [null, token]);
        return ok({ token, seat: 1, ...view(meta, 0, [], 0) });
      }

      case "join": {
        if (!validId(req.room)) return fail(400, "bad room id");
        for (let attempt = 0; attempt < 3; attempt++) {
          const raw = await store.getMeta(req.room);
          if (!raw) return fail(404, "This game no longer exists (games are kept for a week).");
          const meta = JSON.parse(raw);
          const mine = seatOf(meta, req.token);
          if (mine >= 0) {
            const p = await store.poll(req.room, 0);
            return ok({ token: req.token, seat: mine, ...view(meta, p.length, p.entries, 0) });
          }
          if (meta.tokens[0]) return fail(409, "This game already has two players.");
          const token = newToken();
          const next = { ...meta, tokens: [token, meta.tokens[1]], names: [cleanName(req.name), meta.names[1]] };
          if (!(await store.swapMeta(req.room, raw, JSON.stringify(next)))) continue; // someone else joined first: look again
          // both seats taken: the first game starts with the opening roll
          await store.append(req.room, 0, JSON.stringify({ n: 0, seat: null, t: "open", dice: openingDice(), at: Date.now() }));
          const p = await store.poll(req.room, 0);
          return ok({ token, seat: 0, ...view(next, p.length, p.entries, 0) });
        }
        return fail(409, "Could not join, please try again.");
      }

      case "poll": {
        if (!validId(req.room)) return fail(400, "bad room id");
        const since = Number.isInteger(req.since) && req.since >= 0 ? req.since : 0;
        const p = await store.poll(req.room, since);
        if (!p) return fail(404, "This game no longer exists.");
        return ok(view(JSON.parse(p.meta), p.length, p.entries, since));
      }

      case "act": {
        if (!validId(req.room)) return fail(400, "bad room id");
        const raw = await store.getMeta(req.room);
        if (!raw) return fail(404, "This game no longer exists.");
        const meta = JSON.parse(raw);
        const seat = seatOf(meta, req.token);
        if (seat < 0) return fail(403, "You are not a player in this game.");
        if (!meta.tokens[0]) return fail(409, "Your friend has not joined yet.");
        if (!Number.isInteger(req.expect) || req.expect < 0) return fail(400, "bad expect");
        if (req.expect >= MAX_LOG) return fail(409, "This game is too long.");
        const entry = entryFor(req.action, seat, req.expect);
        if (!entry) return fail(400, "bad action");
        const r = await store.append(req.room, req.expect, JSON.stringify(entry));
        if (!r) return fail(404, "This game no longer exists.");
        if (!r.ok) return { status: 409, body: { ok: false, error: "out of date", length: r.length } };
        return ok({ entry, length: req.expect + 1 });
      }

      case "rematch": {
        if (!validId(req.room)) return fail(400, "bad room id");
        for (let attempt = 0; attempt < 3; attempt++) {
          const raw = await store.getMeta(req.room);
          if (!raw) return fail(404, "This game no longer exists.");
          const meta = JSON.parse(raw);
          if (seatOf(meta, req.token) < 0) return fail(403, "You are not a player in this game.");
          if (meta.next) return ok({ next: meta.next });
          // the same two players, seats and settings; the new match starts at once
          const fresh = await createRoom(store, meta.settings, meta.names, meta.tokens);
          await store.append(fresh.id, 0, JSON.stringify({ n: 0, seat: null, t: "open", dice: openingDice(), at: Date.now() }));
          if (await store.swapMeta(req.room, raw, JSON.stringify({ ...meta, next: fresh.id }))) return ok({ next: fresh.id });
          // the other player asked for a rematch at the same moment: use theirs (ours just expires)
        }
        return fail(409, "Could not start the rematch, please try again.");
      }

      default:
        return fail(400, "unknown op");
    }
  } catch (e) {
    console.error("room:", e);
    return fail(503, "The game server is unavailable, please try again in a moment.");
  }
}
