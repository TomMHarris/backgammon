// Phase 1 smoke test: load the WebAssembly engine in Node, load gnubg's data
// files, evaluate the opening position, rank the moves for an opening 3-1, and
// check that both bearoff databases are really in use.
//
//   node tests/smoke.mjs
//
// Exits non-zero if anything fails.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// import() takes a URL; a plain path breaks if the checkout path contains # or %.
const { default: createGnubgModule } = await import(pathToFileURL(path.join(root, "engine/dist/gnubg.mjs")).href);

const t0 = performance.now();
const Module = await createGnubgModule();

// Copy the data files into Emscripten's in-memory filesystem, exactly as the
// browser worker will (there it fetch()es them instead of reading from disk).
const dataDir = path.join(root, "engine/data");
const FS = Module.FS;
FS.mkdirTree("/gnubg-data/met");
for (const f of ["gnubg.wd", "gnubg_os0.bd", "gnubg_ts0.bd"]) {
  FS.writeFile(`/gnubg-data/${f}`, readFileSync(path.join(dataDir, f)));
}
for (const f of readdirSync(path.join(dataDir, "met"))) {
  FS.writeFile(`/gnubg-data/met/${f}`, readFileSync(path.join(dataDir, "met", f)));
}

// Small wrapper: call a JSON API function and parse the result.
const call = (fn, arg) => JSON.parse(Module.ccall(fn, "string", ["string"], [arg]));
const api = (fn, req) => call(fn, JSON.stringify(req));

const init = call("gnubg_api_init", "/gnubg-data");
assert.equal(init.ok, true, `init failed: ${JSON.stringify(init)}`);
const t1 = performance.now();
console.log(`gnubg ${init.version} initialised in ${(t1 - t0).toFixed(0)} ms`);

const OPENING = "4HPwATDgc/ABMA"; // gnubg position ID of the starting position

// 1. Evaluate the opening position (0-ply and 2-ply, cubeful money game).
for (const plies of [0, 2]) {
  const r = api("gnubg_api_evaluate", { position: OPENING, eval: { plies, cubeful: true } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const p = r.probs;
  console.log(
    `\nOpening position, ${plies}-ply:` +
      `\n  win ${p.win.toFixed(4)}  W(g) ${p.winGammon.toFixed(4)}  W(bg) ${p.winBackgammon.toFixed(4)}` +
      `  L(g) ${p.loseGammon.toFixed(4)}  L(bg) ${p.loseBackgammon.toFixed(4)}` +
      `\n  cubeless equity ${r.cubelessEquity.toFixed(4)}   cubeful equity ${r.cubefulEquity.toFixed(4)}`
  );
  // Sanity: the opening is close to even for the player on roll.
  assert.ok(p.win > 0.45 && p.win < 0.56, "opening win probability out of range");
  assert.ok(Math.abs(r.cubelessEquity) < 0.15, "opening equity out of range");
}

// 2. Rank moves for an opening 3-1 at gnubg's "world class" setting.
const t2 = performance.now();
const r = api("gnubg_api_rank_moves", { position: OPENING, dice: [3, 1], preset: "world class" });
const t3 = performance.now();
assert.equal(r.ok, true, JSON.stringify(r));
console.log(`\nOpening 3-1, world class (${r.moves.length} legal plays, ${(t3 - t2).toFixed(0)} ms):`);
for (const [i, m] of r.moves.slice(0, 5).entries()) {
  console.log(
    `  ${i + 1}. ${m.move.padEnd(14)} eq ${m.equity >= 0 ? "+" : ""}${m.equity.toFixed(4)}` +
      `  diff ${m.diff.toFixed(4)}  (${m.plies}-ply${m.cubeful ? ", cubeful" : ""})`
  );
}
assert.equal(r.moves[0].move, "8/5 6/5", "best opening 3-1 should be 8/5 6/5");
assert.ok(r.moves.length === 16, `expected 16 legal 3-1 plays from the opening, got ${r.moves.length}`);

// 3. Bearoff databases. gnubg treats a missing or unreadable gnubg_os0.bd /
// gnubg_ts0.bd as non-fatal (it falls back to an approximation, sometimes
// without even a warning), and the positions above never use them. So rank
// the corpus' bearoff positions and require exactly the values native gnubg
// produced when it generated the corpus (tests/corpus/positions.json). Checked
// to fail when either file is missing or truncated: the "ts" positions need
// the two-sided database, the "os" positions the one-sided one.
const corpus = JSON.parse(readFileSync(path.join(root, "tests/corpus/positions.json"), "utf8"));
const bearoff = corpus.positions.filter((p) => p.category === "bearoff-ts" || p.category === "bearoff-os");
assert.ok(bearoff.some((p) => p.category === "bearoff-ts") && bearoff.some((p) => p.category === "bearoff-os"),
  "corpus is missing bearoff positions");
console.log("\nBearoff positions vs native gnubg (2-ply hint, exact):");
for (const p of bearoff) {
  const dice = api("gnubg_api_position_info", { position: p.positionId, match: p.matchId }).match.dice;
  const c = p.nativeHintAtCreation.context;
  const h = api("gnubg_api_rank_moves", {
    position: p.positionId, match: p.matchId, dice,
    eval: { plies: c.plies, cubeful: !!c.cubeful, prune: !!c.prune, deterministic: !!c.deterministic, noise: c.noise },
  });
  assert.equal(h.ok, true, JSON.stringify(h));
  const db = p.category === "bearoff-ts" ? "gnubg_ts0.bd (two-sided)" : "gnubg_os0.bd (one-sided)";
  p.nativeHintAtCreation.top.forEach((n, i) => {
    const m = h.moves[i];
    const probs = [m.probs.win, m.probs.winGammon, m.probs.winBackgammon, m.probs.loseGammon, m.probs.loseBackgammon];
    assert.ok(m.move === n.move && m.equity === n.equity && probs.every((x, k) => x === n.probs[k]),
      `${p.id}: move ${i + 1} is ${m.move} ${m.equity}, native gnubg says ${n.move} ${n.equity}. ` +
        `Is ${db} loaded correctly?`);
  });
  console.log(`  ${p.id.padEnd(14)} ${h.moves[0].move.padEnd(12)} eq ${h.moves[0].equity.toFixed(6)}` +
    `  = native (needs ${db})`);
}

console.log("\nSmoke test passed.");
