"use client";
// The side panel with two tabs: Hint (gnubg's analysis of your position) and
// Moves (the match record). Closed by default. On wide screens it sits to the
// right of the board; on narrower screens it is a sheet over the page (a
// native modal <dialog>, so focus and Esc behave).

import { useEffect, useRef } from "react";
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
  docked: boolean; // true: inline beside the board; false: sheet
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  hint: React.ReactNode;
  moves: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d || docked) return;
    if (open && !d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute("open", "");
      }
    } else if (!open && d.open) d.close();
  }, [open, docked]);

  const body = (
    <>
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
        <button className="round" onClick={onClose} aria-label="Close panel" data-testid="close-panel">
          <Icon name="close" />
        </button>
      </header>
      <div className="panel-body" role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "hint" ? hint : moves}
      </div>
    </>
  );

  if (docked) {
    if (!open) return null;
    return (
      <aside className="side-panel" aria-label="Hint and moves" data-testid="side-panel">
        {body}
      </aside>
    );
  }
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label="Hint and moves"
      data-testid="side-panel"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && <div className="sheet-card">{body}</div>}
    </dialog>
  );
}
