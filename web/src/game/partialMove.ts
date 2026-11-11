// Entering a move one checker at a time, with legality decided by the engine.
//
// The engine's legalMoves() lists every legal play for the roll (gnubg's
// GenerateMoves): only plays that use as many dice as possible (and the
// higher die when only one can be played), and only ONE play per resulting
// position. So the engine's list tells us which *final positions* are legal,
// but not every order in which the checkers may be moved to get there
// (e.g. 6-1 "13/7 7/6" and "13/12 12/6" are listed once).
//
// The human moves single checkers, one die at a time. This module decides
// which single steps are allowed:
//   1. `possibleSteps` lists the physically possible single steps for one
//      die (a checker moves that many pips; checkers on the bar first; a
//      point held by 2+ opposing checkers is blocked; bearing off only with
//      all checkers home). These are the mechanics of moving a checker, not
//      the rules about which plays are legal.
//   2. A step is offered ONLY IF the partial play can still be completed to
//      one of the engine's legal final positions (compared as positions,
//      decoded from the engine's positionAfter IDs). So the legal-move rules
//      (use both dice, higher die, ...) come entirely from the engine.
//
// All boards here are from the mover's perspective (board[1] = mover).

import type { Board, Dice, MovePairs } from "./board.ts";
import { boardFromPositionId, boardKey, cloneBoard } from "./board.ts";
import type { LegalMove } from "../engine/types.ts";

/** One checker moved by one die. from/to: mover's numbering (24 = bar, -1 = off). */
export interface Step {
  from: number;
  to: number;
  die: number;
  hit: boolean;
}

/** Apply one step to a copy of the board (hitting a lone opposing checker). */
export function applyStep(b: Board, s: Step): Board {
  const out = cloneBoard(b);
  out[1][s.from]--;
  if (s.to >= 0) {
    if (s.hit) {
      out[0][23 - s.to] = 0;
      out[0][24]++;
    }
    out[1][s.to]++;
  }
  return out;
}

/** Physically possible single steps with die `d` (see the header comment). */
export function possibleSteps(b: Board, d: number): Step[] {
  const me = b[1];
  const opp = b[0];
  const steps: Step[] = [];
  const sources = me[24] > 0 ? [24] : Array.from({ length: 24 }, (_, i) => 23 - i);
  // All checkers in the home board (indices 0..5) and none on the bar?
  let allHome = true;
  for (let i = 6; i < 25; i++) if (me[i] > 0) allHome = false;
  for (const from of sources) {
    if (me[from] === 0) continue;
    // From the bar, die d enters on my point 25-d, i.e. index 24-d.
    const to = from === 24 ? 24 - d : from - d;
    if (to >= 0) {
      const blockers = opp[23 - to];
      if (blockers >= 2) continue;
      steps.push({ from, to, die: d, hit: blockers === 1 });
    } else if (allHome) {
      // Bearing off: exact, or with a higher die from the highest occupied point.
      let higherOccupied = false;
      for (let i = from + 1; i < 6; i++) if (me[i] > 0) higherOccupied = true;
      if (to === -1 || !higherOccupied) steps.push({ from, to: -1, die: d, hit: false });
    }
  }
  return steps;
}

/** Dice to play: doubles give four of the same. */
export function diceToPlay(dice: Dice): number[] {
  return dice[0] === dice[1] ? [dice[0], dice[0], dice[0], dice[0]] : [dice[0], dice[1]];
}

function removeOne(arr: number[], v: number): number[] {
  const i = arr.indexOf(v);
  return i < 0 ? arr : [...arr.slice(0, i), ...arr.slice(i + 1)];
}

/**
 * Everything needed to enter one play: built once per roll from the engine's
 * legal-move list.
 */
export class PlayBuilder {
  readonly start: Board;
  readonly dice: Dice;
  readonly legal: LegalMove[];
  /** Number of single steps every legal play uses (0 = no legal move). */
  readonly stepsNeeded: number;
  /** legal final position key -> the engine's legal move */
  private finals = new Map<string, LegalMove>();
  /** memo: node key -> can this partial play still be completed legally? */
  private memo = new Map<string, boolean>();

  constructor(start: Board, dice: Dice, legal: LegalMove[]) {
    this.start = cloneBoard(start);
    this.dice = dice;
    this.legal = legal;
    this.stepsNeeded = legal.length ? legal[0].pairs.length : 0;
    for (const m of legal) this.finals.set(boardKey(boardFromPositionId(m.positionAfter)), m);
  }

  private canComplete(b: Board, remaining: number[], stepsLeft: number): boolean {
    if (stepsLeft === 0) return this.finals.has(boardKey(b));
    const key = boardKey(b) + "#" + [...remaining].sort().join("");
    const cached = this.memo.get(key);
    if (cached !== undefined) return cached;
    let ok = false;
    for (const d of new Set(remaining)) {
      for (const s of possibleSteps(b, d)) {
        if (this.canComplete(applyStep(b, s), removeOne(remaining, d), stepsLeft - 1)) {
          ok = true;
          break;
        }
      }
      if (ok) break;
    }
    this.memo.set(key, ok);
    return ok;
  }

  /** Board after a list of steps from the start. */
  boardAfter(steps: Step[]): Board {
    return steps.reduce(applyStep, this.start);
  }

  /** Dice not yet used after `steps`. */
  remainingDice(steps: Step[]): number[] {
    return steps.reduce((rem, s) => removeOne(rem, s.die), diceToPlay(this.dice));
  }

  /** Allowed next single steps after `steps` (empty when the play is complete). */
  nextSteps(steps: Step[]): Step[] {
    const left = this.stepsNeeded - steps.length;
    if (left <= 0) return [];
    const b = this.boardAfter(steps);
    const rem = this.remainingDice(steps);
    const out: Step[] = [];
    for (const d of new Set(rem)) {
      for (const s of possibleSteps(b, d)) {
        if (this.canComplete(applyStep(b, s), removeOne(rem, d), left - 1)) out.push(s);
      }
    }
    return out;
  }

  /**
   * Where can the checker on `from` go next, moving only that checker (one or
   * more dice)? Returns destination -> list of steps. When several step
   * orders reach the same destination, prefer the one that hits more, then
   * the one using the larger die first (a choice only for click/drag; the
   * user can always move die by die instead).
   */
  destinations(steps: Step[], from: number): Map<number, Step[]> {
    const result = new Map<number, Step[]>();
    const score = (seq: Step[]) => seq.filter((s) => s.hit).length * 10 + seq[0].die / 10;
    const walk = (done: Step[], pos: number, seq: Step[]) => {
      for (const s of this.nextSteps(done)) {
        if (s.from !== pos) continue;
        const path = [...seq, s];
        const prev = result.get(s.to);
        if (!prev || path.length < prev.length || (path.length === prev.length && score(path) > score(prev)))
          result.set(s.to, path);
        if (s.to >= 0) walk([...done, s], s.to, path);
      }
    };
    walk(steps, from, []);
    return result;
  }

  /**
   * Steps that bring checkers to `target` (a click on a point with no checker
   * of the mover to move, e.g. an empty point). Prefers making the point (two
   * or more of the mover's checkers there afterwards), then fewer steps (so
   * one checker when the point cannot be made). Every step used must end on the target or
   * carry a checker that a later step brings there, so the other dice stay
   * free. The tray (-1) bears off one checker, with the larger die. null when
   * no legal step can reach the target.
   */
  toPoint(steps: Step[], target: number): Step[] | null {
    if (target === -1) {
      const off = this.nextSteps(steps).filter((s) => s.to === -1).sort((a, b) => b.die - a.die)[0];
      return off ? [off] : null;
    }
    /** Can some of `dice` add up to exactly `dist`? */
    const reach = (dist: number, dice: number[]): boolean => {
      if (dist === 0) return true;
      if (dist < 0 || !dice.length) return false;
      return dice.some((d, i) => reach(dist - d, [...dice.slice(0, i), ...dice.slice(i + 1)]));
    };
    let best: { seq: Step[]; score: number } | null = null;
    let nodes = 0;
    const consider = (seq: Step[]) => {
      // each step must end on the target, or be continued by a later step that does
      const good = new Array<boolean>(seq.length).fill(false);
      for (let i = seq.length - 1; i >= 0; i--)
        good[i] = seq[i].to === target || seq.some((t, j) => j > i && good[j] && t.from === seq[i].to);
      if (!good.every(Boolean)) return;
      const arrivals = seq.filter((s) => s.to === target).length;
      if (!arrivals) return;
      // make the point if possible, with as few dice as possible (the rest stay yours to play)
      const made = this.boardAfter([...steps, ...seq])[1][target] >= 2;
      const score = (made ? 100 : 0) - seq.length;
      if (!best || score > best.score) best = { seq, score };
    };
    const walk = (seq: Step[]) => {
      if (++nodes > 20000) return; // (a safety cap; real positions need far fewer)
      consider(seq);
      const all = [...steps, ...seq];
      const rem = this.remainingDice(all);
      for (const s of this.nextSteps(all)) {
        // only steps that land on the target, or bring a checker within reach of it
        if (s.to !== target && !(s.to > target && reach(s.to - target, removeOne(rem, s.die)))) continue;
        walk([...seq, s]);
      }
    };
    walk([]);
    return best ? (best as { seq: Step[] }).seq : null;
  }

  /** The engine's legal move matching a complete play, or null. */
  completedMove(steps: Step[]): LegalMove | null {
    if (steps.length !== this.stepsNeeded) return null;
    return this.finals.get(boardKey(this.boardAfter(steps))) ?? null;
  }

  /**
   * Steps that realise a given legal move (used when the human clicks a move
   * in the hint list): the engine's pairs are already single-die steps.
   */
  stepsForMove(m: LegalMove): Step[] {
    const steps: Step[] = [];
    let b = this.start;
    for (const [from, to] of m.pairs as MovePairs) {
      const die = from === 24 ? 24 - to : to < 0 ? 0 : from - to;
      // Bear-off steps may use a larger die than the distance: find the die
      // that is still unused and allowed for this step.
      const rem = this.remainingDice(steps);
      const d = die > 0 && rem.includes(die) ? die : rem.filter((x) => x >= from + 1).sort((a, c) => a - c)[0];
      const s: Step = { from, to, die: d, hit: to >= 0 && b[0][23 - to] === 1 };
      steps.push(s);
      b = applyStep(b, s);
    }
    return steps;
  }
}
