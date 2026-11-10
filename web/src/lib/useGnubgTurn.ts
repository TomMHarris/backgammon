"use client";
// gnubg's side of the game, as a React effect.
//
// Runs after every change of the match. If it is gnubg's turn to act (roll or
// double, move, or answer your double), it asks the engine (game/bot.ts),
// waits a moment so the action can be followed, and applies the result with
// a match.ts transition -- but only if the match is still the one it looked
// at (cur === m), so a new match started meanwhile is never overwritten.

import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { EngineClient } from "@/engine/client";
import type { Preset } from "@/engine/types";
import { applyPairs, swapSides, type Board, type Dice } from "@/game/board";
import { rollDice } from "@/game/dice";
import { beaver, canDouble, double, drop, move, responder, roll, take, type MatchState } from "@/game/match";
import { botAnswerDouble, botChooseMove, botWantsToDouble } from "@/game/bot";
import { playSound, type SoundName } from "@/sound/sounds";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The sound for one checker step: a hit, a bear-off or a plain placement. */
export const stepSound = (hit: boolean, to: number): SoundName => (hit ? "hit" : to === -1 ? "bearoff" : "place");

export function useGnubgTurn(p: {
  engineRef: MutableRefObject<EngineClient | null>;
  ready: boolean;
  match: MatchState | null;
  botLevel: Preset;
  retry: number; // bumped by "retry" after an error: runs the step again
  animate: MutableRefObject<boolean>; // show gnubg's move checker by checker
  setMatch: Dispatch<SetStateAction<MatchState | null>>;
  setBusy: (s: string | null) => void;
  setNotice: (s: string | null) => void;
  setAnim: (a: { board: Board; dice: Dice } | null) => void;
  fail: (e: unknown) => void;
}) {
  const { engineRef, ready, match, botLevel, retry, animate, setMatch, setBusy, setNotice, setAnim, fail } = p;
  useEffect(() => {
    const engine = engineRef.current;
    if (!ready || !engine || !match) return;
    const m = match;
    let cancelled = false;
    const applyIfCurrent = (f: (x: MatchState) => MatchState) => setMatch((cur) => (cur === m && !cancelled ? f(cur) : cur));

    async function run() {
      if (!engine) return;
      if (m.phase === "rolling" && m.turn === 0) {
        // gnubg on roll: double, or roll
        if (canDouble(m, 0)) {
          setBusy("gnubg is considering the cube");
          const dbl = await botWantsToDouble(engine, m, 0, botLevel);
          if (cancelled) return;
          if (dbl) {
            setNotice(null);
            applyIfCurrent(double);
            return;
          }
        }
        setBusy("gnubg rolls");
        await sleep(400);
        const dice = rollDice();
        applyIfCurrent((x) => roll(x, dice));
      } else if (m.phase === "moving" && m.turn === 0 && m.dice) {
        // gnubg moves
        setBusy("gnubg is thinking");
        const t0 = Date.now();
        const { pairs, move: text } = await botChooseMove(engine, m, botLevel);
        if (cancelled) return;
        if (Date.now() - t0 < 300) await sleep(300 - (Date.now() - t0));
        const start = swapSides(m.board); // gnubg's view (board[1] = gnubg)
        // Did step k hit? (a lone opposing checker on its destination before the step)
        const hits = (k: number) => {
          const to = pairs[k][1];
          return to >= 0 && applyPairs(start, pairs.slice(0, k))[0][23 - to] === 1;
        };
        if (animate.current) {
          // Show the move one checker at a time, with a sound per checker.
          for (let k = 0; k < pairs.length; k++) {
            if (cancelled) return;
            playSound(stepSound(hits(k), pairs[k][1]));
            setAnim({ board: swapSides(applyPairs(start, pairs.slice(0, k + 1))), dice: m.dice });
            await sleep(420);
          }
        } else if (pairs.length) {
          playSound(pairs.some((_, k) => hits(k)) ? "hit" : "place");
        }
        if (cancelled) return;
        setAnim(null);
        setNotice(text ? `gnubg plays ${m.dice[0]}-${m.dice[1]}: ${text}` : `gnubg rolls ${m.dice[0]}-${m.dice[1]} and cannot move`);
        applyIfCurrent((x) => move(x, pairs, text));
      } else if (m.phase === "doubled" && responder(m) === 0) {
        // gnubg answers your double (or your beaver)
        setBusy("gnubg is considering your double");
        const a = await botAnswerDouble(engine, m, botLevel);
        if (cancelled) return;
        if (a === "take") {
          setNotice(m.beavered ? "gnubg accepts your beaver" : `gnubg takes · the cube is at ${m.cube * 2}`);
          applyIfCurrent(take);
        } else if (a === "drop") {
          applyIfCurrent(drop);
        } else {
          setNotice(`gnubg beavers · the cube would be at ${m.cube * 4}, owned by gnubg`);
          applyIfCurrent(beaver);
        }
      }
    }
    run()
      .catch((e) => {
        if (!cancelled) fail(e);
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
      setAnim(null);
    };
    // The setters are stable; `animate` is a ref read at move time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match, ready, botLevel, fail, retry, engineRef]);
}
