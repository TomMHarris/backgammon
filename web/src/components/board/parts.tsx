// Drawing pieces for BoardView: the shared <defs>, the static layer (frame,
// field, points, trays; memoised, it only changes with `flipped`), dice and
// the cube.

import { memo } from "react";
import s from "./Board.module.css";
import {
  BAR,
  CUBE,
  DIE,
  FT,
  H,
  MID,
  PLEN,
  PW,
  R,
  TRAY_W,
  W,
  barX,
  colX,
  fieldX0,
  place,
  trayX,
} from "./geometry";

/** Gradients and the two checker shapes, referenced as `#${uid}-human` / `#${uid}-bot`. */
export const Defs = memo(function Defs({ uid }: { uid: string }) {
  const body = (side: "human" | "bot") => {
    const ivory = side === "human";
    return (
      <g id={`${uid}-${side}`}>
        <circle cx={0.4} cy={1.6} r={R - 0.25} className={s.shadow} />
        <circle r={R - 0.75} fill={`url(#${uid}-g${side})`} />
        <circle r={R - 0.75} className={ivory ? s.ivoryRim : s.ebonyRim} />
        <circle r={R * 0.64} className={ivory ? s.ivoryRing : s.ebonyRing} />
      </g>
    );
  };
  return (
    <defs>
      <radialGradient id={`${uid}-ghuman`} cx="0.38" cy="0.3" r="0.78">
        <stop offset="0" className={s.sIvoryHi} />
        <stop offset="0.55" className={s.sIvory} />
        <stop offset="1" className={s.sIvoryLo} />
      </radialGradient>
      <radialGradient id={`${uid}-gbot`} cx="0.38" cy="0.3" r="0.78">
        <stop offset="0" className={s.sEbonyHi} />
        <stop offset="0.5" className={s.sEbony} />
        <stop offset="1" className={s.sEbonyLo} />
      </radialGradient>
      {body("human")}
      {body("bot")}
    </defs>
  );
});

/** Frame, playing field, points, point numbers, bar and the bear-off wells. */
export const StaticLayer = memo(function StaticLayer({ flipped }: { flipped: boolean }) {
  const x0 = fieldX0(flipped);
  const bx = barX(flipped);
  const tx = trayX(flipped);
  const fieldW = 6 * PW;
  const fieldH = H - 2 * FT;
  const els: React.ReactElement[] = [];
  for (let i = 0; i < 24; i++) {
    const { col, top } = place(i, flipped);
    const x = colX(col, flipped);
    const baseY = top ? FT : H - FT;
    const tipY = top ? FT + PLEN : H - FT - PLEN;
    const cls = (col + (top ? 0 : 1)) % 2 === 0 ? s.pointA : s.pointB;
    els.push(<polygon key={`p${i}`} points={`${x + 0.5},${baseY} ${x + PW - 0.5},${baseY} ${x + PW / 2},${tipY}`} className={cls} />);
    els.push(
      <text key={`n${i}`} x={x + PW / 2} y={top ? FT / 2 + 4 : H - FT / 2 + 4} textAnchor="middle" className={s.label}>
        {i + 1}
      </text>
    );
  }
  return (
    <g aria-hidden="true">
      <rect x={0} y={0} width={W} height={H} rx={12} className={s.frame} />
      <rect x={0.5} y={0.5} width={W - 1} height={H - 1} rx={11.5} className={s.frameHi} />
      <rect x={x0} y={FT} width={fieldW} height={fieldH} className={s.field} />
      <rect x={bx + BAR} y={FT} width={fieldW} height={fieldH} className={s.field} />
      {els}
      <rect x={x0 + 0.5} y={FT + 0.5} width={fieldW - 1} height={fieldH - 1} className={s.fieldEdge} />
      <rect x={bx + BAR + 0.5} y={FT + 0.5} width={fieldW - 1} height={fieldH - 1} className={s.fieldEdge} />
      <line x1={bx + BAR / 2} y1={FT + 6} x2={bx + BAR / 2} y2={H - FT - 6} className={s.barLine} />
      <rect x={tx} y={FT} width={TRAY_W} height={MID - 5 - FT} rx={6} className={s.well} />
      <rect x={tx} y={MID + 5} width={TRAY_W} height={MID - 5 - FT} rx={6} className={s.well} />
    </g>
  );
});

const SPOTS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [[0.27, 0.27], [0.73, 0.73]],
  3: [[0.27, 0.27], [0.5, 0.5], [0.73, 0.73]],
  4: [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]],
  5: [[0.27, 0.27], [0.73, 0.27], [0.5, 0.5], [0.27, 0.73], [0.73, 0.73]],
  6: [[0.27, 0.25], [0.73, 0.25], [0.27, 0.5], [0.73, 0.5], [0.27, 0.75], [0.73, 0.75]],
};

/** One die, top-left corner at (x, y). */
export function Die({ x, y, value, faded, human }: { x: number; y: number; value: number; faded: boolean; human: boolean }) {
  return (
    <g className={`${s.die} ${faded ? s.used : ""}`}>
      <rect x={x + 0.5} y={y + 2} width={DIE} height={DIE} rx={9} className={s.dieShadow} />
      <rect x={x} y={y} width={DIE} height={DIE} rx={9} className={human ? s.dieHuman : s.dieBot} />
      {(SPOTS[value] ?? []).map(([cx, cy], k) => (
        <circle key={k} cx={x + cx * DIE} cy={y + cy * DIE} r={DIE * 0.095} className={human ? s.pipHuman : s.pipBot} />
      ))}
    </g>
  );
}

/** The doubling cube centred on (cx, cy), `size` units wide. */
export function Cube({ cx, cy, value, size = CUBE, offered = false }: { cx: number; cy: number; value: number; size?: number; offered?: boolean }) {
  const h = size / 2;
  const depth = size * 0.09;
  return (
    <g className={`${s.cube} ${offered ? s.offered : ""}`} aria-label={`Cube ${value}`} role="img">
      <rect x={cx - h} y={cy - h + depth} width={size} height={size} rx={size * 0.18} className={s.cubeSide} />
      <rect x={cx - h} y={cy - h} width={size} height={size} rx={size * 0.18} className={s.cubeFace} />
      {offered && <rect x={cx - h - 4} y={cy - h - 4} width={size + 8} height={size + 8 + depth} rx={size * 0.24} className={s.cubeOfferRing} />}
      <text x={cx} y={cy + size * 0.17} textAnchor="middle" className={s.cubeText} style={{ fontSize: size * 0.47 }}>
        {value}
      </text>
    </g>
  );
}
