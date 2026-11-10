"use client";
// The status line under the board and the row of buttons at the bottom of
// the page. Only what applies now is shown. `mode` comes from Game.tsx:
//   idle       no match yet                 -> new match
//   wait       gnubg is acting              -> (nothing but "new match")
//   roll       your turn, before rolling    -> roll, double, hint, resign
//   move       you are entering a move      -> confirm, undo, hint, die: N, resign
//   answer     gnubg doubled you            -> take, pass, beaver, hint
//   warning    the tutor objects            -> undo, play anyway
//   gameOver / matchOver (summary closed)  -> next game / new match, summary
//   review     looking at a past mistake    -> back to summary
// The status line is aria-live, so screen readers hear each new prompt.
// When a cube hint is shown, the button for gnubg's choice is marked
// (`suggest`). In a tutor warning, gnubg's better move can be previewed on
// the board: hover or focus it, or tap it to keep it shown.

import { useEffect, useRef } from "react";

export type Severity = "doubtful" | "bad" | "verybad";

export interface TutorWarning {
  severity: Severity;
  title: string; // "Bad move"
  loss: string; // "−0.081"
  best: string; // "gnubg prefers 13/7 8/7" (cube: "gnubg: Double, take")
  bestMove?: string; // the better move ("13/7 8/7"), when it can be previewed
  confirmLabel: string; // "Play anyway"
  onConfirm: () => void;
  onCancel: () => void;
}

export type Mode =
  | { kind: "idle" }
  | { kind: "wait" }
  | { kind: "roll"; canDouble: boolean; canHint: boolean }
  | {
      kind: "move";
      noMove: boolean;
      complete: boolean;
      canUndo: boolean;
      /** When two different dice are left: the die a click (or tap) uses, and the one a right-click uses. */
      dieChoice: { primary: number; secondary: number } | null;
    }
  | { kind: "answer"; canBeaver: boolean; canHint: boolean }
  | { kind: "warning"; warning: TutorWarning }
  | { kind: "gameOver" }
  | { kind: "matchOver" }
  | { kind: "review" };

export interface Status {
  title: string;
  detail?: string | null;
  busy?: boolean;
}

export interface Actions {
  roll: () => void;
  double: () => void;
  confirm: () => void;
  undo: () => void;
  hint: () => void;
  resign: () => void;
  take: () => void;
  pass: () => void;
  beaver: () => void;
  nextGame: () => void;
  newMatch: () => void;
  summary: () => void;
  swapDie: () => void;
}

export interface WarningPreview {
  pinned: boolean;
  onHover: (on: boolean) => void;
  onPin: (on: boolean) => void;
}

export function StatusLine({ mode, status, preview }: { mode: Mode; status: Status; preview?: WarningPreview }) {
  const w = mode.kind === "warning" ? mode.warning : null;
  return (
    <div className={`statusline ${w ? `warn-${w.severity}` : ""}`} aria-live="polite" data-testid="status">
      {w ? (
        <>
          <p className="status-title" role="alert" data-testid="tutor-warning-text">
            <span className="sev-word">{w.title}</span> <span className="tnum">{w.loss}</span>
          </p>
          {w.bestMove && preview ? (
            <p className="status-detail status-detail-pv">
              gnubg prefers{" "}
              <button
                className={`pv-link num ${preview.pinned ? "on" : ""}`}
                aria-pressed={preview.pinned}
                title="Show gnubg's move on the board"
                onPointerEnter={(e) => e.pointerType === "mouse" && preview.onHover(true)}
                onPointerLeave={(e) => e.pointerType === "mouse" && preview.onHover(false)}
                onFocus={(e) => {
                  if (e.currentTarget.matches(":focus-visible")) preview.onHover(true);
                }}
                onBlur={() => preview.onHover(false)}
                onClick={() => preview.onPin(!preview.pinned)}
                data-testid="tutor-best"
              >
                {w.bestMove}
                <span className="pv-link-hint">{preview.pinned ? "hide" : "show"}</span>
              </button>
            </p>
          ) : (
            <p className="status-detail">{w.best}</p>
          )}
        </>
      ) : (
        <>
          <p className="status-title">
            {status.title}
            {status.busy && <span className="dots" aria-hidden="true" />}
          </p>
          <p className="status-detail" data-testid="notice">
            {status.detail ?? " "}
          </p>
        </>
      )}
    </div>
  );
}

export function ButtonRow({
  mode,
  busy,
  canResign,
  act,
  suggest,
}: {
  mode: Mode;
  busy: boolean;
  canResign: boolean;
  act: Actions;
  suggest?: "roll" | "double" | "take" | "pass" | null; // gnubg's choice in a cube hint
}) {
  const sg = (a: string) => (suggest === a ? true : undefined);
  // Move keyboard focus to the main button of a prompt (cube offer, tutor).
  const focusRef = useRef<HTMLButtonElement>(null);
  const focusKey = mode.kind === "answer" || mode.kind === "warning" ? mode.kind : null;
  useEffect(() => {
    if (focusKey) focusRef.current?.focus({ preventScroll: true });
  }, [focusKey]);

  return (
    <nav className="bottombar" aria-label="actions" data-testid="actions">
      <div className="row">
        {mode.kind === "roll" && (
          <>
            <B label="Roll" primary onClick={act.roll} disabled={busy} testId="roll" title="Roll (R)" suggest={sg("roll")} />
            {mode.canDouble && <B label="Double" onClick={act.double} disabled={busy} testId="double" title="Double (D)" suggest={sg("double")} />}
            {mode.canHint && <B label="Hint" onClick={act.hint} disabled={busy} testId="hint" title="Hint (H)" />}
          </>
        )}

        {mode.kind === "move" &&
          (mode.noMove ? (
            <B label="No move · OK" primary onClick={act.confirm} disabled={busy} testId="pass" title="Enter" />
          ) : (
            <>
              <B label="Confirm" primary onClick={act.confirm} disabled={!mode.complete || busy} testId="confirm" title="Confirm (Enter)" />
              <B label="Undo" onClick={act.undo} disabled={!mode.canUndo || busy} testId="undo" title="Undo (U)" />
              <B label="Hint" onClick={act.hint} disabled={busy} testId="hint" title="Hint (H)" />
              {mode.dieChoice && (
                <B
                  label={`Die ${mode.dieChoice.primary}`}
                  onClick={act.swapDie}
                  testId="swap-die"
                  title={`A click or tap moves a checker by ${mode.dieChoice.primary}, a right-click by ${mode.dieChoice.secondary}; press to swap (S)`}
                />
              )}
            </>
          ))}

        {mode.kind === "answer" && (
          <>
            <B label="Take" primary onClick={act.take} disabled={busy} testId="take" title="Take (T)" refEl={focusRef} suggest={sg("take")} />
            <B label="Pass" onClick={act.pass} disabled={busy} testId="drop" title="Pass (P)" suggest={sg("pass")} />
            {mode.canBeaver && <B label="Beaver" onClick={act.beaver} disabled={busy} testId="beaver" />}
            {mode.canHint && <B label="Hint" onClick={act.hint} disabled={busy} testId="hint" title="Hint (H)" />}
          </>
        )}

        {mode.kind === "warning" && (
          <span className="row" data-testid="tutor-warning">
            <B label="Undo" primary onClick={mode.warning.onCancel} testId="tutor-undo" title="Undo (U)" refEl={focusRef} />
            <B label={mode.warning.confirmLabel} onClick={mode.warning.onConfirm} testId="tutor-confirm" />
          </span>
        )}

        {mode.kind === "gameOver" && (
          <>
            <B label="Next game" primary onClick={act.nextGame} testId="next-game-bar" title="Next game (N)" />
            <B label="Summary" onClick={act.summary} testId="show-summary" />
          </>
        )}
        {mode.kind === "matchOver" && <B label="Summary" onClick={act.summary} testId="show-summary" />}
        {mode.kind === "review" && <B label="Back to summary" primary onClick={act.summary} testId="back-to-summary" title="Esc" />}

        {canResign && (mode.kind === "roll" || mode.kind === "move") && (
          <B label="Resign" onClick={act.resign} disabled={busy} testId="resign" />
        )}
        {mode.kind !== "warning" && mode.kind !== "answer" && mode.kind !== "review" && (
          <B label="New match" primary={mode.kind === "idle" || mode.kind === "matchOver"} onClick={act.newMatch} testId="new-match-bar" />
        )}
      </div>
    </nav>
  );
}

/** One flat button (module level, so React keeps the same element between renders). */
function B({ label, onClick, disabled, testId, primary, title, refEl, suggest }: BtnProps) {
  return (
    <button
      ref={refEl}
      className={`flat ${primary ? "flat-primary" : ""} ${suggest ? "flat-suggest" : ""}`}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      data-suggested={suggest ? "true" : undefined}
      title={suggest ? `${title ?? label} · gnubg's choice` : title}
    >
      {label}
    </button>
  );
}

interface BtnProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
  primary?: boolean;
  title?: string;
  refEl?: React.Ref<HTMLButtonElement>;
  suggest?: boolean; // gnubg's choice (cube hint)
}
