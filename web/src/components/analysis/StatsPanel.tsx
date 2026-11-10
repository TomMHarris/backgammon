"use client";
// gnubg's "show statistics" for the match or one game, per player: chequer
// play, luck, cube and overall, with gnubg's own labels and values
// (analysisView.statSections, checked row by row against gnubg's text by
// tests/analysis_page.mjs). gnubg's exact text is one click away.

import { useState } from "react";
import { matchKind, playerName, statSections, type MatchView } from "@/lib/analysisView";
import s from "./Analysis.module.css";

export default function StatsPanel({ view, game }: { view: MatchView; game: number }) {
  const [scope, setScope] = useState<"match" | "game">("match");
  const g = view.games[game];
  const st = scope === "match" ? view.statistics : g.statistics;
  const text = scope === "match" ? view.statisticsText : g.statisticsText;
  const sections = statSections(st, view.matchLength, view.errorRateFactor);
  const analysed = scope === "match" ? view.analysed : g.analysed;

  return (
    <section className={s.panel} aria-labelledby="stats-title" data-testid="stats-panel">
      <div className={s.panelHead}>
        <h2 className={s.panelTitle} id="stats-title">
          Statistics
        </h2>
        <span className="segmented segmented-sm" role="radiogroup" aria-label="Statistics for">
          {(["match", "game"] as const).map((v) => (
            <label key={v} className={v === scope ? "on" : ""}>
              <input type="radio" name="stats-scope" checked={v === scope} onChange={() => setScope(v)} data-testid={`stats-${v}`} />
              <span>{v === "match" ? (view.matchLength ? "Match" : "Session") : `Game ${game + 1}`}</span>
            </label>
          ))}
        </span>
      </div>
      <div className={s.panelBody}>
        {!analysed && <p className="small muted">Not analysed yet: the counts below are from the move records only.</p>}
        <p className="small muted">
          gnubg&apos;s &ldquo;show statistics {scope}&rdquo; · {matchKind(view.matchLength)}
          {scope === "match" ? ` · ${st.games} game${st.games === 1 ? "" : "s"}` : ""} · errors negated as gnubg prints them; rates in mEMG
          per decision ({view.matchLength ? "MWC" : "points"} in brackets)
        </p>
        <div className={s.statsGrid}>
          {sections.map((sec) => (
            <table key={sec.title} className={s.statsTable} data-testid={`stats-${sec.title.toLowerCase().replace(/\s+/g, "-")}`}>
              <caption>{sec.title}</caption>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">Statistic</span>
                  </th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    {playerName(view, 0)}
                  </th>
                  <th scope="col" style={{ textAlign: "right" }}>
                    {playerName(view, 1)}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sec.rows.map((r, k) => (
                  <tr key={`${r.label}-${k}`} className={r.emphasis ? s.em : ""}>
                    <th scope="row">{r.label}</th>
                    <td>{r.cells[0]}</td>
                    <td>{r.cells[1]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
        {text && (
          <details className={s.gnubgText}>
            <summary>gnubg&apos;s own text</summary>
            <pre data-testid="stats-text">{text}</pre>
          </details>
        )}
      </div>
    </section>
  );
}
