"use client";
// gnubg's hint: ranked moves (after a roll) or a cube analysis (before
// rolling, or when answering a double). All numbers are the engine's; this
// component only formats them.
//
// Moves can be previewed on the board: hovering a row (mouse) or focusing it
// with the keyboard shows that move while the pointer / focus stays there; a
// click or tap on the row pins the preview (the best move is pinned when the
// hint arrives). "Play" enters the move. The parent (Game.tsx) owns the
// preview state and draws it on the board.

import type { CubeAnalysis, Probabilities, RankedMove } from "@/engine/types";
import OutcomeBar, { OutcomeLegend } from "./OutcomeBar";
import { responderAdvice } from "@/game/tutor";
import { fmtEq, pct, skillClass, SKILL_LABEL } from "@/lib/format";
import { levelLabel } from "@/lib/settings";

export type Hint =
  | { kind: "moves"; moves: RankedMove[]; preset: string }
  | { kind: "cube"; role: "doubler" | "taker"; analysis: CubeAnalysis; preset: string };

/** The action gnubg recommends in a cube hint. */
export type CubeAction = "roll" | "double" | "take" | "pass";

const SHOWN = 10;

/**
 * gnubg's choice in a cube hint. gnubg's "optimal" equity is copied from the
 * doubler's proper action: no double when it equals ND (this includes "too
 * good to double"); otherwise the responder's choice of take / pass (the
 * lower of the two, from the doubler's side).
 */
export function cubeChoice(hint: Extract<Hint, { kind: "cube" }>): { row: "nd" | "dt" | "dp"; action: CubeAction } {
  const e = hint.analysis.equities;
  const noDouble = e.optimal === e.noDouble;
  const responderTakes = e.doubleTake <= e.doublePass;
  if (hint.role === "taker") return responderTakes ? { row: "dt", action: "take" } : { row: "dp", action: "pass" };
  if (noDouble) return { row: "nd", action: "roll" };
  return { row: responderTakes ? "dt" : "dp", action: "double" };
}

const ACTION_LABEL: Record<CubeAction, string> = { roll: "Roll", double: "Double", take: "Take", pass: "Pass" };

export interface PreviewControl {
  active: string | null; // the move shown on the board
  pinned: string | null; // the move pinned by a click / tap
  onHover: (move: string | null) => void;
  onPin: (move: string | null) => void;
}

export default function HintPanel({
  hint,
  onPlay,
  preview,
  onCubeAction,
}: {
  hint: Hint;
  onPlay?: (move: string) => void;
  preview?: PreviewControl;
  onCubeAction?: (a: CubeAction) => void;
}) {
  return (
    <section className="hint" aria-label="Hint" data-testid="hint-panel">
      <header className="hint-head">
        <h3>{hint.kind === "moves" ? "Best moves" : hint.role === "taker" ? "Take or pass?" : "Double or roll?"}</h3>
        <span className="badge">gnubg · {levelLabel(hint.preset as never)}</span>
      </header>
      {hint.kind === "moves" ? (
        <MoveList moves={hint.moves} onPlay={onPlay} preview={preview} />
      ) : (
        <CubeHint hint={hint} onAction={onCubeAction} />
      )}
    </section>
  );
}

function MoveList({ moves, onPlay, preview }: { moves: RankedMove[]; onPlay?: (move: string) => void; preview?: PreviewControl }) {
  if (moves.length === 0) return <p className="empty">No legal moves.</p>;
  return (
    <>
      {preview && <p className="hint-tip">Hover or tap a move to see it on the board.</p>}
      <ol className="hint-moves">
        {moves.slice(0, SHOWN).map((m, k) => {
          const sc = skillClass(m.diff);
          const on = preview?.active === m.move;
          return (
            <li
              key={m.move}
              className={`hint-move ${k === 0 ? "best" : ""} ${on ? "on" : ""}`}
              onPointerEnter={(e) => e.pointerType === "mouse" && preview?.onHover(m.move)}
              onPointerLeave={(e) => e.pointerType === "mouse" && preview?.onHover(null)}
              data-testid="hint-move"
            >
              <button
                className="hint-pick"
                aria-pressed={preview ? preview.pinned === m.move : undefined}
                aria-label={`${m.move}: equity ${fmtEq(m.equity)}${k > 0 ? `, ${fmtEq(m.diff)} against the best` : ""}. Show on the board`}
                disabled={!preview}
                onClick={() => preview?.onPin(preview.pinned === m.move ? null : m.move)}
                onFocus={(e) => {
                  if (e.currentTarget.matches(":focus-visible")) preview?.onHover(m.move);
                }}
                onBlur={() => preview?.onHover(null)}
              >
                <span className="rank num">{k + 1}</span>
                <span className="hint-text num">{m.move}</span>
                <span className="hint-eq num" title="Equity (cubeful, normalised)">
                  {fmtEq(m.equity)}
                </span>
                <span className={`hint-diff num delta delta-${sc}`} title={k > 0 ? SKILL_LABEL[sc] || "Within 0.03 of the best move" : undefined}>
                  {k > 0 ? fmtEq(m.diff) : ""}
                </span>
                <span className="hint-outcome">
                  <OutcomeBar probs={m.probs} who={`After ${m.move}`} />
                </span>
              </button>
              {onPlay && (
                <button className="flat flat-sm hint-play" onClick={() => onPlay(m.move)} aria-label={`Play ${m.move}`}>
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
      <OutcomeLegend />
      <p className="legend small">
        <span>Loss against the best move:</span>
        <span className="legend-sev">
          <span className="delta delta-doubtful">doubtful</span>
          <span className="delta delta-bad">bad</span>
          <span className="delta delta-verybad">very bad</span>
        </span>
      </p>
    </>
  );
}

function CubeHint({ hint, onAction }: { hint: Extract<Hint, { kind: "cube" }>; onAction?: (a: CubeAction) => void }) {
  const a = hint.analysis;
  const e = a.equities;
  const { row: best, action } = cubeChoice(hint);
  const rows: { id: "nd" | "dt" | "dp"; label: string; eq: number; mwc?: number }[] = [
    { id: "nd", label: "No double", eq: e.noDouble, mwc: a.mwc?.noDouble },
    { id: "dt", label: "Double, take", eq: e.doubleTake, mwc: a.mwc?.doubleTake },
    { id: "dp", label: "Double, pass", eq: e.doublePass, mwc: a.mwc?.doublePass },
  ];
  return (
    <div className="cube-hint">
      <div className="verdict">
        <div className="verdict-text">
          <span className="verdict-label">gnubg recommends</span>
          <strong data-testid="cube-verdict">{hint.role === "taker" ? responderAdvice(a.recommendation) : a.recommendation}</strong>
          {hint.role === "taker" && <span className="verdict-sub">For the doubler: {a.recommendation}</span>}
        </div>
        {onAction && (
          <button className="flat flat-sm flat-suggest" onClick={() => onAction(action)} data-testid="cube-hint-action">
            {ACTION_LABEL[action]}
          </button>
        )}
      </div>
      <table className="cube-table">
        <caption className="sr-only">Equities from the doubler&apos;s side</caption>
        <thead>
          <tr>
            <th scope="col">Doubler&apos;s equity</th>
            <th scope="col" className="num-col">
              Equity
            </th>
            {a.mwc && (
              <th scope="col" className="num-col">
                MWC
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.id === best ? "best" : ""} aria-current={r.id === best ? "true" : undefined}>
              <th scope="row">
                {r.label}
                {r.id === best && <span className="best-tag">best</span>}
              </th>
              <td className="num-col num">{fmtEq(r.eq)}</td>
              {a.mwc && <td className="num-col num">{r.mwc !== undefined ? pct(r.mwc) : ""}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="cube-probs">
        <span className="muted small">Your chances (cubeless, before the double)</span>
        <OutcomeBar probs={hint.role === "taker" ? swapSides(a.noDouble.probs) : a.noDouble.probs} who="You" />
      </div>
    </div>
  );
}

/** The same probabilities seen from the other side (the doubler's chances as the taker's). */
function swapSides(pr: Probabilities): Probabilities {
  return {
    ...pr,
    win: 1 - pr.win,
    winGammon: pr.loseGammon,
    winBackgammon: pr.loseBackgammon,
    loseGammon: pr.winGammon,
    loseBackgammon: pr.winBackgammon,
  };
}
