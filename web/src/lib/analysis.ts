// Post-game analysis with gnubg's own match analysis (engine/api/MATCH_API.md).
//
// Flow, run in the engine worker after a game (or the match) ends:
//   1. toMatText(record)            our game record as a .mat file
//   2. engine.loadMatch(...)        gnubg imports it ("import mat")
//   3. engine.setAnalysisSettings   gnubg's defaults, with the chosen preset
//                                   for chequer play and cube decisions
//   4. engine.analyseGame(i)        "analyse game" (one game, or every game
//                                   in turn for the match, reporting progress)
//   5. engine.getAnalysis(...)      the records and gnubg's statistics
//
// Every number shown comes verbatim from get_analysis; this module only picks
// fields and maps gnubg's player numbers onto ours.
//
// Players: toMatText writes gnubg (our player 0) in the left column and you
// (player 1) in the right, and gnubg's importer makes the left column its
// player 0 (the .mat round-trip test checks this). We still look the names up
// rather than assume the order.

import type { EngineClient } from "@/engine/client";
import type { AnalysisRecord, Cost, PlayerStatistics, Preset, SkillMark } from "@/engine/types";
import { boardFromPositionId, swapSides, type Board, type Dice, type Side } from "@/game/board";
import type { MatchRecord } from "@/game/match";
import { toMatText } from "@/game/matFile";
import { NAMES, rowsOf } from "./format";
import { buildMatchView, type MatchView, type Player } from "./analysisView";

export interface Mistake {
  game: number; // 0-based game index
  row: number; // row number in the game's move list (as in the .mat file)
  kind: "move" | "cube";
  dice: Dice | null;
  played: string; // the move played, or the cube action ("Double", "Take", "Pass", "No double")
  best: string; // gnubg's best move, or its cube verdict ("Double, take")
  error: Cost; // <= 0, gnubg's error of the action
  skill: SkillMark;
  board: Board; // the position before the action, from the human's side (board[1] = you)
  cube: number;
  cubeOwner: -1 | Side; // our side numbering
  player: Side; // who made the mistake (always 1, you, except in a two-player game)
}

export interface AnalysisSummary {
  scope: "game" | "match";
  game: number; // the game analysed (scope "game"), or the number of games
  preset: Preset;
  plies: number; // chequer-play plies gnubg used
  matchLength: number;
  errorRateFactor: number; // gnubg shows rates x 1000 (mEMG)
  stats: [PlayerStatistics, PlayerStatistics]; // indexed by OUR side: [gnubg, you]
  mistakes: Mistake[]; // your biggest errors, worst first (at most 3)
  view: MatchView; // the same reply as the analysis page's view model (the card's win-chance graph)
  human: Player; // your player number in gnubg's numbering (view.players)
  names: [string, string]; // our sides' names: [gnubg, "You"], or the two players'
  twoPlayer: boolean; // both sides are people: mistakes of both are listed
}

const CUBE_ACTION: Record<string, string> = { "no double": "No double", double: "Double", take: "Take", drop: "Pass" };

/**
 * Analyse the last game (scope "game") or every game (scope "match") of the
 * record. `onProgress(done, total)` is called between games.
 */
export async function analyse(
  engine: EngineClient,
  record: MatchRecord,
  scope: "game" | "match",
  preset: Preset,
  onProgress?: (done: number, total: number) => void
): Promise<AnalysisSummary> {
  const info = await engine.loadMatch({ format: "mat", text: toMatText(record) });
  const set = await engine.setAnalysisSettings({ defaults: true, chequer: { preset }, cube: { preset } });
  const last = info.games.length - 1;
  const games = scope === "game" ? [last] : info.games.map((g) => g.index);
  onProgress?.(0, games.length);
  for (let k = 0; k < games.length; k++) {
    await engine.analyseGame({ game: games[k] });
    onProgress?.(k + 1, games.length);
  }
  const res = await engine.getAnalysis(scope === "game" ? { maxMoves: 1, game: last } : { maxMoves: 1 });

  // gnubg's player index -> our side (0 = gnubg, 1 = you)
  const names = record.playerNames;
  const twoPlayer = names[0] !== NAMES[0];
  const humanIdx = res.players.indexOf(names[1]) === 0 ? 0 : 1;
  const side = (p: number): Side => (p === humanIdx ? 1 : 0);
  const statsByIdx = scope === "game" ? res.games[0].statistics.players : res.statistics.players;
  const stats: [PlayerStatistics, PlayerStatistics] =
    humanIdx === 1 ? [statsByIdx[0], statsByIdx[1]] : [statsByIdx[1], statsByIdx[0]];

  const mistakes: Mistake[] = [];
  for (const g of res.games) {
    const acts = g.records.filter((r) => ["move", "double", "take", "drop", "resign"].includes(r.type));
    const { rowOf } = rowsOf(
      acts.map((r) => ({ ...r, player: side(r.player) })),
      () => "",
      () => ""
    );
    acts.forEach((r, k) => {
      if (side(r.player) !== 1 && !twoPlayer) return;
      for (const m of mistakesOf(r, side)) mistakes.push({ ...m, game: g.index, row: rowOf[k], player: side(r.player) });
    });
  }
  mistakes.sort((a, b) => a.error.equity - b.error.equity);

  return {
    scope,
    game: scope === "game" ? last : info.games.length,
    preset,
    plies: set.settings.chequer.eval.plies,
    matchLength: res.matchLength,
    errorRateFactor: res.errorRateFactor,
    stats,
    mistakes: mistakes.slice(0, twoPlayer ? 4 : 3),
    view: buildMatchView(res),
    human: humanIdx as Player,
    names,
    twoPlayer,
  };
}

/** The errors in one of your records: a chequer error and/or a cube error. */
function mistakesOf(r: AnalysisRecord, side: (p: number) => Side): Omit<Mistake, "game" | "row" | "player">[] {
  // The position is from the side of the player to act; for take/drop that
  // is the doubler (MATCH_API.md, "Records").
  const onRoll = r.type === "take" || r.type === "drop" ? 1 - r.player : r.player;
  const b = boardFromPositionId(r.positionId);
  const board = side(onRoll) === 1 ? b : swapSides(b);
  const base = {
    board,
    cube: r.cube,
    cubeOwner: (r.cubeOwner === -1 ? -1 : side(r.cubeOwner)) as -1 | Side,
    dice: r.dice ?? null,
  };
  const out: Omit<Mistake, "game" | "row" | "player">[] = [];
  const cd = r.cubeDecision;
  if (cd && cd.error && cd.error.equity < 0) {
    out.push({ ...base, dice: null, kind: "cube", played: CUBE_ACTION[cd.actual] ?? cd.actual, best: cd.proper, error: cd.error, skill: cd.skill });
  }
  const ch = r.chequer;
  if (r.type === "move" && ch && ch.error && ch.error.equity < 0 && ch.moves?.length) {
    out.push({ ...base, kind: "move", played: r.move ?? "", best: ch.moves[0].move, error: ch.error, skill: ch.skill });
  }
  return out;
}
