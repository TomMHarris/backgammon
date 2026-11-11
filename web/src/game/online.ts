// An online game as a log of actions (kept by the server, web/api/_rooms.js),
// replayed through the match state machine (match.ts).
//
// Seats: the host is seat 1, the friend who joined is seat 0. Each browser
// sees ITSELF as side 1 (the bottom player, "You") and the other player as
// side 0, exactly like a game against gnubg. The rules are symmetric, so the
// only thing that changes between the two browsers is which seat is mapped
// to which side, and the order of the two opening dice.
//
// applyEntry() checks that each action comes from the side whose turn it is
// (match.ts checks the phase); the caller also checks remote moves against
// the engine's legal moves before applying them.

import type { Dice, MovePairs, Side } from "./board.ts";
import type { MatchSettings, MatchState } from "./match.ts";
import { beaver, canBeaver, canDouble, double, drop, move, newMatch, nextGame, openingRoll, resign, responder, roll, take } from "./match.ts";

export type Seat = 0 | 1;

/** What a player sends (the server adds the dice to "roll" and "next"). */
export type RoomAction =
  | { t: "roll" }
  | { t: "move"; pairs: MovePairs; text: string }
  | { t: "double" }
  | { t: "take" }
  | { t: "drop" }
  | { t: "beaver" }
  | { t: "resign"; value: 1 | 2 | 3 }
  | { t: "next" };

/** One entry of the room's log. */
export interface RoomEntry {
  n: number; // position in the log
  seat: Seat | null; // who sent it (null: the server, for the first opening roll)
  t: "open" | RoomAction["t"];
  dice?: [number, number]; // roll: the two dice; open / next: [seat 0's die, seat 1's die]
  pairs?: MovePairs;
  text?: string;
  value?: 1 | 2 | 3;
  at: number;
}

/** The room's match settings, chosen by the host. */
export interface RoomSettings {
  matchLength: number;
  jacoby: boolean;
  beavers: boolean;
  hints: boolean; // hints and the tutor during play (the analysis after each game is always on)
}

/** The local side of a seat: this browser's own seat is side 1. */
export const sideOf = (seat: Seat, mySeat: Seat): Side => (seat === mySeat ? 1 : 0);

/** Match settings for this browser: the friend is player 0, "You" player 1. */
export function localSettings(s: RoomSettings, friendName: string): MatchSettings {
  return { matchLength: s.matchLength, jacoby: s.jacoby, beavers: s.beavers, playerNames: [friendName || "Friend", "You"] };
}

/** Opening dice from the server's [seat 0, seat 1] to this browser's [side 0, side 1]. */
const openingFor = (d: [number, number], mySeat: Seat): Dice => [d[1 - mySeat], d[mySeat]];

/**
 * Apply one log entry. `s` is null before the first one (which must be the
 * opening roll). Throws an Error naming the problem when the entry is not
 * allowed now.
 */
export function applyEntry(s: MatchState | null, e: RoomEntry, mySeat: Seat, settings: MatchSettings): MatchState {
  if (e.t === "open") {
    if (s) throw new Error("a second opening roll");
    return openingRoll(newMatch(settings), openingFor(e.dice!, mySeat));
  }
  if (!s) throw new Error("the game has not started");
  if (e.t === "next") return openingRoll(nextGame(s), openingFor(e.dice!, mySeat));
  if (e.seat === null) throw new Error("an action without a player");
  const side = sideOf(e.seat, mySeat);
  const actorIs = (who: Side, what: string) => {
    if (side !== who) throw new Error(`${what} by the wrong player`);
  };
  switch (e.t) {
    case "roll":
      actorIs(s.turn, "a roll");
      return roll(s, e.dice!);
    case "move":
      actorIs(s.turn, "a move");
      return move(s, e.pairs ?? [], e.text ?? "");
    case "double":
      actorIs(s.turn, "a double");
      if (!canDouble(s, side)) throw new Error("a double that is not allowed");
      return double(s);
    case "take":
      actorIs(responder(s), "a take");
      return take(s);
    case "drop":
      actorIs(responder(s), "a pass");
      return drop(s);
    case "beaver":
      actorIs(responder(s), "a beaver");
      if (!canBeaver(s)) throw new Error("a beaver that is not allowed");
      return beaver(s);
    case "resign":
      if (s.phase !== "rolling" && s.phase !== "moving") throw new Error("a resignation outside a game");
      actorIs(s.turn, "a resignation");
      return resign(s, side, e.value ?? 1);
  }
}
