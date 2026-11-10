// API validation tests: the engine refuses bad input and bad states instead
// of returning numbers for something else. One section per review finding
// (API-1 ... API-10, see engine/api/*.c).
//
//   node tests/api_validation.mjs
//
// Exits non-zero if anything fails. Takes about 15 s (it starts several
// engine instances, each with its own data files).

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadEngine, ROOT } from "./lib/engine-node.mjs";

const OPENING = "4HPwATDgc/ABMA";
const DATA = "/gnubg-data";
const DATA_FILES = ["gnubg.wd", "gnubg_os0.bd", "gnubg_ts0.bd", "met/Kazaross-XG2.xml"];
const W0 = { plies: 0, cubeful: true, prune: true, deterministic: true, noise: 0 };
const W2 = { ...W0, plies: 2 };

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}\n      ${String(e.stack || e).split("\n").slice(0, 6).join("\n      ")}`);
  }
}

// A fresh engine module that is NOT initialised, with control over its data
// files (engine-node.mjs's loadEngine always initialises, with all files).
//   omit: data files to leave out; corrupt: data files to replace with junk.
// GNUBG_DIST=<dir> tests another build (e.g. an older one, to see these tests fail).
const DIST = process.env.GNUBG_DIST || path.join(ROOT, "engine/dist");
const { default: createGnubgModule } = await import(path.join(DIST, "gnubg.mjs"));
async function rawModule({ omit = [], corrupt = [] } = {}) {
  const Module = await createGnubgModule({ print: () => {}, printErr: () => {} });
  const dataDir = path.join(ROOT, "engine/data");
  Module.FS.mkdirTree(`${DATA}/met`);
  const files = ["gnubg.wd", "gnubg_os0.bd", "gnubg_ts0.bd", ...readdirSync(path.join(dataDir, "met")).map((f) => `met/${f}`)];
  for (const f of files) {
    if (omit.includes(f)) continue;
    const bytes = corrupt.includes(f) ? new TextEncoder().encode("this is not a gnubg data file\n".repeat(40)) : readFileSync(path.join(dataDir, f));
    Module.FS.writeFile(`${DATA}/${f}`, bytes);
  }
  const raw = (fn, arg) => JSON.parse(Module.ccall(fn, "string", ["string"], [arg]));
  return {
    Module,
    raw,
    call: (fn, req) => raw(fn, JSON.stringify(req)),
    init: (dir = DATA) => raw("gnubg_api_init", dir),
    exports: Object.keys(Module).filter((k) => k.startsWith("_gnubg_api_") && k !== "_gnubg_api_init").map((k) => k.slice(1)),
  };
}

const engine = await loadEngine({ dist: DIST });
const call = (fn, req) => engine.call(fn, req);
const raw = (fn, text) => JSON.parse(engine.Module.ccall(fn, "string", ["string"], [text]));
const ok = (r) => (assert.equal(r.ok, true, JSON.stringify(r)), r);
const fails = (r, re) => {
  assert.equal(r.ok, false, `expected an error, got ${JSON.stringify(r).slice(0, 200)}`);
  if (re) assert.match(r.error, re);
  return r;
};
const openingEval = ok(call("gnubg_api_evaluate", { position: OPENING, eval: W0 }));

// ---------------------------------------------------------------------------
console.log("API-1: calls before init");
await test("every API function refuses to run before init, and init then works normally", async () => {
  const m = await rawModule();
  assert.ok(m.exports.length >= 18, `found only ${m.exports.length} exports`);
  for (const fn of m.exports) {
    const r = m.call(fn, { position: OPENING, dice: [3, 1], format: "sgf", text: "", game: 0 });
    fails(r, /not initialised/);
  }
  // rank_moves before init used to write through a NULL pointer and corrupt
  // the module; now the module is untouched and init works.
  ok(m.init());
  const r = ok(m.call("gnubg_api_evaluate", { position: OPENING, eval: W0 }));
  assert.deepEqual(r, openingEval);
});

// ---------------------------------------------------------------------------
console.log("API-2: init failures");
for (const f of DATA_FILES) {
  await test(`init fails without ${f}; nothing changed, so a retry with the file works`, async () => {
    const m = await rawModule({ omit: [f] });
    fails(m.init(), new RegExp(`missing data file ${f}`));
    fails(m.call("gnubg_api_evaluate", { position: OPENING }), /not initialised/);
    m.Module.FS.writeFile(`${DATA}/${f}`, readFileSync(path.join(ROOT, "engine/data", f)));
    ok(m.init());
    assert.deepEqual(ok(m.call("gnubg_api_evaluate", { position: OPENING, eval: W0 })), openingEval);
  });
}
for (const f of ["gnubg_os0.bd", "gnubg_ts0.bd", "met/Kazaross-XG2.xml"]) {
  await test(`init fails if gnubg cannot read ${f} (no silent fallback); the instance is then unusable`, async () => {
    const m = await rawModule({ corrupt: [f] });
    fails(m.init(), new RegExp(`could not read ${f.replace(".", "\\.")}`));
    fails(m.call("gnubg_api_evaluate", { position: OPENING }), /initialisation failed/);
    fails(m.init(), /initialisation failed/); // even with all files back
  });
}
await test("unreadable weights: gnubg exits (an exception in JS); the instance is then unusable", async () => {
  const m = await rawModule({ corrupt: ["gnubg.wd"] });
  assert.throws(() => m.init());
  fails(m.call("gnubg_api_evaluate", { position: OPENING }), /initialisation failed/);
  fails(m.init(), /initialisation failed/);
});
await test("init with an empty or missing data directory fails", async () => {
  const m = await rawModule();
  fails(m.init(""), /missing data directory/);
  fails(m.init("/no/such/dir"), /missing data file/);
  ok(m.init());
});

// ---------------------------------------------------------------------------
console.log("API-8: repeated init");
await test("init again: same version, no re-initialisation, no memory growth", async () => {
  const again = ok(raw("gnubg_api_init", DATA));
  assert.equal(again.version, engine.version);
  assert.equal(again.alreadyInitialised, true);
  const M = engine.Module;
  const probe = () => { const p = M._malloc(32 << 20); M._free(p); return p; };
  const before = probe();
  for (let i = 0; i < 5; i++) ok(raw("gnubg_api_init", DATA));
  assert.equal(probe(), before, "the heap grew across repeated init calls");
  fails(raw("gnubg_api_init", "/elsewhere"), /already initialised/);
  assert.deepEqual(ok(call("gnubg_api_evaluate", { position: OPENING, eval: W0 })), openingEval);
});

// ---------------------------------------------------------------------------
console.log("API-6: position IDs");
await test("malformed position IDs are rejected by every function that takes one", async () => {
  const bad = {
    "": /14 characters/,
    "4HPwATDgc/AB": /14 characters/, // truncated: used to evaluate a different board
    "4HPwATDgc/ABMAXYZ": /14 characters/, // trailing characters used to be ignored
    "4HPwATDgc/AB*A": /only A-Z/,
    "4HPwATDgc/AB A": /only A-Z/,
    "//////////////": /not a legal position/, // more than 15 chequers
    "4HPwATDgc/ABMB": /canonical/, // unused bits set
    AAAAAAAAAAAAAA: /no chequers/, // empty board
  };
  for (const [id, re] of Object.entries(bad)) {
    for (const fn of ["gnubg_api_evaluate", "gnubg_api_rank_moves", "gnubg_api_analyse_cube", "gnubg_api_legal_moves",
      "gnubg_api_bot_move", "gnubg_api_bot_double", "gnubg_api_bot_take", "gnubg_api_position_info", "gnubg_api_make_ids"]) {
      fails(call(fn, { position: id, dice: [3, 1] }), re);
    }
  }
  for (const v of [5, null, true, ["4HPwATDgc/ABMA"]]) fails(call("gnubg_api_evaluate", { position: v }), /"position" must be a string/);
  fails(call("gnubg_api_evaluate", {}), /missing "position"/);
});
await test("a finished game (one side has borne off) can be decoded but not evaluated", async () => {
  const board = [Array(25).fill(0), Array(25).fill(0)];
  board[1][0] = 2; // player on roll: 2 chequers on the ace point; opponent: none left
  const { positionId } = ok(call("gnubg_api_make_ids", { board }));
  const info = ok(call("gnubg_api_position_info", { position: positionId }));
  assert.deepEqual(info.borneOff, [15, 13]);
  fails(call("gnubg_api_evaluate", { position: positionId }), /borne off all/);
  fails(call("gnubg_api_legal_moves", { position: positionId, dice: [1, 2] }), /borne off all/);
});

// ---------------------------------------------------------------------------
console.log("API-5 / API-9: match IDs");
await test("malformed match IDs are rejected (\"\" no longer means 'cube owned by player 0')", async () => {
  const bad = { "": /12 characters/, MAHgAAAAAAA: /12 characters/, MAHgAAAAAAAEA: /12 characters/, "MAHgAAAAAA*E": /only A-Z/ };
  for (const [id, re] of Object.entries(bad)) {
    for (const fn of ["gnubg_api_evaluate", "gnubg_api_analyse_cube", "gnubg_api_bot_double", "gnubg_api_position_info"]) {
      fails(call(fn, { position: OPENING, match: id }), re);
    }
  }
  for (const v of [5, null, false]) fails(call("gnubg_api_evaluate", { position: OPENING, match: v }), /"match" must be a string/);
});
await test("a stray Crawford flag is normalised as desktop 'set matchid' does", async () => {
  // sAHgAAAAAAAE = MAHgAAAAAAAE (7-point match, 0-0) plus the Crawford bit.
  const info = ok(call("gnubg_api_position_info", { position: OPENING, match: "sAHgAAAAAAAE" }));
  assert.equal(info.match.crawford, false);
  assert.equal(info.match.matchId, "MAHgAAAAAAAE");
  const a = ok(call("gnubg_api_evaluate", { position: OPENING, match: "sAHgAAAAAAAE", eval: W0 }));
  const b = ok(call("gnubg_api_evaluate", { position: OPENING, match: "MAHgAAAAAAAE", eval: W0 }));
  assert.deepEqual(a, b);
  const c = ok(call("gnubg_api_analyse_cube", { position: OPENING, match: "sAHgAAAAAAAE", eval: W0 }));
  assert.equal(c.cubeAvailable, true);
  // A real Crawford game (5-point match, 4-0) keeps its flag.
  const ids = ok(call("gnubg_api_make_ids", { position: OPENING, matchLength: 5, score: [4, 0], crawford: true }));
  assert.equal(ok(call("gnubg_api_position_info", { position: OPENING, match: ids.matchId })).match.crawford, true);
});
await test("a pending double in the match ID is stepped back to the doubler, as desktop does", async () => {
  const doubled = ok(call("gnubg_api_make_ids", { position: OPENING, matchLength: 7, doubled: true, turn: 1, move: 0 })).matchId;
  const plain = ok(call("gnubg_api_make_ids", { position: OPENING, matchLength: 7, turn: 0, move: 0 })).matchId;
  const info = ok(call("gnubg_api_position_info", { position: OPENING, match: doubled }));
  assert.equal(info.match.doubled, false);
  assert.equal(info.match.turn, 0);
  assert.equal(info.match.matchId, plain);
  assert.deepEqual(ok(call("gnubg_api_analyse_cube", { position: OPENING, match: doubled, eval: W0 })),
    ok(call("gnubg_api_analyse_cube", { position: OPENING, match: plain, eval: W0 })));
});
await test("cube values beyond gnubg's tables are rejected (API-9)", async () => {
  // 7-point match IDs with cube 128 and 4096 (read past aaaafGammonPrices).
  fails(call("gnubg_api_evaluate", { position: OPENING, match: "NwHgAAAAAAAE" }), /above 64/);
  fails(call("gnubg_api_evaluate", { position: OPENING, match: "PAHgAAAAAAAE" }), /above 64/);
  const m64 = ok(call("gnubg_api_make_ids", { position: OPENING, matchLength: 7, cube: 64, cubeOwner: 0 })).matchId;
  ok(call("gnubg_api_evaluate", { position: OPENING, match: m64, eval: W0 }));
  fails(call("gnubg_api_make_ids", { position: OPENING, matchLength: 7, cube: 128 }), /at most 64/);
  // Money: up to MAX_CUBE = 4096.
  const m4096 = ok(call("gnubg_api_make_ids", { position: OPENING, cube: 4096, cubeOwner: 1 })).matchId;
  ok(call("gnubg_api_evaluate", { position: OPENING, match: m4096, eval: W0 }));
  fails(call("gnubg_api_make_ids", { position: OPENING, cube: 8192 }), /"cube" must be an integer from 1 to 4096/);
  fails(call("gnubg_api_make_ids", { position: OPENING, cube: 3 }), /power of 2/);
});

// ---------------------------------------------------------------------------
console.log("API-7: request types and ranges");
await test("the request must be one JSON object", async () => {
  fails(raw("gnubg_api_evaluate", `{"position":"${OPENING}"} xyz`), /not valid JSON/);
  fails(raw("gnubg_api_evaluate", "not json"), /not valid JSON/);
  fails(raw("gnubg_api_evaluate", `["${OPENING}"]`), /must be a JSON object/);
  ok(raw("gnubg_api_evaluate", `  {"position":"${OPENING}","eval":{"plies":0}}  \n`)); // whitespace is fine
});
await test("evaluation settings: wrong types and ranges are errors, not defaults", async () => {
  const bad = [
    [{ plies: "0" }, /"plies" must be an integer from 0 to 4/],
    [{ plies: 2.5 }, /"plies"/],
    [{ plies: 5 }, /"plies"/],
    [{ plies: -1 }, /"plies"/],
    [{ cubeful: 0 }, /"cubeful" must be true or false/],
    [{ prune: "yes" }, /"prune"/],
    [{ deterministic: null }, /"deterministic"/],
    [{ noise: -0.01 }, /"noise" must be a number >= 0/],
    [{ noise: "0.1" }, /"noise"/],
    [{ ply: 2 }, /unknown field "ply"/],
  ];
  for (const [ev, re] of bad)
    for (const fn of ["gnubg_api_evaluate", "gnubg_api_rank_moves", "gnubg_api_analyse_cube", "gnubg_api_bot_move", "gnubg_api_bot_double", "gnubg_api_bot_take"])
      fails(call(fn, { position: OPENING, dice: [3, 1], eval: ev }), re);
  fails(call("gnubg_api_evaluate", { position: OPENING, eval: 2 }), /"eval" must be an object/);
  fails(call("gnubg_api_evaluate", { position: OPENING, preset: 5 }), /"preset" must be a string/);
  fails(call("gnubg_api_evaluate", { position: OPENING, preset: "worldclass" }), /unknown preset/);
  fails(call("gnubg_api_evaluate", { position: OPENING, preset: "expert", eval: { plies: 0 } }), /not both/);
  // Valid: a whole number written as 0.0 is an integer.
  assert.deepEqual(ok(raw("gnubg_api_evaluate", `{"position":"${OPENING}","eval":{"plies":0.0,"cubeful":true,"prune":true,"deterministic":true,"noise":0}}`)), openingEval);
});
await test("dice: two integers 1..6", async () => {
  for (const d of [[true, true], [3.9, 1.2], [7, 1], [0, 3], [3], [3, 1, 2], "31", null, { a: 3 }])
    for (const fn of ["gnubg_api_rank_moves", "gnubg_api_legal_moves", "gnubg_api_bot_move"])
      fails(call(fn, { position: OPENING, dice: d, eval: W0 }), /"dice"/);
  fails(call("gnubg_api_rank_moves", { position: OPENING, eval: W0 }), /missing "dice"/);
  fails(call("gnubg_api_legal_moves", { position: OPENING }), /need "dice"/);
  const a = ok(raw("gnubg_api_rank_moves", `{"position":"${OPENING}","dice":[3.0,1],"eval":{"plies":0}}`));
  const b = ok(call("gnubg_api_rank_moves", { position: OPENING, dice: [3, 1], eval: { plies: 0 } }));
  assert.deepEqual(a, b);
});
await test("rank_moves echoes the settings it used", async () => {
  const r = ok(call("gnubg_api_rank_moves", { position: OPENING, dice: [3, 1], preset: "expert" }));
  assert.deepEqual(r.eval, { plies: 0, cubeful: true, prune: false, deterministic: true, noise: 0 });
});
await test("make_ids / bot_take fields", async () => {
  const bad = [
    [{ turn: 2 }, /"turn"/], [{ move: true }, /"move"/], [{ resigned: 4 }, /"resigned"/], [{ doubled: 1 }, /"doubled"/],
    [{ cubeOwner: 2 }, /"cubeOwner"/], [{ matchLength: 65 }, /"matchLength"/], [{ jacoby: "no" }, /"jacoby"/],
    [{ gameState: 5 }, /"gameState"/], [{ dice: [3, 0] }, /"dice"/], [{ score: [1] }, /"score"/],
    [{ matchLength: 5, score: [6, 0] }, /"score"/], [{ crawford: true }, /"crawford"/],
    [{ matchLength: 5, score: [0, 0], crawford: true }, /"crawford"/],
  ];
  for (const [req, re] of bad) fails(call("gnubg_api_make_ids", { position: OPENING, ...req }), re);
  fails(call("gnubg_api_make_ids", { position: OPENING, board: [[], []] }), /not both/);
  const board = ok(call("gnubg_api_position_info", { position: OPENING })).board;
  ok(call("gnubg_api_make_ids", { board }));
  fails(call("gnubg_api_make_ids", { board: [board[0].map((n) => n + 0.5), board[1]] }), /integers/);
  // Both sides on one point: the opponent's 6-point (board[0][5]) is the
  // player on roll's 19-point (board[1][18]); move one chequer there.
  const overlap = board.map((s) => s.slice());
  overlap[1][5] -= 1;
  overlap[1][18] += 1;
  fails(call("gnubg_api_make_ids", { board: overlap }), /not a legal position/);
  ok(call("gnubg_api_make_ids", { position: OPENING, dice: [0, 0] }));
  fails(call("gnubg_api_bot_take", { position: OPENING, beaversSoFar: -1 }), /"beaversSoFar"/);
  fails(call("gnubg_api_bot_take", { position: OPENING, beaversSoFar: "1" }), /"beaversSoFar"/);
});
await test("match API fields", async () => {
  const s = (settings) => call("gnubg_api_set_analysis_settings", settings);
  fails(s({ chequer: { plies: "2" } }), /"plies"/);
  fails(s({ chequer: 2 }), /preset name or an object/);
  fails(s({ cube: { preset: 1 } }), /"preset" must be a string/);
  fails(s({ luck: { noise: -1 } }), /"noise"/);
  fails(s({ analyse: { moves: "yes" } }), /"moves"/);
  fails(s({ analyse: { players: [1, 0] } }), /players/);
  fails(s({ defaults: 1 }), /"defaults"/);
  fails(s({ moveFilter: [[{ accept: 0.5 }]] }), /4x4/);
  ok(s({ defaults: true }));
  fails(call("gnubg_api_analyse_game", { game: "0" }), /"game"/);
  fails(call("gnubg_api_analyse_game", {}), /missing "game"/);
  fails(call("gnubg_api_get_analysis", { maxMoves: -1 }), /"maxMoves"/);
  fails(call("gnubg_api_get_analysis", { text: "yes" }), /"text"/);
});

// ---------------------------------------------------------------------------
console.log("API-3 / API-4: what evaluate's cubeful numbers are");
await test("money: cubefulOptimal = cubefulEquity = analyse_cube optimal; desktop eval's number is noDouble", async () => {
  // A race where doubling is right (desktop gnubg 2-ply: eval 'Cubeful' +0.665,
  // cube analysis: No double +0.665, Double/take +0.680).
  const position = "andbAADa7jYAAA";
  const e = ok(call("gnubg_api_evaluate", { position, eval: W2 }));
  const c = ok(call("gnubg_api_analyse_cube", { position, eval: W2 }));
  assert.equal(e.cubefulOptimal, e.cubefulEquity);
  assert.equal(e.cubefulOptimal, c.equities.optimal);
  assert.equal(c.recommendation, "Double, take");
  assert.equal(c.equities.noDouble.toFixed(3), "0.665");
  assert.equal(c.equities.optimal.toFixed(3), "0.680");
});
await test("match play: cubefulOptimal is EMG (as rank_moves and analyse_cube), cubefulEquity is MWC", async () => {
  const match = "MAHgAEAAEAAE"; // 7-point match, 4-2
  const e = ok(call("gnubg_api_evaluate", { position: OPENING, match, eval: W2 }));
  const c = ok(call("gnubg_api_analyse_cube", { position: OPENING, match, eval: W2 }));
  assert.equal(e.cubefulOptimal, c.equities.optimal);
  assert.ok(Math.abs(e.cubefulEquity - c.mwc.optimal) < 1e-6, `${e.cubefulEquity} vs ${c.mwc.optimal}`);
  assert.ok(e.cubefulEquity > 0.6 && e.cubefulEquity < 0.7); // a match winning chance
  assert.ok(Math.abs(e.cubefulOptimal) < 0.1); // an equity
  // cubeless evaluation: no cubeful numbers
  const n = ok(call("gnubg_api_evaluate", { position: OPENING, match, eval: { ...W0, cubeful: false } }));
  assert.equal(n.cubefulOptimal, null);
  assert.equal(n.cubefulEquity, null);
});

// ---------------------------------------------------------------------------
console.log("API-10: dice order");
await test("dice are used in the order given; both orders give the same plays and best move", async () => {
  const req = { position: "HA1AWF5ikdwBMQ", preset: "world class" };
  const a = ok(call("gnubg_api_rank_moves", { ...req, dice: [6, 2] }));
  const b = ok(call("gnubg_api_rank_moves", { ...req, dice: [2, 6] }));
  assert.deepEqual(a.moves.map((m) => m.move).sort(), b.moves.map((m) => m.move).sort());
  assert.equal(a.moves[0].move, b.moves[0].move);
  const eq = new Map(b.moves.map((m) => [m.move, m.equity]));
  for (const m of a.moves) assert.ok(Math.abs(m.equity - eq.get(m.move)) < 1e-5);
  // Each order is reproducible (no dependence on earlier calls).
  assert.deepEqual(ok(call("gnubg_api_rank_moves", { ...req, dice: [6, 2] })), a);
  const la = ok(call("gnubg_api_legal_moves", { position: "HA1AWF5ikdwBMQ", dice: [6, 2] }));
  const lb = ok(call("gnubg_api_legal_moves", { position: "HA1AWF5ikdwBMQ", dice: [2, 6] }));
  assert.deepEqual(la.moves.map((m) => m.move).sort(), lb.moves.map((m) => m.move).sort());
});

// ---------------------------------------------------------------------------
console.log(failures ? `\n${failures} test(s) FAILED` : "\nAPI validation tests passed.");
process.exit(failures ? 1 : 0);
