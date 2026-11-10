"use client";
// The backgammon board, drawn as SVG. It only draws and reports clicks /
// drags; it knows nothing about rules (the parent passes which points are
// selectable and where the selected checker may go).
//
// Screen mapping. The board is passed from the HUMAN's side (board[1] =
// human, board[0] = gnubg; see game/board.ts). The human plays from the
// bottom, gnubg from the top. Human index i (0..23) is the human's point
// i+1; gnubg's index j is the human's index 23 - j.
//   Normal direction (human's home board bottom right, like gnubg's default):
//     bottom row, left to right: points 12 11 10 9 8 7 | 6 5 4 3 2 1
//     top row,    left to right: points 13 14 15 16 17 18 | 19 20 21 22 23 24
//     bear-off tray on the right, cube on the left.
//   Flipped ("home board on the left"): mirror image; tray left, cube right.
// Index 24 (bar) is drawn in the middle bar; -1 (off) is the tray.

import { useRef, useState } from "react";
import type { Board, Dice } from "@/game/board";

// Geometry (SVG user units; the SVG scales to its container).
const PW = 50; // point width
const BAR = 50; // middle bar width
const FRAME = 12;
const SIDE = 56; // tray / cube column at each side
const PLEN = 200; // point length
const GAP = 80; // space between the top and bottom points
const R = 22; // checker radius
const W = SIDE + FRAME + 12 * PW + BAR + FRAME + SIDE;
const H = FRAME + PLEN + GAP + PLEN + FRAME;
const MID = H / 2;
const FIELD_X0 = SIDE + FRAME; // left edge of the playing field
const BAR_X = FIELD_X0 + 6 * PW;
const MAX_SHOWN = 5; // checkers drawn per point before showing a count

export interface BoardViewProps {
  board: Board; // [gnubg, human], see above
  flipped: boolean;
  cube: number;
  cubeOwner: -1 | 0 | 1; // 0 = gnubg (top), 1 = human (bottom)
  cubeOffered?: boolean; // a double is pending: `cube` is the offered value, drawn in the middle
  dice: Dice | null;
  diceOwner: 0 | 1 | null;
  usedDice?: number[]; // dice already played (shown faded)
  sources?: Set<number>; // human indices (0..24) that can move now
  selected?: number | null;
  targets?: Set<number>; // destinations of the selected checker (-1 = off)
  onPointClick?: (index: number) => void; // 0..23, 24 = bar, -1 = tray
  onDragMove?: (from: number, to: number) => void;
  canDrag?: (from: number) => Set<number> | null; // destinations when dragging from `from`
}

/** Column (0..11, left to right) and row of a human point index 0..23. */
function place(i: number, flipped: boolean): { col: number; top: boolean } {
  const p = i + 1;
  if (p <= 12) return { col: flipped ? p - 1 : 12 - p, top: false };
  return { col: flipped ? 24 - p : p - 13, top: true };
}

function colX(col: number): number {
  return FIELD_X0 + col * PW + (col >= 6 ? BAR : 0);
}

/** Which human index is at SVG coordinates (x, y)? null = none. */
function indexAt(x: number, y: number, flipped: boolean): number | null {
  const trayX = flipped ? 0 : W - SIDE;
  if (x >= trayX && x < trayX + SIDE) return -1;
  if (x >= BAR_X && x < BAR_X + BAR) return 24;
  let col = -1;
  for (let c = 0; c < 12; c++) if (x >= colX(c) && x < colX(c) + PW) col = c;
  if (col < 0) return null;
  const top = y < MID;
  for (let i = 0; i < 24; i++) {
    const pl = place(i, flipped);
    if (pl.col === col && pl.top === top) return i;
  }
  return null;
}

function DieFace({ x, y, value, faded }: { x: number; y: number; value: number; faded: boolean }) {
  const s = 40;
  const pip = (cx: number, cy: number, k: number) => (
    <circle key={k} cx={x + cx * s} cy={y + cy * s} r={4} className="die-pip" />
  );
  const spots: Record<number, [number, number][]> = {
    1: [[0.5, 0.5]],
    2: [[0.25, 0.25], [0.75, 0.75]],
    3: [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]],
    4: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]],
    5: [[0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]],
    6: [[0.25, 0.22], [0.75, 0.22], [0.25, 0.5], [0.75, 0.5], [0.25, 0.78], [0.75, 0.78]],
  };
  return (
    <g opacity={faded ? 0.35 : 1}>
      <rect x={x} y={y} width={s} height={s} rx={7} className="die" />
      {spots[value].map(([cx, cy], k) => pip(cx, cy, k))}
    </g>
  );
}

export default function BoardView(props: BoardViewProps) {
  const { board, flipped, cube, cubeOwner, dice, diceOwner, usedDice = [] } = props;
  const sources = props.sources ?? new Set<number>();
  const targets = props.targets ?? new Set<number>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ from: number; x: number; y: number; active: boolean; dests: Set<number> } | null>(null);
  const down = useRef<{ index: number | null; x: number; y: number } | null>(null);

  const toSvg = (e: React.PointerEvent) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  };

  // Pointer events cover mouse, pen and touch. A press that does not move
  // is a click; a press on a movable checker that moves is a drag.
  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = toSvg(e);
    const index = indexAt(x, y, flipped);
    down.current = { index, x, y };
    const dests = index !== null && props.canDrag ? props.canDrag(index) : null;
    if (index !== null && dests && dests.size > 0) {
      svgRef.current?.setPointerCapture?.(e.pointerId); // keep receiving moves outside the checker
      setDrag({ from: index, x, y, active: false, dests });
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || !down.current) return;
    const { x, y } = toSvg(e);
    const moved = Math.hypot(x - down.current.x, y - down.current.y) > 8;
    setDrag({ ...drag, x, y, active: drag.active || moved });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const { x, y } = toSvg(e);
    const start = down.current;
    down.current = null;
    if (drag && drag.active) {
      const to = indexAt(x, y, flipped);
      setDrag(null);
      if (to !== null && drag.dests.has(to)) props.onDragMove?.(drag.from, to);
      return;
    }
    setDrag(null);
    if (start && start.index !== null) props.onPointClick?.(start.index);
  };

  // ---- drawing helpers ---------------------------------------------------
  const checker = (key: string, cx: number, cy: number, human: boolean, cls = "") => (
    <circle key={key} cx={cx} cy={cy} r={R - 1} className={`checker ${human ? "checker-human" : "checker-bot"} ${cls}`} />
  );

  const points: React.ReactElement[] = [];
  const pieces: React.ReactElement[] = [];
  for (let i = 0; i < 24; i++) {
    const { col, top } = place(i, flipped);
    const x = colX(col);
    const baseY = top ? FRAME : H - FRAME;
    const tipY = top ? FRAME + PLEN - 20 : H - FRAME - PLEN + 20;
    const shade = (col + (top ? 1 : 0)) % 2 === 0 ? "point-a" : "point-b";
    points.push(
      <polygon
        key={`p${i}`}
        points={`${x},${baseY} ${x + PW},${baseY} ${x + PW / 2},${tipY}`}
        className={`point ${shade} ${targets.has(i) ? "point-target" : ""}`}
      />
    );
    points.push(
      <text key={`n${i}`} x={x + PW / 2} y={top ? FRAME - 2 : H - 2} className="point-label" textAnchor="middle">
        {i + 1}
      </text>
    );
    // checkers: human's on index i, gnubg's on gnubg index 23 - i
    let n = board[1][i];
    let human = true;
    if (board[0][23 - i] > 0) {
      n = board[0][23 - i];
      human = false;
    }
    if (drag?.active && drag.from === i) n -= 1; // the dragged checker follows the pointer
    const shown = Math.min(n, MAX_SHOWN);
    for (let k = 0; k < shown; k++) {
      const cy = top ? FRAME + R + k * 2 * R : H - FRAME - R - k * 2 * R;
      const isTop = k === shown - 1;
      let cls = "";
      if (isTop && human && selectedIs(props.selected, i)) cls = "checker-selected";
      else if (isTop && human && sources.has(i)) cls = "checker-movable";
      pieces.push(checker(`c${i}-${k}`, x + PW / 2, cy, human, cls));
    }
    if (n > MAX_SHOWN) {
      const cy = top ? FRAME + R + (shown - 1) * 2 * R : H - FRAME - R - (shown - 1) * 2 * R;
      pieces.push(
        <text key={`cnt${i}`} x={x + PW / 2} y={cy + 6} textAnchor="middle" className={`checker-count ${human ? "on-human" : "on-bot"}`}>
          {n}
        </text>
      );
    }
  }

  // bar: gnubg's checkers in the upper half, the human's in the lower half
  const barPieces: React.ReactElement[] = [];
  for (const side of [0, 1] as const) {
    let n = board[side][24];
    if (side === 1 && drag?.active && drag.from === 24) n -= 1;
    const shown = Math.min(n, 3);
    for (let k = 0; k < shown; k++) {
      const cy = side === 0 ? MID - 30 - R - k * 2 * R : MID + 30 + R + k * 2 * R;
      let cls = "";
      if (side === 1 && k === shown - 1) {
        if (selectedIs(props.selected, 24)) cls = "checker-selected";
        else if (sources.has(24)) cls = "checker-movable";
      }
      barPieces.push(checker(`bar${side}-${k}`, BAR_X + BAR / 2, cy, side === 1, cls));
    }
    if (n > 3) {
      const cy = side === 0 ? MID - 30 - R - 2 * 2 * R : MID + 30 + R + 2 * 2 * R;
      barPieces.push(
        <text key={`barc${side}`} x={BAR_X + BAR / 2} y={cy + 6} textAnchor="middle" className={`checker-count ${side ? "on-human" : "on-bot"}`}>
          {n}
        </text>
      );
    }
  }

  // bear-off tray: gnubg's borne-off checkers at the top, the human's at the bottom
  const trayX = flipped ? 0 : W - SIDE;
  const tray: React.ReactElement[] = [];
  for (const side of [0, 1] as const) {
    const off = 15 - board[side].reduce((a, b) => a + b, 0);
    for (let k = 0; k < off; k++) {
      const y = side === 0 ? FRAME + 4 + k * 12 : H - FRAME - 14 - k * 12;
      tray.push(
        <rect key={`off${side}-${k}`} x={trayX + 8} y={y} width={SIDE - 16} height={10} rx={3} className={`checker ${side ? "checker-human" : "checker-bot"}`} />
      );
    }
    if (off > 0)
      tray.push(
        <text key={`offn${side}`} x={trayX + SIDE / 2} y={side === 0 ? FRAME + 4 + off * 12 + 14 : H - FRAME - 14 - off * 12 - 4} textAnchor="middle" className="tray-label">
          {off}
        </text>
      );
  }

  // cube in the column opposite the tray
  const cubeX = (flipped ? W - SIDE : 0) + 8;
  const cubeY = props.cubeOffered || cubeOwner === -1 ? MID - 20 : cubeOwner === 0 ? FRAME + 6 : H - FRAME - 46;
  const cubeLabel = cubeOwner === -1 && cube === 1 ? 64 : cube;

  // dice: the human's on the right half, gnubg's on the left (mirrored if flipped)
  const diceEls: React.ReactElement[] = [];
  if (dice && diceOwner !== null) {
    const rightHalf = (diceOwner === 1) !== flipped;
    const cx = rightHalf ? BAR_X + BAR + 3 * PW : FIELD_X0 + 3 * PW;
    const used = usedDice.slice();
    const faces = dice[0] === dice[1] ? [dice[0], dice[1]] : dice;
    faces.forEach((v, k) => {
      // with doubles, a die fades once two of its four moves are used
      let faded = false;
      if (dice[0] === dice[1]) faded = used.length >= (k + 1) * 2;
      else {
        const u = used.indexOf(v);
        if (u >= 0) {
          used.splice(u, 1);
          faded = true;
        }
      }
      diceEls.push(<DieFace key={`d${k}`} x={cx - 46 + k * 52} y={MID - 20} value={v} faded={faded} />);
    });
  }

  return (
    <svg
      ref={svgRef}
      className="board"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Backgammon board"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        setDrag(null);
        down.current = null;
      }}
    >
      <rect x={0} y={0} width={W} height={H} rx={10} className="board-frame" />
      <rect x={FIELD_X0} y={FRAME} width={6 * PW} height={H - 2 * FRAME} className="board-field" />
      <rect x={BAR_X + BAR} y={FRAME} width={6 * PW} height={H - 2 * FRAME} className="board-field" />
      <rect x={BAR_X} y={0} width={BAR} height={H} className="board-bar" />
      <rect x={trayX + 4} y={FRAME} width={SIDE - 8} height={H - 2 * FRAME} rx={4} className={`board-tray ${targets.has(-1) ? "tray-target" : ""}`} />
      {points}
      {pieces}
      {barPieces}
      {tray}
      <g className="cube" aria-label={`Cube ${cube}`}>
        <rect x={cubeX} y={cubeY} width={40} height={40} rx={6} className={`cube-face ${props.cubeOffered ? "cube-offered" : ""}`} />
        <text x={cubeX + 20} y={cubeY + 27} textAnchor="middle" className="cube-text">
          {cubeLabel}
        </text>
      </g>
      {diceEls}
      {drag?.active && checker("drag", drag.x, drag.y, true, "checker-dragging")}
    </svg>
  );
}

function selectedIs(sel: number | null | undefined, i: number) {
  return sel !== null && sel !== undefined && sel === i;
}
