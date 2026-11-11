// How good was each decision, for the review screens:
//
//   ★  Best      gnubg's first choice
//   ✓  Strong    within STRONG_LOSS of the best (equity)
//      (none)    a small loss, from STRONG_LOSS up to gnubg's doubtful threshold
//   ?! Doubtful  gnubg's marks, in gnubg's own words: an equity loss of
//   ?  Bad       0.03, 0.06 and 0.12 or more (arSkillLevel, see game/tutor.ts)
//   ?? Very bad
//   –  Forced    only one legal play
//
// The error grades are gnubg's verdicts unchanged. "Best" is gnubg's ranking.
// "Strong" is the one judgement of ours: gnubg has no such grade, so the
// threshold STRONG_LOSS is a choice, kept well below gnubg's doubtful 0.03.
// Nothing here evaluates anything; the losses are gnubg's.

import type { Decision } from "./analysisView";
import { playedMove } from "./analysisView";
import type { SkillMark } from "@/engine/types";

/** A move (or cube action) losing less than this much equity against the best counts as strong. */
export const STRONG_LOSS = 0.01;

export type Quality = "best" | "strong" | "doubtful" | "bad" | "verybad" | "forced";

export const QUALITY: Record<Quality, { label: string; symbol: string; gnubg: string }> = {
  best: { label: "Best", symbol: "★", gnubg: "gnubg's first choice" },
  strong: { label: "Strong", symbol: "✓", gnubg: `within ${STRONG_LOSS} of gnubg's best` },
  doubtful: { label: "Doubtful", symbol: "?!", gnubg: "gnubg: doubtful (loses 0.03 or more)" },
  bad: { label: "Bad", symbol: "?", gnubg: "gnubg: bad (loses 0.06 or more)" },
  verybad: { label: "Very bad", symbol: "??", gnubg: "gnubg: very bad (loses 0.12 or more)" },
  forced: { label: "Forced", symbol: "–", gnubg: "only one legal play" },
};

/** The order of the summary (best first). */
export const QUALITY_ORDER: Quality[] = ["best", "strong", "doubtful", "bad", "verybad"];

/** gnubg's mark as a quality (null: unmarked). */
export const qualityOfSkill = (s: SkillMark): Quality | null => (s === "none" ? null : s);

/** gnubg's mark in its own words, lower case ("very bad"), or "" for none. */
export const skillLabel = (s: SkillMark): string => (s === "none" ? "" : QUALITY[s].label.toLowerCase());

/**
 * The quality of one decision, or null when it gets no grade: not analysed,
 * a resignation, or a small loss between "strong" and gnubg's "doubtful".
 */
export function qualityOf(d: Decision): Quality | null {
  if (!d.analysed) return null;
  const marked = qualityOfSkill(d.skill);
  if (marked) return marked;
  const r = d.record;
  const grade = (loss: number, best: boolean): Quality | null => (best && loss <= 0 ? "best" : loss < STRONG_LOSS ? "strong" : null);
  if (d.kind === "move") {
    const ch = r.chequer;
    const cubeLoss = -(r.cubeDecision?.error?.equity ?? 0);
    if (!ch?.analysed) return r.cubeDecision ? grade(cubeLoss, true) : null;
    if ((ch.legalMoves ?? 0) <= 1) return cubeLoss > 0 ? grade(cubeLoss, false) : "forced";
    const played = playedMove(r);
    const loss = -(ch.error?.equity ?? 0) + cubeLoss;
    return grade(loss, !!played && played.rank === 0 && cubeLoss <= 0);
  }
  if (d.kind === "double" || d.kind === "take" || d.kind === "drop") {
    const e = r.cubeDecision?.error?.equity;
    return e === undefined ? null : grade(-e, true);
  }
  return null;
}

/** Counts of each quality for `player` over `decisions` (forced and ungraded decisions left out). */
export function qualityCounts(decisions: Decision[], player: number): Record<Quality, number> {
  const c: Record<Quality, number> = { best: 0, strong: 0, doubtful: 0, bad: 0, verybad: 0, forced: 0 };
  for (const d of decisions) {
    if (d.player !== player) continue;
    const q = qualityOf(d);
    if (q) c[q]++;
  }
  return c;
}
