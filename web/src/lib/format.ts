// Text and number formatting shared by the UI components. Nothing here
// computes an evaluation: the numbers all come from the engine.

import type { Side } from "@/game/board";
import type { GameAction, GameRecord, MatchState } from "@/game/match";
import { skill, type Skill } from "@/game/tutor";

export const NAMES: [string, string] = ["gnubg", "You"];
/**
 * The names in a two-player game: [player 0 (top, dark checkers), player 1
 * (bottom, light checkers)]. One word each: they are written into .mat files,
 * whose importer reads a name up to the first space.
 */
export const TWO_PLAYER_NAMES: [string, string] = ["Dark", "Light"];

/** "You win" / "gnubg wins": a verb after a player's name. */
export function says(name: string, verb: string): string {
  if (name === "You") return `${name} ${verb}`;
  return `${name} ${verb.endsWith("s") ? verb + "es" : verb + "s"}`;
}

/** Equity with an explicit sign and a real minus sign: "+0.123", "−0.045". */
export const fmtEq = (x: number, digits = 3) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(digits);
/** Probability as a percentage: "54.1%". */
export const pct = (x: number, digits = 1) => (100 * x).toFixed(digits) + "%";
export const points = (n: number) => `${n} point${n === 1 ? "" : "s"}`;

/** CSS class suffix for an equity loss, by gnubg's thresholds (tutor.ts). */
export function skillClass(diff: number): "ok" | "doubtful" | "bad" | "verybad" {
  const s: Skill = skill(diff);
  return s === "none" ? "ok" : s === "very bad" ? "verybad" : s;
}
export const SKILL_LABEL = { ok: "", doubtful: "Doubtful", bad: "Bad", verybad: "Very bad" } as const;

/** The match in one line, e.g. "5-point match · Game 2 · Crawford". */
export function matchLabel(m: MatchState): string {
  const n = m.settings.matchLength;
  const game = `Game ${m.record.games.length}`;
  if (n === 0) {
    const rules = [m.record.jacoby ? "Jacoby" : null, m.settings.beavers ? "beavers" : null].filter(Boolean);
    return ["Money game", ...rules, game].join(" · ");
  }
  const c = m.crawford ? " · Crawford" : m.postCrawford ? " · post-Crawford" : "";
  return `${n}-point match · ${game}${c}`;
}

/** How the last game ended, e.g. "You win a gammon (2 points)." */
export function describeResult(m: MatchState): string {
  const r = m.lastResult;
  if (!r) return "";
  const pts = points(r.points);
  const N = m.record.playerNames;
  const w = N[r.winner];
  const l = N[1 - r.winner];
  switch (r.how) {
    case "drop":
      return `${says(l, "pass")}. ${says(w, "win")} ${pts}.`;
    case "resign":
      return `${says(l, "resign")}. ${says(w, "win")} ${pts}.`;
    default: {
      const kind = r.how === "single" ? "a single game" : `a ${r.how}`;
      return `${says(w, "win")} ${kind} (${pts}).`;
    }
  }
}

/** Short result kind for the summary card: "Gammon", "Single game", "Pass", ... */
export function resultKind(m: MatchState): string {
  const r = m.lastResult;
  if (!r) return "";
  switch (r.how) {
    case "drop":
      return `${m.record.playerNames[1 - r.winner]} passed the cube`;
    case "resign":
      return `${m.record.playerNames[1 - r.winner]} resigned`;
    case "single":
      return "Single game";
    default:
      return r.how === "gammon" ? "Gammon" : "Backgammon";
  }
}

/** One action as a move-log cell, in gnubg's .mat wording ("64: 24/18 13/9", "Doubles => 2"). */
export function logCell(a: GameAction): string {
  switch (a.type) {
    case "move":
      return `${a.dice[0]}${a.dice[1]}: ${a.move || "(no move)"}`;
    case "double":
      return `Doubles => ${a.cube}`;
    case "beaver":
      return `Beavers => ${a.cube}`;
    case "take":
      return "Takes";
    case "drop":
      return "Passes";
    case "resign":
      return `Resigns (${["single", "gammon", "backgammon"][a.value - 1]})`;
  }
}

export interface LogRow {
  number: number;
  cells: [string | null, string | null]; // [gnubg's column, your column], as in a .mat file
  kinds: [string | null, string | null]; // action type per cell, for styling
}

/**
 * Lay out actions in rows with gnubg in the left column and you in the right,
 * as gnubg's .mat export does: a new row starts when gnubg acts and the row
 * already has an entry, or when you act and your cell is taken.
 */
export function rowsOf<T extends { player: number }>(
  actions: T[],
  cell: (a: T) => string,
  kind: (a: T) => string
): { rows: LogRow[]; rowOf: number[] } {
  const rows: LogRow[] = [];
  const rowOf: number[] = [];
  for (const a of actions) {
    let row = rows[rows.length - 1];
    const p = a.player === 0 ? 0 : 1;
    if (!row || (p === 0 && (row.cells[0] !== null || row.cells[1] !== null)) || (p === 1 && row.cells[1] !== null)) {
      row = { number: rows.length + 1, cells: [null, null], kinds: [null, null] };
      rows.push(row);
    }
    row.cells[p] = cell(a);
    row.kinds[p] = kind(a);
    rowOf.push(row.number);
  }
  return { rows, rowOf };
}

export function gameRows(g: GameRecord) {
  return rowsOf(g.actions, logCell, (a) => a.type);
}

/** "You" / "gnubg" for a side. */
export const nameOf = (s: Side | number) => (s === 1 ? "You" : "gnubg");
