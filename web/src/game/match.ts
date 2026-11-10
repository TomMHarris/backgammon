// The match as a small state machine (pure functions, no React, no engine).
//
// Each function takes a MatchState and returns a NEW MatchState; nothing is
// modified in place. The React page keeps the state in a reducer; the Node
// round-trip test (tests/ui_mat_roundtrip.mjs) drives the same functions.
//
// Phases (state.phase) and what can happen next:
//
//   "opening"  A game is about to start. openingRoll(): each side rolls one
//              die (ties are re-rolled by the caller); the higher die moves
//              first, using both dice.                       -> "moving"
//   "rolling"  state.turn is on roll and has not rolled yet.
//              roll(dice)                                    -> "moving"
//              double()  (only if canDouble)                 -> "doubled"
//              resign(...)                                   -> "gameOver"/"matchOver"
//   "doubled"  A double is pending; responder(state) must answer.
//              take()  cube x2, owned by the taker           -> "rolling" (doubler rolls)
//              drop()  doubler wins the current cube value   -> "gameOver"/"matchOver"
//              beaver() (money play, if allowed): the responder takes and
//                       immediately redoubles; now the doubler answers
//                       (take or drop)                       -> "doubled"
//   "moving"   state.turn has rolled state.dice and must play.
//              move(pairs)  (pairs = [] when no legal move)  -> "rolling" (other side),
//                                                               or "gameOver"/"matchOver"
//   "gameOver" The game is finished; state.lastResult says how.
//              nextGame()                                    -> "opening"
//   "matchOver" The match is decided (match play only; a money session
//              never ends by itself).
//
// Cube bookkeeping follows gnubg's ApplyMoveRecord (play.c:252-400): a double
// leaves the cube value alone until it is taken; a beaver doubles the value
// and gives the cube to the beaverer; the final take doubles it again and
// gives it to the side that is not on roll.

import type { Board, Dice, MovePairs, Side } from "./board.ts";
import { applyPairs, gameStatus, initialBoard, matchId, positionId, swapSides } from "./board.ts";

/** gnubg's limits: MAX_CUBE (backgammon.h:34) and MAXSCORE (matchequity.h:26). */
export const MAX_CUBE = 4096;
export const MAXSCORE = 64;

export interface MatchSettings {
  matchLength: number; // 0 = money session; otherwise 1..25 (Crawford rule always on)
  jacoby: boolean; // money only: gammons count only once the cube has been turned
  beavers: boolean; // money only: allow one beaver per double (see README of game/)
  playerNames: [string, string]; // [player 0 = gnubg, player 1 = human]
}

export type Phase = "opening" | "rolling" | "doubled" | "moving" | "gameOver" | "matchOver";

/** One entry of the game record (the information a .mat file needs, and more). */
export type GameAction =
  | {
      type: "move";
      player: Side;
      dice: Dice; // higher die first, as gnubg records it
      pairs: MovePairs; // the engine's move (mover's numbering); [] = no legal move
      move: string; // gnubg's notation, e.g. "24/18 13/11"; "" = no move
      positionId: string; // before the move, from the mover's side
      matchId: string; // before the move (dice included)
    }
  | { type: "double"; player: Side; cube: number; positionId: string; matchId: string }
  | { type: "beaver"; player: Side; cube: number }
  | { type: "take"; player: Side }
  | { type: "drop"; player: Side }
  | { type: "resign"; player: Side; value: 1 | 2 | 3 };

export interface GameResult {
  winner: Side;
  points: number; // points added to the winner's score
  how: "single" | "gammon" | "backgammon" | "drop" | "resign";
}

export interface GameRecord {
  number: number; // 1, 2, ...
  score: [number, number]; // at the start of the game
  crawford: boolean; // this game is the Crawford game
  actions: GameAction[];
  result: GameResult | null;
}

export interface MatchRecord {
  matchLength: number;
  jacoby: boolean;
  playerNames: [string, string];
  date: string; // YYYY-MM-DD
  games: GameRecord[];
}

export interface MatchState {
  settings: MatchSettings;
  phase: Phase;
  score: [number, number];
  crawford: boolean; // the current game is the Crawford game
  postCrawford: boolean;
  board: Board; // board[0] = gnubg's checkers, board[1] = human's (see board.ts)
  cube: number;
  cubeOwner: -1 | Side;
  turn: Side; // player on roll (the one who moves, or who doubled)
  dice: Dice | null; // set in phase "moving"
  openingDice: Dice | null; // [player 0's die, player 1's die] of this game's opening roll
  beavered: boolean; // phase "doubled": the double has been beavered
  lastResult: GameResult | null;
  record: MatchRecord;
}

const other = (s: Side): Side => (s === 0 ? 1 : 0);

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A new match (or money session); the first game is ready for its opening roll. */
export function newMatch(settings: MatchSettings, date = today()): MatchState {
  const s: MatchState = {
    settings,
    phase: "opening",
    score: [0, 0],
    crawford: false,
    postCrawford: false,
    board: initialBoard(),
    cube: 1,
    cubeOwner: -1,
    turn: 0,
    dice: null,
    openingDice: null,
    beavered: false,
    lastResult: null,
    record: {
      matchLength: settings.matchLength,
      jacoby: settings.jacoby && settings.matchLength === 0,
      playerNames: settings.playerNames,
      date,
      games: [],
    },
  };
  return startGame(s);
}

/** Set up the next game. Crawford bookkeeping as gnubg's NewGame (play.c:801-806). */
function startGame(prev: MatchState): MatchState {
  const n = prev.settings.matchLength;
  let { crawford, postCrawford } = prev;
  if (n > 0) {
    const hi = Math.max(prev.score[0], prev.score[1]);
    const lo = Math.min(prev.score[0], prev.score[1]);
    postCrawford = postCrawford || (crawford && hi < n);
    crawford = !postCrawford && !crawford && hi === n - 1 && lo < n - 1;
  }
  const game: GameRecord = {
    number: prev.record.games.length + 1,
    score: [prev.score[0], prev.score[1]],
    crawford,
    actions: [],
    result: null,
  };
  return {
    ...prev,
    phase: "opening",
    crawford,
    postCrawford,
    board: initialBoard(),
    cube: 1,
    cubeOwner: -1,
    dice: null,
    openingDice: null,
    beavered: false,
    lastResult: null,
    record: { ...prev.record, games: [...prev.record.games, game] },
  };
}

function addAction(s: MatchState, a: GameAction): MatchState["record"] {
  const games = s.record.games.slice();
  const g = games[games.length - 1];
  games[games.length - 1] = { ...g, actions: [...g.actions, a] };
  return { ...s.record, games };
}

// ---------------------------------------------------------------------------
// Engine IDs for the current state
// ---------------------------------------------------------------------------

/** The board seen from `side` (board[1] = side). */
export function boardFor(s: MatchState, side: Side): Board {
  return side === 1 ? s.board : swapSides(s.board);
}

/**
 * gnubg position + match ID with `onRoll` on roll (the perspective every
 * engine request uses). `dice` null = before rolling. `cubeOwner` can be
 * overridden (needed for gnubg's beaver handling, see bot.ts).
 */
export function idsFor(
  s: MatchState,
  onRoll: Side,
  dice: Dice | null,
  cubeOwner: -1 | Side = s.cubeOwner,
  cube: number = s.cube
): { position: string; match: string } {
  return {
    position: positionId(boardFor(s, onRoll)),
    match: matchId({
      cube,
      cubeOwner,
      move: onRoll,
      turn: onRoll,
      crawford: s.crawford,
      gameState: 1, // GAME_PLAYING
      doubled: false,
      resigned: 0,
      dice,
      matchLength: s.settings.matchLength,
      score: s.score,
      jacoby: s.record.jacoby,
    }),
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * May `player` double now? gnubg's CommandDouble checks (play.c:2349-2411):
 * a game in progress, on roll and not yet rolled, not the Crawford game, cube
 * centred or owned by the player, cube below the maximum, and in match play
 * the cube not dead (cube < points the player still needs). In match play
 * that also stops the post-Crawford leader from doubling, as GetDPEq does
 * (eval.c:3586-3592).
 */
export function canDouble(s: MatchState, player: Side): boolean {
  const n = s.settings.matchLength;
  if (s.phase !== "rolling" || s.turn !== player) return false;
  if (s.crawford) return false;
  if (s.cubeOwner !== -1 && s.cubeOwner !== player) return false;
  if (s.cube >= (n ? MAXSCORE : MAX_CUBE)) return false;
  if (n && s.cube >= n - s.score[player]) return false;
  return true;
}

/** Who must answer the pending double? */
export function responder(s: MatchState): Side {
  return s.beavered ? s.turn : other(s.turn);
}

/**
 * May the responder beaver? Money play only, beavers enabled, not already
 * beavered (we allow one beaver per double and no raccoons), and gnubg's cube
 * limit for beavers (play.c:1232: nCube < MAX_CUBE/2).
 */
export function canBeaver(s: MatchState): boolean {
  return (
    s.phase === "doubled" &&
    !s.beavered &&
    s.settings.matchLength === 0 &&
    s.settings.beavers &&
    s.cube < MAX_CUBE / 2
  );
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** Opening roll: d = [player 0's die, player 1's die], d[0] != d[1]. */
export function openingRoll(s: MatchState, d: Dice): MatchState {
  if (s.phase !== "opening") throw new Error("not at the start of a game");
  if (d[0] === d[1]) throw new Error("opening roll must not be a tie");
  const turn: Side = d[1] > d[0] ? 1 : 0;
  return {
    ...s,
    phase: "moving",
    turn,
    openingDice: d,
    dice: [Math.max(d[0], d[1]), Math.min(d[0], d[1])],
  };
}

export function roll(s: MatchState, dice: Dice): MatchState {
  if (s.phase !== "rolling") throw new Error("not time to roll");
  // Record dice higher first (as gnubg does); the order does not matter for play.
  return { ...s, phase: "moving", dice: [Math.max(...dice), Math.min(...dice)] as Dice };
}

export function double(s: MatchState): MatchState {
  if (!canDouble(s, s.turn)) throw new Error("doubling is not allowed now");
  const ids = idsFor(s, s.turn, null);
  return {
    ...s,
    phase: "doubled",
    beavered: false,
    record: addAction(s, {
      type: "double",
      player: s.turn,
      cube: s.cube * 2,
      positionId: ids.position,
      matchId: ids.match,
    }),
  };
}

export function beaver(s: MatchState): MatchState {
  if (!canBeaver(s)) throw new Error("beaver not allowed");
  const by = responder(s);
  return {
    ...s,
    beavered: true,
    cube: s.cube * 2,
    cubeOwner: by,
    record: addAction(s, { type: "beaver", player: by, cube: s.cube * 4 }),
  };
}

export function take(s: MatchState): MatchState {
  if (s.phase !== "doubled") throw new Error("no double to take");
  const by = responder(s);
  return {
    ...s,
    phase: "rolling",
    beavered: false,
    cube: s.cube * 2,
    cubeOwner: other(s.turn),
    record: addAction(s, { type: "take", player: by }),
  };
}

export function drop(s: MatchState): MatchState {
  if (s.phase !== "doubled") throw new Error("no double to drop");
  const by = responder(s);
  const s2 = { ...s, beavered: false, record: addAction(s, { type: "drop", player: by }) };
  return finishGame(s2, { winner: other(by), points: s.cube, how: "drop" });
}

/**
 * Play a move for state.turn. `pairs` are the engine's pairs (mover's
 * numbering; [] if there is no legal move) and `text` gnubg's notation.
 */
export function move(s: MatchState, pairs: MovePairs, text: string): MatchState {
  if (s.phase !== "moving" || !s.dice) throw new Error("not time to move");
  const ids = idsFor(s, s.turn, s.dice);
  const record = addAction(s, {
    type: "move",
    player: s.turn,
    dice: s.dice,
    pairs,
    move: text,
    positionId: ids.position,
    matchId: ids.match,
  });
  const after = applyPairs(boardFor(s, s.turn), pairs); // mover's view
  const board = s.turn === 1 ? after : swapSides(after);
  const s2: MatchState = { ...s, board, record, dice: null };
  const over = gameStatus(after);
  if (over) {
    let value: number = over.value;
    // Jacoby rule (play.c:350): no gammons on a centred cube in money play.
    if (s.record.jacoby && s.cubeOwner === -1) value = 1;
    const how = value === 3 ? "backgammon" : value === 2 ? "gammon" : "single";
    return finishGame(s2, { winner: s.turn, points: s.cube * value, how });
  }
  return { ...s2, phase: "rolling", turn: other(s.turn) };
}

/** `player` resigns, conceding `value` x cube (1 single, 2 gammon, 3 backgammon). */
export function resign(s: MatchState, player: Side, value: 1 | 2 | 3): MatchState {
  if (s.phase === "opening" || s.phase === "gameOver" || s.phase === "matchOver")
    throw new Error("no game in progress");
  const s2 = { ...s, record: addAction(s, { type: "resign", player, value }) };
  return finishGame(s2, { winner: other(player), points: s.cube * value, how: "resign" });
}

function finishGame(s: MatchState, result: GameResult): MatchState {
  const score: [number, number] = [s.score[0], s.score[1]];
  score[result.winner] += result.points;
  const games = s.record.games.slice();
  games[games.length - 1] = { ...games[games.length - 1], result };
  const n = s.settings.matchLength;
  const over = n > 0 && (score[0] >= n || score[1] >= n);
  return {
    ...s,
    score,
    phase: over ? "matchOver" : "gameOver",
    dice: null,
    lastResult: result,
    record: { ...s.record, games },
  };
}

export function nextGame(s: MatchState): MatchState {
  if (s.phase !== "gameOver") throw new Error("the game is not over");
  return startGame(s);
}

/** Match winner (match play), or null. */
export function matchWinner(s: MatchState): Side | null {
  const n = s.settings.matchLength;
  if (!n) return null;
  if (s.score[0] >= n) return 0;
  if (s.score[1] >= n) return 1;
  return null;
}
