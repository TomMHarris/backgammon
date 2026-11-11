"use client";
// The move list of one game, laid out like gnubg's .mat export (player 0 on
// the left, player 1 on the right). Each decision carries its quality badge
// (lib/quality.ts: ★ best, ✓ strong, and gnubg's own marks ?! doubtful,
// ? bad, ?? very bad) and the luck of the roll; above the list, each player's tally
// for the game. Every cell is a button that jumps to that decision.

import { useEffect, useRef } from "react";
import { LUCK_SYMBOL, LUCK_TEXT, playerName, type Decision, type MatchView } from "@/lib/analysisView";
import { QUALITY, QUALITY_ORDER, qualityCounts, qualityOf } from "@/lib/quality";
import QualityBadge from "@/components/QualityBadge";
import { says } from "@/lib/format";
import s from "./Analysis.module.css";

export default function MoveList({
  view,
  game,
  current,
  onGame,
  onJump,
}: {
  view: MatchView;
  game: number;
  current: Decision;
  onGame: (g: number) => void;
  onJump: (seq: number) => void;
}) {
  const g = view.games[game];
  const scrollRef = useRef<HTMLDivElement>(null);

  // keep the current decision visible inside the list (without scrolling the page)
  useEffect(() => {
    const box = scrollRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-seq="${current.seq}"]`);
    if (!box || !el) return;
    const rel = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    const top = rel - 34; // below the sticky header
    const bottom = rel + el.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 8;
  }, [current.seq, game]);

  return (
    <section className={s.panel} aria-labelledby="moves-title" data-testid="move-list">
      <div className={s.panelHead}>
        <h2 className={s.panelTitle} id="moves-title">
          Moves
        </h2>
        {view.games.length > 1 && (
          <nav className={s.games} aria-label="Games">
            {view.games.map((gv) => (
              <button
                key={gv.index}
                className={`${s.gameChip} ${gv.index === game ? s.on : ""}`}
                onClick={() => onGame(gv.index)}
                aria-current={gv.index === game ? "true" : undefined}
                title={`Game ${gv.index + 1} · score ${gv.scoreBefore[0]}–${gv.scoreBefore[1]}${gv.crawfordGame ? " · Crawford" : ""}`}
                data-testid={`game-${gv.index + 1}`}
              >
                {gv.index + 1}
              </button>
            ))}
          </nav>
        )}
      </div>
      <div className={s.panelBody}>
        <p className="small muted" style={{ marginBottom: 6 }}>
          Game {game + 1} · score {g.scoreBefore[0]}–{g.scoreBefore[1]}
          {g.crawfordGame ? " · Crawford" : ""} · {says(playerName(view, g.winner), "win")} {g.points} point{g.points === 1 ? "" : "s"}
          {g.resigned ? " (resignation)" : ""}
        </p>
        {g.analysed && (
          <div className={s.tally} data-testid="quality-tally">
            {[0, 1].map((p) => {
              const c = qualityCounts(g.decisions, p);
              return (
                <div key={p} className={s.tallyRow}>
                  <span className={`${s.tallyName} ${s.name}`}>{playerName(view, p)}</span>
                  {QUALITY_ORDER.map((q) => (
                    <span key={q} className={`${s.tallyCell} ${c[q] ? "" : s.tallyZero}`} title={`${QUALITY[q].label}: ${QUALITY[q].gnubg}`}>
                      <QualityBadge q={q} /> <span className="tnum">{c[q]}</span>
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        )}
        <div className={s.listScroll} ref={scrollRef}>
          <table className={s.list}>
            <thead>
              <tr>
                <th scope="col" style={{ width: 32 }}>
                  <span className="sr-only">Move</span>
                </th>
                <th scope="col">{playerName(view, 0)}</th>
                <th scope="col">{playerName(view, 1)}</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map((row) => (
                <tr key={row.number}>
                  <td className={s.rowNo}>{row.number}</td>
                  {row.cells.map((d, k) => (
                    <td key={k}>{d && <Cell d={d} current={d.seq === current.seq} onJump={onJump} />}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={s.legend} aria-hidden="true">
          {QUALITY_ORDER.map((q) => (
            <span key={q} title={QUALITY[q].gnubg}>
              <QualityBadge q={q} /> {QUALITY[q].label}
            </span>
          ))}
          <span>
            <span className={s.symLuck}>↑↑</span> Very lucky · <span className={s.symLuck}>↑</span> lucky
          </span>
          <span>
            <span className={s.symLuck}>↓</span> Unlucky · <span className={s.symLuck}>↓↓</span> very unlucky
          </span>
        </p>
      </div>
    </section>
  );
}

function Cell({ d, current, onJump }: { d: Decision; current: boolean; onJump: (seq: number) => void }) {
  const q = qualityOf(d);
  const shown = q && q !== "forced" ? q : null;
  const marks = [shown ? QUALITY[shown].label : "", d.luck !== "none" ? LUCK_TEXT[d.luck] : ""].filter(Boolean).join(", ");
  return (
    <button
      className={`${s.cell} ${current ? s.current : ""} ${d.kind !== "move" ? s.cube : ""}`}
      onClick={() => onJump(d.seq)}
      aria-current={current ? "step" : undefined}
      data-seq={d.seq}
      data-skill={d.skill}
      data-quality={q ?? ""}
      data-luck={d.luck}
      data-testid="move-cell"
    >
      <span className={s.cellText}>{d.text}</span>
      {shown && <QualityBadge q={shown} className={s.cellBadge} />}
      {d.luck !== "none" && (
        <span className={s.symLuck} aria-hidden="true">
          {LUCK_SYMBOL[d.luck]}
        </span>
      )}
      {marks && <span className="sr-only">({marks})</span>}
    </button>
  );
}
