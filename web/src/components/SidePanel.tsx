"use client";
// The side panel with two tabs: Hint (gnubg's analysis of your position) and
// Moves (the match record). Closed by default. It never covers the board: on
// wide screens it is a column to the right of the board, on narrower screens
// a compact sheet between the board and the buttons (at most ~40% of the
// screen, scrolling inside). In both cases the board shrinks to make room,
// so a previewed hint stays visible. Esc closes it (Game.tsx's shortcuts).

import Icon from "./ui/Icon";

export type PanelTab = "hint" | "moves";

export default function SidePanel({
  open,
  docked,
  tab,
  onTab,
  onClose,
  hint,
  moves,
}: {
  open: boolean;
  docked: boolean; // true: a column beside the board; false: a sheet under it
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  hint: React.ReactNode;
  moves: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <aside className={docked ? "side-panel" : "bottom-sheet"} aria-label="Hint and moves" data-testid="side-panel">
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
