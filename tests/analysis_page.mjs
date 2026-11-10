// Checks the analysis page's view model (web/src/lib/analysisView.ts)
// against gnubg's own get_analysis output, with the wasm engine in Node.
//
//   node tests/analysis_page.mjs [match file ...] [--preset expert]
//
// Default: tests/corpus/matches/selfplay-7pt.sgf (a match with real errors)
// plus money4.sgf (money-play formatting), analysed at "expert" (0-ply), the
// page's fastest preset, game by game exactly as the page does it.
//
// For every match it checks that
//   1. every decision gnubg recorded (move, double, take, drop, resign) is
//      listed once, in order, with gnubg's player, dice and move text;
//   2. the error and luck marks shown are gnubg's marks, and counting them per
//      player gives gnubg's statistics counters (unmarked / doubtful / bad /
//      very bad moves; very lucky ... very unlucky rolls);
//   3. the statistics panel (statSections) shows exactly gnubg's
//      "show statistics" rows: same labels, same values, for the match and
//      for every game;
//   4. the board after every listed move (played and alternatives), which the
//      page computes from gnubg's move text, equals the position the engine's
//      legal_moves gives for that move;
//   5. the graph values are gnubg's numbers (played move's win probability /
//      MWC / equity, cube evaluations), turned to one player's side;
//   6. the move list's row numbers match gnubg's .mat export.
// Exits non-zero on the first failure (node:assert). About 2 s at expert;
// pass --preset "world class" for gnubg's 2-ply analysis (about a minute).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEngine, ROOT } from "./lib/engine-node.mjs";

const view = await import(path.join(ROOT, "web/src/lib/analysisView.ts"));
const { positionId } = await import(path.join(ROOT, "web/src/game/board.ts"));

const args = process.argv.slice(2);
let preset = "expert";
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--preset") preset = args[++i];
  else files.push(args[i]);
}
if (!files.length) files.push("tests/corpus/matches/selfplay-7pt.sgf", "tests/corpus/matches/money4.sgf");

const engine = await loadEngine();
const call = (fn, req = {}) => {
  const r = engine.call(fn, req);
  assert.equal(r.ok, true, `${fn} failed: ${JSON.stringify(r).slice(0, 300)}`);
  return r;
};

const SKILL_KEY = { none: "none", doubtful: "doubtful", bad: "bad", verybad: "veryBad" };
const LUCK_KEY = { verylucky: "veryLucky", lucky: "lucky", none: "none", unlucky: "unlucky", veryunlucky: "veryUnlucky" };
const KINDS = ["move", "double", "take", "drop", "resign"];

/** gnubg's "show statistics" text -> [{label, cells:[a, b]}] (column layout of formatGS). */
function parseStatsText(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (line.length <= 41 || line.startsWith("Player")) continue;
    const label = line.slice(0, 41).trim();
    if (!label) continue;
    rows.push({ label, cells: [line.slice(41, 65).trim(), line.slice(65).trim()] });
  }
  return rows;
}
const norm = (s) => s.replace(/−/g, "-").replace(/\s+/g, "");
const numbers = (s) => (norm(s).match(/[-+]?\d+(\.\d+)?/g) ?? []).map(Number);
/** Same text once spaces are ignored and the real minus is ASCII; numbers compared as numbers (-0 == 0). */
function sameCell(mine, gnubg, where) {
  const a = norm(mine);
  const b = norm(gnubg);
  if (a === b) return;
  const na = numbers(mine);
  const nb = numbers(gnubg);
  const textA = a.replace(/[-+]?\d+(\.\d+)?/g, "#");
  const textB = b.replace(/[-+]?\d+(\.\d+)?/g, "#");
  assert.equal(textA, textB, `${where}: "${mine}" vs gnubg "${gnubg}"`);
  assert.deepEqual(na, nb, `${where}: "${mine}" vs gnubg "${gnubg}"`);
}

/** Compare statSections with gnubg's text, row by row. */
function checkStats(st, text, matchLength, factor, where) {
  const mine = view.statSections(st, matchLength, factor).flatMap((s) => s.rows);
  const theirs = parseStatsText(text);
  // gnubg prints the Snowie rate as "<mEMG> ( +0.000%)" (a constant second part); the page shows the rate only.
  for (const r of theirs) if (r.label === "Snowie error rate") r.cells = r.cells.map((c) => c.replace(/\(\s*\+0\.000%?\)/, ""));
  assert.deepEqual(mine.map((r) => r.label), theirs.map((r) => r.label), `${where}: statistics rows`);
  mine.forEach((r, k) => r.cells.forEach((c, i) => sameCell(c, theirs[k].cells[i], `${where}: ${r.label} [player ${i}]`)));
  return mine.length;
}

/** Row numbers of gnubg's .mat export, per game: one entry per decision, in order. */
function matRows(matText) {
  const games = [];
  let cur = null;
  for (const line of matText.split("\n")) {
    if (/^\s*Game \d+/.test(line)) {
      cur = [];
      games.push(cur);
      continue;
    }
    const m = /^\s*(\d+)\)(.*)$/.exec(line);
    if (!m || !cur) continue;
    // Player 0's column starts right after "nnn) ", player 1's about 31 characters later
    // (a long left entry can push it right). Each entry starts with dice or a cube word.
    const body = line.slice(line.indexOf(")") + 1);
    const starts = [...body.matchAll(/(\d\d:|Doubles|Beavers|Takes|Drops|Resigns|Accepts|Rejects)/g)];
    starts.forEach((s, k) => {
      const text = body.slice(s.index, k + 1 < starts.length ? starts[k + 1].index : undefined).trim();
      cur.push({ row: Number(m[1]), player: s.index < 10 ? 0 : 1, text });
    });
  }
  return games;
}

for (const rel of files) {
  const file = path.resolve(ROOT, rel);
  const name = path.basename(file);
  const format = file.endsWith(".mat") ? "mat" : "sgf";
  const info = call("gnubg_api_load_match", { format, text: readFileSync(file, "utf8") });
  // As the page does it (lib/analysisRun.ts): clear, settings, then game by game.
  call("gnubg_api_clear_analysis");
  call("gnubg_api_set_analysis_settings", { defaults: true, chequer: { preset }, cube: { preset } });
  for (const g of info.games) call("gnubg_api_analyse_game", { game: g.index });
  const res = call("gnubg_api_get_analysis", { maxMoves: 8, text: true });
  const v = view.buildMatchView(res);
  const counts = { decisions: 0, marks: 0, luck: 0, boards: 0, statRows: 0, graph: 0 };

  // 1. every decision, in order
  let seq = 0;
  res.games.forEach((g, gi) => {
    const recs = g.records.filter((r) => KINDS.includes(r.type));
    const gv = v.games[gi];
    assert.equal(gv.decisions.length, recs.length, `${name} game ${gi + 1}: decision count`);
    recs.forEach((r, k) => {
      const d = gv.decisions[k];
      assert.equal(d, v.decisions[seq], `${name}: match-wide order`);
      assert.equal(d.seq, seq++);
      assert.equal(d.record, r);
      assert.equal(d.kind, r.type);
      assert.equal(d.player, r.player);
      if (r.type === "move") assert.equal(d.text, `${r.dice[0]}${r.dice[1]}: ${r.move || "(no move)"}`);
      counts.decisions++;
    });
  });
  assert.equal(v.decisions.length, counts.decisions);

  // 2. marks = gnubg's marks; counted per player = gnubg's statistics counters
  const tally = (games) => {
    const t = [0, 1].map(() => ({ skill: { none: 0, doubtful: 0, bad: 0, veryBad: 0 }, luck: { veryLucky: 0, lucky: 0, none: 0, unlucky: 0, veryUnlucky: 0 } }));
    for (const gv of games)
      for (const d of gv.decisions) {
        const r = d.record;
        if (d.kind === "move") {
          assert.equal(d.chequerSkill, r.chequer.analysed ? r.chequer.skill : "none");
          assert.equal(d.luck, r.luck?.label ?? "none");
          t[d.player].skill[SKILL_KEY[d.chequerSkill]]++;
          if (r.luck) t[d.player].luck[LUCK_KEY[d.luck]]++;
          if (d.chequerSkill !== "none") counts.marks++;
          if (d.luck !== "none") counts.luck++;
        }
        if (r.cubeDecision) assert.equal(d.cubeSkill, r.cubeDecision.skill);
        if (d.cubeSkill !== "none") counts.marks++;
      }
    return t;
  };
  const checkTally = (t, st, where) =>
    [0, 1].forEach((p) => {
      assert.deepEqual(t[p].skill, st.players[p].chequer.marked, `${where}: ${res.players[p]}'s move marks`);
      assert.deepEqual(t[p].luck, st.players[p].luck.marked, `${where}: ${res.players[p]}'s luck marks`);
    });
  checkTally(tally(v.games), res.statistics, `${name} match`);
  v.games.forEach((gv) => checkTally(tally([gv]), gv.statistics, `${name} game ${gv.index + 1}`));
  // (tally() counted every game twice; recount the shown marks once)
  counts.marks /= 2;
  counts.luck /= 2;

  // 3. statistics panel = gnubg's "show statistics" text
  counts.statRows += checkStats(res.statistics, res.statisticsText, res.matchLength, res.errorRateFactor, `${name} match`);
  for (const gv of v.games) counts.statRows += checkStats(gv.statistics, gv.statisticsText, res.matchLength, res.errorRateFactor, `${name} game ${gv.index + 1}`);

  // 4. boards after every listed move = the engine's positions
  for (const d of v.decisions) {
    const r = d.record;
    if (d.kind !== "move" || !r.dice) continue;
    const legal = call("gnubg_api_legal_moves", { position: r.positionId, match: r.matchId, dice: r.dice });
    const byText = new Map(legal.moves.map((m) => [m.move, m]));
    const texts = new Set([...(r.chequer?.moves ?? []).map((m) => m.move), ...(r.move ? [r.move] : [])]);
    for (const t of texts) {
      const lm = byText.get(t);
      assert.ok(lm, `${name}: "${t}" is not one of the engine's legal moves`);
      // boardAfter is oriented for the board; with the mover at the bottom it is the mover's view.
      const after = view.boardAfter(d, t, d.onRoll);
      assert.equal(positionId(after), lm.positionAfter, `${name} game ${d.game + 1} ${d.text}: board after "${t}"`);
      const trail = view.moveTrail(d, t, d.onRoll);
      assert.equal(trail.player, 1);
      assert.equal(trail.steps.length, view.parseMove(t).length);
      counts.boards++;
    }
    // the board before is gnubg's position, seen from either side
    assert.equal(positionId(view.boardBefore(d, d.onRoll)), r.positionId);
    const other = view.boardBefore(d, 1 - d.onRoll);
    assert.deepEqual([other[1], other[0]], view.boardBefore(d, d.onRoll));
  }

  // 5. graph values are gnubg's numbers
  for (const mode of ["win", "equity"])
    for (const persp of [0, 1]) {
      const pts = view.graphPoints(v.decisions, mode, persp, res.matchLength);
      assert.equal(pts.length, v.decisions.length);
      for (const p of pts) {
        const d = p.d;
        const r = d.record;
        let expected = null;
        let actor = null;
        if (d.kind === "move" && r.chequer?.analysed && r.chequer.playedIndex !== null) {
          const m = r.chequer.moves.find((x) => x.rank === r.chequer.playedIndex);
          actor = r.player;
          expected = mode === "win" ? m.probs.win : res.matchLength ? m.mwc : m.equity;
        } else if (["double", "take", "drop"].includes(d.kind) && r.cubeDecision) {
          const cd = r.cubeDecision;
          const key = d.kind === "drop" ? "doublePass" : "doubleTake";
          actor = d.kind === "double" ? r.player : 1 - r.player;
          expected = mode === "win" ? cd.raw.noDoubleProbs.win : res.matchLength ? cd.mwc[key] : cd.equities[key];
        }
        if (expected === null) {
          assert.equal(p.y, null);
          continue;
        }
        const flip = actor !== persp;
        const want = !flip ? expected : mode === "win" || res.matchLength ? 1 - expected : -expected;
        assert.equal(p.y, want, `${name} graph ${mode} ${d.text}`);
        if (mode === "win") assert.ok(p.y >= 0 && p.y <= 1);
        counts.graph++;
      }
    }

  // 6. move-list rows = gnubg's .mat rows
  const mat = matRows(call("gnubg_api_export_match", { format: "mat" }).text);
  assert.equal(mat.length, v.games.length, `${name}: games in the .mat export`);
  v.games.forEach((gv, gi) => {
    const mine = gv.decisions.filter((d) => d.kind !== "resign"); // the .mat export writes no resign rows for some results
    const theirs = mat[gi].filter((e) => !/^Resigns|^Accepts|^Wins/i.test(e.text));
    assert.equal(mine.length, theirs.length, `${name} game ${gi + 1}: .mat entries`);
    mine.forEach((d, k) => {
      assert.equal(d.row, theirs[k].row, `${name} game ${gi + 1}: row of "${d.text}"`);
      assert.equal(d.player, theirs[k].player, `${name} game ${gi + 1}: column of "${d.text}"`);
    });
  });

  console.log(
    `${name}: ${info.games.length} games, ${counts.decisions} decisions listed; ${counts.marks} error marks and ` +
      `${counts.luck} luck marks = gnubg's; ${counts.statRows} statistics rows = gnubg's text; ` +
      `${counts.boards} boards after moves = engine; ${counts.graph} graph values = gnubg's; .mat rows ok`
  );
}

// Parser corner cases (gnubg's notation).
assert.deepEqual(view.parseMove("24/18 6/3"), [[23, 17], [5, 2]]);
assert.deepEqual(view.parseMove("8/5(2) 6/3(2)"), [[7, 4], [7, 4], [5, 2], [5, 2]]);
assert.deepEqual(view.parseMove("bar/23*/22"), [[24, 22], [22, 21]]);
assert.deepEqual(view.parseMove("6/off 5/off"), [[5, -1], [4, -1]]);
assert.deepEqual(view.parseMove(""), []);
// Formatting as gnubg prints it.
assert.equal(view.signed(-0, 3), "−0.000");
assert.equal(view.costText({ equity: 0.141, mwc: 0.00884 }, 7, -1), "−0.141 (−0.884%)");

console.log("analysis page view model: all checks passed");
