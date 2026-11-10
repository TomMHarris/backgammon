"use client";
// Shows gnubg's hint: ranked moves (for a roll) or a cube analysis.
// All numbers are the engine's; this component only formats them.

import type { CubeAnalysis, RankedMove } from "@/engine/types";
import { responderAdvice } from "@/game/tutor";

export type Hint =
  | { kind: "moves"; moves: RankedMove[]; preset: string }
  | { kind: "cube"; role: "doubler" | "taker"; analysis: CubeAnalysis; preset: string };

const pct = (x: number) => (100 * x).toFixed(1) + "%";
const eq = (x: number) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(3);

export default function HintPanel({
  hint,
  onPlay,
  onClose,
}: {
  hint: Hint;
  onPlay?: (move: string) => void;
  onClose: () => void;
}) {
  return (
    <section className="panel hint" aria-label="Hint">
      <div className="panel-head">
        <h2>Hint</h2>
        <span className="muted small">gnubg, {hint.preset}</span>
        <button className="link" onClick={onClose} aria-label="Close hint">
          Close
        </button>
      </div>
      {hint.kind === "moves" ? (
        hint.moves.length === 0 ? (
          <p>No legal moves.</p>
        ) : (
          <>
            <div className="table-wrap">
            <table className="moves-table">
              <thead>
                <tr>
                  <th className="wide">#</th>
                  <th>Move</th>
                  <th className="num wide" title="Equity (cubeful, normalised)">Equity</th>
                  <th className="num" title="Difference to the best move">Diff</th>
                  <th className="num" title="Winning chances">Win</th>
                  <th className="num" title="Chances of winning a gammon">W g</th>
                  <th className="num wide" title="Chances of losing a gammon">L g</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {hint.moves.slice(0, 10).map((m, k) => (
                  <tr key={m.move}>
                    <td className="wide">{k + 1}</td>
                    <td className="mono">{m.move}</td>
                    <td className="num wide">{eq(m.equity)}</td>
                    <td className="num">{k === 0 ? "" : eq(m.diff)}</td>
                    <td className="num">{pct(m.probs.win)}</td>
                    <td className="num">{pct(m.probs.winGammon)}</td>
                    <td className="num wide">{pct(m.probs.loseGammon)}</td>
                    <td>
                      {onPlay && (
                        <button className="small-btn" onClick={() => onPlay(m.move)} aria-label={`Play ${m.move}`}>
                          Play
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {hint.moves.length > 10 && <p className="muted small">{hint.moves.length - 10} more moves not shown.</p>}
            <p className="muted small">
              Moves cut by gnubg&apos;s move filter keep their lower-ply evaluation, as in gnubg&apos;s own hint.
            </p>
          </>
        )
      ) : (
        <CubeHint hint={hint} />
      )}
    </section>
  );
}

function CubeHint({ hint }: { hint: Extract<Hint, { kind: "cube" }> }) {
  const a = hint.analysis;
  const rows: [string, number, number | undefined][] = [
    ["No double", a.equities.noDouble, a.mwc?.noDouble],
    ["Double, take", a.equities.doubleTake, a.mwc?.doubleTake],
    ["Double, pass", a.equities.doublePass, a.mwc?.doublePass],
  ];
  return (
    <div>
      <p>
        <strong>{hint.role === "taker" ? `Your answer: ${responderAdvice(a.recommendation)}` : a.recommendation}</strong>
        {hint.role === "taker" && <span className="muted"> (gnubg&apos;s verdict for the doubler: {a.recommendation})</span>}
      </p>
      <table className="moves-table">
        <thead>
          <tr>
            <th>Doubler&apos;s equity</th>
            <th className="num">Equity</th>
            {a.mwc && <th className="num">Match winning chance</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, e, m]) => (
            <tr key={label}>
              <td>{label}</td>
              <td className="num">{eq(e)}</td>
              {a.mwc && <td className="num">{m !== undefined ? pct(m) : ""}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Doubler&apos;s chances (no double): win {pct(a.noDouble.probs.win)}, win gammon {pct(a.noDouble.probs.winGammon)},
        lose gammon {pct(a.noDouble.probs.loseGammon)}.
      </p>
    </div>
  );
}
