"use client";
// Temporary engine check page (Phase 3): loads the engine in a Web Worker and
// shows an evaluation. The real play/analysis UI replaces this in Phase 4.
import { useEffect, useState } from "react";
import { getEngine } from "@/engine/client";
import type { EvaluateResult, LoadProgress, RankMovesResult } from "@/engine/types";

const OPENING = "4HPwATDgc/ABMA";

export default function Home() {
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluateResult | null>(null);
  const [ranked, setRanked] = useState<RankMovesResult | null>(null);

  useEffect(() => {
    const engine = getEngine();
    engine.onProgress = setProgress;
    engine.ready
      .then(async (v) => {
        setVersion(v);
        setEvaluation(await engine.evaluate({ position: OPENING, preset: "world class" }));
        setRanked(await engine.rankMoves({ position: OPENING, dice: [3, 1], preset: "world class" }));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const pct = progress ? Math.round((100 * progress.loaded) / progress.total) : 0;
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "24px 16px" }}>
      <h1>gnubg-web</h1>
      {error && <p style={{ color: "crimson" }}>Engine error: {error}</p>}
      {!version && !error && (
        <p data-testid="loading">
          Loading engine… {pct}% {progress ? `(${progress.file})` : ""}
        </p>
      )}
      {version && <p data-testid="version">GNU Backgammon {version} ready.</p>}
      {evaluation && (
        <p data-testid="evaluation">
          Opening position, world class: win {(100 * evaluation.probs.win).toFixed(1)}%, cubeful equity{" "}
          {evaluation.cubefulEquity?.toFixed(3)}
        </p>
      )}
      {ranked && (
        <ol data-testid="moves">
          {ranked.moves.slice(0, 5).map((m) => (
            <li key={m.move}>
              {m.move} ({m.equity.toFixed(3)}, {m.plies}-ply)
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
