// Online rooms: the server logic (web/api/_rooms.js, in-memory store) and the
// browsers' replay (web/src/game/online.ts), with the wasm engine choosing
// moves and cube actions for both players.
//   node tests/online_rooms.mjs        (Node 24: runs the .ts modules directly)
//
// Checks that
//   - create / join / poll / act / rematch work, and the server rolls the dice;
//   - both browsers, each replaying the same log from its own side, always
//     see mirror images of one game (board, score, cube, turn);
//   - stale actions (an out-of-date log length), forged tokens, and actions
//     by the wrong player are refused.
import assert from "node:assert/strict";
import { loadEngine, ROOT } from "./lib/engine-node.mjs";

const { handle } = await import(ROOT + "/web/api/_rooms.js");
const { memoryStore } = await import(ROOT + "/web/api/_store.js");
const O = await import(ROOT + "/web/src/game/online.ts");
const M = await import(ROOT + "/web/src/game/match.ts");
const B = await import(ROOT + "/web/src/game/board.ts");
const engine = await loadEngine();

const store = memoryStore();
const api = async (op, body) => (await handle(store, { op, ...body })).body;

// ---- create and join
const settings = { matchLength: 3, jacoby: false, beavers: false, hints: false };
const host = await api("create", { settings, name: "Ann Lee" });
assert.ok(host.ok && host.seat === 1 && /^[a-z0-9]{6}$/.test(host.room));
assert.deepEqual(host.names, ["", "AnnLee"], "names are one word");
assert.equal((await api("act", { room: host.room, token: host.token, expect: 0, action: { t: "roll" } })).ok, false, "no play before the friend joins");
const guest = await api("join", { room: host.room, name: "Bob" });
assert.ok(guest.ok && guest.seat === 0 && guest.log.length === 1 && guest.log[0].t === "open");
assert.notEqual(guest.log[0].dice[0], guest.log[0].dice[1], "opening dice are never tied");
assert.equal((await api("join", { room: host.room, name: "Eve" })).ok, false, "a third player cannot join");
const again = await api("join", { room: host.room, token: host.token });
assert.ok(again.ok && again.seat === 1, "the host's token gets the host's seat back");
assert.equal(JSON.stringify(guest).includes(host.token), false, "tokens are never sent to the other player");

// ---- two browsers
const players = [
  { seat: 0, token: guest.token, m: null, n: 0 },
  { seat: 1, token: host.token, m: null, n: 0 },
];
const local = (p) => O.localSettings(settings, p.seat === 0 ? "AnnLee" : "Bob");
async function sync(p) {
  const v = await api("poll", { room: host.room, since: p.n });
  assert.ok(v.ok);
  for (const e of v.log) {
    p.m = O.applyEntry(p.m, e, p.seat, local(p));
    p.n++;
  }
}
const mirrorCheck = () => {
  const [a, b] = players.map((p) => p.m);
  assert.deepEqual(a.board, B.swapSides(b.board), "boards mirror each other");
  assert.deepEqual(a.score, [b.score[1], b.score[0]]);
  assert.equal(a.cube, b.cube);
  assert.equal(a.phase, b.phase);
  if (a.phase !== "gameOver" && a.phase !== "matchOver") assert.equal(a.turn, 1 - b.turn);
};
/** The player (browser) who must act now, or null when the game is over. */
function actor() {
  const m = players[0].m;
  if (m.phase === "gameOver" || m.phase === "matchOver") return null;
  const side = m.phase === "doubled" ? M.responder(m) : m.turn; // in player 0's view
  return side === 1 ? players[0] : players[1];
}
async function act(p, action) {
  const r = await api("act", { room: host.room, token: p.token, expect: p.n, action });
  assert.ok(r.ok, JSON.stringify(r));
  for (const q of players) await sync(q);
  mirrorCheck();
}

for (const p of players) await sync(p);
mirrorCheck();

// stale and forged actions
assert.equal((await api("act", { room: host.room, token: host.token, expect: 0, action: { t: "roll" } })).error, "out of date");
assert.equal((await api("act", { room: host.room, token: "f".repeat(32), expect: 1, action: { t: "roll" } })).ok, false);
assert.equal((await api("act", { room: host.room, token: host.token, expect: 1, action: { t: "move", pairs: [[30, 2]], text: "x" } })).ok, false, "malformed move");

let games = 0, moves = 0, doubles = 0;
for (let step = 0; step < 4000; step++) {
  const m = players[0].m;
  if (m.phase === "matchOver") break;
  if (m.phase === "gameOver") {
    games++;
    await act(players[step % 2], { t: "next" });
    continue;
  }
  const p = actor();
  const pm = p.m; // this player's own view: it is side 1
  if (pm.phase === "rolling") {
    // gnubg decides whether to double (for this player)
    if (M.canDouble(pm, 1)) {
      const d = engine.call("gnubg_api_bot_double", { ...M.idsFor(pm, 1, null), preset: "expert" });
      if (d.double) {
        doubles++;
        await act(p, { t: "double" });
        continue;
      }
    }
    await act(p, { t: "roll" });
  } else if (pm.phase === "doubled") {
    const r = engine.call("gnubg_api_bot_take", { ...M.idsFor(pm, pm.turn, null), preset: "expert", beaversSoFar: 0 });
    await act(p, { t: r.action === "drop" ? "drop" : "take" });
  } else {
    const r = engine.call("gnubg_api_bot_move", { ...M.idsFor(pm, 1, pm.dice), preset: "expert" });
    moves++;
    // the other browser checks the move against the engine's legal moves
    const other = players[1 - players.indexOf(p)].m; // there, the mover is side 0
    const legal = engine.call("gnubg_api_legal_moves", { ...M.idsFor(other, 0, other.dice), dice: other.dice });
    const after = B.positionId(B.applyPairs(M.boardFor(other, 0), r.pairs));
    assert.ok(legal.moves.length === 0 ? r.pairs.length === 0 : legal.moves.some((x) => x.positionAfter === after), "a legal move");
    await act(p, { t: "move", pairs: r.pairs, text: r.move ?? "" });
  }
}
assert.equal(players[0].m.phase, "matchOver", "the match finishes");

// an action by the wrong player is refused by the replay
{
  const room = await api("create", { settings, name: "A" });
  const g = await api("join", { room: room.room, name: "B" });
  const start = O.applyEntry(null, g.log[0], 0, O.localSettings(settings, "A"));
  const wrong = start.turn === 1 ? room : g; // the browser NOT on turn (side 0 in the guest's view = host)
  const r = await api("act", { room: room.room, token: wrong.token, expect: 1, action: { t: "move", pairs: [], text: "" } });
  assert.ok(r.ok, "the server accepts it (it does not know the rules) ...");
  assert.throws(() => O.applyEntry(start, r.entry, 0, O.localSettings(settings, "A")), /wrong player/, "... the browsers refuse it");
}

// rematch: both ask, one new room, same seats
const r1 = await api("rematch", { room: host.room, token: host.token });
const r2 = await api("rematch", { room: host.room, token: guest.token });
assert.ok(r1.ok && r1.next === r2.next);
const re = await api("join", { room: r1.next, token: guest.token });
assert.ok(re.ok && re.seat === 0 && re.log[0].t === "open", "the rematch starts at once with the same seats");

console.log(`online rooms test passed: ${games + 1} games, ${moves} moves, ${doubles} doubles, both views mirror each other throughout`);
