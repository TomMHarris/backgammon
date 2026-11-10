"use client";
// gnubg's outcome probabilities, shared by the hint panel (moves and cube
// hint) and the analysis page: a stacked bar of the whole 0-100% outcome
// space, with six labelled numbers under it in the same order.
//
// gnubg's probabilities are cumulative (a win includes gammons, a gammon
// includes backgammons). The bar shows the six exclusive outcomes in a fixed
// order: win bg | win gammon | win single || lose single | lose gammon |
// lose bg, with a divider at the win / lose boundary. The win side is in the
// tone of the checkers of the player whose chances these are (ivory: you /
// the bottom player; walnut: gnubg / the top player), the lose side in the
// opponent's, gammons and backgammons in progressively deeper shades.
//
// The numbers, one column per outcome in the bar's order:
//     bg    g     W   |   L     g    bg
//    0.8  15.0  52.1  |  47.9  12.5  0.5
// W and L are the totals (L = 100 − W); g and bg are the parts of W (or L)
// that are gammons (backgammons included) and backgammons. Each header has
// a swatch in its bar segment's colour.

import type { Probabilities } from "@/engine/types";
import { outcomes } from "@/lib/analysisView";

export type Tone = "ivory" | "walnut";

const p1 = (x: number) => (100 * Math.max(0, x)).toFixed(1);
const SHADE: Record<string, 1 | 2 | 3> = { w: 1, wg: 2, wbg: 3, l: 1, lg: 2, lbg: 3 };
const HEAD: Record<string, string> = { wbg: "bg", wg: "g", w: "W", l: "L", lg: "g", lbg: "bg" };

/** The one-line key, also the numbers' tooltip. */
export const OUTCOME_KEY = "W and L are totals (W includes gammons, gammons include backgammons); g and bg: the part of W or L won or lost as a gammon or a backgammon, in %.";

export default function OutcomeBar({
  probs,
  tone = "ivory",
  who,
  testId,
}: {
  probs: Probabilities;
  tone?: Tone; // the colour of the winning side's checkers
  who?: string; // whose chances, for the accessible name ("You", "gnubg")
  testId?: string;
}) {
  const o = outcomes(probs);
  const other: Tone = tone === "ivory" ? "walnut" : "ivory";
  const cls = (key: string) => `oc-${key.startsWith("w") ? tone : other}-${SHADE[key]}`;
  const title = o.parts.map((p) => `${p.label[0].toUpperCase()}${p.label.slice(1)} ${p1(p.value)}%`).join(" · ");
  const label = `${who ? `${who}: ` : ""}win ${p1(o.win)}% (gammon ${p1(o.winGammon)}%, backgammon ${p1(o.winBackgammon)}%), lose ${p1(o.lose)}% (gammon ${p1(o.loseGammon)}%, backgammon ${p1(o.loseBackgammon)}%)`;
  // the numbers, cumulative as gnubg gives them, in the bar's order
  const value: Record<string, number> = {
    wbg: o.winBackgammon,
    wg: o.winGammon,
    w: o.win,
    l: o.lose,
    lg: o.loseGammon,
    lbg: o.loseBackgammon,
  };
  const col = (key: string) => (
    <span key={key} className={`oc-col oc-col-${key}`}>
      <span className="oc-h">
        <span className={`oc-sw ${cls(key)}`} />
        {HEAD[key]}
      </span>
      <span className="oc-v num">{p1(value[key])}</span>
    </span>
  );
  return (
    <span className="outcome" data-testid={testId}>
      <span className="probbar" role="img" aria-label={label} title={title}>
        {o.parts.slice(0, 3).map((p) => (p.value > 0 ? <span key={p.key} className={`pb ${cls(p.key)}`} style={{ width: `${100 * p.value}%` }} /> : null))}
        <span className="pb-div" aria-hidden="true" />
        {o.parts.slice(3).map((p) => (p.value > 0 ? <span key={p.key} className={`pb ${cls(p.key)}`} style={{ width: `${100 * p.value}%` }} /> : null))}
      </span>
      <span className="oc-cols" aria-hidden="true" title={OUTCOME_KEY} data-testid="outcome-cols">
        {["wbg", "wg", "w"].map(col)}
        <span className="oc-cdiv" />
        {["l", "lg", "lbg"].map(col)}
      </span>
    </span>
  );
}

/** The one-line key to the numbers (shown once under a list). */
export function OutcomeLegend() {
  return (
    <p className="oc-legend" data-testid="outcome-legend">
      <span className="oc-legend-order">bg · g · W | L · g · bg</span> {OUTCOME_KEY}
    </p>
  );
}
