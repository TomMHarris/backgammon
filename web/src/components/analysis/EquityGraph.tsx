"use client";
// gnubg's evaluation across a game or the whole match, as a plain SVG line:
// x = decision number, y = one player's chances after each decision (win
// probability, or MWC / money equity). Errors are dots sized and coloured by
// gnubg's mark; jokers and stinkers (luck marks) are triangles in a strip
// under the plot (up = good for the chosen player). Hover shows a readout,
// a click jumps to the nearest decision. The values are gnubg's
// (analysisView.graphPoints); this only draws them.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  LUCK_TEXT,
  SKILL_TEXT,
  graphPoints,
  percent,
  playerName,
  signed,
  type Decision,
  type GraphMode,
  type MatchView,
  type Player,
} from "@/lib/analysisView";
import { Segmented } from "@/components/ui/controls";
import s from "./Analysis.module.css";

const ML = 44; // left margin (y labels)
const MR = 12;
const MT = 10;
const LUCK_H = 16; // luck strip under the plot
const MB = 20 + LUCK_H; // bottom: luck strip + x labels
const R_ERR = { none: 0, doubtful: 4, bad: 5.5, verybad: 7 } as const;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

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
  const { ref, w } = useWidth<HTMLDivElement>();
  const H = w && w < 560 ? 170 : 210;

  const decisions = scope === "game" ? view.games[current.game].decisions : view.decisions;
  const pts = useMemo(() => graphPoints(decisions, mode, perspective, view.matchLength), [decisions, mode, perspective, view.matchLength]);
  useEffect(() => setHover(null), [scope, current.game]);

  // y domain: probabilities and MWC 0..1; money equity symmetric around 0
  let yMin = 0;
  let yMax = 1;
  if (mode === "equity" && !match) {
    const m = Math.max(1, ...pts.map((p) => (p.y === null ? 0 : Math.abs(p.y))));
    yMax = Math.ceil(m * 2) / 2;
    yMin = -yMax;
  }
  const plotW = Math.max(10, w - ML - MR);
  const plotH = H - MT - MB;
  const n = pts.length;
  const xOf = (i: number) => ML + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const yOf = (v: number) => MT + ((yMax - v) / (yMax - yMin)) * plotH;
  const fmtY = (v: number) => (mode === "win" || match ? percent(v, 0) : signed(v, 1));
  const ticks = mode === "win" || match ? [0, 0.25, 0.5, 0.75, 1] : [yMin, yMin / 2, 0, yMax / 2, yMax];

  // the line, broken at game boundaries (match scope) and skipping decisions without a value
  const paths: string[] = [];
  let seg = "";
  let lastGame = -1;
  pts.forEach((p, i) => {
    if (p.d.game !== lastGame) {
      if (seg) paths.push(seg);
      seg = "";
      lastGame = p.d.game;
    }
    if (p.y === null) return;
    seg += `${seg ? "L" : "M"}${xOf(i).toFixed(1)},${yOf(p.y).toFixed(1)}`;
  });
  if (seg) paths.push(seg);

  const gameStarts = scope === "match" ? pts.filter((p, i) => i > 0 && p.d.game !== pts[i - 1].d.game) : [];
  const curIdx = pts.findIndex((p) => p.d.seq === current.seq);
  const pName = playerName(view, perspective);
  const valueLabel = mode === "win" ? "win" : match ? "mwc" : "equity";

  const idxAt = (clientX: number, svg: SVGSVGElement) => {
    const x = clientX - svg.getBoundingClientRect().left;
    if (n <= 1) return 0;
    return Math.max(0, Math.min(n - 1, Math.round(((x - ML) / plotW) * (n - 1))));
  };

  const shown = hover ?? curIdx;
  const sp = shown >= 0 ? pts[shown] : null;
  const readout = sp
    ? [
        scope === "match" ? `game ${sp.d.game + 1}` : null,
        `move ${sp.d.row}`,
        `${playerName(view, sp.d.player)} ${sp.d.text}`,
        sp.y !== null ? `${valueLabel} ${fmtY2(sp.y, mode, match)} for ${pName}` : null,
        sp.d.skill !== "none" ? SKILL_TEXT[sp.d.skill] : null,
        sp.d.luck !== "none" ? LUCK_TEXT[sp.d.luck] : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <section className={s.panel} aria-labelledby="graph-title" data-testid="graph-panel">
      <div className={s.panelHead}>
        <h2 className={s.panelTitle} id="graph-title">
          {mode === "win" ? "Winning chances" : match ? "Match winning chances" : "Equity"}
        </h2>
        <Segmented
          size="sm"
          label="graph range"
          value={scope}
          onChange={setScope}
          options={[
            { value: "game", label: `game ${current.game + 1}` },
            { value: "match", label: match ? "match" : "session" },
          ]}
          testId="graph-scope"
        />
        <Segmented
          size="sm"
          label="graph value"
          value={mode}
          onChange={setMode}
          options={[
            { value: "win", label: "win %" },
            { value: "equity", label: match ? "mwc" : "equity" },
          ]}
          testId="graph-mode"
        />
        <Segmented
          size="sm"
          label="from the side of"
          value={perspective}
          onChange={(v) => onPerspective(v as Player)}
          options={[0, 1].map((p) => ({ value: p as Player, label: playerName(view, p) }))}
          testId="graph-side"
        />
      </div>
      <div className={s.panelBody}>
        <div className={s.graphBox} ref={ref}>
          {w > 0 && (
            <svg
              className={s.graph}
              width={w}
              height={H}
              viewBox={`0 0 ${w} ${H}`}
              role="img"
              aria-label={`${pName}'s ${valueLabel} after each decision, ${scope === "game" ? `game ${current.game + 1}` : "whole match"}; click to jump to a decision`}
              data-testid="graph"
              onPointerMove={(e) => setHover(idxAt(e.clientX, e.currentTarget))}
              onPointerLeave={() => setHover(null)}
              onClick={(e) => {
                const i = idxAt(e.clientX, e.currentTarget);
                if (pts[i]) onJump(pts[i].d.seq);
              }}
            >
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={ML} x2={ML + plotW} y1={yOf(t)} y2={yOf(t)} className={t === (yMin + yMax) / 2 ? s.gMid : s.gGrid} />
                  <text x={ML - 6} y={yOf(t) + 3.5} textAnchor="end" className={s.gAxis}>
                    {fmtY(t)}
                  </text>
                </g>
              ))}
              {gameStarts.map((p) => (
                <g key={`g${p.d.game}`}>
                  <line x1={xOf(p.x) - 0.5} x2={xOf(p.x) - 0.5} y1={MT} y2={MT + plotH} className={s.gGame} />
                  <text x={xOf(p.x) + 3} y={MT + 9} className={s.gGameLabel}>
                    {p.d.game + 1}
                  </text>
                </g>
              ))}
              {/* x labels: first and last decision number */}
              {n > 0 && (
                <>
                  <text x={ML} y={H - 4} className={s.gAxis}>
                    {scope === "game" ? "move 1" : "game 1"}
                  </text>
                  <text x={ML + plotW} y={H - 4} textAnchor="end" className={s.gAxis}>
                    {scope === "game" ? `move ${pts[n - 1].d.row}` : `game ${pts[n - 1].d.game + 1}`}
                  </text>
                  <text x={ML - 6} y={MT + plotH + LUCK_H / 2 + 5} textAnchor="end" className={s.gAxis}>
                    luck
                  </text>
                </>
              )}
              {paths.map((d, k) => (
                <path key={k} d={d} className={s.gLine} />
              ))}
              {/* current decision and hover guide */}
              {curIdx >= 0 && <line x1={xOf(curIdx)} x2={xOf(curIdx)} y1={MT} y2={MT + plotH + LUCK_H} className={s.gCursor} />}
              {hover !== null && hover !== curIdx && (
                <line x1={xOf(hover)} x2={xOf(hover)} y1={MT} y2={MT + plotH + LUCK_H} className={s.gHover} />
              )}
              {/* errors: dots by gnubg's mark */}
              {pts.map((p, i) => {
                if (p.d.skill === "none") return null;
                const y = p.y ?? nearestY(pts, i);
                if (y === null) return null;
                return (
                  <circle
                    key={`e${i}`}
                    cx={xOf(i)}
                    cy={yOf(y)}
                    r={R_ERR[p.d.skill]}
                    className={s[`gErr-${p.d.skill}`]}
                    data-testid="graph-error"
                    data-seq={p.d.seq}
                  >
                    <title>{`${playerName(view, p.d.player)} ${p.d.text}: ${SKILL_TEXT[p.d.skill]}`}</title>
                  </circle>
                );
              })}
              {/* luck strip: jokers / stinkers, up = good for the chosen player */}
              {pts.map((p, i) => {
                if (p.d.luck === "none") return null;
                const good = (p.d.luck === "lucky" || p.d.luck === "verylucky") === (p.d.player === perspective);
                const strong = p.d.luck === "verylucky" || p.d.luck === "veryunlucky";
                const cx = xOf(i);
                const cy = MT + plotH + LUCK_H / 2 + 2;
                const sz = strong ? 6 : 4.5;
                const d = good
                  ? `M${cx},${cy - sz} L${cx + sz},${cy + sz * 0.8} L${cx - sz},${cy + sz * 0.8}Z`
                  : `M${cx},${cy + sz} L${cx + sz},${cy - sz * 0.8} L${cx - sz},${cy - sz * 0.8}Z`;
                return (
                  <path key={`l${i}`} d={d} className={strong ? s.gLuckStrong : s.gLuckWeak} data-testid="graph-luck">
                    <title>{`${playerName(view, p.d.player)} ${p.d.text}: ${LUCK_TEXT[p.d.luck]}`}</title>
                  </path>
                );
              })}
              {curIdx >= 0 && pts[curIdx].y !== null && (
                <circle cx={xOf(curIdx)} cy={yOf(pts[curIdx].y!)} r={pts[curIdx].d.skill === "none" ? 4.5 : R_ERR[pts[curIdx].d.skill] + 3} className={pts[curIdx].d.skill === "none" ? s.gCurrent : s.gCurrentRing} data-testid="graph-current" />
              )}
            </svg>
          )}
        </div>
        <p className={`${s.gReadout} tnum`} aria-live="polite" data-testid="graph-readout">
          {readout}
        </p>
        <p className={s.legend}>
          <span>line: gnubg&apos;s evaluation after each decision, for {pName}</span>
          <span>● error (size: doubtful · bad · very bad)</span>
          <span>▲ ▼ luck mark (filled: very lucky / very unlucky)</span>
        </p>
      </div>
    </section>
  );
}

function fmtY2(v: number, mode: GraphMode, match: boolean) {
  return mode === "win" || match ? percent(v, 1) : signed(v, 3);
}

/** A decision without a value of its own (e.g. a forced "no move") sits on its neighbours' level. */
function nearestY(pts: { y: number | null; d: Decision }[], i: number): number | null {
  for (let k = 1; k < pts.length; k++) {
    for (const j of [i - k, i + k]) if (j >= 0 && j < pts.length && pts[j].y !== null && pts[j].d.game === pts[i].d.game) return pts[j].y;
  }
  return null;
}
