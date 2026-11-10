"use client";
// The minimal top line: both players (a tiny checker in their colour, name,
// score, pip count), the match in a few words, and on the right a "Review"
// link (the analysis page) and three quiet round buttons: moves and hints /
// settings / help. The player on turn is in full colour, the other faded;
// while gnubg works, it says "thinking".

import Link from "next/link";
import Icon from "./ui/Icon";

export interface PlayerInfo {
  name: string; // "You", "gnubg"
  level?: string; // gnubg's strength, "Expert"
  score: number;
  pips: number;
  active: boolean;
  thinking?: boolean;
}

export default function TopBar({
  players,
  match,
  panelOpen,
  onPanel,
  onSettings,
  onHelp,
}: {
  players: [PlayerInfo, PlayerInfo]; // [you, gnubg]
  match: string; // "5-point match · Game 2"
  panelOpen: boolean;
  onPanel: () => void;
  onSettings: () => void;
  onHelp: () => void;
}) {
  return (
    <header className="topbar">
      <div className="players" data-testid="players">
        {players.map((p, k) => (
          <span key={k} className={`who ${p.active ? "on" : ""}`} data-testid={`player-${k === 0 ? 1 : 0}`}>
            <span className={`piece ${k === 0 ? "piece-ivory" : "piece-walnut"}`} aria-hidden="true" />
            <span className="who-name">
              {p.name}
              {p.level && <span className="who-level"> {p.level}</span>}
            </span>
            <span className="who-score num" aria-label={`score ${p.score}`}>
              {p.score}
            </span>
            <span className="who-pips num" title="Pip count">
              {p.pips}
              <span className="who-pips-unit"> pips</span>
            </span>
            {p.thinking && (
              <span className="who-thinking" aria-live="off">
                thinking<span className="dots" aria-hidden="true" />
              </span>
            )}
            {p.active && <span className="sr-only">(on turn)</span>}
          </span>
        ))}
        {match && (
          <span className="match-info" data-testid="match-status">
            {match}
          </span>
        )}
      </div>
      <nav className="corner" aria-label="App">
        <Link className="corner-link" href="/analysis" prefetch={false} title="Review a match: import a .mat file and analyse it" data-testid="review-link">
          Review
        </Link>
        <button
          className={`round ${panelOpen ? "pressed" : ""}`}
          onClick={onPanel}
          aria-pressed={panelOpen}
          aria-label="Moves and hints"
          title="Moves and hints (L)"
          data-testid="toggle-panel"
        >
          <Icon name="list" size={16} />
        </button>
        <button className="round" onClick={onSettings} aria-label="Settings" title="Settings" data-testid="open-settings">
          <Icon name="gear" size={16} />
        </button>
        <button className="round" onClick={onHelp} aria-label="Help and keyboard shortcuts" title="Help (?)" data-testid="open-help">
          <Icon name="help" size={17} />
        </button>
      </nav>
    </header>
  );
}
