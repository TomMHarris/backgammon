// gnubg's decisions for the computer player, asked from the engine.
//
// Works with anything that has the engine client's methods (the browser's
// EngineClient, or the Node wrapper in tests/ui_mat_roundtrip.mjs).

import type { EngineClient } from "../engine/client.ts";
import type { Preset } from "../engine/types.ts";
import type { MovePairs, Side } from "./board.ts";
import type { MatchState } from "./match.ts";
import { canBeaver, canDouble, idsFor, responder } from "./match.ts";
import { CD } from "./tutor.ts";

/** The engine calls the game logic needs (EngineClient has all of them). */
export type EngineLike = Pick<
  EngineClient,
  "legalMoves" | "botMove" | "botDouble" | "botTake" | "analyseCube" | "rankMoves" | "evaluate"
>;

/** Would gnubg (on roll, before rolling) double now? */
export async function botWantsToDouble(engine: EngineLike, s: MatchState, bot: Side, preset: Preset) {
  if (!canDouble(s, bot)) return false;
  const r = await engine.botDouble({ ...idsFor(s, bot, null), preset });
  return r.double;
}

/** gnubg's move for the current dice (null move = no legal move). */
export async function botChooseMove(
  engine: EngineLike,
  s: MatchState,
  preset: Preset
): Promise<{ pairs: MovePairs; move: string }> {
  if (!s.dice) throw new Error("no dice");
  const r = await engine.botMove({ ...idsFor(s, s.turn, s.dice), preset });
  return { pairs: r.pairs, move: r.move ?? "" };
}

/**
 * gnubg's answer to a pending double (phase "doubled", gnubg = responder).
 *
 * - A normal double by the human: the engine's botTake (play.c:1199-1245),
 *   evaluated from the doubler's side with the cube as before the double.
 *   A "beaver" answer becomes "take" when beavers are not allowed here.
 * - The human beavered gnubg's double: play.c:1130-1185 ("opponent has
 *   beavered"), with the cube treated as owned by gnubg (play.c:1108-1113).
 *   gnubg would raccoon (redouble again) when the beaver was a blunder; we do
 *   not support raccoons, so it takes instead. It drops the beaver only when
 *   it should not have doubled and double/take is worth <= -1.
 */
export async function botAnswerDouble(
  engine: EngineLike,
  s: MatchState,
  preset: Preset
): Promise<"take" | "drop" | "beaver"> {
  const doubler = s.turn;
  if (!s.beavered) {
    const r = await engine.botTake({ ...idsFor(s, doubler, null), preset, beaversSoFar: 0 });
    if (r.action === "beaver" && !canBeaver(s)) return "take";
    return r.action;
  }
  if (responder(s) !== doubler) throw new Error("unexpected beaver state");
  const a = await engine.analyseCube({ ...idsFor(s, doubler, null, doubler, s.cube), preset });
  if (a.decision === CD.NODOUBLE_TAKE || a.decision === CD.NO_REDOUBLE_TAKE)
    return a.equities.doubleTake <= -1 ? "drop" : "take";
  return "take";
}

/**
 * Does gnubg accept the human's resignation of `value` (1 single, 2 gammon,
 * 3 backgammon)? gnubg itself compares cubeful equities before and after
 * (play.c:1054-1072, getResignEquities), which our engine API does not offer.
 * We use a safe rule instead: accept only when gnubg could not win more by
 * playing on, i.e. when the engine gives the resigning side zero chance of
 * losing a bigger result, or when bigger results do not count (Jacoby rule
 * with a centred cube; or gnubg needs no more points to win the match).
 */
export async function botAcceptsResignation(
  engine: EngineLike,
  s: MatchState,
  resigner: Side,
  value: 1 | 2 | 3
): Promise<boolean> {
  if (value === 3) return true;
  const bot: Side = resigner === 0 ? 1 : 0;
  const n = s.settings.matchLength;
  if (n === 0 && s.record.jacoby && s.cubeOwner === -1) return true;
  if (n > 0 && s.score[bot] + s.cube * value >= n) return true;
  const ev = await engine.evaluate({ ...idsFor(s, resigner, null), preset: "world class" });
  // probs are for the resigning side (on roll here).
  if (value === 2) return ev.probs.loseBackgammon === 0;
  return ev.probs.loseGammon === 0 && ev.probs.loseBackgammon === 0;
}
