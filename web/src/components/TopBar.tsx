"use client";
// The minimal top line: both players (a tiny checker in their colour, name,
// score, pip count), the match in a few words, and three quiet round buttons
// on the right: moves / settings / help. The player on turn is in full
// colour, the other faded; while gnubg works, it says "thinking".

import Icon from "./ui/Icon";

export interface PlayerInfo {
  name: string; // "you", "gnubg expert"
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
  match: string; // "5-point match · game 2"
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
            <span className="who-name">{p.name}</span>
            <span className="sep" aria-hidden="true">
              ·
            </span>
            <span className="who-score tnum" aria-label={`score ${p.score}`}>
              {p.score}
            </span>
            <span className="sep" aria-hidden="true">
              ·
            </span>
            <span className="who-pips tnum">{p.pips} pips</span>
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
      <nav className="corner" aria-label="app">
        <button
          className={`round ${panelOpen ? "pressed" : ""}`}
          onClick={onPanel}
          aria-pressed={panelOpen}
          aria-label="moves and hints"
          title="moves and hints (L)"
          data-testid="toggle-panel"
        >
          <Icon name="list" size={16} />
        </button>
        <button className="round" onClick={onSettings} aria-label="settings" title="settings" data-testid="open-settings">
          <Icon name="gear" size={16} />
        </button>
        <button className="round round-i" onClick={onHelp} aria-label="help and keyboard shortcuts" title="help (?)" data-testid="open-help">
          i
        </button>
      </nav>
    </header>
  );
}
