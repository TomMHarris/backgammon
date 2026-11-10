"use client";
// One player's strip above (gnubg) or below (you) the board: a dot in the
// checker colour, name, strength, pip count and score. The player on turn is
// marked; while gnubg works out its play the strip says "thinking".

export default function PlayerBar({
  side,
  name,
  detail,
  score,
  matchLength,
  pips,
  active,
  thinking,
}: {
  side: 0 | 1;
  name: string;
  detail?: string;
  score: number;
  matchLength: number;
  pips: number;
  active: boolean;
  thinking?: boolean;
}) {
  return (
    <div className={`player ${active ? "active" : ""}`} data-testid={`player-${side}`}>
      <span className={`avatar ${side === 0 ? "avatar-bot" : "avatar-you"}`} aria-hidden="true" />
      <div className="player-id">
        <span className="player-name">
          {name}
          {active && <span className="sr-only"> (on turn)</span>}
        </span>
        {thinking ? (
          <span className="player-detail thinking" aria-hidden="true">
            thinking<span className="dots" />
          </span>
        ) : (
          detail && <span className="player-detail">{detail}</span>
        )}
      </div>
      <div className="player-stats">
        <span className="pips tnum" title="Pip count">
          <span className="pips-n">{pips}</span> pips
        </span>
        <span className="score tnum" aria-label={`Score ${score}${matchLength ? ` of ${matchLength}` : ""}`}>
          {score}
        </span>
      </div>
    </div>
  );
}
