"use client";
// gnubg's hint: ranked moves (after a roll) or a cube analysis (before
// rolling, or when answering a double). All numbers are the engine's; this
// component only formats them.

import type { CubeAnalysis, Probabilities, RankedMove } from "@/engine/types";
import { responderAdvice } from "@/game/tutor";
import { fmtEq, pct, skillClass, SKILL_LABEL } from "@/lib/format";
import { levelLabel } from "@/lib/settings";

export type Hint =
  | { kind: "moves"; moves: RankedMove[]; preset: string }
  | { kind: "cube"; role: "doubler" | "taker"; analysis: CubeAnalysis; preset: string };

const SHOWN = 10;

export default function HintPanel({ hint, onPlay }: { hint: Hint; onPlay?: (move: string) => void }) {
  return (
    <section className="hint" aria-label="Hint" data-testid="hint-panel">
      <header className="hint-head">
        <h3>{hint.kind === "moves" ? "Best moves" : hint.role === "taker" ? "Take or pass?" : "Double or roll?"}</h3>
        <span className="badge">gnubg · {levelLabel(hint.preset as never)}</span>
      </header>
      {hint.kind === "moves" ? <MoveList moves={hint.moves} onPlay={onPlay} /> : <CubeHint hint={hint} />}
    </section>
  );
}

function MoveList({ moves, onPlay }: { moves: RankedMove[]; onPlay?: (move: string) => void }) {
  if (moves.length === 0) return <p className="empty">No legal moves.</p>;
  return (
    <>
      <ol className="hint-moves">
        {moves.slice(0, SHOWN).map((m, k) => {
          const sc = skillClass(m.diff);
          return (
            <li key={m.move} className={`hint-move ${k === 0 ? "best" : ""}`}>
              <span className="rank tnum" aria-label={`Rank ${k + 1}`}>
                {k + 1}
              </span>
              <div className="hint-main">
                <div className="hint-line">
                  <span className="mono hint-text">{m.move}</span>
                  <span className="hint-eq tnum" title="Equity (cubeful, normalised)">
                    {fmtEq(m.equity)}
                  </span>
                </div>
                <ProbBar probs={m.probs} />
                <div className="hint-line hint-sub">
                  <span className="muted tnum">
                    W {pct(m.probs.win)} · G {pct(m.probs.winGammon)} · L·G {pct(m.probs.loseGammon)}
                  </span>
                  <span className="hint-meta">
                    <span className="ply" title="Evaluated at this many plies (gnubg's move filter)">
                      {m.plies}-ply
                    </span>
                    {k > 0 && (
                      <span className={`delta delta-${sc} tnum`} title={SKILL_LABEL[sc] || "Within 0.03 of the best move"}>
                        {fmtEq(m.diff)}
                      </span>
                    )}
                  </span>
                </div>
              </div>
              {onPlay && (
                <button className="btn btn-sm btn-ghost hint-play" onClick={() => onPlay(m.move)} aria-label={`Play ${m.move}`}>
                  Play
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {moves.length > SHOWN && (
        <p className="muted small">
          {moves.length - SHOWN} more move{moves.length === SHOWN + 1 ? "" : "s"} not shown.
        </p>
      )}
      <p className="legend small">
        <span className="delta delta-doubtful">doubtful</span>
        <span className="delta delta-bad">bad</span>
        <span className="delta delta-verybad">very bad</span>
        <span className="muted">by gnubg&apos;s thresholds</span>
      </p>
    </>
  );
}

/**
 * Outcome probabilities as one stacked bar: wins (backgammon, gammon,
 * single) on the left in the accent colour, losses on the right in grey.
 */
export function ProbBar({ probs }: { probs: Probabilities }) {
  const winBg = probs.winBackgammon;
  const winG = Math.max(0, probs.winGammon - probs.winBackgammon);
  const winS = Math.max(0, probs.win - probs.winGammon);
  const loseBg = probs.loseBackgammon;
  const loseG = Math.max(0, probs.loseGammon - probs.loseBackgammon);
  const loseS = Math.max(0, 1 - probs.win - probs.loseGammon);
  const seg = (w: number, cls: string) => <span className={`pb ${cls}`} style={{ width: `${100 * w}%` }} />;
  return (
    <div
      className="probbar"
      role="img"
      aria-label={`Win ${pct(probs.win)} (gammon ${pct(probs.winGammon)}, backgammon ${pct(probs.winBackgammon)}); lose gammon ${pct(probs.loseGammon)}`}
    >
      {seg(winBg, "pb-wbg")}
      {seg(winG, "pb-wg")}
      {seg(winS, "pb-w")}
      {seg(loseS, "pb-l")}
      {seg(loseG, "pb-lg")}
      {seg(loseBg, "pb-lbg")}
    </div>
  );
}

function CubeHint({ hint }: { hint: Extract<Hint, { kind: "cube" }> }) {
  const a = hint.analysis;
  const e = a.equities;
  // Which row to highlight. gnubg's "optimal" equity is copied from the
  // doubler's proper action: no double when it equals ND; otherwise the
  // opponent's choice of take/pass (the lower of the two, doubler's side).
  const noDouble = e.optimal === e.noDouble;
  const responderTakes = e.doubleTake <= e.doublePass;
  const doublerRow = noDouble ? "nd" : responderTakes ? "dt" : "dp";
  const takerRow = responderTakes ? "dt" : "dp";
  const best = hint.role === "taker" ? takerRow : doublerRow;
  const rows: { id: "nd" | "dt" | "dp"; label: string; eq: number; mwc?: number }[] = [
    { id: "nd", label: "No double", eq: e.noDouble, mwc: a.mwc?.noDouble },
    { id: "dt", label: "Double, take", eq: e.doubleTake, mwc: a.mwc?.doubleTake },
    { id: "dp", label: "Double, pass", eq: e.doublePass, mwc: a.mwc?.doublePass },
  ];
  return (
    <div className="cube-hint">
      <p className="verdict">
        <span className="verdict-label">gnubg</span>
        <strong data-testid="cube-verdict">{hint.role === "taker" ? responderAdvice(a.recommendation) : a.recommendation}</strong>
      </p>
      {hint.role === "taker" && <p className="muted small">Verdict for the doubler: {a.recommendation}</p>}
      <table className="cube-table">
        <caption className="sr-only">Equities from the doubler&apos;s side</caption>
        <thead>
          <tr>
            <th scope="col">Doubler&apos;s equity</th>
            <th scope="col" className="num">
              Equity
            </th>
            {a.mwc && (
              <th scope="col" className="num">
                MWC
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.id === best ? "best" : ""}>
              <th scope="row">{r.label}</th>
              <td className="num tnum">{fmtEq(r.eq)}</td>
              {a.mwc && <td className="num tnum">{r.mwc !== undefined ? pct(r.mwc) : ""}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="cube-probs">
        <span className="muted small">Doubler&apos;s chances without doubling</span>
        <ProbBar probs={a.noDouble.probs} />
        <span className="muted small tnum">
          Win {pct(a.noDouble.probs.win)} · gammon {pct(a.noDouble.probs.winGammon)} · lose gammon {pct(a.noDouble.probs.loseGammon)}
        </span>
      </div>
    </div>
  );
}
