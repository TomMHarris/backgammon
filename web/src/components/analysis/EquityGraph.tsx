"use client";
// "Win chances over the game": gnubg's evaluation across a game or the whole
// match, at the top of the review column (under the board on phones).
// x = decision number, y = one player's chances after each decision (win
// probability, or MWC / money equity), shaded in the tone of the player who
// is ahead, with gnubg's error marks as dots and its luck marks as triangles
// under the plot. Hover shows a readout, a click jumps to the decision. The
// plot itself is components/WinGraph.tsx (shared with the end-of-game card);
// the values are gnubg's (analysisView.graphPoints).

import { useEffect, useMemo, useState } from "react";
import { graphPoints, percent, playerName, signed, LUCK_TEXT, type Decision, type GraphMode, type MatchView, type Player } from "@/lib/analysisView";
import { useElementWidth } from "@/lib/hooks";
import { objectName, possessive } from "@/lib/format";
import { skillLabel } from "@/lib/quality";
import { Segmented } from "@/components/ui/controls";
import WinGraph, { markTitle } from "@/components/WinGraph";
import s from "./Analysis.module.css";

export default function EquityGraph({
  view,
  current,
  onJump,
  perspective,
  onPerspective,
}: {
  view: MatchView;
  current: Decision;
  onJump: (seq: number) => void;
  perspective: Player;
  onPerspective: (p: Player) => void;
}) {
  const match = view.matchLength > 0;
  const [scope, setScope] = useState<"game" | "match">("game");
  const [mode, setMode] = useState<GraphMode>("win");
  const [hover, setHover] = useState<number | null>(null);
  const { ref, w } = useElementWidth<HTMLDivElement>();
  const H = w && w < 400 ? 190 : 220;

  const decisions = scope === "game" ? view.games[current.game].decisions : view.decisions;
  const pts = useMemo(() => graphPoints(decisions, mode, perspective, view.matchLength), [decisions, mode, perspective, view.matchLength]);
  useEffect(() => setHover(null), [scope, current.game]);

  // y domain: probabilities and MWC 0..1; money equity symmetric around 0
  const pctScale = mode === "win" || match;
  let yMin = 0;
  let yMax = 1;
  if (!pctScale) {
    const m = Math.max(1, ...pts.map((p) => (p.y === null ? 0 : Math.abs(p.y))));
    yMax = Math.ceil(m * 2) / 2;
    yMin = -yMax;
  }
  const fmtY = (v: number) => (pctScale ? percent(v, 0) : signed(v, 1));
  const ticks = pctScale ? [0, 0.25, 0.5, 0.75, 1] : [yMin, yMin / 2, 0, yMax / 2, yMax];
  const n = pts.length;
  const curIdx = pts.findIndex((p) => p.d.seq === current.seq);
  const pName = playerName(view, perspective);
  const oName = playerName(view, 1 - perspective);
  const valueLabel = mode === "win" ? "win" : match ? "MWC" : "equity";
  const span = scope === "game" ? "game" : match ? "match" : "session";
  const title = mode === "win" ? `Win chances over the ${span}` : match ? `Match winning chances over the ${span}` : `Equity over the ${span}`;

  const shown = hover ?? curIdx;
  const sp = shown >= 0 ? pts[shown] : null;
  const readout = sp
    ? [
        scope === "match" ? `Game ${sp.d.game + 1}` : null,
        `${scope === "match" ? "move" : "Move"} ${sp.d.row}`,
        `${playerName(view, sp.d.player)} ${sp.d.text}`,
        sp.y !== null ? `${valueLabel} ${pctScale ? percent(sp.y, 1) : signed(sp.y, 3)} for ${objectName(pName)}` : null,
        sp.d.skill !== "none" ? skillLabel(sp.d.skill) : null,
        sp.d.luck !== "none" ? LUCK_TEXT[sp.d.luck] : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <section className={s.panel} aria-labelledby="graph-title" data-testid="graph-panel">
      <div className={s.graphHead}>
        <h2 className={s.panelTitle} id="graph-title" data-testid="graph-title">
          {title}
        </h2>
        <div className={s.graphControls}>
          <Segmented
            size="sm"
            label="Graph value"
            value={mode}
            onChange={setMode}
            options={[
              { value: "win", label: "Win %" },
              { value: "equity", label: match ? "MWC" : "Equity" },
            ]}
            testId="graph-mode"
          />
          <Segmented
            size="sm"
            label="Graph range"
            value={scope}
            onChange={setScope}
            options={[
              { value: "game", label: `Game ${current.game + 1}` },
              { value: "match", label: match ? "Match" : "Session" },
            ]}
            testId="graph-scope"
          />
          <Segmented
            size="sm"
            label="From the side of"
            value={perspective}
            onChange={(v) => onPerspective(v as Player)}
            options={[0, 1].map((p) => ({ value: p as Player, label: playerName(view, p) }))}
            testId="graph-side"
          />
        </div>
      </div>
      <div className={s.graphBody}>
        <div className={s.graphBox} ref={ref}>
          {w > 0 && (
            <WinGraph
              pts={pts}
              width={w}
              height={H}
              domain={[yMin, yMax]}
              ticks={ticks}
              reference={pctScale ? 0.5 : 0}
              fmtTick={fmtY}
              perspective={perspective}
              current={curIdx}
              hover={hover}
              onHover={setHover}
              onPick={(i) => onJump(pts[i].d.seq)}
              luck
              xLabels={n ? (scope === "game" ? ["move 1", `move ${pts[n - 1].d.row}`] : ["game 1", `game ${pts[n - 1].d.game + 1}`]) : undefined}
              zoneLabels={[`${pName} ahead`, `${oName} ahead`]}
              pointTitle={(p, what) => markTitle(playerName(view, p.d.player), p, what)}
              ariaLabel={`${possessive(pName)} ${valueLabel} after each decision, ${scope === "game" ? `game ${current.game + 1}` : "whole match"}; click to jump to a decision`}
              testId="graph"
            />
          )}
        </div>
        <p className={`${s.gReadout} tnum`} aria-live="polite" data-testid="graph-readout">
          {readout}
        </p>
        <p className={s.legend}>
          <span>
            <span className="wg-key wg-key-err" aria-hidden="true" /> Error: inaccuracy · mistake · <span className={s.rustText}>blunder</span>
          </span>
          <span>▲ ▼ Luck (filled: very lucky / unlucky)</span>
          <span>Click a point to go to that decision</span>
        </p>
      </div>
    </section>
  );
}
