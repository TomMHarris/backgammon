"use client";
// The slim header: app name, the match in one line, and buttons for New
// match, the side panel, Settings and Help.

import Icon from "./ui/Icon";

export default function AppHeader({
  status,
  panelOpen,
  onNewMatch,
  onPanel,
  onSettings,
  onHelp,
}: {
  status: string;
  panelOpen: boolean;
  onNewMatch: () => void;
  onPanel: () => void;
  onSettings: () => void;
  onHelp: () => void;
}) {
  return (
    <header className="app-header">
      <div className="brand">
        <Logo />
        <span className="brand-name">gnubg-web</span>
      </div>
      <p className="match-status" data-testid="match-status">
        {status}
      </p>
      <nav className="header-actions" aria-label="App">
        <button className="btn btn-secondary btn-sm hide-narrow" onClick={onNewMatch} data-testid="open-new-match">
          <Icon name="plus" size={16} />
          New match
        </button>
        <button className="btn btn-icon btn-ghost show-narrow" onClick={onNewMatch} aria-label="New match" title="New match">
          <Icon name="plus" />
        </button>
        <button
          className={`btn btn-icon btn-ghost ${panelOpen ? "pressed" : ""}`}
          onClick={onPanel}
          aria-pressed={panelOpen}
          aria-label="Hint and moves panel"
          title="Hint and moves (L)"
          data-testid="toggle-panel"
        >
          <Icon name="panel" />
        </button>
        <button className="btn btn-icon btn-ghost" onClick={onSettings} aria-label="Settings" title="Settings" data-testid="open-settings">
          <Icon name="gear" />
        </button>
        <button className="btn btn-icon btn-ghost" onClick={onHelp} aria-label="Help and keyboard shortcuts" title="Help (?)" data-testid="open-help">
          <Icon name="help" />
        </button>
      </nav>
    </header>
  );
}

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" className="logo-bg" />
      <path d="M7 7l4.5 12L16 7M16 25l4.5-12L25 25" className="logo-pts" />
      <circle cx="11.5" cy="23" r="2.6" className="logo-dot" />
      <circle cx="20.5" cy="9" r="2.6" className="logo-dot logo-dot-2" />
    </svg>
  );
}
