"use client";
// Sounds for what just happened in the match: compares each new MatchState
// with the previous one. (Checker sounds are played where checkers move:
// in Game.tsx when you enter a step, in useGnubgTurn for gnubg's move.)

import { useEffect, useRef } from "react";
import { matchWinner, type MatchState } from "@/game/match";
import { playSound } from "./sounds";

export function useMatchSounds(match: MatchState | null) {
  const prevRef = useRef<MatchState | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = match;
    if (!prev || !match || prev === match) return;
    // dice were rolled (yours, gnubg's, or an opening roll)
    if (prev.phase !== "moving" && match.phase === "moving") playSound("dice");
    // a cube action was added to the current game
    const pg = prev.record.games[prev.record.games.length - 1];
    const cg = match.record.games[match.record.games.length - 1];
    if (pg && cg && pg.number === cg.number && cg.actions.length > pg.actions.length) {
      const a = cg.actions[cg.actions.length - 1];
      if (a.type === "double" || a.type === "beaver") playSound("cube");
      else if (a.type === "take") playSound("take");
      else if (a.type === "drop") playSound("pass");
    }
    // the game (or match) is over
    if ((match.phase === "gameOver" || match.phase === "matchOver") && prev.phase !== match.phase) {
      // (two players: someone always wins)
      const won = match.settings.twoPlayer || (match.phase === "matchOver" ? matchWinner(match) === 1 : match.lastResult?.winner === 1);
      playSound(won ? "win" : "lose", 0.25);
    }
  }, [match]);
}
