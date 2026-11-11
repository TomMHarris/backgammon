"use client";
// The plot of gnubg's evaluation over a game or a match, shared by the
// analysis page (analysis/EquityGraph.tsx, with its controls around it) and
// the end-of-game card (ResultDialog.tsx, a compact version). Plain SVG.
//
// x = decision number, y = one player's chances after each decision (the
// values come from analysisView.graphPoints; this only draws them). The area
// between the line and the reference line (50%, or 0 for money equity) is
// shaded in the tone of the player who is ahead: ivory above (the player
// whose chances these are, drawn at the bottom of the board), walnut below.
// Errors are dots sized and coloured by gnubg's mark; luck marks (optional)
// are triangles in a strip under the plot, up = good for that player. Game
// boundaries are marked when the points span several games. The parent
// owns the hover state; a click or tap picks the nearest decision.

import { useId } from "react";
import { LUCK_TEXT, type GraphPoint, type Player } from "@/lib/analysisView";
import { skillLabel } from "@/lib/quality";

const R_ERR = { none: 0, doubtful: 4, bad: 5.5, verybad: 7 } as const;
const R_ERR_SM = { none: 0, doubtful: 3, bad: 4, verybad: 5 } as const;
const LUCK_H = 20; // the luck strip under the plot

export interface WinGraphProps {
  pts: GraphPoint[];
  width: number;
  height: number;
  domain: [number, number]; // y range
  ticks: number[]; // y grid lines (labelled)
  reference: number; // the 50% / 0 line
  fmtTick: (v: number) => string;
  perspective: Player; // whose chances the y values are
  current?: number; // index of the current decision (-1: none)
  hover: number | null;
  onHover: (i: number | null) => void;
  onPick: (i: number) => void;
  luck?: boolean; // draw the luck strip
  compact?: boolean; // smaller margins, marks and labels
  xLabels?: [string, string];
  zoneLabels?: [string, string]; // [above, below], e.g. ["Alice ahead", "Bob ahead"]
  pointTitle: (p: GraphPoint, what: "error" | "luck") => string;
  ariaLabel: string;
  testId?: string;
}

export default function WinGraph({
  pts,
  width: w,
  height: H,
  domain: [yMin, yMax],
  ticks,
  reference,
  fmtTick,
  perspective,
  current = -1,
  hover,
  onHover,
  onPick,
  luck = false,
  compact = false,
  xLabels,
  zoneLabels,
  pointTitle,
  ariaLabel,
  testId,
}: WinGraphProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const ML = compact ? 34 : 44; // left margin (y labels)
  const MR = compact ? 8 : 12;
  const MT = compact ? 6 : 10;
  const strip = luck ? LUCK_H : 0;
  const MB = (xLabels ? (compact ? 16 : 20) : 6) + strip;
  const plotW = Math.max(10, w - ML - MR);
  const plotH = Math.max(10, H - MT - MB);
  const n = pts.length;
  const xOf = (i: number) => ML + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const yOf = (v: number) => MT + ((yMax - v) / (yMax - yMin)) * plotH;
  const yRef = yOf(reference);
  const rErr = compact ? R_ERR_SM : R_ERR;

  // the line and its shaded area, one piece per game
  const lines: string[] = [];
  const areas: string[] = [];
  let run: { x: number; y: number }[] = [];
  const flush = () => {
    if (run.length) {
      const f = (v: number) => v.toFixed(1);
      lines.push(run.map((p, k) => `${k ? "L" : "M"}${f(p.x)},${f(p.y)}`).join(""));
      const first = run[0];
      const last = run[run.length - 1];
      areas.push(`M${f(first.x)},${f(yRef)}${run.map((p) => `L${f(p.x)},${f(p.y)}`).join("")}L${f(last.x)},${f(yRef)}Z`);
    }
    run = [];
  };
  pts.forEach((p, i) => {
    if (i > 0 && p.d.game !== pts[i - 1].d.game) flush();
    if (p.y === null) return; // (no value of its own, e.g. a forced move: the line carries on)
    run.push({ x: xOf(i), y: yOf(p.y) });
  });
  flush();

  const gameStarts = pts.filter((p, i) => i > 0 && p.d.game !== pts[i - 1].d.game);
  const idxAt = (clientX: number, svg: SVGSVGElement) => {
    const x = clientX - svg.getBoundingClientRect().left;
    if (n <= 1) return 0;
    return Math.max(0, Math.min(n - 1, Math.round(((x - ML) / plotW) * (n - 1))));
  };

  return (
    <svg
      className={`wg ${compact ? "wg-compact" : ""}`}
      width={w}
      height={H}
      viewBox={`0 0 ${w} ${H}`}
      role="img"
      aria-label={ariaLabel}
      data-testid={testId}
      onPointerMove={(e) => onHover(idxAt(e.clientX, e.currentTarget))}
      onPointerLeave={() => onHover(null)}
      onClick={(e) => {
        const i = idxAt(e.clientX, e.currentTarget);
        if (pts[i]) onPick(i);
      }}
    >
      <defs>
        <clipPath id={`${uid}-up`}>
          <rect x={ML} y={MT} width={plotW} height={Math.max(0, yRef - MT)} />
        </clipPath>
        <clipPath id={`${uid}-down`}>
          <rect x={ML} y={yRef} width={plotW} height={Math.max(0, MT + plotH - yRef)} />
        </clipPath>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          {t !== reference && <line x1={ML} x2={ML + plotW} y1={yOf(t)} y2={yOf(t)} className="wg-grid" />}
          <text x={ML - 6} y={yOf(t) + 3.5} textAnchor="end" className="wg-axis">
            {fmtTick(t)}
          </text>
        </g>
      ))}
      {/* shading: the player ahead's tone between the line and the reference line */}
      <g clipPath={`url(#${uid}-up)`}>
        {areas.map((d, k) => (
          <path key={k} d={d} className="wg-up" />
        ))}
      </g>
      <g clipPath={`url(#${uid}-down)`}>
        {areas.map((d, k) => (
          <path key={k} d={d} className="wg-down" />
        ))}
      </g>
      <line x1={ML} x2={ML + plotW} y1={yRef} y2={yRef} className="wg-ref" data-testid="graph-reference" />
      {zoneLabels && (
        <>
          <text x={ML + 5} y={MT + (compact ? 10 : 12)} className="wg-zone">
            {zoneLabels[0]}
          </text>
          <text x={ML + 5} y={MT + plotH - (compact ? 4 : 6)} className="wg-zone">
            {zoneLabels[1]}
          </text>
        </>
      )}
      {gameStarts.map((p) => (
        <g key={`g${p.d.game}`}>
          <line x1={xOf(p.x) - 0.5} x2={xOf(p.x) - 0.5} y1={MT} y2={MT + plotH + strip} className="wg-game" />
          <text x={xOf(p.x) + 3} y={MT + plotH - 4} className="wg-game-label">
            G{p.d.game + 1}
          </text>
        </g>
      ))}
      {xLabels && n > 0 && (
        <>
          <text x={ML} y={H - 4} className="wg-axis">
            {xLabels[0]}
          </text>
          <text x={ML + plotW} y={H - 4} textAnchor="end" className="wg-axis">
            {xLabels[1]}
          </text>
        </>
      )}
      {luck && n > 0 && (
        <text x={ML - 6} y={MT + plotH + strip / 2 + 7} textAnchor="end" className="wg-axis">
          luck
        </text>
      )}
      {lines.map((d, k) => (
        <path key={k} d={d} className="wg-line" />
      ))}
      {/* current decision and hover guide */}
      {current >= 0 && <line x1={xOf(current)} x2={xOf(current)} y1={MT} y2={MT + plotH + strip} className="wg-cursor" />}
      {hover !== null && hover !== current && <line x1={xOf(hover)} x2={xOf(hover)} y1={MT} y2={MT + plotH + strip} className="wg-hover" />}
      {/* errors: dots by gnubg's mark */}
      {pts.map((p, i) => {
        if (p.d.skill === "none") return null;
        const y = p.y ?? nearestY(pts, i);
        if (y === null) return null;
        return (
          <circle key={`e${i}`} cx={xOf(i)} cy={yOf(y)} r={rErr[p.d.skill]} className={`wg-err wg-err-${p.d.skill}`} data-testid="graph-error" data-seq={p.d.seq}>
            <title>{pointTitle(p, "error")}</title>
          </circle>
        );
      })}
      {/* luck strip: jokers / stinkers, up = good for `perspective` */}
      {luck &&
        pts.map((p, i) => {
          if (p.d.luck === "none") return null;
          const good = (p.d.luck === "lucky" || p.d.luck === "verylucky") === (p.d.player === perspective);
          const strong = p.d.luck === "verylucky" || p.d.luck === "veryunlucky";
          const cx = xOf(i);
          const cy = MT + plotH + strip / 2 + 3;
          const sz = strong ? 6 : 4.5;
          const d = good
            ? `M${cx},${cy - sz} L${cx + sz},${cy + sz * 0.8} L${cx - sz},${cy + sz * 0.8}Z`
            : `M${cx},${cy + sz} L${cx + sz},${cy - sz * 0.8} L${cx - sz},${cy - sz * 0.8}Z`;
          return (
            <path key={`l${i}`} d={d} className={strong ? "wg-luck-strong" : "wg-luck-weak"} data-testid="graph-luck">
              <title>{pointTitle(p, "luck")}</title>
            </path>
          );
        })}
      {current >= 0 && pts[current]?.y !== null && pts[current] && (
        <circle
          cx={xOf(current)}
          cy={yOf(pts[current].y!)}
          r={pts[current].d.skill === "none" ? (compact ? 3.5 : 4.5) : rErr[pts[current].d.skill] + 3}
          className={pts[current].d.skill === "none" ? "wg-current" : "wg-current-ring"}
          data-testid="graph-current"
        />
      )}
      {hover !== null && hover !== current && pts[hover]?.y !== null && pts[hover] && (
        <circle cx={xOf(hover)} cy={yOf(pts[hover].y!)} r={compact ? 3 : 3.5} className="wg-hover-dot" />
      )}
    </svg>
  );
}

/** A decision without a value of its own (e.g. a forced "no move") sits on its neighbours' level. */
export function nearestY(pts: GraphPoint[], i: number): number | null {
  for (let k = 1; k < pts.length; k++) {
    for (const j of [i - k, i + k]) if (j >= 0 && j < pts.length && pts[j].y !== null && pts[j].d.game === pts[i].d.game) return pts[j].y;
  }
  return null;
}

/** Tooltip text of an error dot or a luck mark. */
export function markTitle(name: string, p: GraphPoint, what: "error" | "luck"): string {
  return `${name} ${p.d.text}: ${what === "error" ? skillLabel(p.d.skill) : LUCK_TEXT[p.d.luck]}`;
}
