// View model of the analysis page (app/analysis): turns gnubg's
// get_analysis reply (engine/api/MATCH_API.md) into what the page shows.
//
// Rule: every evaluation, error, mark, luck value and statistic comes
// verbatim from gnubg. This module only selects, orients and formats them.
// The one thing it works out itself is the board after a move (to draw a
// played or alternative move): it applies gnubg's move text to gnubg's
// position ID, which tests/analysis_page.mjs checks against the engine's own
// legal_moves for every listed move of a sample match.
//
// Plain TypeScript with relative imports, so Node can run it directly
// (tests/analysis_page.mjs).

import type {
  AnalysedMove,
  AnalysisRecord,
  AnalysisResult,
  Cost,
  PlayerStatistics,
  RecordCubeDecision,
  SkillMark,
  Statistics,
} from "../engine/types.ts";
import { applyPairs, boardFromPositionId, swapSides, type Board, type Dice, type MovePairs } from "../game/board.ts";
import { toBoardIndex, type LastMove } from "../game/lastMove.ts";

export type Player = 0 | 1;
export type LuckLabel = "veryunlucky" | "unlucky" | "none" | "lucky" | "verylucky";
export type DecisionKind = "move" | "double" | "take" | "drop" | "resign";
const KINDS: DecisionKind[] = ["move", "double", "take", "drop", "resign"];

/** The value plotted for a decision: gnubg's evaluation after it, from the actor's side. */
export interface DecisionValue {
  actor: Player; // whose point of view win / equity / mwc are from
  win: number; // probability that `actor` wins the game
  equity: number; // gnubg's normalised equity (EMG in match play)
  mwc?: number; // match winning chance (match play)
}

/** One decision of the match: a chequer move, a cube action or a resignation. */
export interface Decision {
  seq: number; // position in the whole match's list of decisions
  game: number; // 0-based game index
  gameSeq: number; // position within its game
  row: number; // move-list row (numbered like gnubg's .mat export)
  record: AnalysisRecord;
  kind: DecisionKind;
  player: Player; // who acts
  onRoll: Player; // whose side the position ID is from (take / drop: the doubler)
  text: string; // move-list text: "63: 24/18 6/3", "Doubles => 2", "Takes", ...
  chequerSkill: SkillMark; // gnubg's mark on the chequer play (moves)
  cubeSkill: SkillMark; // gnubg's mark on the cube action (for a move: the decision before rolling)
  skill: SkillMark; // the worse of the two (resignations: gnubg's resign mark)
  luck: LuckLabel; // gnubg's luck mark of the roll ("none" when not analysed)
  analysed: boolean; // gnubg has analysed this decision
  value: DecisionValue | null;
}

export interface GameView {
  index: number;
  scoreBefore: [number, number];
  crawfordGame: boolean;
  winner: number;
  points: number;
  resigned: boolean;
  decisions: Decision[];
  rows: MoveRow[];
  statistics: Statistics;
  statisticsText?: string;
  analysed: boolean;
}

export interface MoveRow {
  number: number;
  cells: [Decision | null, Decision | null]; // [player 0, player 1], as in gnubg's .mat export
}

export interface MatchView {
  matchLength: number; // 0 = money
  players: [string, string];
  crawfordRule: boolean;
  jacoby: boolean;
  games: GameView[];
  decisions: Decision[]; // every decision of the match, in order
  statistics: Statistics;
  statisticsText?: string;
  errorRateFactor: number;
  analysed: boolean; // at least one decision has gnubg's analysis
}

const SKILL_ORDER: SkillMark[] = ["none", "doubtful", "bad", "verybad"];
export const worseSkill = (a: SkillMark, b: SkillMark): SkillMark =>
  SKILL_ORDER.indexOf(a) >= SKILL_ORDER.indexOf(b) ? a : b;

/** gnubg's names for its marks (analysis.c aszSkillType / aszLuckType). */
export const SKILL_TEXT: Record<SkillMark, string> = { none: "", doubtful: "doubtful", bad: "bad", verybad: "very bad" };
export const LUCK_TEXT: Record<LuckLabel, string> = {
  veryunlucky: "very unlucky",
  unlucky: "unlucky",
  none: "",
  lucky: "lucky",
  verylucky: "very lucky",
};
/** Annotation symbols for the move list (the usual ?!, ?, ??) and the luck marks. */
export const SKILL_SYMBOL: Record<SkillMark, string> = { none: "", doubtful: "?!", bad: "?", verybad: "??" };
export const LUCK_SYMBOL: Record<LuckLabel, string> = { veryunlucky: "↓↓", unlucky: "↓", none: "", lucky: "↑", verylucky: "↑↑" };

const RESIGN_TEXT = ["", "single game", "gammon", "backgammon"];

function actionText(r: AnalysisRecord): string {
  switch (r.type) {
    case "move":
      return `${r.dice ? `${r.dice[0]}${r.dice[1]}` : "??"}: ${r.move || "(no move)"}`;
    case "double":
      return `Doubles => ${r.newCube ?? 2 * r.cube}`;
    case "take":
      return "Takes";
    case "drop":
      return "Drops";
    case "resign": {
      const n = (r as { resign?: { resigned?: number } }).resign?.resigned ?? 1;
      return `Resigns ${RESIGN_TEXT[n] ?? ""}`.trim();
    }
    default:
      return r.type;
  }
}

interface ResignInfo {
  resigned: number;
  type: string;
  analysed: boolean;
  probs?: AnalysedMove["probs"];
  equityBefore?: number;
  equityAfter?: number;
  resignSkill?: SkillMark;
  acceptSkill?: SkillMark;
}
/** The resign details of a resign record (MATCH_API.md "resign"). */
export const resignOf = (r: AnalysisRecord): ResignInfo | null => (r as { resign?: ResignInfo }).resign ?? null;

/** The played move's entry in gnubg's list (it is always included, even below maxMoves). */
export function playedMove(r: AnalysisRecord): AnalysedMove | null {
  const ch = r.chequer;
  if (!ch || !ch.analysed || ch.playedIndex === null || ch.playedIndex === undefined || !ch.moves) return null;
  return ch.moves.find((m) => m.rank === ch.playedIndex) ?? null;
}

function valueOf(r: AnalysisRecord, player: Player): DecisionValue | null {
  if (r.type === "move") {
    const m = playedMove(r);
    return m ? { actor: player, win: m.probs.win, equity: m.equity, mwc: m.mwc } : null;
  }
  if (r.type === "double" || r.type === "take" || r.type === "drop") {
    const cd = r.cubeDecision as (RecordCubeDecision & { raw?: { noDoubleProbs?: { win: number } } }) | null | undefined;
    if (!cd || !cd.raw?.noDoubleProbs) return null;
    const doubler = (r.type === "double" ? player : 1 - player) as Player;
    const key = r.type === "drop" ? "doublePass" : "doubleTake";
    return { actor: doubler, win: cd.raw.noDoubleProbs.win, equity: cd.equities[key], mwc: cd.mwc?.[key] };
  }
  return null;
}

/** Build the view model from gnubg's get_analysis reply. */
export function buildMatchView(res: AnalysisResult): MatchView {
  const decisions: Decision[] = [];
  const games: GameView[] = res.games.map((g) => {
    const list: Decision[] = [];
    const rows: MoveRow[] = [];
    for (const r of g.records) {
      if (!KINDS.includes(r.type as DecisionKind)) continue; // setboard, setdice, ...: not decisions
      const kind = r.type as DecisionKind;
      const player = (r.player === 1 ? 1 : 0) as Player;
      const onRoll = (kind === "take" || kind === "drop" ? 1 - player : player) as Player;
      const chequerSkill: SkillMark = kind === "move" && r.chequer?.analysed ? r.chequer.skill : "none";
      const cubeSkill: SkillMark = r.cubeDecision?.skill ?? (kind !== "move" && r.skill ? r.skill : "none");
      const resign = kind === "resign" ? resignOf(r) : null;
      const skill = resign ? (resign.resignSkill ?? "none") : worseSkill(chequerSkill, cubeSkill);
      const analysed = !!(r.chequer?.analysed || r.cubeDecision || resign?.analysed);
      const luck = (r.luck?.label ?? "none") as LuckLabel;

      // Rows as in gnubg's .mat export: player 0 left, player 1 right; a new
      // row starts when player 0 acts and the row is not empty, or when
      // player 1 acts and its cell is taken (the same rule as lib/format.ts rowsOf).
      let row = rows[rows.length - 1];
      if (!row || (player === 0 && (row.cells[0] || row.cells[1])) || (player === 1 && row.cells[1])) {
        row = { number: rows.length + 1, cells: [null, null] };
        rows.push(row);
      }
      const d: Decision = {
        seq: decisions.length,
        game: g.index,
        gameSeq: list.length,
        row: row.number,
        record: r,
        kind,
        player,
        onRoll,
        text: actionText(r),
        chequerSkill,
        cubeSkill,
        skill,
        luck,
        analysed,
        value: valueOf(r, player),
      };
      row.cells[player] = d;
      list.push(d);
      decisions.push(d);
    }
    return {
      index: g.index,
      scoreBefore: g.scoreBefore,
      crawfordGame: g.crawfordGame,
      winner: g.winner,
      points: g.points,
      resigned: g.resigned,
      decisions: list,
      rows,
      statistics: g.statistics,
      statisticsText: g.statisticsText,
      analysed: list.some((d) => d.analysed),
    };
  });
  return {
    matchLength: res.matchLength,
    players: res.players,
    crawfordRule: res.crawfordRule,
    jacoby: res.jacoby,
    games,
    decisions,
    statistics: res.statistics,
    statisticsText: res.statisticsText,
    errorRateFactor: res.errorRateFactor,
    analysed: decisions.some((d) => d.analysed),
  };
}

// ---- boards -------------------------------------------------------------------
// The board is drawn with one player fixed at the bottom (`bottom`), the way
// components/BoardView.tsx expects it: board[1] = the bottom player, board[0]
// = the top player, each in its own numbering.

/**
 * Parse gnubg's move notation (FormatMove: "24/18 6/3", "bar/22*", "8/5(2)",
 * "6/off", and chains with a hit on the way such as 21/15*, then on to 11)
 * into (from, to) pairs in the mover's numbering (0-based, 24 = bar, -1 = off). A chain "a/b/c" becomes a→b, b→c; "(n)"
 * repeats a part n times. Hits need no special handling: applyPairs hits a
 * lone opposing chequer on any point a step ends on, and gnubg's notation
 * splits a chain at every point where it hits.
 */
export function parseMove(text: string): MovePairs {
  const pairs: MovePairs = [];
  const point = (s: string): number => {
    const t = s.replace(/\*/g, "").trim().toLowerCase();
    if (t === "bar") return 24;
    if (t === "off") return -1;
    const n = Number(t);
    if (!Number.isInteger(n) || n < 1 || n > 24) throw new Error(`bad point "${s}" in move "${text}"`);
    return n - 1;
  };
  for (const part of text.trim().split(/\s+/)) {
    if (!part) continue;
    const m = /^(.*?)(?:\((\d+)\))?$/.exec(part)!;
    const pts = m[1].split("/").map(point);
    const times = m[2] ? Number(m[2]) : 1;
    for (let k = 0; k < times; k++) for (let i = 0; i + 1 < pts.length; i++) pairs.push([pts[i], pts[i + 1]]);
  }
  return pairs;
}

/** Orient a board given from `onRoll`'s side so that `bottom` is board[1]. */
const orient = (b: Board, onRoll: Player, bottom: Player): Board => (onRoll === bottom ? b : swapSides(b));

/** The position before the decision, oriented for the board. */
export function boardBefore(d: Decision, bottom: Player): Board {
  return orient(boardFromPositionId(d.record.positionId), d.onRoll, bottom);
}

/** The position after playing `moveText` (gnubg notation) in a chequer decision. */
export function boardAfter(d: Decision, moveText: string, bottom: Player): Board {
  const b = applyPairs(boardFromPositionId(d.record.positionId), parseMove(moveText));
  return orient(b, d.onRoll, bottom);
}

/** The move as a trail for BoardView's lastMove prop. */
export function moveTrail(d: Decision, moveText: string, bottom: Player): LastMove {
  const screen = (d.onRoll === bottom ? 1 : 0) as Player;
  return {
    player: screen,
    steps: parseMove(moveText).map(([from, to]) => ({ from: toBoardIndex(screen, from), to: toBoardIndex(screen, to) })),
  };
}

/** The most recent chequer move before decision `d` in the same game, or null. */
export function previousMove(view: MatchView, d: Decision): Decision | null {
  const list = view.games[d.game].decisions;
  for (let k = d.gameSeq - 1; k >= 0; k--) if (list[k].kind === "move") return list[k];
  return null;
}

/** Cube for the board: value, owner (screen side) and whether a double is pending. */
export function cubeOf(d: Decision, bottom: Player): { cube: number; owner: -1 | 0 | 1; offered: boolean } {
  const r = d.record;
  const screen = (p: number) => (p === bottom ? 1 : 0) as 0 | 1;
  if (d.kind === "take" || d.kind === "drop") return { cube: 2 * r.cube, owner: screen(d.onRoll), offered: true };
  return { cube: r.cube, owner: r.cubeOwner === -1 ? -1 : screen(r.cubeOwner), offered: false };
}

/** Dice for the board (moves only) and whose they are (screen side). */
export function diceOf(d: Decision, bottom: Player): { dice: Dice | null; owner: 0 | 1 | null } {
  if (d.kind !== "move" || !d.record.dice) return { dice: null, owner: null };
  return { dice: d.record.dice, owner: d.onRoll === bottom ? 1 : 0 };
}

// ---- graph ---------------------------------------------------------------------

export type GraphMode = "win" | "equity";

export interface GraphPoint {
  d: Decision;
  x: number; // 0-based position along the x axis
  y: number | null; // the value from `perspective`'s side (null: nothing to plot)
}

/**
 * Points for the equity / win graph. The value of each decision is gnubg's
 * evaluation after it (the played move's entry in gnubg's move list; for a
 * cube action, gnubg's cube evaluation), seen from `perspective`:
 *   win     probability that `perspective` wins the game
 *   equity  match play: gnubg's match winning chance (MWC); money: gnubg's equity
 * The other player's numbers are turned around: 1 − p, 1 − MWC, −equity.
 */
export function graphPoints(decisions: Decision[], mode: GraphMode, perspective: Player, matchLength: number): GraphPoint[] {
  return decisions.map((d, x) => {
    const v = d.value;
    let y: number | null = null;
    if (v) {
      const mine = v.actor === perspective;
      if (mode === "win") y = mine ? v.win : 1 - v.win;
      else if (matchLength > 0) y = v.mwc === undefined ? null : mine ? v.mwc : 1 - v.mwc;
      else y = mine ? v.equity : -v.equity;
    }
    return { d, x, y };
  });
}

// ---- number formatting -------------------------------------------------------

const MINUS = "−";
/** Fixed decimals with an explicit sign (real minus), as gnubg's "%+.3f". */
export function signed(x: number, digits: number): string {
  const s = Math.abs(x).toFixed(digits);
  const neg = x < 0 || Object.is(x, -0);
  return (neg ? MINUS : "+") + s;
}
/** A percentage of a fraction: 0.5015 -> "50.15%". */
export const percent = (x: number, digits = 2) => `${(100 * x).toFixed(digits)}%`;

/** An error or luck value as gnubg shows it: "−0.141 (−0.884%)" (match) or "−0.141 (−0.282)" (money). */
export function costText(c: Cost, matchLength: number, sign: 1 | -1 = 1, digits = 3): string {
  const eq = signed(sign * c.equity, digits);
  if (matchLength > 0 && c.mwc !== undefined) return `${eq} (${signed(sign * 100 * c.mwc, 3)}%)`;
  if (c.points !== undefined) return `${eq} (${signed(sign * c.points, 3)})`;
  return eq;
}
/** A rate as gnubg shows it: mEMG with one decimal, then MWC % or points. */
export function rateText(c: Cost, matchLength: number, factor: number, sign: 1 | -1): string {
  const eq = signed(sign * factor * c.equity, 1);
  if (matchLength > 0 && c.mwc !== undefined) return `${eq} (${signed(sign * 100 * c.mwc, 3)}%)`;
  if (c.points !== undefined) return `${eq} (${signed(sign * c.points, 3)})`;
  return eq;
}

// ---- statistics ----------------------------------------------------------------

export interface StatRow {
  label: string; // gnubg's own label from "show statistics"
  cells: [string, string]; // player 0, player 1 ("" = gnubg prints nothing)
  emphasis?: boolean; // a rating / headline row
}
export interface StatSection {
  title: string;
  rows: StatRow[];
}

type CubeErrorKey =
  | "missedDoubleBelowCP"
  | "missedDoubleAboveCP"
  | "wrongDoubleBelowDP"
  | "wrongDoubleAboveTG"
  | "wrongTake"
  | "wrongPass";
const CUBE_ERRORS: [CubeErrorKey, string][] = [
  ["missedDoubleBelowCP", "Missed doubles below CP"],
  ["missedDoubleAboveCP", "Missed doubles above CP"],
  ["wrongDoubleBelowDP", "Wrong doubles below DP"],
  ["wrongDoubleAboveTG", "Wrong doubles above TG"],
  ["wrongTake", "Wrong takes"],
  ["wrongPass", "Wrong passes"],
];

/**
 * gnubg's "show statistics" (formatGS) as rows: the same sections, labels and
 * values (errors printed negated, rates x errorRateFactor), from the numbers
 * get_analysis returns. tests/analysis_page.mjs checks every row against
 * gnubg's own text.
 */
export function statSections(st: Statistics, matchLength: number, factor: number): StatSection[] {
  const P = st.players;
  const match = matchLength > 0;
  const unit = match ? "MWC" : "Points";
  const both = (f: (p: PlayerStatistics, i: number) => string): [string, string] => [f(P[0], 0), f(P[1], 1)];
  const count = (n: number) => String(n);
  const rating = (r: string | null) => r ?? "n/a";
  const sections: StatSection[] = [];

  if (st.hasChequer) {
    sections.push({
      title: "Chequer play",
      rows: [
        { label: "Total moves", cells: both((p) => count(p.chequer.totalMoves)) },
        { label: "Unforced moves", cells: both((p) => count(p.chequer.unforcedMoves)) },
        { label: "Unmarked moves", cells: both((p) => count(p.chequer.marked.none)) },
        { label: "Moves marked doubtful", cells: both((p) => count(p.chequer.marked.doubtful)) },
        { label: "Moves marked bad", cells: both((p) => count(p.chequer.marked.bad)) },
        { label: "Moves marked very bad", cells: both((p) => count(p.chequer.marked.veryBad)) },
        { label: `Error total EMG (${unit})`, cells: both((p) => costText(p.chequer.errorTotal, matchLength, -1)) },
        { label: `Error rate mEMG (${unit})`, cells: both((p) => rateText(p.chequer.errorPerMove, matchLength, factor, -1)) },
        { label: "Chequerplay rating", cells: both((p) => rating(p.chequer.rating)), emphasis: true },
      ],
    });
  }
  if (st.hasLuck) {
    sections.push({
      title: "Luck",
      rows: [
        { label: "Rolls marked very lucky", cells: both((p) => count(p.luck.marked.veryLucky)) },
        { label: "Rolls marked lucky", cells: both((p) => count(p.luck.marked.lucky)) },
        { label: "Rolls unmarked", cells: both((p) => count(p.luck.marked.none)) },
        { label: "Rolls marked unlucky", cells: both((p) => count(p.luck.marked.unlucky)) },
        { label: "Rolls marked very unlucky", cells: both((p) => count(p.luck.marked.veryUnlucky)) },
        { label: `Luck total EMG (${unit})`, cells: both((p) => costText(p.luck.total, matchLength, 1)) },
        { label: `Luck rate mEMG (${unit})`, cells: both((p) => rateText(p.luck.perMove, matchLength, factor, 1)) },
        { label: "Luck rating", cells: both((p) => rating(p.luck.rating)), emphasis: true },
      ],
    });
  }
  if (st.hasCube) {
    const cubeErr = (p: PlayerStatistics, k: CubeErrorKey) => {
      const e = p.cube[k] as Cost & { count: number };
      return e.count ? `${e.count} (${costText(e, matchLength, -1)})` : "0";
    };
    sections.push({
      title: "Cube",
      rows: [
        { label: "Total cube decisions", cells: both((p) => count(p.cube.total)) },
        { label: "Close or actual cube decisions", cells: both((p) => count(p.cube.close)) },
        { label: "Doubles", cells: both((p) => count(p.cube.doubles)) },
        { label: "Takes", cells: both((p) => count(p.cube.takes)) },
        { label: "Passes", cells: both((p) => count(p.cube.passes)) },
        ...CUBE_ERRORS.map(([k, label]) => ({ label: `${label} (EMG (${unit}))`, cells: both((p) => cubeErr(p, k)) })),
        { label: `Error total EMG (${unit})`, cells: both((p) => costText(p.cube.errorTotal, matchLength, -1)) },
        { label: `Error rate mEMG (${unit})`, cells: both((p) => rateText(p.cube.errorPerDecision, matchLength, factor, -1)) },
        { label: "Cube decision rating", cells: both((p) => rating(p.cube.rating)), emphasis: true },
      ],
    });
  }

  const overall: StatRow[] = [];
  if (st.hasChequer || st.hasCube) {
    overall.push(
      { label: `Error total EMG (${unit})`, cells: both((p) => costText(p.overall.errorTotal, matchLength, -1)) },
      { label: `Error rate mEMG (${unit})`, cells: both((p) => rateText(p.overall.errorPerDecision, matchLength, factor, -1)) },
      // gnubg prints the Snowie rate in mEMG followed by a constant "(+0.000%)"; we show the rate.
      { label: "Snowie error rate", cells: both((p) => signed(-factor * p.overall.snowieErrorRate, 1)) },
      { label: "Overall rating", cells: both((p) => rating(p.overall.rating)), emphasis: true }
    );
  }
  const result = (v: number) => (match ? `${signed(100 * v, 2)}%` : signed(v, 3));
  overall.push({ label: "Actual result", cells: both((p) => result(p.overall.actualResult)) });
  if (st.hasLuck) overall.push({ label: "Luck adjusted result", cells: both((p) => result(p.overall.luckAdjustedResult)) });
  if (match) {
    if (st.hasLuck && st.luckBasedFibsRatingDiff !== null && st.luckBasedFibsRatingDiff !== undefined)
      overall.push({ label: "Luck based FIBS rating diff.", cells: [signed(st.luckBasedFibsRatingDiff, 2), ""] });
    const fibs = (p: PlayerStatistics) =>
      p.overall.errorBasedFibsRating as Record<"total" | "chequerLoss" | "cubeLoss", number | null> | undefined;
    // gnubg prints "n/a" where it has no value (e.g. no cube decisions in the Crawford game)
    const one = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : v.toFixed(1));
    if ((st.hasChequer || st.hasCube) && fibs(P[0]) && fibs(P[1])) {
      overall.push({ label: "Error based abs. FIBS rating", cells: both((p) => one(fibs(p)!.total)) });
      if (st.hasChequer)
        overall.push({ label: "Chequerplay errors rating loss", cells: both((p) => one(fibs(p)!.chequerLoss)) });
      if (st.hasCube) overall.push({ label: "Cube errors rating loss", cells: both((p) => one(fibs(p)!.cubeLoss)) });
    }
  } else {
    type Adv = { ppg: number; ciLow: number; ciHigh: number } | undefined;
    const adv = (p: PlayerStatistics, k: "advantageActual" | "advantageLuckAdjusted") => p.overall[k] as Adv;
    const ci = (a: Adv) => (a ? `[${signed(a.ciLow, 3)}, ${signed(a.ciHigh, 3)}]` : "");
    if (adv(P[0], "advantageActual")) {
      overall.push(
        { label: "Advantage (actual) in ppg", cells: both((p) => signed(adv(p, "advantageActual")!.ppg, 3)) },
        { label: "95% confidence interval (ppg)", cells: both((p) => ci(adv(p, "advantageActual"))) }
      );
      if (st.hasLuck && adv(P[0], "advantageLuckAdjusted"))
        overall.push(
          { label: "Advantage (luck adjusted) in ppg", cells: both((p) => signed(adv(p, "advantageLuckAdjusted")!.ppg, 3)) },
          { label: "95% confidence interval (ppg)", cells: both((p) => ci(adv(p, "advantageLuckAdjusted"))) }
        );
    }
  }
  sections.push({ title: "Overall", rows: overall });
  return sections;
}

// ---- small helpers for the page -------------------------------------------------

/** "7-point match" / "money session". */
export const matchKind = (matchLength: number) => (matchLength > 0 ? `${matchLength}-point match` : "money session");

/** The index of the next / previous decision with an error mark (any player), or -1. */
export function nextMarked(view: MatchView, from: number, dir: 1 | -1, pred = (d: Decision) => d.skill !== "none"): number {
  for (let k = from + dir; k >= 0 && k < view.decisions.length; k += dir) if (pred(view.decisions[k])) return k;
  return -1;
}

/** The text the move list and the page use for a player: the name from the match file. */
export const playerName = (view: MatchView, p: number) => view.players[p] || `player ${p}`;

// ---- outcome probabilities ---------------------------------------------------------

/**
 * gnubg's five outputs as a complete, symmetric breakdown. gnubg's numbers
 * are cumulative (win includes gammons, gammons include backgammons); the
 * loss is 1 − win. `parts` splits the whole outcome space into the six
 * exclusive outcomes, in the fixed order the outcome bar draws them:
 * win bg | win gammon | win single || lose single | lose gammon | lose bg.
 */
export interface Outcomes {
  win: number;
  winGammon: number;
  winBackgammon: number;
  lose: number;
  loseGammon: number;
  loseBackgammon: number;
  parts: { key: "wbg" | "wg" | "w" | "l" | "lg" | "lbg"; label: string; value: number }[];
}
export function outcomes(p: {
  win: number;
  winGammon: number;
  winBackgammon: number;
  loseGammon: number;
  loseBackgammon: number;
}): Outcomes {
  const lose = 1 - p.win;
  const nonNeg = (x: number) => Math.max(0, x);
  return {
    win: p.win,
    winGammon: p.winGammon,
    winBackgammon: p.winBackgammon,
    lose,
    loseGammon: p.loseGammon,
    loseBackgammon: p.loseBackgammon,
    parts: [
      { key: "wbg", label: "win backgammon", value: nonNeg(p.winBackgammon) },
      { key: "wg", label: "win gammon", value: nonNeg(p.winGammon - p.winBackgammon) },
      { key: "w", label: "win single", value: nonNeg(p.win - p.winGammon) },
      { key: "l", label: "lose single", value: nonNeg(lose - p.loseGammon) },
      { key: "lg", label: "lose gammon", value: nonNeg(p.loseGammon - p.loseBackgammon) },
      { key: "lbg", label: "lose backgammon", value: nonNeg(p.loseBackgammon) },
    ],
  };
}
