"use client";
// gnubg's outcome probabilities, shared by the hint panel and the analysis
// page: a stacked bar of the whole 0-100% outcome space plus the numbers.
//
// gnubg's probabilities are cumulative (a win includes gammons, a gammon
// includes backgammons). The bar shows the six exclusive outcomes in a fixed
// order: win bg | win gammon | win single || lose single | lose gammon |
// lose bg, with a divider at the win / lose boundary. The win side is in the
// tone of the checkers of the player whose chances these are (ivory: you /
// the bottom player; walnut: gnubg / the top player), the lose side in the
// opponent's, gammons and backgammons in progressively deeper shades.
// The numbers: "Win 52.1% (g 15.0, bg 0.8)  Lose 47.9% (g 12.5, bg 0.5)":
// Win and Lose are totals (Lose = 100 − Win), g and bg the parts of each that
// are gammons (including backgammons) and backgammons.

import type { Probabilities } from "@/engine/types";
import { outcomes } from "@/lib/analysisView";

export type Tone = "ivory" | "walnut";

const p1 = (x: number) => (100 * Math.max(0, x)).toFixed(1);
const SHADE: Record<string, 1 | 2 | 3> = { w: 1, wg: 2, wbg: 3, l: 1, lg: 2, lbg: 3 };

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
  return (
    <span className="outcome" data-testid={testId}>
      <span className="probbar" role="img" aria-label={label} title={title}>
        {o.parts.slice(0, 3).map((p) => (p.value > 0 ? <span key={p.key} className={`pb ${cls(p.key)}`} style={{ width: `${100 * p.value}%` }} /> : null))}
        <span className="pb-div" aria-hidden="true" />
        {o.parts.slice(3).map((p) => (p.value > 0 ? <span key={p.key} className={`pb ${cls(p.key)}`} style={{ width: `${100 * p.value}%` }} /> : null))}
      </span>
      <span className="outcome-nums" aria-hidden="true">
        <span className="oc-side">
          <span className={`oc-key ${cls("w")}`} />
          <span className="oc-word">Win</span>
          <span className="oc-total num">{p1(o.win)}%</span>
          <span className="oc-sub num">
            (g {p1(o.winGammon)}, bg {p1(o.winBackgammon)})
          </span>
        </span>
        <span className="oc-side">
          <span className={`oc-key ${cls("l")}`} />
          <span className="oc-word">Lose</span>
          <span className="oc-total num">{p1(o.lose)}%</span>
          <span className="oc-sub num">
            (g {p1(o.loseGammon)}, bg {p1(o.loseBackgammon)})
          </span>
        </span>
      </span>
    </span>
  );
}

/** A one-line key to the bar and the numbers (shown once under a list). */
export function OutcomeLegend({ tone = "ivory" }: { tone?: Tone }) {
  const other: Tone = tone === "ivory" ? "walnut" : "ivory";
  return (
    <div className="oc-legend">
      <p>
        Win and Lose are totals in % (Lose = 100 − Win). In brackets, the part of each that is a gammon (<strong>g</strong>, backgammons
        included) and a backgammon (<strong>bg</strong>).
      </p>
      <p className="oc-legend-bar" aria-hidden="true">
        <span className={`pb oc-${tone}-3`} />
        <span className={`pb oc-${tone}-2`} />
        <span className={`pb oc-${tone}-1`} />
        <span className="oc-legend-text">win: bg · g · single</span>
        <span className="pb-div" />
        <span className={`pb oc-${other}-1`} />
        <span className={`pb oc-${other}-2`} />
        <span className={`pb oc-${other}-3`} />
        <span className="oc-legend-text">lose: single · g · bg</span>
      </p>
    </div>
  );
}
