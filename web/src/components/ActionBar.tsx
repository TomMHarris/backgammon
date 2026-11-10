"use client";
// The status line under the board and the row of buttons at the bottom of
// the page. Only what applies now is shown. `mode` comes from Game.tsx
// (primary button | secondary buttons | in the ⋯ menu):
//   idle       no match yet                 -> New match
//   wait       gnubg is acting              -> (primary slot kept empty) | | New match
//   roll       your turn, before rolling    -> Roll | Double | Resign, New match
//   move       you are entering a move      -> Confirm | Undo, Die N (touch) | swap die, Resign, New match
//   answer     gnubg doubled you            -> Take | Pass | Beaver
//   warning    the tutor objects            -> Undo | Play anyway
//   gameOver / matchOver (summary closed)  -> Next game / New match | Summary
//   review     looking at a past mistake    -> Back to summary
// plus a Hint icon button and the menu (also Download .mat) at the right.
// The status line is aria-live, so screen readers hear each new prompt.
// When a cube hint is shown, the button for gnubg's choice is marked
// (`suggest`). In a tutor warning, gnubg's better move can be previewed on
// the board: hover or focus it, or tap it to keep it shown.

import { useEffect, useRef, useState } from "react";
import Icon from "./ui/Icon";

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
  download?: () => void; // save the match as .mat (when there is one)
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

/**
 * The bottom row, in three fixed parts so nothing ever moves the main button:
 *   [ secondary actions ]  [ PRIMARY ]  [ hint · ⋯ menu ]
 * The middle column has a fixed width and the outer columns share the rest
 * equally, so the primary button (Roll, Confirm, Take, Next game, ...) is
 * always in exactly the same place and can be clicked again and again.
 * While nothing is to be done (gnubg's turn) its slot stays reserved.
 * At most two secondary buttons; rarely used actions (resign, new match,
 * swapping the die on a desktop, download .mat, beaver) live in the menu.
 */
export function ButtonRow({
  mode,
  busy,
  canResign,
  canHint,
  act,
  suggest,
}: {
  mode: Mode;
  busy: boolean;
  canResign: boolean;
  canHint: boolean; // a hint can be asked for now
  act: Actions;
  suggest?: "roll" | "double" | "take" | "pass" | null; // gnubg's choice in a cube hint
}) {
  // Move keyboard focus to the main button of a prompt (cube offer, tutor).
  const focusRef = useRef<HTMLButtonElement>(null);
  const focusKey = mode.kind === "answer" || mode.kind === "warning" ? mode.kind : null;
  useEffect(() => {
    if (focusKey) focusRef.current?.focus({ preventScroll: true });
  }, [focusKey]);
  const sg = (a: string) => (suggest === a ? true : undefined);

  let primary: React.ReactNode = null;
  const secondary: React.ReactNode[] = [];
  const menu: MenuItem[] = [];

  switch (mode.kind) {
    case "idle":
      primary = <B label="New match" primary onClick={act.newMatch} testId="new-match-bar" />;
      break;
    case "roll":
      primary = <B label="Roll" primary onClick={act.roll} disabled={busy} testId="roll" title="Roll (R)" suggest={sg("roll")} />;
      if (mode.canDouble)
        secondary.push(<B key="d" label="Double" onClick={act.double} disabled={busy} testId="double" title="Double (D)" suggest={sg("double")} />);
      break;
    case "move":
      if (mode.noMove) primary = <B label="No move · OK" primary onClick={act.confirm} disabled={busy} testId="pass" title="Enter" />;
      else {
        primary = <B label="Confirm" primary onClick={act.confirm} disabled={!mode.complete || busy} testId="confirm" title="Confirm (Enter)" />;
        secondary.push(<B key="u" label="Undo" onClick={act.undo} disabled={!mode.canUndo || busy} testId="undo" title="Undo (U)" />);
        if (mode.dieChoice) {
          const title = `A click or tap moves a checker by ${mode.dieChoice.primary}, a right-click by ${mode.dieChoice.secondary}; press to swap (S)`;
          // on touch screens (no right-click) the swap is a button; elsewhere it is in the menu
          secondary.push(<B key="s" label={`Die ${mode.dieChoice.primary}`} onClick={act.swapDie} testId="swap-die" title={title} className="touch-only" />);
          menu.push({ label: `Click uses die ${mode.dieChoice.primary} · swap`, onClick: act.swapDie, testId: "swap-die-menu", hint: "S", className: "pointer-only" });
        }
      }
      break;
    case "answer":
      primary = <B label="Take" primary onClick={act.take} disabled={busy} testId="take" title="Take (T)" refEl={focusRef} suggest={sg("take")} />;
      secondary.push(<B key="p" label="Pass" onClick={act.pass} disabled={busy} testId="drop" title="Pass (P)" suggest={sg("pass")} />);
      if (mode.canBeaver) menu.push({ label: "Beaver", onClick: act.beaver, testId: "beaver" });
      break;
    case "warning":
      primary = <B label="Undo" primary onClick={mode.warning.onCancel} testId="tutor-undo" title="Undo (U)" refEl={focusRef} />;
      secondary.push(<B key="c" label={mode.warning.confirmLabel} onClick={mode.warning.onConfirm} testId="tutor-confirm" />);
      break;
    case "gameOver":
      primary = <B label="Next game" primary onClick={act.nextGame} testId="next-game-bar" title="Next game (N)" />;
      secondary.push(<B key="s" label="Summary" onClick={act.summary} testId="show-summary" />);
      break;
    case "matchOver":
      primary = <B label="New match" primary onClick={act.newMatch} testId="new-match-bar" />;
      secondary.push(<B key="s" label="Summary" onClick={act.summary} testId="show-summary" />);
      break;
    case "review":
      primary = <B label="Back to summary" primary onClick={act.summary} testId="back-to-summary" title="Esc" />;
      break;
  }
  if (canResign && (mode.kind === "roll" || mode.kind === "move")) menu.push({ label: "Resign…", onClick: act.resign, testId: "resign", disabled: busy });
  if (act.download) menu.push({ label: "Download .mat", onClick: act.download, testId: "download-mat-menu" });
  if (mode.kind !== "idle" && mode.kind !== "matchOver" && mode.kind !== "warning" && mode.kind !== "answer" && mode.kind !== "review")
    menu.push({ label: "New match…", onClick: act.newMatch, testId: "new-match-bar" });

  return (
    <nav className="bottombar" aria-label="Actions" data-testid="actions">
      <div className="actions-grid">
        <div className="actions-secondary">{secondary}</div>
        <div className="actions-primary" data-testid="primary-slot">
          {primary}
        </div>
        <div className="actions-tools">
          <button
            className="round round-lg"
            onClick={act.hint}
            disabled={!canHint || busy}
            aria-label="Hint"
            title="Hint (H)"
            data-testid="hint"
          >
            <Icon name="bulb" size={18} />
          </button>
          <Menu items={menu} />
        </div>
      </div>
    </nav>
  );
}

interface MenuItem {
  label: string;
  onClick: () => void;
  testId: string;
  disabled?: boolean;
  hint?: string; // keyboard shortcut
  className?: string;
}

/** A quiet "⋯" button opening a small menu above it (Esc or a click outside closes it). */
function Menu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        ref.current?.querySelector<HTMLButtonElement>(".menu-button")?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button
        className={`round round-lg menu-button ${open ? "pressed" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        title="More actions"
        disabled={!items.length}
        onClick={() => setOpen((o) => !o)}
        data-testid="more-menu"
      >
        <Icon name="more" size={18} />
      </button>
      {open && (
        <div className="menu-pop" role="menu" aria-label="More actions">
          {items.map((it) => (
            <button
              key={it.testId}
              role="menuitem"
              className={`menu-item ${it.className ?? ""}`}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
              data-testid={it.testId}
            >
              <span>{it.label}</span>
              {it.hint && <kbd>{it.hint}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** One flat button (module level, so React keeps the same element between renders). */
function B({ label, onClick, disabled, testId, primary, title, refEl, suggest, className }: BtnProps) {
  return (
    <button
      ref={refEl}
      className={`flat ${primary ? "flat-primary" : ""} ${suggest ? "flat-suggest" : ""} ${className ?? ""}`}
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
  className?: string;
}
