"use client";
// gnubg's outcome probabilities as a complete, symmetric breakdown: win and
// lose (lose = 1 − win), each with its gammon and backgammon parts (gnubg's
// numbers are cumulative), plus a stacked bar of the whole outcome space in
// a fixed order: win bg | win gammon | win single || lose single | lose
// gammon | lose bg. The win side is drawn in the tone of the player whose
// probabilities these are, the lose side in the opponent's.

import type { Probabilities } from "@/engine/types";
import { outcomes } from "@/lib/analysisView";
import s from "./Analysis.module.css";

export type Tone = "ivory" | "walnut";
const pct1 = (x: number) => `${(100 * x).toFixed(1)}%`;

export default function Outcome({ probs, tone, who }: { probs: Probabilities; tone: Tone; who: string }) {
  const o = outcomes(probs);
  const other: Tone = tone === "ivory" ? "walnut" : "ivory";
  const cls = (k: string) =>
    ({ wbg: s[`${tone}-bg`], wg: s[`${tone}-g`], w: s[`${tone}-w`], l: s[`${other}-w`], lg: s[`${other}-g`], lbg: s[`${other}-bg`] })[k];
  const title = o.parts.map((p) => `${p.label} ${pct1(p.value)}`).join(" · ");
  return (
    <div className={s.outcome} data-testid="outcome">
      <div className={s.obar} role="img" aria-label={`${who}: ${title}`} title={title}>
        {o.parts.map((p) => (
          <span key={p.key} className={`${s.oseg} ${cls(p.key)}`} style={{ width: `${100 * p.value}%` }} />
        ))}
        <span className={s.odiv} style={{ left: `${100 * o.win}%` }} aria-hidden="true" />
      </div>
      <div className={s.onums}>
        <span>
          <span className={`${s.ok} ${cls("w")}`} aria-hidden="true" />
          win <b>{pct1(o.win)}</b> (gammon {pct1(o.winGammon)} · bg {pct1(o.winBackgammon)})
        </span>
        <span>
          <span className={`${s.ok} ${cls("l")}`} aria-hidden="true" />
          lose <b>{pct1(o.lose)}</b> (gammon {pct1(o.loseGammon)} · bg {pct1(o.loseBackgammon)})
        </span>
      </div>
    </div>
  );
}
