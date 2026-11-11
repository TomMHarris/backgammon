// Cube decisions in plain words, for the review screens.
//
// gnubg states its verdict as "<doubler's action>, <taker's response>", e.g.
// "Double, take", "No redouble, take", "Too good to double, pass", "Optional
// double, take", "Never double, take (dead cube)" (GetCubeRecommendation,
// eval.c:3128). This module splits that into what the player who acted
// should have done, and lists that player's options with their equities
// from THEIR side (gnubg's equities are from the doubler's side). Every
// number is gnubg's; only the wording and the sign are ours.

import type { CubeEquities } from "@/engine/types";

export type CubeActual = "no double" | "double" | "take" | "drop";

/** gnubg's verdict, split into its two halves. */
export function readProper(proper: string) {
  const [d = "", t = ""] = proper.toLowerCase().split(",").map((x) => x.trim());
  const word = d.includes("redouble") ? "redouble" : "double";
  return {
    word, // "double" or "redouble"
    tooGood: d.startsWith("too good"),
    optional: d.startsWith("optional"),
    double: d === "double" || d === "redouble", // the doubler should double
    take: !t.startsWith("pass"), // the taker should take (or beaver)
    beaver: t.startsWith("beaver"),
  };
}

/** Did the player act as the doubler (double / no double) or the taker (take / pass)? */
export const isTaker = (actual: CubeActual) => actual === "take" || actual === "drop";

/** "You doubled", "Light passed", ... */
export function cubeDid(actual: CubeActual, who: string, cube: number): string {
  switch (actual) {
    case "double":
      return `${who} doubled to ${2 * cube}`;
    case "no double":
      return `${who} did not double`;
    case "take":
      return `${who} took`;
    case "drop":
      return `${who} passed`;
  }
}

/** What gnubg would have done in the same player's place. */
export function cubeShould(actual: CubeActual, proper: string): string {
  const p = readProper(proper);
  if (isTaker(actual)) return p.beaver ? "gnubg would take (even beaver)" : p.take ? "gnubg would take" : "gnubg would pass";
  if (p.tooGood) return `gnubg would not ${p.word}: too good, play on for a gammon`;
  if (p.optional) return `gnubg: ${p.word === "redouble" ? "redoubling" : "doubling"} is optional here`;
  return p.double ? `gnubg would ${p.word}` : `gnubg would not ${p.word} yet`;
}

export interface CubeOption {
  label: string; // "No double", "Double", "Take", "Pass"
  note?: string; // "then take": the opponent's best reply to a double
  equity: number; // from the side of the player who decided
  best: boolean;
  yours: boolean; // the option the player chose
}

/**
 * The deciding player's options, with gnubg's equities from that player's
 * side: the doubler compares not doubling with doubling (against the
 * opponent's best reply); the taker compares taking with passing.
 */
export function cubeOptions(actual: CubeActual, eq: CubeEquities): CubeOption[] {
  let opts: Omit<CubeOption, "best">[];
  if (isTaker(actual)) {
    opts = [
      { label: "Take", equity: -eq.doubleTake, yours: actual === "take" },
      { label: "Pass", equity: -eq.doublePass, yours: actual === "drop" },
    ];
  } else {
    const takes = eq.doubleTake <= eq.doublePass;
    opts = [
      { label: "No double", equity: eq.noDouble, yours: actual === "no double" },
      { label: "Double", note: takes ? "then take" : "then pass", equity: Math.min(eq.doubleTake, eq.doublePass), yours: actual === "double" },
    ];
  }
  const top = Math.max(...opts.map((o) => o.equity));
  return opts.map((o) => ({ ...o, best: o.equity === top }));
}
