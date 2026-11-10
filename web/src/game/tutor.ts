// Tutor and hint helpers: gnubg's skill thresholds and cube-decision tables.
//
// Nothing here computes an equity. The engine supplies the equities (rankMoves
// diffs, analyseCube's ND / D-T / D-P values); these functions only compare
// them with gnubg's thresholds, exactly as gnubg's own tutor does.

/**
 * gnubg's error thresholds (normalised equity), arSkillLevel in gnubg.c:282-287
 * (gnubg 1.08.003): very bad 0.12, bad 0.06, doubtful 0.03. Skill() in
 * analysis.c:295-305 labels an equity loss r (r <= 0) as
 *   r < -0.12 very bad, r < -0.06 bad, r < -0.03 doubtful, else fine.
 */
export const SKILL_THRESHOLDS = { veryBad: 0.12, bad: 0.06, doubtful: 0.03 } as const;

export type Skill = "very bad" | "bad" | "doubtful" | "none";

/** gnubg's Skill() (analysis.c:295). `r` = equity of the chosen action minus the best (<= 0). */
export function skill(r: number): Skill {
  if (r < -SKILL_THRESHOLDS.veryBad) return "very bad";
  if (r < -SKILL_THRESHOLDS.bad) return "bad";
  if (r < -SKILL_THRESHOLDS.doubtful) return "doubtful";
  return "none";
}

const SEVERITY: Record<Skill, number> = { "very bad": 0, bad: 1, doubtful: 2, none: 3 };

/**
 * Should the tutor warn? Like gnubg's GiveAdvice (gnubg.c:5313): warn when the
 * mistake is at least as bad as the chosen tutor level ("set tutor skill";
 * gnubg's default is doubtful, gnubg.c:266).
 */
export function tutorWarns(s: Skill, level: Exclude<Skill, "none">): boolean {
  return s !== "none" && SEVERITY[s] <= SEVERITY[level];
}

// gnubg's cubedecision enum (eval.h), as returned in CubeAnalysis.decision.
export const CD = {
  DOUBLE_TAKE: 0,
  DOUBLE_PASS: 1,
  NODOUBLE_TAKE: 2,
  TOOGOOD_TAKE: 3,
  TOOGOOD_PASS: 4,
  DOUBLE_BEAVER: 5,
  NODOUBLE_BEAVER: 6,
  REDOUBLE_TAKE: 7,
  REDOUBLE_PASS: 8,
  NO_REDOUBLE_TAKE: 9,
  TOOGOODRE_TAKE: 10,
  TOOGOODRE_PASS: 11,
  NO_REDOUBLE_BEAVER: 12,
  NODOUBLE_DEADCUBE: 13,
  NO_REDOUBLE_DEADCUBE: 14,
  NOT_AVAILABLE: 15,
  OPTIONAL_DOUBLE_TAKE: 16,
  OPTIONAL_REDOUBLE_TAKE: 17,
  OPTIONAL_DOUBLE_BEAVER: 18,
  OPTIONAL_DOUBLE_PASS: 19,
  OPTIONAL_REDOUBLE_PASS: 20,
} as const;

/** analyseCube's equities, from the doubler's side (normalised, money units or EMG). */
export interface CubeEq {
  noDouble: number;
  doubleTake: number;
  doublePass: number;
}

/**
 * Equity lost by each cube action, following gnubg.c no_double_skill (2078),
 * double_skill (2104), drop_skill (2134) and take_skill (2165). Returns the
 * (<= 0) error; 0 when the action is right or the decision is not clear-cut
 * for gnubg's tutor. Equities are from the doubler's side, as in gnubg.
 */
export function noDoubleError(cd: number, eq: CubeEq): number {
  switch (cd) {
    case CD.DOUBLE_TAKE:
    case CD.DOUBLE_BEAVER:
    case CD.REDOUBLE_TAKE:
      return eq.noDouble - eq.doubleTake;
    case CD.DOUBLE_PASS:
    case CD.REDOUBLE_PASS:
      return eq.noDouble - eq.doublePass;
    default:
      return 0;
  }
}

export function doubleError(cd: number, eq: CubeEq): number {
  switch (cd) {
    case CD.NODOUBLE_TAKE:
    case CD.NODOUBLE_BEAVER:
    case CD.NO_REDOUBLE_TAKE:
    case CD.NO_REDOUBLE_BEAVER:
    case CD.TOOGOOD_TAKE:
    case CD.TOOGOODRE_TAKE:
      return eq.doubleTake - eq.noDouble;
    case CD.TOOGOOD_PASS:
    case CD.TOOGOODRE_PASS:
      return eq.doublePass - eq.noDouble;
    default:
      return 0;
  }
}

/** Error of passing (the responder's loss; doubler's equities inverted). */
export function dropError(cd: number, eq: CubeEq): number {
  switch (cd) {
    case CD.DOUBLE_TAKE:
    case CD.DOUBLE_BEAVER:
    case CD.REDOUBLE_TAKE:
    case CD.NODOUBLE_TAKE:
    case CD.NODOUBLE_BEAVER:
    case CD.NO_REDOUBLE_TAKE:
    case CD.NO_REDOUBLE_BEAVER:
    case CD.TOOGOOD_TAKE:
    case CD.TOOGOODRE_TAKE:
    case CD.OPTIONAL_DOUBLE_BEAVER:
    case CD.OPTIONAL_DOUBLE_TAKE:
    case CD.OPTIONAL_REDOUBLE_TAKE:
      return eq.doubleTake - eq.doublePass;
    default:
      return 0;
  }
}

/** Error of taking (the responder's loss; doubler's equities inverted). */
export function takeError(cd: number, eq: CubeEq): number {
  switch (cd) {
    case CD.DOUBLE_PASS:
    case CD.REDOUBLE_PASS:
    case CD.TOOGOOD_PASS:
    case CD.TOOGOODRE_PASS:
    case CD.OPTIONAL_DOUBLE_PASS:
    case CD.OPTIONAL_REDOUBLE_PASS:
      return eq.doublePass - eq.doubleTake;
    default:
      return 0;
  }
}

/** Take/drop advice for the responder, from gnubg's verdict text for the doubler. */
export function responderAdvice(recommendation: string): string {
  const r = recommendation.toLowerCase();
  if (r.includes("beaver")) return "Beaver (or take)";
  if (r.includes("pass")) return "Pass";
  if (r.includes("take")) return "Take";
  return recommendation;
}
