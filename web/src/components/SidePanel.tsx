"use client";
// The side panel with two tabs: Hint (gnubg's analysis of your position) and
// Moves (the match record). Closed by default. It never covers the board, so
// a previewed hint stays visible:
//   docked  wide screens: a column to the right of the board (the board
//           shrinks to make room)
//   sheet   phones in portrait: a sheet over the lower part of the screen,
//           from the bottom edge of the board down (Game.tsx sets
//           --sheet-top); it covers the status line and the buttons
//   side    phones in landscape: a sheet over the control column, from the
//           right edge of the board (--sheet-left) to the screen edge
// Esc closes it (Game.tsx's shortcuts).

import Icon from "./ui/Icon";

export type PanelTab = "hint" | "moves";

export default function SidePanel({
  open,
  variant,
  tab,
  onTab,
  onClose,
  hint,
  moves,
}: {
  open: boolean;
  variant: "docked" | "sheet" | "side";
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  hint: React.ReactNode;
  moves: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <aside className={variant === "docked" ? "side-panel" : variant === "sheet" ? "bottom-sheet" : "side-sheet"} aria-label="Hint and moves" data-testid="side-panel">
      <header className="panel-head">
        <div className="tabs" role="tablist" aria-label="Side panel">
          {(["hint", "moves"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              id={`tab-${t}`}
              aria-selected={tab === t}
              aria-controls={`tabpanel-${t}`}
              className={`tab ${tab === t ? "on" : ""}`}
              onClick={() => onTab(t)}
              data-testid={`tab-${t}`}
            >
              {t === "hint" ? "Hint" : "Moves"}
            </button>
          ))}
        </div>
        <button className="round round-sm" onClick={onClose} aria-label="Close panel" title="Close (Esc)" data-testid="close-panel">
          <Icon name="close" size={14} />
        </button>
      </header>
      <div className="panel-body" role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "hint" ? hint : moves}
      </div>
    </aside>
  );
}
