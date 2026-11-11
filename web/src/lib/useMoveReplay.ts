"use client";
// Playing a move on the board one checker at a time (the review screens:
// "show your move" / "show gnubg's move").
//
//   const replay = useMoveReplay(resetKey);
//   replay.play("best", pairs.length);   // step 0 = the position before, then one step per checker
//   board = applyPairs(start, pairs.slice(0, replay.step));
//
// `which` is the move being shown (null = none: the caller shows the
// position before, e.g. with arrows). Each step changes the board, so
// BoardView slides the checker that moved. Step 0 shows the position before
// for a moment, so starting again from another move's result first slides
// the checkers back. A change of `resetKey` (another decision) clears it.

import { useEffect, useRef, useState } from "react";

/** Time between checkers: the slide itself takes 250 ms (Board.module.css). */
const STEP_MS = 420;

export function useMoveReplay<W extends string>(resetKey: unknown) {
  const [state, setState] = useState<{ which: W | null; step: number; steps: number }>({ which: null, step: 0, steps: 0 });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  useEffect(() => {
    stop();
    setState({ which: null, step: 0, steps: 0 });
  }, [resetKey]);
  useEffect(() => stop, []);

  const play = (which: W, steps: number) => {
    stop();
    setState({ which, step: 0, steps });
    let k = 0;
    timer.current = setInterval(() => {
      k++;
      setState({ which, step: k, steps });
      if (k >= steps) stop();
    }, STEP_MS);
  };
  const clear = () => {
    stop();
    setState({ which: null, step: 0, steps: 0 });
  };

  return { which: state.which, step: state.step, done: state.which !== null && state.step >= state.steps, play, clear };
}
