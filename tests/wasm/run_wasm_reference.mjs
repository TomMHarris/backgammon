// run_wasm_reference.mjs - replay a native reference file through the
// WebAssembly engine, writing results in the same layout so that
// tests/compare/compare.py can compare them field by field.
//
//   node tests/wasm/run_wasm_reference.mjs [NATIVE_JSON] [OUT_JSON]
//
// Defaults: tests/reference/native-strict-fresh.json -> tests/reference/wasm-strict.json
//
// What it does, in ONE engine instance (the API flushes gnubg's evaluation
// cache at the start of every evaluating call, so this corresponds to the
// native "fresh" mode, one process per query):
//
// 1. Positions: every query of the native file, in the native order
//    (`queryOrder`), with the same inputs:
//      eval-Nply-cubeX  -> gnubg_api_evaluate   eval {plies N, cubeful X, prune, deterministic, noise 0}
//      hint-expert      -> gnubg_api_rank_moves preset "expert"
//      hint-worldclass  -> gnubg_api_rank_moves preset "world class"
//      cube-Nply        -> gnubg_api_analyse_cube eval {plies N, cubeful, prune, deterministic, noise 0}
//    Position and match ID are passed as they are. The API builds the cube
//    information like desktop gnubg (SetCubeInfo with nBeavers = 3, Jacoby
//    from the match ID); this script records it (from gnubg_api_position_info)
//    so the comparison can check it is the same cubeinfo native used.
//
// 2. Matches: every match file of the native file, in order, with the same
//    analysis settings: set_analysis_settings -> load_match -> clear_analysis
//    -> analyse_match -> get_analysis (all moves, with statistics text).
//
// Fields that exist on only one side (listed in the output as `notCompared`)
// are simply absent from one of the two files; compare.py reports them.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEngine, ROOT } from "../lib/engine-node.mjs";

const nativePath = process.argv[2] || path.join(ROOT, "tests/reference/native-strict-fresh.json");
const outPath = process.argv[3] || path.join(ROOT, "tests/reference/wasm-strict.json");
const native = JSON.parse(readFileSync(nativePath, "utf8"));

const engine = await loadEngine();
const call = (fn, req = {}) => {
  const r = engine.call(fn, req);
  if (!r.ok) throw new Error(`${fn} failed: ${JSON.stringify(r)} for ${JSON.stringify(req).slice(0, 300)}`);
  return r;
};

const SIDES = ["X", "O"];   // gnubg's Python names for player 0 and 1

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/** The cubeinfo fields native records, as the API builds them (parse_position). */
function cubeinfoFor(pos) {
  const m = call("gnubg_api_position_info", { position: pos.positionId, match: pos.matchId }).match;
  const money = m.matchLength === 0;
  return {
    info: m,
    cubeinfo: {
      cube: m.cube, cubeowner: m.cubeOwner, move: m.move, matchto: m.matchLength,
      // SetCubeInfoMoney sets score and Crawford to 0 (the money match IDs in
      // the corpus carry a running session score that gnubg ignores)
      score: money ? [0, 0] : m.score, crawford: !money && m.crawford ? 1 : 0,
      jacoby: money && m.jacoby ? 1 : 0,       // SetCubeInfoMatch forces 0 in match play
      beavers: money ? 3 : 0,                  // nBeavers (gnubg.c:231); 0 in match play
    },
  };
}

const evalCtx = (plies, cubeful) => ({ plies, cubeful, prune: true, deterministic: true, noise: 0 });

function runQuery(pos, query) {
  const { info, cubeinfo } = cubeinfoFor(pos);
  const base = { position: pos.positionId, match: pos.matchId };
  let m;
  if ((m = query.match(/^eval-(\d)ply-(cubeful|cubeless)$/))) {
    const r = call("gnubg_api_evaluate", { ...base, eval: evalCtx(Number(m[1]), m[2] === "cubeful") });
    return {
      call: "gnubg_api_evaluate", cubeinfo, evalContext: r.eval,
      probs: r.probs, cubelessEquity: r.cubelessEquity,
      cubefulEquity: r.cubefulEquity,   // native cannot report this (Python returns 6 of 7 outputs)
    };
  }
  if ((m = query.match(/^hint-(expert|worldclass)$/))) {
    const preset = m[1] === "expert" ? "expert" : "world class";
    // Dice in the order the match ID stores them, as native's SetMatchID -> SetDice uses them.
    const r = call("gnubg_api_rank_moves", { ...base, dice: info.dice, preset });
    return {
      call: "gnubg_api_rank_moves", cubeinfo, preset,
      moves: r.moves.map((x) => ({ move: x.move, equity: x.equity, diff: x.diff, probs: x.probs,
                                   plies: x.plies, cubeful: x.cubeful ? 1 : 0 })),
    };
  }
  if ((m = query.match(/^cube-(\d)ply$/))) {
    const r = call("gnubg_api_analyse_cube", { ...base, eval: evalCtx(Number(m[1]), true) });
    const out = {
      call: "gnubg_api_analyse_cube", cubeinfo, evalContext: r.eval,
      equities: r.equities, decision: r.decision, recommendation: r.recommendation,
      percent: r.percent, cubeAvailable: r.cubeAvailable,
      noDouble: r.noDouble,             // native cannot report this (see PYTHON_INTERFACE.md)
    };
    if (r.mwc) out.mwc = r.mwc;
    return out;
  }
  throw new Error(`unknown query ${query}`);
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

// Native preset name -> wasm move filter name (dump_match_reference.py ANALYSIS_PRESETS)
const FILTER_OF_PRESET = { "world class": "normal", supremo: "large" };

function wasmSettings(ns) {
  const ctx = (e) => ({ plies: e.plies, cubeful: !!e.cubeful, prune: !!e.prune,
                        deterministic: !!e.deterministic, noise: e.noise });
  if (ns.globalJacoby !== "on") {
    // The API has no global Jacoby setting; gnubg's default (on) is in effect.
    throw new Error(`native used global Jacoby ${ns.globalJacoby}; the wasm API can only use gnubg's default (on)`);
  }
  return {
    defaults: true,   // gnubg's thresholds and analyse flags (moves, cube, luck on)
    chequer: ctx(ns.chequerplay),
    cube: ctx(ns.cubedecision),
    moveFilter: FILTER_OF_PRESET[ns.preset],
    luck: ctx(ns.luckAnalysis),
    analyse: { moves: true, cube: true, luck: true, players: [true, true] },
  };
}

const SKILL = { none: undefined, doubtful: "doubtful", bad: "bad", verybad: "very bad" };
const LUCK = { none: undefined, veryunlucky: "verybad", unlucky: "bad", lucky: "good", verylucky: "verygood" };
const cost = (x) => (x.mwc !== undefined ? x.mwc : x.points);

function convertRecord(r) {
  const out = { index: r.index, action: r.type === "setdice" || r.type === "setboard" ||
                r.type.startsWith("setcube") ? "set" : r.type };
  if (r.player !== undefined && r.player !== null && r.player >= 0) out.player = SIDES[r.player];
  if (r.dice) out.dice = r.dice;
  if (r.positionId) out.positionId = r.positionId;
  out.cubeinfo = { cube: r.cube, cubeowner: r.cubeOwner };
  const a = {};
  if (r.type === "move") {
    out.move = r.move;
    const c = r.chequer;
    if (c && c.analysed && c.moves && c.moves.length) {
      a.moves = c.moves.map((x) => ({ move: x.move, equity: x.equity, probs: x.probs,
                                      plies: x.plies, cubeful: x.cubeful }));
      a.playedIndex = c.playedIndex;
      a.bestMove = c.moves[0].move;
      a.equityLoss = c.error.equity;
      a.equityLossCost = cost(c.error);
      if (SKILL[c.skill]) a.skill = SKILL[c.skill];
    }
  }
  if (r.luck) {
    a["luck-value"] = r.luck.equity;
    a.luckCost = cost(r.luck);
    if (LUCK[r.luck.label]) a.luck = LUCK[r.luck.label];
  }
  const cd = r.cubeDecision;
  if (cd) {
    const raw = cd.raw;
    if (r.type === "move" || r.type === "double") {
      a.cube = {
        stored: { probs: raw.noDoubleProbs, "nd-cubeful-eq": raw.noDoubleCubeful,
                  "dt-cubeful-eq": raw.doubleTakeCubeful, "nd-match-eq": raw.noDoubleCubeless,
                  "dt-match-eq": raw.doubleTakeCubeless },
        derived: { noDouble: cd.equities.noDouble, doubleTake: cd.equities.doubleTake,
                   doublePass: cd.equities.doublePass, optimal: cd.equities.optimal },
        actionError: cd.error.equity, actionErrorCost: cost(cd.error),
        decision: cd.decision, recommendation: cd.proper,
      };
      if (r.type === "move") { if (SKILL[cd.skill]) a["cube-skill"] = SKILL[cd.skill]; }
      else if (SKILL[cd.skill]) a.skill = SKILL[cd.skill];
    } else {   // take / drop: judged on the double's evaluation
      a.cube = { basedOnDoubleRecord: true, actionError: cd.error.equity, actionErrorCost: cost(cd.error) };
      if (SKILL[cd.skill]) a.skill = SKILL[cd.skill];
    }
  } else if (r.skill && SKILL[r.skill]) {
    a.skill = SKILL[r.skill];
  }
  if (Object.keys(a).length) out.analysis = a;
  return out;
}

function convertStats(st, matchLength) {
  const derived = {}, raw = {}, luckCounts = {};
  st.players.forEach((p, i) => {
    const s = SIDES[i], d = {};
    const pair = (x) => [x.equity, cost(x)];
    if (p.chequer) {
      d.chequerErrorTotal = pair(p.chequer.errorTotal);
      d.chequerErrorPerMove = pair(p.chequer.errorPerMove);
      d.chequerRating = p.chequer.rating === null ? null : p.chequer.ratingIndex;
    }
    if (p.cube) {
      d.cubeErrorTotal = pair(p.cube.errorTotal);
      d.cubeErrorPerDecision = pair(p.cube.errorPerDecision);
      d.cubeRating = p.cube.rating === null ? null : p.cube.ratingIndex;
    }
    const o = p.overall;
    d.overallErrorTotal = pair(o.errorTotal);
    d.overallErrorPerDecision = pair(o.errorPerDecision);
    d.overallRating = o.rating === null ? null : o.ratingIndex;
    d.snowieErrorRate = o.snowieErrorRate;
    if (p.luck) {
      d.luckTotal = pair(p.luck.total);
      d.luckPerMove = pair(p.luck.perMove);
      d.luckRating = p.luck.rating === null ? null : p.luck.ratingIndex;
      d.actualResult = o.actualResult;
      d.luckAdjustedResult = o.luckAdjustedResult;
      const lm = p.luck.marked;
      luckCounts[s] = { verygood: lm.veryLucky, good: lm.lucky, unmarked: lm.none, bad: lm.unlucky, verybad: lm.veryUnlucky };
    }
    derived[s] = d;
    const r = {};
    if (p.chequer) {
      const m = p.chequer.marked;
      r.moves = { "unforced-moves": p.chequer.unforcedMoves, "total-moves": p.chequer.totalMoves,
                  "error-skill": p.chequer.errorTotal.equity, "error-cost": cost(p.chequer.errorTotal),
                  marked: { "very bad": m.veryBad, bad: m.bad, doubtful: m.doubtful, unmarked: m.none } };
    }
    if (p.cube) {
      const c = p.cube;
      r.cube = { "total-cube": c.total, "close-cube": c.close, "n-doubles": c.doubles, "n-takes": c.takes,
                 "n-drops": c.passes,
                 "missed-double-below-cp": c.missedDoubleBelowCP.count, "missed-double-above-cp": c.missedDoubleAboveCP.count,
                 "wrong-double-below-dp": c.wrongDoubleBelowDP.count, "wrong-double-above-tg": c.wrongDoubleAboveTG.count,
                 "wrong-take": c.wrongTake.count, "wrong-drop": c.wrongPass.count,
                 // gnubg.match()'s cube "error-skill/-cost" are per close decision
                 "error-skill": c.errorPerDecision.equity, "error-cost": cost(c.errorPerDecision) };
      const errs = { "missed-double-below-cp": c.missedDoubleBelowCP, "missed-double-above-cp": c.missedDoubleAboveCP,
                     "wrong-double-below-dp": c.wrongDoubleBelowDP, "wrong-double-above-tg": c.wrongDoubleAboveTG,
                     "wrong-take": c.wrongTake, "wrong-drop": c.wrongPass };
      for (const [k, v] of Object.entries(errs)) {
        r.cube[`err-${k}-skill`] = v.equity;
        r.cube[`err-${k}-cost`] = cost(v);
      }
    }
    if (p.luck) {
      r.dice = { luck: p.luck.total.equity, "luck-cost": cost(p.luck.total),
                 "actual-result": o.actualResult, "luck-adjusted-result": o.luckAdjustedResult };
    }
    if (o.errorBasedFibsRating) {
      r["error-based-fibs-rating"] = { total: o.errorBasedFibsRating.total };
      if (p.chequer && p.chequer.unforcedMoves) r["error-based-fibs-rating"].chequer = o.errorBasedFibsRating.chequerLoss;
      if (p.cube && p.cube.close) r["error-based-fibs-rating"].cube = o.errorBasedFibsRating.cubeLoss;
    }
    raw[s] = r;
  });
  // native reports the luck-based FIBS rating difference per side; gnubg's text shows player 0's
  if (st.luckBasedFibsRatingDiff !== undefined && st.luckBasedFibsRatingDiff !== null && raw.X.dice)
    raw.X.dice["fibs-rating-difference"] = st.luckBasedFibsRatingDiff;
  return { derived, raw, luckCounts };
}

function runMatch(nm) {
  const settings = call("gnubg_api_set_analysis_settings", wasmSettings(nm.settings)).settings;
  const file = path.isAbsolute(nm.file) ? nm.file : path.join(ROOT, nm.file);
  const info = call("gnubg_api_load_match", { format: nm.format, text: readFileSync(file, "utf8") });
  call("gnubg_api_clear_analysis");   // as native: "analyse clear match"
  const t0 = performance.now();
  call("gnubg_api_analyse_match");
  const seconds = (performance.now() - t0) / 1000;
  const a = call("gnubg_api_get_analysis", { maxMoves: 0, text: true });
  const st = convertStats(a.statistics, a.matchLength);
  return {
    file: nm.file, format: nm.format, analyseSeconds: seconds,
    matchInfo: { players: info.players, "match-length": a.matchLength, jacoby: a.jacoby },
    settings: { preset: nm.settings.preset, wasm: settings },
    games: a.games.map((g) => ({ info: { scoreBefore: g.scoreBefore, winner: g.winner, points: g.points },
                                 records: g.records.map(convertRecord) })),
    statistics: {
      raw: st.raw, derived: st.derived, luckLabelCountsFromRecords: st.luckCounts,
      showStatisticsMatchText: a.statisticsText,
    },
  };
}

// ---------------------------------------------------------------------------

const t0 = performance.now();
let positionsReference = null;
const pr = native.positionsReference;
if (pr && pr.results) {
  const results = [];
  for (const nr of [...pr.results].sort((x, y) => x.queryIndex - y.queryIndex)) {
    const pos = pr.positions[nr.positionIndex];
    results.push({ queryIndex: nr.queryIndex, positionIndex: nr.positionIndex,
                   positionKey: nr.positionKey, query: nr.query, result: runQuery(pos, nr.query) });
  }
  positionsReference = { generator: "tests/wasm/run_wasm_reference.mjs", variant: "wasm", mode: "one instance, cache flushed per call",
                         corpus: pr.corpus, queryOrder: pr.queryOrder, positions: pr.positions, results };
}
const tPos = (performance.now() - t0) / 1000;
const t1 = performance.now();
const matchesReference = (native.matchesReference || []).map(runMatch);
const tMatch = (performance.now() - t1) / 1000;

const out = {
  variant: "wasm", mode: "single-instance", engineVersion: engine.version,
  replayed: path.relative(ROOT, nativePath),
  seconds: { positions: tPos, matches: tMatch },
  notCompared: [
    "eval cubefulEquity: wasm only (gnubg.evaluate() does not return it)",
    "cube noDouble probs/cubeless equity: wasm only (gnubg.cfevaluate() does not return them)",
    "hint/eval evalContext per move (deterministic flag): native only; plies and cubeful are compared",
    "match records: move mwc, cubelessEquity, rank, cube 'close', resign analysis: wasm only",
    "match statistics: variances, ppg advantage: wasm only; per-game statistics: native only",
    "cubeinfo gammon prices: native only",
  ],
  positionsReference, matchesReference,
};
writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`wrote ${path.relative(ROOT, outPath)} (positions ${tPos.toFixed(1)} s, matches ${tMatch.toFixed(1)} s)`);
