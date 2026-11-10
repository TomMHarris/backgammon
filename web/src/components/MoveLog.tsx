"use client";
// The match record as compact tables, one per game, in gnubg's .mat layout:
// gnubg's actions in the left column, yours in the right. The current game is
// highlighted and kept scrolled into view.

import { useEffect, useRef } from "react";
import type { MatchState } from "@/game/match";
import { gameRows, points } from "@/lib/format";
import Icon from "./ui/Icon";

export default function MoveLog({ match, onDownload }: { match: MatchState | null; onDownload: () => void }) {
  const endRef = useRef<HTMLDivElement>(null);
  const games = match?.record.games ?? [];
  const count = games.reduce((n, g) => n + g.actions.length, 0);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [count]);

  if (!match) return <p className="empty">No match in progress.</p>;
  return (
    <div className="movelog" data-testid="move-log">
      <div className="movelog-tools">
        <span className="muted small">{games.length === 1 ? "1 game" : `${games.length} games`}</span>
        <button className="btn btn-sm btn-ghost" onClick={onDownload} data-testid="download-mat">
          <Icon name="download" size={16} /> Download .mat
        </button>
      </div>
      {games.map((g, gi) => {
        const current = gi === games.length - 1;
        const { rows } = gameRows(g);
        return (
          <section key={g.number} className={`log-game ${current ? "current" : ""}`} aria-label={`Game ${g.number}`}>
            <header className="log-head">
              <span className="log-title">Game {g.number}</span>
              <span className="muted small tnum">
                gnubg {g.score[0]} · You {g.score[1]}
                {g.crawford ? " · Crawford" : ""}
              </span>
            </header>
            {rows.length > 0 && (
              <table className="log-table">
                <thead className="sr-only">
                  <tr>
                    <th>#</th>
                    <th>gnubg</th>
                    <th>You</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.number}>
                      <td className="log-n tnum">{r.number}</td>
                      {r.cells.map((c, side) => (
                        <td key={side} className={`log-cell ${r.kinds[side] && r.kinds[side] !== "move" ? "log-cube" : ""}`}>
                          {c ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {g.result && (
              <p className="log-result">
                {g.result.winner === 1 ? "You win" : "gnubg wins"} {points(g.result.points)}
              </p>
            )}
          </section>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
