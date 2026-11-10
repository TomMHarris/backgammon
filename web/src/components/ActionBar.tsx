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

import { useEffect, useRef } from "react";

export type Severity = "doubtful" | "bad" | "verybad";

export interface TutorWarning {
  severity: Severity;
  title: string; // "bad move"
  loss: string; // "−0.081"
  best: string; // "gnubg prefers 13/7 8/7"
  confirmLabel: string; // "play anyway"
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

export function StatusLine({ mode, status }: { mode: Mode; status: Status }) {
  const w = mode.kind === "warning" ? mode.warning : null;
  return (
    <div className={`statusline ${w ? `warn-${w.severity}` : ""}`} aria-live="polite" data-testid="status">
      {w ? (
        <>
          <p className="status-title" role="alert" data-testid="tutor-warning-text">
            <span className="sev-word">{w.title}</span> <span className="tnum">{w.loss}</span>
          </p>
          <p className="status-detail">{w.best}</p>
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

export function ButtonRow({ mode, busy, canResign, act }: { mode: Mode; busy: boolean; canResign: boolean; act: Actions }) {
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
            <B label="roll" primary onClick={act.roll} disabled={busy} testId="roll" title="roll (R)" />
            {mode.canDouble && <B label="double" onClick={act.double} disabled={busy} testId="double" title="double (D)" />}
            {mode.canHint && <B label="hint" onClick={act.hint} disabled={busy} testId="hint" title="hint (H)" />}
          </>
        )}

        {mode.kind === "move" &&
          (mode.noMove ? (
            <B label="ok · no move" primary onClick={act.confirm} disabled={busy} testId="pass" title="Enter" />
          ) : (
            <>
              <B label="confirm" primary onClick={act.confirm} disabled={!mode.complete || busy} testId="confirm" title="confirm (Enter)" />
              <B label="undo" onClick={act.undo} disabled={!mode.canUndo || busy} testId="undo" title="undo (U)" />
              <B label="hint" onClick={act.hint} disabled={busy} testId="hint" title="hint (H)" />
              {mode.dieChoice && (
                <B
                  label={`die: ${mode.dieChoice.primary}`}
                  onClick={act.swapDie}
                  testId="swap-die"
                  title={`a click or tap moves a checker by ${mode.dieChoice.primary}, a right-click by ${mode.dieChoice.secondary}; press to swap (S)`}
                />
              )}
            </>
          ))}

        {mode.kind === "answer" && (
          <>
            <B label="take" primary onClick={act.take} disabled={busy} testId="take" title="take (T)" refEl={focusRef} />
            <B label="pass" onClick={act.pass} disabled={busy} testId="drop" title="pass (P)" />
            {mode.canBeaver && <B label="beaver" onClick={act.beaver} disabled={busy} testId="beaver" />}
            {mode.canHint && <B label="hint" onClick={act.hint} disabled={busy} testId="hint" title="hint (H)" />}
          </>
        )}

        {mode.kind === "warning" && (
          <span className="row" data-testid="tutor-warning">
            <B label="undo" primary onClick={mode.warning.onCancel} testId="tutor-undo" title="undo (U)" refEl={focusRef} />
            <B label={mode.warning.confirmLabel} onClick={mode.warning.onConfirm} testId="tutor-confirm" />
          </span>
        )}

        {mode.kind === "gameOver" && (
          <>
            <B label="next game" primary onClick={act.nextGame} testId="next-game-bar" title="next game (N)" />
            <B label="summary" onClick={act.summary} testId="show-summary" />
          </>
        )}
        {mode.kind === "matchOver" && <B label="summary" onClick={act.summary} testId="show-summary" />}
        {mode.kind === "review" && <B label="back to summary" primary onClick={act.summary} testId="back-to-summary" title="Esc" />}

        {canResign && (mode.kind === "roll" || mode.kind === "move") && (
          <B label="resign" onClick={act.resign} disabled={busy} testId="resign" />
        )}
        {mode.kind !== "warning" && mode.kind !== "answer" && mode.kind !== "review" && (
          <B label="new match" primary={mode.kind === "idle" || mode.kind === "matchOver"} onClick={act.newMatch} testId="new-match-bar" />
        )}
      </div>
    </nav>
  );
}

/** One flat button (module level, so React keeps the same element between renders). */
function B({ label, onClick, disabled, testId, primary, title, refEl }: BtnProps) {
  return (
    <button ref={refEl} className={`flat ${primary ? "flat-primary" : ""}`} onClick={onClick} disabled={disabled} data-testid={testId} title={title}>
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
}
