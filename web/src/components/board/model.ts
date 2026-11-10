// Pure helpers: reading the board in screen locations, finding which
// checkers moved between two boards (for the slide animation) and laying out
// the last-move trail. No React here.

import type { Board } from "@/game/board";
import { slotAt, type Pt, type Side } from "./geometry";

/** Checkers of `side` at a screen location (0..23 point, 24 bar, -1 off). */
export function countAt(board: Board, side: Side, loc: number): number {
  const s = board[side];
  if (loc === 24) return s[24];
  if (loc < 0) return 15 - s.reduce((a, b) => a + b, 0);
  return side === 1 ? s[loc] : s[23 - loc];
}

/** All 26 screen locations, in the order a side moves (from far to home). */
function locsInMoveOrder(side: Side): number[] {
  const pts = Array.from({ length: 24 }, (_, i) => (side === 1 ? 23 - i : i));
  return [24, ...pts, -1];
}

export interface Slide {
  side: Side;
  from: number; // screen location
  to: number;
  fromSlot: number; // stack position (0 = against the frame) it left
  toSlot: number; // stack position it arrived at
}

/**
 * Which checkers moved from `a` to `b`? For each side, locations that lost
 * checkers are paired with locations that gained some, in move order (the
 * furthest-back origin with the furthest-back destination), which gives the
 * natural reading for moves, hits (a checker to the bar), bearing off and
 * undo alike. Returns null when the change is too big to be one move
 * (a new game, a loaded position): then nothing is animated.
 */
export function diffBoards(a: Board, b: Board): Slide[] | null {
  const slides: Slide[] = [];
  for (const side of [0, 1] as Side[]) {
    const losses: { loc: number; slot: number }[] = [];
    const gains: { loc: number; slot: number }[] = [];
    const order = locsInMoveOrder(side);
    for (const loc of order) {
      const na = countAt(a, side, loc);
      const nb = countAt(b, side, loc);
      for (let k = nb; k < na; k++) losses.push({ loc, slot: k });
      for (let k = na; k < nb; k++) gains.push({ loc, slot: k });
    }
    if (losses.length !== gains.length) return null; // not a consistent board change
    // A real move: losses in move order paired with gains in move order. When
    // both lists run the other way (an undo) the same pairing still works.
    for (let k = 0; k < losses.length; k++) {
      slides.push({ side, from: losses[k].loc, to: gains[k].loc, fromSlot: losses[k].slot, toSlot: gains[k].slot });
    }
  }
  return slides.length > 8 ? null : slides;
}

export interface LastMove {
  player: 0 | 1;
  steps: { from: number; to: number }[];
}

export interface TrailStep {
  from: Pt;
  to: Pt;
  toLoc: number;
  origin: boolean; // `from` is where a checker started (not an intermediate stop)
  final: boolean; // `to` is where a checker ended (not an intermediate stop)
}

/**
 * Screen positions for the last-move trail. The steps are undone one by one
 * (last first) on the final board, so each step's ends land on the exact
 * stack slot the checker left and reached.
 */
export function layoutTrail(board: Board, lm: LastMove, flipped: boolean): TrailStep[] {
  const side = lm.player as Side;
  const counts = new Map<number, number>();
  const get = (loc: number) => counts.get(loc) ?? countAt(board, side, loc);
  const out: TrailStep[] = [];
  const valid = (l: number) => Number.isInteger(l) && l >= -1 && l <= 24;
  const steps = lm.steps.filter((s) => valid(s.from) && valid(s.to) && s.from !== s.to && s.from !== -1);
  for (let k = steps.length - 1; k >= 0; k--) {
    const { from, to } = steps[k];
    const nTo = Math.max(1, get(to));
    counts.set(to, nTo - 1);
    const toPt = slotAt(side, to, nTo - 1, flipped);
    const nFrom = get(from);
    counts.set(from, nFrom + 1);
    const fromPt = slotAt(side, from, nFrom, flipped);
    const origin = !steps.slice(0, k).some((s) => s.to === from);
    const final = !steps.slice(k + 1).some((s) => s.from === to);
    out.unshift({ from: fromPt, to: toPt, toLoc: to, origin, final });
  }
  return out;
}

/** A move to preview on the board (same numbering as LastMove). */
export type MovePreview = LastMove;

export interface PreviewPath {
  pts: Pt[]; // origin, any intermediate stops, destination (stack slot centres)
  toLoc: number; // final location (-1 = borne off)
  toSlot: number; // stack slot (or tray slice) the checker lands in
}
export interface PreviewLayout {
  side: Side;
  paths: PreviewPath[]; // one per checker that moves
  leaving: Map<number, number>; // location -> checkers leaving it (from the top of the stack)
  hits: Set<number>; // locations of the opponent's blots that are hit
}

/**
 * Screen positions for a previewed move, played forward on the current
 * board. Consecutive steps of the same checker (gnubg lists a move such as
 * 13/7 as one step per die: 13/10, 10/7) are joined into one path.
 */
export function layoutPreview(board: Board, pv: MovePreview, flipped: boolean): PreviewLayout {
  const side = pv.player as Side;
  const opp = (1 - side) as Side;
  const counts = new Map<number, number>();
  const get = (loc: number) => counts.get(loc) ?? countAt(board, side, loc);
  const valid = (l: number) => Number.isInteger(l) && l >= -1 && l <= 24;
  const paths: (PreviewPath & { end: number })[] = [];
  const leaving = new Map<number, number>();
  const hits = new Set<number>();
  for (const { from, to } of pv.steps) {
    if (!valid(from) || !valid(to) || from === to || from === -1) continue;
    const nFrom = Math.max(1, get(from));
    counts.set(from, nFrom - 1);
    let nTo = get(to);
    if (to >= 0 && to < 24 && countAt(board, opp, to) === 1 && !hits.has(to)) {
      hits.add(to);
      nTo = 0;
    }
    counts.set(to, nTo + 1);
    const toPt = slotAt(side, to, nTo, flipped);
    // the same checker carrying on from where an earlier step ended?
    const cont = [...paths].reverse().find((p) => p.end === from);
    if (cont) {
      cont.pts.push(toPt);
      cont.end = to;
      cont.toLoc = to;
      cont.toSlot = nTo;
    } else {
      paths.push({ pts: [slotAt(side, from, nFrom - 1, flipped), toPt], toLoc: to, toSlot: nTo, end: to });
      leaving.set(from, (leaving.get(from) ?? 0) + 1);
    }
  }
  return { side, paths: paths.map(({ pts, toLoc, toSlot }) => ({ pts, toLoc, toSlot })), leaving, hits };
}
