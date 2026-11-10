// Round-trip test for the web app's game logic and .mat writer.
//
//   node tests/ui_mat_roundtrip.mjs            (Node 24: runs the .ts modules directly)
//
// 1. Plays several matches/sessions through the web app's own game modules
//    (web/src/game/*.ts) with the wasm engine in Node: random legal moves,
//    gnubg's bot moves, random doubles / takes / drops / beavers and the odd
//    resignation, with crypto-random dice.
// 2. Along the way checks the move-entry logic (PlayBuilder): every legal play
//    can be entered checker by checker, and random step-by-step entry always
//    ends in one of the engine's legal plays. Also checks our TypeScript
//    position-ID / match-ID encoders against the engine's.
// 3. Writes each record with toMatText(), imports it into NATIVE gnubg
//    ("import mat"), and checks that every move, dice roll, position, match
//    ID (cube, owner, score, Crawford), cube action and game result that
//    gnubg reads back equals what the game logic recorded.
//
// Native gnubg: $GNUBG, default engine/native/build/strict/gnubg (see
// engine/native/). Exits 1 on any mismatch.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEngine, ROOT } from "./lib/engine-node.mjs";

const game = await import(path.join(ROOT, "web/src/game/match.ts"));
const { toMatText } = await import(path.join(ROOT, "web/src/game/matFile.ts"));
const { PlayBuilder, possibleSteps } = await import(path.join(ROOT, "web/src/game/partialMove.ts"));
const boardMod = await import(path.join(ROOT, "web/src/game/board.ts"));
const bot = await import(path.join(ROOT, "web/src/game/bot.ts"));
const { rollDice, rollOpening } = await import(path.join(ROOT, "web/src/game/dice.ts"));

const GNUBG = process.env.GNUBG ?? path.join(ROOT, "engine/native/build/strict/gnubg");
if (!existsSync(GNUBG)) {
  console.error(`native gnubg not found at ${GNUBG} (set $GNUBG)`);
  process.exit(1);
}

// ---- the wasm engine with the browser client's method names -------------
const raw = await loadEngine();
const call = (fn, req) => {
  const r = raw.call(fn, req);
  if (!r.ok) throw new Error(`${fn}: ${r.error} for ${JSON.stringify(req)}`);
  return Promise.resolve(r);
};
const engine = {
  legalMoves: (r) => call("gnubg_api_legal_moves", r),
  botMove: (r) => call("gnubg_api_bot_move", r),
  botDouble: (r) => call("gnubg_api_bot_double", r),
  botTake: (r) => call("gnubg_api_bot_take", r),
  analyseCube: (r) => call("gnubg_api_analyse_cube", r),
  rankMoves: (r) => call("gnubg_api_rank_moves", r),
  evaluate: (r) => call("gnubg_api_evaluate", r),
};

const rand = (n) => Math.floor(Math.random() * n);
const chance = (p) => Math.random() < p;
let checks = { idPositions: 0, idMatches: 0, builtPlays: 0, randomEntries: 0 };

/** Check PlayBuilder against the engine's legal list for this roll. */
function checkBuilder(start, dice, legal) {
  const pb = new PlayBuilder(start, dice, legal);
  for (const m of legal) {
    // our position ID encoder vs the engine
    assert.equal(boardMod.positionId(boardMod.applyPairs(start, m.pairs)), m.positionAfter);
    checks.idPositions++;
    // every legal play can be entered as single steps
    const steps = pb.stepsForMove(m);
    for (let k = 0; k < steps.length; k++) {
      const next = pb.nextSteps(steps.slice(0, k));
      assert.ok(
        next.some((s) => s.from === steps[k].from && s.to === steps[k].to && s.die === steps[k].die),
        `step ${k} of ${m.move} not offered (dice ${dice})`
      );
    }
    assert.equal(pb.completedMove(steps)?.positionAfter, m.positionAfter);
    checks.builtPlays++;
  }
  // random checker-by-checker entry always ends in a legal play
  for (let t = 0; t < 3 && legal.length; t++) {
    const steps = [];
    for (;;) {
      const next = pb.nextSteps(steps);
      if (!next.length) break;
      steps.push(next[rand(next.length)]);
    }
    assert.ok(pb.completedMove(steps), `random entry did not complete (dice ${dice})`);
    checks.randomEntries++;
  }
  if (!legal.length) assert.equal(pb.nextSteps([]).length, 0);
  // sanity: there are physically possible steps whenever the engine has moves
  if (legal.length) assert.ok(possibleSteps(start, dice[0]).length + possibleSteps(start, dice[1]).length > 0);
}

const lastAction = (s) => s.record.games.at(-1).actions.at(-1);

/** Play one match/session; returns the final MatchState. */
async function playMatch(settings, { maxGames, cubeRate, resignRate, botRate }) {
  let s = game.newMatch(settings, "2026-11-10");
  for (;;) {
    switch (s.phase) {
      case "opening":
        s = game.openingRoll(s, rollOpening());
        break;
      case "rolling":
        // (A resignation straight after a beavered cube is taken cannot be
        // written in .mat: Jellyfish leaves that "take" implicit until the
        // next roll. So only resign right after a move.)
        if (chance(resignRate) && lastAction(s)?.type === "move") {
          s = game.resign(s, s.turn, 1 + rand(3));
        } else if (game.canDouble(s, s.turn) && chance(cubeRate)) {
          s = game.double(s);
        } else {
          s = game.roll(s, rollDice());
        }
        break;
      case "doubled": {
        // Half the time gnubg answers (exercises bot.ts), else random.
        let a;
        if (chance(0.5)) a = await bot.botAnswerDouble(engine, s, "beginner");
        else a = ["take", "drop", "beaver"][rand(3)];
        if (a === "beaver" && !game.canBeaver(s)) a = "take";
        s = a === "take" ? game.take(s) : a === "drop" ? game.drop(s) : game.beaver(s);
        break;
      }
      case "moving": {
        const ids = game.idsFor(s, s.turn, s.dice);
        // our match ID encoder vs the engine's
        const info = await call("gnubg_api_position_info", { position: ids.position, match: ids.match });
        const mk = await call("gnubg_api_make_ids", { board: info.board, ...info.match });
        assert.equal(mk.matchId, ids.match);
        checks.idMatches++;
        const legal = (await engine.legalMoves({ ...ids, dice: s.dice })).moves;
        checkBuilder(game.boardFor(s, s.turn), s.dice, legal);
        let pairs = [], text = "";
        if (legal.length) {
          if (chance(botRate)) ({ pairs, move: text } = await bot.botChooseMove(engine, s, "expert"));
          else ({ pairs, move: text } = legal[rand(legal.length)]);
        }
        s = game.move(s, pairs, text);
        break;
      }
      case "gameOver":
        if (s.record.games.length >= maxGames) return s;
        s = game.nextGame(s);
        break;
      case "matchOver":
        return s;
    }
  }
}

// ---- native gnubg: import the .mat and dump what it read -----------------
const PY = String.raw`
import gnubg, json, sys
import os
mat, out, jacoby = os.environ["MAT_IN"], os.environ["MAT_OUT"], os.environ["MAT_JACOBY"]
gnubg.command("set jacoby " + jacoby)
gnubg.command('import mat "%s"' % mat)
m = gnubg.match(analysis=0, boards=1, statistics=0, verbose=0)
games = []
for gi, g in enumerate(m["games"]):
    gnubg.navigate()
    if gi:
        gnubg.navigate(game=gi)
    else:
        gnubg.navigate(next=0)
    recs = []
    for k, rec in enumerate(g["game"]):
        if k:
            gnubg.navigate(next=1)
        r = {"action": rec["action"], "player": rec.get("player")}
        if rec["action"] == "move":
            r["dice"] = list(rec["dice"])
            r["move"] = [list(p) for p in rec["move"]]
            r["board"] = rec["board"]
            r["pos"] = gnubg.positionid()
            r["mid"] = gnubg.matchid()
        if rec["action"] == "resign":
            r["points"] = rec.get("points")
        recs.append(r)
    games.append({"info": g["info"], "records": recs})
json.dump({"games": games, "length": m["match-info"]["match-length"]}, open(out, "w"))
`;

function importIntoNative(matText, jacoby, tag) {
  const dir = mkdtempSync(path.join(tmpdir(), "gnubg-mat-"));
  const matPath = path.join(dir, `${tag}.mat`);
  const pyPath = path.join(dir, "dump.py");
  const outPath = path.join(dir, "out.json");
  writeFileSync(matPath, matText);
  writeFileSync(pyPath, PY);
  execFileSync(
    GNUBG,
    ["-t", "-r", "-q", "-P", path.join(ROOT, "engine/data"), "-p", pyPath],
    {
      env: { ...process.env, HOME: dir, MAT_IN: matPath, MAT_OUT: outPath, MAT_JACOBY: jacoby ? "on" : "off" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  return { native: JSON.parse(readFileSync(outPath, "utf8")), matPath };
}

const XO = { X: 0, O: 1 };

function compare(rec, native, tag) {
  assert.equal(native.length, rec.matchLength, `${tag}: match length`);
  assert.equal(native.games.length, rec.games.length, `${tag}: number of games`);
  rec.games.forEach((g, gi) => {
    const ng = native.games[gi];
    const where = `${tag} game ${gi + 1}`;
    assert.deepEqual([ng.info["score-X"], ng.info["score-O"]], g.score, `${where}: score at start`);
    if (g.result) {
      assert.equal(XO[ng.info.winner], g.result.winner, `${where}: winner`);
      assert.equal(ng.info["points-won"], g.result.points, `${where}: points`);
      assert.equal(ng.info.resigned, g.result.how === "resign", `${where}: resigned`);
    }
    if ("crawford" in ng.info) assert.equal(ng.info.crawford, g.crawford, `${where}: Crawford`);
    // gnubg has no separate "beaver" record: a beaver is a second "double"
    const ours = g.actions.map((a) => ({ ...a, type: a.type === "beaver" ? "double" : a.type }));
    const theirs = ng.records;
    assert.equal(theirs.length, ours.length, `${where}: number of records ${JSON.stringify(theirs.map((r) => r.action))} vs ${JSON.stringify(ours.map((a) => a.type))}`);
    ours.forEach((a, k) => {
      const r = theirs[k];
      const at = `${where} record ${k + 1} (${a.type})`;
      assert.equal(r.action, a.type, at);
      assert.equal(XO[r.player], a.player, `${at}: player`);
      if (a.type === "move") {
        assert.deepEqual(r.dice, a.dice, `${at}: dice`);
        assert.equal(r.board, a.positionId, `${at}: position before the move`);
        assert.equal(r.pos, a.positionId, `${at}: navigated position`);
        assert.equal(r.mid, a.matchId, `${at}: match ID`);
        // compare the position after the move (gnubg may order sub-moves differently)
        const before = boardMod.boardFromPositionId(a.positionId);
        const mine = boardMod.positionId(boardMod.applyPairs(before, a.pairs));
        const pairs = r.move.map(([f, t]) => [f - 1, t - 1]); // PyMove is 1-based (25 = bar, 0 = off)
        assert.equal(boardMod.positionId(boardMod.applyPairs(before, pairs)), mine, `${at}: move ${a.move}`);
      }
      if (a.type === "resign") assert.equal(r.points, a.value, `${at}: resignation value`);
    });
  });
}

const runs = [
  { tag: "match1", settings: { matchLength: 1, jacoby: false, beavers: false }, opts: { maxGames: 99, cubeRate: 0.05, resignRate: 0, botRate: 0.5 } },
  { tag: "match3", settings: { matchLength: 3, jacoby: false, beavers: false }, opts: { maxGames: 99, cubeRate: 0.08, resignRate: 0.01, botRate: 0.3 } },
  { tag: "match5", settings: { matchLength: 5, jacoby: false, beavers: false }, opts: { maxGames: 99, cubeRate: 0.02, resignRate: 0.005, botRate: 0.3 } },
  { tag: "match7", settings: { matchLength: 7, jacoby: false, beavers: false }, opts: { maxGames: 99, cubeRate: 0.01, resignRate: 0.003, botRate: 0.2 } },
  // Rare cube use, so the match runs through a Crawford and post-Crawford game.
  { tag: "match9-crawford", settings: { matchLength: 9, jacoby: false, beavers: false }, opts: { maxGames: 99, cubeRate: 0.004, resignRate: 0.002, botRate: 0 } },
  { tag: "money-jacoby", settings: { matchLength: 0, jacoby: true, beavers: true }, opts: { maxGames: 4, cubeRate: 0.08, resignRate: 0.01, botRate: 0.3 } },
  { tag: "money-nojacoby", settings: { matchLength: 0, jacoby: false, beavers: true }, opts: { maxGames: 4, cubeRate: 0.1, resignRate: 0.01, botRate: 0.3 } },
];

const counts = { moves: 0, doubles: 0, beavers: 0, takes: 0, drops: 0, resigns: 0, games: 0, crawfordGames: 0 };
for (const run of runs) {
  const s = await playMatch({ ...run.settings, playerNames: ["gnubg", "Human Player"] }, run.opts);
  const text = toMatText(s.record);
  const { native, matPath } = importIntoNative(text, run.settings.jacoby, run.tag);
  try {
    compare(s.record, native, run.tag);
  } catch (e) {
    console.error(`FAILED ${run.tag}; .mat kept at ${matPath}`);
    throw e;
  }
  for (const g of s.record.games) {
    counts.games++;
    if (g.crawford) counts.crawfordGames++;
    for (const a of g.actions) counts[a.type + "s"]++;
  }
  const sc = s.score.join("-");
  console.log(`${run.tag.padEnd(15)} ${String(s.record.games.length).padStart(2)} games, final score ${sc}: native gnubg import matches`);
}
console.log("totals:", JSON.stringify(counts));
console.log("checks:", JSON.stringify(checks));
assert.ok(counts.crawfordGames > 0, "no Crawford game was played; rerun");
console.log("\n.mat round trip test passed.");
