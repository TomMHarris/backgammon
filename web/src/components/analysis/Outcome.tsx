"use client";
// gnubg's outcome probabilities on the analysis page: the shared outcome bar
// and numbers (components/OutcomeBar.tsx, the same as in the game's hint
// panel). The win side is drawn in the tone of the player whose
// probabilities these are, the lose side in the opponent's.

import type { Probabilities } from "@/engine/types";
import OutcomeBar, { type Tone } from "../OutcomeBar";

export type { Tone };

export default function Outcome({ probs, tone, who }: { probs: Probabilities; tone: Tone; who: string }) {
  return <OutcomeBar probs={probs} tone={tone} who={who} testId="outcome" />;
}
