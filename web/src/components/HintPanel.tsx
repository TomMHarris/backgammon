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
                  <Outcome probs={m.probs} plies={m.plies} />
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

/** One decimal, no % sign (the column says it): 52.1 */
const p1 = (x: number) => (100 * Math.max(0, x)).toFixed(1);

/**
 * The six outcomes of a position, from gnubg's cumulative probabilities
 * (a win includes gammons, a gammon includes backgammons): single, gammon
 * and backgammon wins and losses, adding up to 1.
 */
export function outcomes(pr: Probabilities) {
  const lose = Math.max(0, 1 - pr.win);
  return {
    win: pr.win,
    lose,
    winS: Math.max(0, pr.win - pr.winGammon),
    winG: Math.max(0, pr.winGammon - pr.winBackgammon),
    winBg: Math.max(0, pr.winBackgammon),
    loseS: Math.max(0, lose - pr.loseGammon),
    loseG: Math.max(0, pr.loseGammon - pr.loseBackgammon),
    loseBg: Math.max(0, pr.loseBackgammon),
  };
}

/**
 * Outcome probabilities as one stacked bar over the whole 0-100%: wins on
 * the left in the tone of the winner's checkers (ivory: you), losses on the
 * right in the opponent's (walnut), gammons and backgammons in deeper
 * shades of each, with a divider at the win / lose boundary.
 * Order: win bg | win g | win single || lose single | lose g | lose bg.
 */
export function ProbBar({ probs }: { probs: Probabilities }) {
  const o = outcomes(probs);
  const seg = (w: number, cls: string, label: string) =>
    w > 0 ? <span className={`pb ${cls}`} style={{ width: `${100 * w}%` }} title={`${label} ${p1(w)}%`} /> : null;
  return (
    <span
      className="probbar"
      role="img"
      aria-label={`Win ${pct(probs.win)} (gammon ${pct(probs.winGammon)}, backgammon ${pct(probs.winBackgammon)}); lose ${pct(o.lose)} (gammon ${pct(probs.loseGammon)}, backgammon ${pct(probs.loseBackgammon)})`}
    >
      {seg(o.winBg, "pb-wbg", "Win a backgammon")}
      {seg(o.winG, "pb-wg", "Win a gammon")}
      {seg(o.winS, "pb-w", "Win a single game")}
      <span className="pb-div" aria-hidden="true" />
      {seg(o.loseS, "pb-l", "Lose a single game")}
      {seg(o.loseG, "pb-lg", "Lose a gammon")}
      {seg(o.loseBg, "pb-lbg", "Lose a backgammon")}
    </span>
  );
}

/**
 * The bar plus the numbers: "W 52.1 (g 15.0, bg 0.8)  L 47.9 (g 12.5, bg 0.5)".
 * W and L are totals (L = 100 − W); g and bg are the parts of each that are
 * gammons and backgammons (cumulative, as gnubg counts them).
 */
export function Outcome({ probs, plies }: { probs: Probabilities; plies?: number }) {
  const o = outcomes(probs);
  return (
    <span className="outcome">
      <ProbBar probs={probs} />
      <span className="outcome-nums num" title={plies !== undefined ? `Evaluated at ${plies}-ply` : undefined}>
        <span className="oc-side">
          <span className="oc-key oc-key-w" aria-hidden="true" />
          <span className="oc-total">W {p1(o.win)}</span>
          <span className="oc-sub">
            (g {p1(probs.winGammon)}, bg {p1(probs.winBackgammon)})
          </span>
        </span>
        <span className="oc-side">
          <span className="oc-key oc-key-l" aria-hidden="true" />
          <span className="oc-total">L {p1(o.lose)}</span>
          <span className="oc-sub">
            (g {p1(probs.loseGammon)}, bg {p1(probs.loseBackgammon)})
          </span>
        </span>
      </span>
    </span>
  );
}

/** What the outcome numbers and the bar mean. */
function OutcomeLegend() {
  return (
    <div className="oc-legend small">
      <p>
        <strong>W</strong> win, <strong>L</strong> lose, in % (L = 100 − W). In brackets: how much of it is a gammon (<strong>g</strong>, including
        backgammons) and a backgammon (<strong>bg</strong>).
      </p>
      <p className="oc-legend-bar" aria-hidden="true">
        <span className="pb pb-wbg" />
        <span className="pb pb-wg" />
        <span className="pb pb-w" />
        <span>win: bg · g · single</span>
        <span className="pb-div" />
        <span className="pb pb-l" />
        <span className="pb pb-lg" />
        <span className="pb pb-lbg" />
        <span>lose: single · g · bg</span>
      </p>
    </div>
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
        <Outcome probs={hint.role === "taker" ? swapSides(a.noDouble.probs) : a.noDouble.probs} />
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
