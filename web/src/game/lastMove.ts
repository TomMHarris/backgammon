// The last completed move of the current game, in the board's screen numbering.
//
// The board (components/BoardView.tsx) numbers points from the HUMAN's side:
// 0..23 = the human's points 1..24, 24 = the bar, -1 = borne off. Game
// records store each move as the engine's (from, to) pairs in the MOVER's
// numbering (see board.ts). For the human (player 1) the two agree; for gnubg
// (player 0) a point i becomes 23 - i, while the bar (24) and off (-1) keep
// their codes.

import type { Side } from "./board.ts";
import type { MatchRecord } from "./match.ts";

export interface LastMove {
  player: Side; // 0 = gnubg (top), 1 = human (bottom)
  steps: { from: number; to: number }[]; // one entry per checker step (one die)
}

/** Convert one mover's-numbering point (24 bar, -1 off) to the board's numbering. */
export function toBoardIndex(player: Side, i: number): number {
  if (player === 1 || i === 24 || i === -1) return i;
  return 23 - i;
}

/**
 * The most recent "move" action of the current (last) game, or null when no
 * move has been made in this game yet. A roll with no legal move gives an
 * empty step list.
 */
export function lastMoveOf(record: MatchRecord): LastMove | null {
  const game = record.games[record.games.length - 1];
  if (!game) return null;
  for (let k = game.actions.length - 1; k >= 0; k--) {
    const a = game.actions[k];
    if (a.type !== "move") continue;
    return {
      player: a.player,
      steps: a.pairs.map(([from, to]) => ({ from: toBoardIndex(a.player, from), to: toBoardIndex(a.player, to) })),
    };
  }
  return null;
}
