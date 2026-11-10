// Match analysis smoke test: load a sample match, analyse it game by game
// (as the web worker will, reporting progress), print a summary, and check
// that it agrees with a whole-match analysis and survives an SGF round trip.
//
//   node tests/match_smoke.mjs [match file] [plies]
//
// Defaults: tests/corpus/matches/selfplay-7pt.mat at 0-ply (fast). Pass
// "default" as plies to use gnubg's built-in analysis settings.
// Exits non-zero if anything fails.

import { readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { loadEngine, ROOT } from "./lib/engine-node.mjs";

const file = process.argv[2] || path.join(ROOT, "tests/corpus/matches/selfplay-7pt.mat");
const plies = process.argv[3] ?? "0";
const format = file.endsWith(".mat") ? "mat" : "sgf";
const text = readFileSync(file, "utf8");

const engine = await loadEngine();
const call = (fn, req = {}) => {
  const r = engine.call(fn, req);
  assert.equal(r.ok, true, `${fn} failed: ${JSON.stringify(r)}`);
  return r;
};

// Settings: gnubg's defaults, or the same with N-ply chequer and cube evaluation.
const settings = plies === "default" ? { defaults: true }
  : { defaults: true, chequer: { plies: Number(plies) }, cube: { plies: Number(plies) } };
const s = call("gnubg_api_set_analysis_settings", settings).settings;
console.log(`gnubg ${engine.version}; analysis: chequer ${s.chequer.eval.plies}-ply (filter ${s.chequer.moveFilterName}),` +
  ` cube ${s.cube.eval.plies}-ply, luck ${s.luck.eval.plies}-ply`);

// 1. Load and analyse game by game.
const info = call("gnubg_api_load_match", { format, text });
console.log(`\n${path.basename(file)}: ${info.matchLength ? `${info.matchLength}-point match` : "money session"},` +
  ` ${info.players.join(" vs ")}, ${info.games.length} games`);
const totalRecords = info.games.reduce((n, g) => n + g.records, 0);
let done = 0;
const t0 = performance.now();
for (const g of info.games) {
  call("gnubg_api_analyse_game", { game: g.index });
  done += g.records;
  console.log(`  analysed game ${g.index + 1}/${info.games.length} (score ${g.scoreBefore.join("-")}):` +
    ` ${Math.round((100 * done) / totalRecords)}%`);
}
const ms = performance.now() - t0;
console.log(`  ${totalRecords} records in ${ms.toFixed(0)} ms`);
const byGame = call("gnubg_api_get_analysis", { maxMoves: 0, text: true });

// 2. Summary.
const unit = byGame.matchLength ? "mwc" : "points";
const fmtCost = (v) => (byGame.matchLength ? `${(100 * v).toFixed(2)}%` : v.toFixed(3));
console.log("\nStatistics (gnubg's \"show statistics match\" values):");
byGame.statistics.players.forEach((p, i) => {
  console.log(`  ${byGame.players[i].padEnd(8)} chequer: ${p.chequer.unforcedMoves} unforced, error rate` +
    ` ${(p.chequer.errorPerMove.equity * byGame.errorRateFactor).toFixed(1)} mEMG, rating ${p.chequer.rating}` +
    ` | cube: ${p.cube.close} close, error ${fmtCost(p.cube.errorTotal[unit])}, rating ${p.cube.rating}` +
    ` | luck ${p.luck.total.equity >= 0 ? "+" : ""}${p.luck.total.equity.toFixed(3)} EMG (${p.luck.rating})` +
    ` | overall ${p.overall.rating}`);
});
const errors = [];
for (const g of byGame.games)
  for (const r of g.records) {
    if (r.chequer && r.chequer.error && r.chequer.skill !== "none")
      errors.push({ g: g.index, r, what: `${r.dice.join("")}: ${r.move} (best ${r.chequer.moves[0].move})`, e: r.chequer.error, skill: r.chequer.skill });
    if (r.cubeDecision && r.cubeDecision.skill !== "none")
      errors.push({ g: g.index, r, what: `${r.type === "move" ? "no double" : r.type} (proper: ${r.cubeDecision.proper})`, e: r.cubeDecision.error, skill: r.cubeDecision.skill });
  }
errors.sort((a, b) => a.e.equity - b.e.equity);
console.log(`\nLargest errors (${errors.length} marked):`);
for (const x of errors.slice(0, 6))
  console.log(`  game ${x.g + 1} #${x.r.index} ${byGame.players[x.r.player].padEnd(6)} ${x.skill.padEnd(8)}` +
    ` ${x.e.equity.toFixed(3)} EMG (${fmtCost(x.e[unit])})  ${x.what}  [${x.r.positionId}:${x.r.matchId}]`);
const lucky = byGame.games.flatMap((g) => g.records.filter((r) => r.luck && r.luck.label !== "none"));
console.log(`Rolls marked lucky/unlucky: ${lucky.length}`);
console.log("\n" + byGame.statisticsText.split("\n").filter((l) => /rating|Error rate|Luck rate/.test(l)).join("\n"));

// Sanity checks on the shapes.
assert.equal(byGame.games.length, info.games.length);
for (const g of byGame.games)
  for (const r of g.records)
    if (r.type === "move" && r.chequer.legalMoves > 0) {
      assert.ok(r.chequer.analysed, "every move should be analysed");
      assert.ok(r.chequer.playedIndex !== null, "played move must be in the move list");
      assert.ok(r.chequer.error.equity <= 0);
      assert.ok(r.luck && typeof r.luck.equity === "number");
    }
assert.ok(byGame.statisticsText.includes("Chequerplay statistics"));

// 3. Whole-match analysis must give the identical result. This needs a fresh
// engine instance: gnubg's evaluations depend (in the last float bits) on
// what was evaluated before in the same process, natively too (MATCH_API.md).
{
  const engine2 = await loadEngine();
  const call2 = (fn, req = {}) => {
    const r = engine2.call(fn, req);
    assert.equal(r.ok, true, `${fn} failed: ${JSON.stringify(r)}`);
    return r;
  };
  call2("gnubg_api_set_analysis_settings", settings);
  call2("gnubg_api_load_match", { format, text });
  call2("gnubg_api_analyse_match", {});
  const whole = call2("gnubg_api_get_analysis", { maxMoves: 0, text: true });
  assert.deepEqual(whole, byGame, "analyse_match differs from analyse_game for every game");
  console.log("\nanalyse_match == analyse_game for every game (fresh engines): identical");
}

// 4. Export, and SGF round trip (the analysis is stored in the SGF).
const sgf = call("gnubg_api_export_match", { format: "sgf" }).text;
const mat = call("gnubg_api_export_match", { format: "mat" }).text;
assert.ok(sgf.startsWith("(;FF[4]GM[6]") && sgf.includes("A["), "SGF export should contain the analysis");
assert.ok(/point match|Game 1/.test(mat), "unexpected .mat export");
call("gnubg_api_load_match", { format: "sgf", text: sgf });
const reloaded = call("gnubg_api_get_analysis", { maxMoves: 0, text: true });
// The SGF stores floats with 6 decimals, so compare the analysis marks.
const marks = (a) => a.games.map((g) => g.records.map((r) =>
  [r.type, r.move, r.chequer?.skill, r.chequer?.playedIndex, r.luck?.label, r.cubeDecision?.skill]));
assert.ok(JSON.stringify(marks(reloaded)) === JSON.stringify(marks(byGame)), "analysis marks changed after SGF round trip");
console.log(`SGF export (${sgf.length} bytes) reloads with the same analysis; .mat export ${mat.length} bytes`);

// 5. Errors and reset.
const bad = engine.call("gnubg_api_load_match", { format: "sgf", text: "this is not sgf" });
assert.equal(bad.ok, false);
console.log(`Bad SGF rejected: ${bad.error}${bad.messages ? ` (gnubg: ${bad.messages.split("\n")[0]})` : ""}`);
call("gnubg_api_clear_match", {});
assert.equal(engine.call("gnubg_api_get_analysis", {}).ok, false);

console.log("\nMatch smoke test passed.");
