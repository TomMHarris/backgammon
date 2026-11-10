// Drawing pieces for BoardView: the shared <defs>, the static layer (panel,
// points, bar groove, trays; memoised, it only changes with `flipped`), dice
// and the cube.

import { memo } from "react";
import s from "./Board.module.css";
import { BAR, CUBE, DIE, FT, H, MID, PLEN, PW, R, TRAY_W, W, barX, colX, place, trayX } from "./geometry";

/**
 * Gradients and the two checker shapes, referenced as `#${uid}-human` /
 * `#${uid}-bot`: a sphere-like disc lit from the upper left, with a hairline
 * edge one shade darker and a soft contact shadow. No rims or rings.
 */
export const Defs = memo(function Defs({ uid }: { uid: string }) {
  const body = (side: "human" | "bot") => {
    const ivory = side === "human";
    return (
      <g id={`${uid}-${side}`}>
        <circle cx={0.3} cy={1.4} r={R - 0.2} className={s.shadow} />
        <circle r={R - 1} fill={`url(#${uid}-g${side})`} className={ivory ? s.ivoryEdge : s.walnutEdge} />
      </g>
    );
  };
  const sphere = (id: string, cls: [string, string, string, string]) => (
    <radialGradient id={id} cx="0.44" cy="0.36" r="0.66" fx="0.42" fy="0.3">
      <stop offset="0" className={cls[0]} />
      <stop offset="0.38" className={cls[1]} />
      <stop offset="0.74" className={cls[2]} />
      <stop offset="1" className={cls[3]} />
    </radialGradient>
  );
  return (
    <defs>
      {sphere(`${uid}-ghuman`, [s.sIvory0, s.sIvory1, s.sIvory2, s.sIvory3])}
      {sphere(`${uid}-gbot`, [s.sWalnut0, s.sWalnut1, s.sWalnut2, s.sWalnut3])}
      <linearGradient id={`${uid}-dhuman`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" className={s.sIvory0} />
        <stop offset="1" className={s.sIvory2} />
      </linearGradient>
      <linearGradient id={`${uid}-dbot`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" className={s.sWalnut0} />
        <stop offset="1" className={s.sWalnut2} />
      </linearGradient>
      {body("human")}
      {body("bot")}
    </defs>
  );
});

/** Panel, points, point numbers, the bar groove and the bear-off wells. */
export const StaticLayer = memo(function StaticLayer({ flipped }: { flipped: boolean }) {
  const bx = barX(flipped);
  const tx = trayX(flipped);
  const els: React.ReactElement[] = [];
  for (let i = 0; i < 24; i++) {
    const { col, top } = place(i, flipped);
    const x = colX(col, flipped);
    const baseY = top ? FT : H - FT;
    const tipY = top ? FT + PLEN : H - FT - PLEN;
    const cls = (col + (top ? 0 : 1)) % 2 === 0 ? s.pointA : s.pointB;
    els.push(<polygon key={`p${i}`} points={`${x + 2.5},${baseY} ${x + PW - 2.5},${baseY} ${x + PW / 2},${tipY}`} className={cls} />);
    els.push(
      <text key={`n${i}`} x={x + PW / 2} y={top ? FT / 2 + 3.5 : H - FT / 2 + 3.5} textAnchor="middle" className={s.label}>
        {i + 1}
      </text>
    );
  }
  return (
    <g aria-hidden="true">
      <rect x={0.5} y={0.5} width={W - 1} height={H - 1} rx={5} className={s.panel} />
      <rect x={bx + 4} y={FT} width={BAR - 8} height={H - 2 * FT} rx={3} className={s.groove} />
      <rect x={tx} y={FT} width={TRAY_W} height={MID - 4 - FT} rx={3} className={s.groove} />
      <rect x={tx} y={MID + 4} width={TRAY_W} height={MID - 4 - FT} rx={3} className={s.groove} />
      {els}
    </g>
  );
});

const SPOTS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [[0.28, 0.28], [0.72, 0.72]],
  3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
  4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
  5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
  6: [[0.28, 0.26], [0.72, 0.26], [0.28, 0.5], [0.72, 0.5], [0.28, 0.74], [0.72, 0.74]],
};

/** One die, top-left corner at (x, y): a soft ivory (or walnut) tile with round pips. */
export function Die({ uid, x, y, value, faded, human }: { uid: string; x: number; y: number; value: number; faded: boolean; human: boolean }) {
  return (
    <g className={`${s.die} ${faded ? s.used : ""}`}>
      <rect x={x + 0.3} y={y + 1.4} width={DIE} height={DIE} rx={8} className={s.shadow} />
      <rect x={x} y={y} width={DIE} height={DIE} rx={8} fill={`url(#${uid}-d${human ? "human" : "bot"})`} className={human ? s.ivoryEdge : s.walnutEdge} />
      {(SPOTS[value] ?? []).map(([cx, cy], k) => (
        <circle key={k} cx={x + cx * DIE} cy={y + cy * DIE} r={DIE * 0.085} className={human ? s.pipOnIvory : s.pipOnWalnut} />
      ))}
    </g>
  );
}

/** The doubling cube centred on (cx, cy): a small linen tile with the value in mono. */
export function Cube({ cx, cy, value, size = CUBE, offered = false }: { cx: number; cy: number; value: number; size?: number; offered?: boolean }) {
  const h = size / 2;
  return (
    <g className={`${s.cube} ${offered ? s.offered : ""}`} aria-label={`Cube ${value}`}>
      <rect x={cx - h + 0.3} y={cy - h + 1.4} width={size} height={size} rx={5} className={s.shadow} />
      <rect x={cx - h} y={cy - h} width={size} height={size} rx={5} className={offered ? s.cubeTileOffered : s.cubeTile} />
      <text x={cx} y={cy + size * 0.15} textAnchor="middle" className={s.cubeText} style={{ fontSize: size * (value >= 10 ? 0.38 : 0.44) }}>
        {value}
      </text>
    </g>
  );
}
