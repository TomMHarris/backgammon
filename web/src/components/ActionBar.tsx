"use client";
// The status line and the buttons under the board. What it shows depends on
// `mode`, which Game.tsx derives from the match phase:
//   idle       no match yet                 -> New match
//   wait       gnubg is acting              -> status only
//   roll       your turn, before rolling    -> Roll (primary), Double, Hint, Resign
//   move       you are entering a move      -> Confirm (primary), Undo, Hint, Resign, die chooser
//   answer     gnubg doubled you            -> Take (primary), Pass, Beaver, Hint
//   warning    the tutor objects            -> Undo (primary), Play anyway
//   gameOver / matchOver (summary closed)  -> Next game / New match, Summary
//   review     looking at a past mistake    -> Back to summary
// The status region is aria-live, so screen readers hear each new prompt.

import { useEffect, useRef } from "react";
import Icon from "./ui/Icon";

export type Severity = "doubtful" | "bad" | "verybad";

export interface TutorWarning {
  severity: Severity;
  title: string; // "Bad move"
  loss: string; // "−0.081"
  best: string; // "gnubg prefers 13/7 8/7"
  confirmLabel: string;
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
      /** Dice still to play, distinct values; when two differ, the chooser shows which a click uses. */
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
  tone?: "neutral" | "prompt" | "alert";
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

export default function ActionBar({ mode, status, busy, canResign, act }: { mode: Mode; status: Status; busy: boolean; canResign: boolean; act: Actions }) {
  // Move keyboard focus to the main button of a prompt (cube offer, tutor).
  const focusRef = useRef<HTMLButtonElement>(null);
  const focusKey = mode.kind === "answer" || mode.kind === "warning" ? mode.kind : null;
  useEffect(() => {
    if (focusKey) focusRef.current?.focus({ preventScroll: true });
  }, [focusKey]);

  const tone = mode.kind === "warning" ? `warn-${mode.warning.severity}` : mode.kind === "answer" ? "prompt" : status.tone ?? "neutral";

  return (
    <div className={`dock tone-${tone}`} data-testid="actions">
      <div className="status" aria-live="polite" data-testid="status">
        {mode.kind === "warning" ? (
          <div className="tutor" role="alert" data-testid="tutor-warning-text">
            <span className={`sev sev-${mode.warning.severity}`}>{mode.warning.title}</span>
            <span className="status-title">
              <span className="tnum">{mode.warning.loss}</span> · {mode.warning.best}
            </span>
          </div>
        ) : (
          <>
            <span className="status-title">
              {status.busy && <span className="spinner" aria-hidden="true" />}
              {status.title}
            </span>
            {status.detail && (
              <span className="status-detail" data-testid="notice">
                {status.detail}
              </span>
            )}
          </>
        )}
      </div>

      <div className="buttons" role="group" aria-label="Actions">
        {mode.kind === "idle" && (
          <button className="btn btn-primary btn-lg" onClick={act.newMatch} data-testid="new-match">
            New match
          </button>
        )}

        {mode.kind === "roll" && (
          <>
            {canResign && <Secondary icon="flag" label="Resign" onClick={act.resign} disabled={busy} testId="resign" ghost />}
            {mode.canHint && <Secondary icon="bulb" label="Hint" kbd="H" onClick={act.hint} disabled={busy} testId="hint" />}
            {mode.canDouble && <Secondary icon="cube" label="Double" kbd="D" onClick={act.double} disabled={busy} testId="double" />}
            <Primary icon="dice" label="Roll" kbd="R" onClick={act.roll} disabled={busy} testId="roll" />
          </>
        )}

        {mode.kind === "move" && (
          <>
            {mode.dieChoice && (
              <button
                className="die-chooser"
                onClick={act.swapDie}
                title={`Click or tap moves a checker by ${mode.dieChoice.primary}; right-click by ${mode.dieChoice.secondary}. Press to swap (S).`}
                aria-label={`Click uses the ${mode.dieChoice.primary}. Swap to the ${mode.dieChoice.secondary}`}
                data-testid="swap-die"
              >
                <DieGlyph value={mode.dieChoice.primary} />
                <Icon name="swap" size={14} className="die-swap" />
                <DieGlyph value={mode.dieChoice.secondary} muted />
              </button>
            )}
            {canResign && <Secondary icon="flag" label="Resign" onClick={act.resign} disabled={busy} testId="resign" ghost />}
            {!mode.noMove && <Secondary icon="bulb" label="Hint" kbd="H" onClick={act.hint} disabled={busy} testId="hint" />}
            {!mode.noMove && <Secondary icon="undo" label="Undo" kbd="U" onClick={act.undo} disabled={!mode.canUndo || busy} testId="undo" />}
            {mode.noMove ? (
              <Primary icon="check" label="OK" kbd="Enter" onClick={act.confirm} disabled={busy} testId="pass" />
            ) : (
              <Primary icon="check" label="Confirm" kbd="Enter" onClick={act.confirm} disabled={!mode.complete || busy} testId="confirm" />
            )}
          </>
        )}

        {mode.kind === "answer" && (
          <>
            {mode.canHint && <Secondary icon="bulb" label="Hint" kbd="H" onClick={act.hint} disabled={busy} testId="hint" />}
            {mode.canBeaver && <Secondary label="Beaver" onClick={act.beaver} disabled={busy} testId="beaver" big />}
            <Secondary label="Pass" kbd="P" onClick={act.pass} disabled={busy} testId="drop" big />
            <Primary label="Take" kbd="T" onClick={act.take} disabled={busy} testId="take" refEl={focusRef} />
          </>
        )}

        {mode.kind === "warning" && (
          <div className="tutor-buttons" data-testid="tutor-warning">
            <button className="btn btn-secondary btn-lg" onClick={mode.warning.onConfirm} data-testid="tutor-confirm">
              {mode.warning.confirmLabel}
            </button>
            <button ref={focusRef} className="btn btn-primary btn-lg" onClick={mode.warning.onCancel} data-testid="tutor-undo">
              <Icon name="undo" size={18} />
              Undo
            </button>
          </div>
        )}

        {(mode.kind === "gameOver" || mode.kind === "matchOver") && (
          <>
            <Secondary icon="chart" label="Summary" onClick={act.summary} testId="show-summary" />
            {mode.kind === "gameOver" ? (
              <Primary label="Next game" kbd="N" onClick={act.nextGame} testId="next-game-bar" />
            ) : (
              <Primary label="New match" onClick={act.newMatch} testId="new-match-bar" />
            )}
          </>
        )}

        {mode.kind === "review" && <Primary icon="arrowLeft" label="Back to summary" onClick={act.summary} testId="back-to-summary" />}
      </div>
    </div>
  );
}

function Primary({
  icon,
  label,
  kbd,
  onClick,
  disabled,
  testId,
  refEl,
}: {
  icon?: Parameters<typeof Icon>[0]["name"];
  label: string;
  kbd?: string;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
  refEl?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button ref={refEl} className="btn btn-primary btn-lg btn-main" onClick={onClick} disabled={disabled} data-testid={testId} title={kbd ? `${label} (${kbd})` : undefined}>
      {icon && <Icon name={icon} size={20} />}
      {label}
    </button>
  );
}

function Secondary({
  icon,
  label,
  kbd,
  onClick,
  disabled,
  testId,
  ghost,
  big,
}: {
  icon?: Parameters<typeof Icon>[0]["name"];
  label: string;
  kbd?: string;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
  ghost?: boolean;
  big?: boolean;
}) {
  return (
    <button
      className={`btn ${ghost ? "btn-ghost" : "btn-secondary"} ${big ? "btn-lg" : "btn-tool"}`}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      title={kbd ? `${label} (${kbd})` : label}
      aria-label={label}
    >
      {icon && <Icon name={icon} size={18} />}
      <span className="btn-label">{label}</span>
    </button>
  );
}

/** A small die face, for the die chooser. */
export function DieGlyph({ value, muted }: { value: number; muted?: boolean }) {
  const spots: Record<number, [number, number][]> = {
    1: [[12, 12]],
    2: [[7.5, 7.5], [16.5, 16.5]],
    3: [[7, 7], [12, 12], [17, 17]],
    4: [[7.5, 7.5], [16.5, 7.5], [7.5, 16.5], [16.5, 16.5]],
    5: [[7, 7], [17, 7], [12, 12], [7, 17], [17, 17]],
    6: [[7.5, 6.5], [16.5, 6.5], [7.5, 12], [16.5, 12], [7.5, 17.5], [16.5, 17.5]],
  };
  return (
    <svg className={`dieglyph ${muted ? "muted" : ""}`} viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="5" />
      {(spots[value] ?? []).map(([x, y], k) => (
        <circle key={k} cx={x} cy={y} r="2.1" />
      ))}
    </svg>
  );
}
