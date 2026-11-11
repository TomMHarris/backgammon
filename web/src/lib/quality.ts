// How good was each decision, in the style of a chess game review:
// Best / Good / Inaccuracy / Mistake / Blunder (and Forced).
//
// Every label is gnubg's own verdict, renamed: the three error grades are
// gnubg's marks "doubtful", "bad" and "very bad" (its thresholds: an equity
// loss of 0.03, 0.06 and 0.12 or more, see game/tutor.ts); "Best" is a play
// or cube action that gnubg ranks first; "Good" is a smaller error that gnubg
// leaves unmarked. Nothing here evaluates anything.

import type { Decision } from "./analysisView";
import { playedMove } from "./analysisView";
import type { SkillMark } from "@/engine/types";

export type Quality = "best" | "good" | "inaccuracy" | "mistake" | "blunder" | "forced";

export const QUALITY: Record<Quality, { label: string; symbol: string; gnubg: string }> = {
  best: { label: "Best", symbol: "★", gnubg: "gnubg's first choice" },
  good: { label: "Good", symbol: "✓", gnubg: "a small error gnubg does not mark" },
  inaccuracy: { label: "Inaccuracy", symbol: "?!", gnubg: "gnubg: doubtful (loses 0.03 or more)" },
  mistake: { label: "Mistake", symbol: "?", gnubg: "gnubg: bad (loses 0.06 or more)" },
  blunder: { label: "Blunder", symbol: "??", gnubg: "gnubg: very bad (loses 0.12 or more)" },
  forced: { label: "Forced", symbol: "–", gnubg: "only one legal play" },
};

/** gnubg's mark as the review's word, lower case ("blunder"), or "" for none. */
export const skillLabel = (s: SkillMark): string => {
  const q = qualityOfSkill(s);
  return q ? QUALITY[q].label.toLowerCase() : "";
};

/** The order of the summary (best first). */
export const QUALITY_ORDER: Quality[] = ["best", "good", "inaccuracy", "mistake", "blunder"];

export const qualityOfSkill = (s: SkillMark): Quality | null =>
  s === "verybad" ? "blunder" : s === "bad" ? "mistake" : s === "doubtful" ? "inaccuracy" : null;

/**
 * The quality of one decision, or null when there is nothing to grade (not
 * analysed, or a resignation without gnubg's verdict).
 */
export function qualityOf(d: Decision): Quality | null {
  if (!d.analysed) return null;
  const marked = qualityOfSkill(d.skill);
  if (marked) return marked;
  const r = d.record;
  if (d.kind === "move") {
    const ch = r.chequer;
    const cubeError = r.cubeDecision?.error?.equity ?? 0;
    if (!ch?.analysed) return r.cubeDecision ? (cubeError < 0 ? "good" : null) : null;
    if ((ch.legalMoves ?? 0) <= 1) return cubeError < 0 ? "good" : "forced";
    const played = playedMove(r);
    return played && played.rank === 0 && cubeError >= 0 ? "best" : "good";
  }
  if (d.kind === "double" || d.kind === "take" || d.kind === "drop") {
    const e = r.cubeDecision?.error?.equity;
    if (e === undefined) return null;
    return e < 0 ? "good" : "best";
  }
  return null;
}

/** Counts of each quality for `player` over `decisions` (forced moves left out). */
export function qualityCounts(decisions: Decision[], player: number): Record<Quality, number> {
  const c: Record<Quality, number> = { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, forced: 0 };
  for (const d of decisions) {
    if (d.player !== player) continue;
    const q = qualityOf(d);
    if (q) c[q]++;
  }
  return c;
}
