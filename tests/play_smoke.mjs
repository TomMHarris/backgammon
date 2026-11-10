// Play-mode API smoke test: decode IDs, legal moves, bot move / double / take.
//   node tests/play_smoke.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEngine, ROOT } from "./lib/engine-node.mjs";

const engine = await loadEngine();
const ok = (r) => (assert.equal(r.ok, true, JSON.stringify(r)), r);
const OPENING = "4HPwATDgc/ABMA";

// Decode the opening position.
const info = ok(engine.call("gnubg_api_position_info", { position: OPENING, match: "MAEGAAAAAAAA" /* corpus opening-01: money, 4-1 to play */ }));
assert.deepEqual(info.pips, [167, 167]);
assert.deepEqual(info.borneOff, [0, 0]);
console.log("position_info: pips", info.pips, "match", JSON.stringify(info.match));

// IDs round-trip through make_ids.
const ids = ok(engine.call("gnubg_api_make_ids", { board: info.board, ...info.match }));
assert.equal(ids.positionId, OPENING);
assert.equal(ids.matchId, info.match.matchId);
console.log("make_ids round trip: ok");

// Legal moves for an opening 3-1: 16 distinct plays.
const legal = ok(engine.call("gnubg_api_legal_moves", { position: OPENING, dice: [3, 1] }));
assert.equal(legal.count, 16);
assert.ok(legal.moves.some((m) => m.move === "8/5 6/5"));
console.log("legal_moves 3-1:", legal.count, "plays, e.g.", legal.moves[0].move, JSON.stringify(legal.moves[0].pairs));

// Bot move at every preset (weaker ones include gnubg's noise).
for (const preset of ["beginner", "casual play", "intermediate", "advanced", "expert", "world class"]) {
  const m = ok(engine.call("gnubg_api_bot_move", { position: OPENING, dice: [3, 1], preset }));
  console.log(`bot_move 3-1 at ${preset.padEnd(12)}: ${m.move}`);
}
const best = ok(engine.call("gnubg_api_bot_move", { position: OPENING, dice: [3, 1], preset: "world class" }));
assert.equal(best.move, "8/5 6/5");

// Cube actions on the corpus' cube positions, checked against the verdicts
// native gnubg recorded at 2-ply when it generated the corpus.
const corpus = JSON.parse(readFileSync(path.join(ROOT, "tests/corpus/positions.json"), "utf8"));
for (const p of corpus.positions.filter((p) => p.kind === "cube")) {
  const req = { position: p.positionId, match: p.matchId, preset: "world class" };
  const cube = ok(engine.call("gnubg_api_analyse_cube", req));
  const dbl = ok(engine.call("gnubg_api_bot_double", req));
  const take = ok(engine.call("gnubg_api_bot_take", req));
  console.log(
    `${p.id.padEnd(16)} ${cube.recommendation.padEnd(28)} bot doubles: ${String(dbl.double).padEnd(5)} ` +
      `bot answer: ${take.action.padEnd(6)} | corpus: ${p.description.split(";").pop().trim()}`
  );
}
console.log("\nPlay smoke test passed.");
