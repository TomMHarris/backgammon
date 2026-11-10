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
//     bear-off trays on the right.
//   Flipped ("home board on the left"): mirror image; trays on the left.
// Index 24 (bar) is drawn in the middle bar; -1 (off) is the tray.
//
// Geometry lives in board/geometry.ts, the board diff (slide animations) and
// the last-move trail layout in board/model.ts, the look in
// board/Board.module.css (board-local colour tokens, light and dark).
//
// Test hooks: the SVG has class "board"; the top checker of a movable stack
// has a halo circle.checker-movable behind it (circle.checker-selected when
// selected), centred on the checker; legal destinations are a
// polygon.point-target / rect.tray-target.

import { useId, useMemo, useRef, useState } from "react";
import type { Board, Dice } from "@/game/board";
import s from "./board/Board.module.css";
import {
  BAR,
  BAR_STACK,
  CUBE,
  DIE,
  FT,
  H,
  MID,
  PLEN,
  PW,
  R,
  STACK,
  TRAY_W,
  W,
  barSlot,
  barX,
  colX,
  halfCentre,
  indexAt,
  place,
  pointSlot,
  sliceRect,
  slotAt,
  trayX,
  type Pt,
  type Side,
} from "./board/geometry";
import { countAt, diffBoards, layoutTrail, type LastMove, type Slide } from "./board/model";
import { Cube, Defs, Die, StaticLayer } from "./board/parts";

export interface BoardViewProps {
  board: Board; // [gnubg, human], see above
  flipped: boolean;
  cube: number;
  cubeOwner: -1 | 0 | 1; // 0 = gnubg (top), 1 = human (bottom)
  cubeOffered?: boolean; // a double is pending: `cube` is the offered value, drawn in the doubler's half
  dice: Dice | null;
  diceOwner: 0 | 1 | null;
  usedDice?: number[]; // dice already played (shown faded)
  sources?: Set<number>; // human indices (0..24) that can move now
  selected?: number | null;
  targets?: Set<number>; // destinations of the selected checker (-1 = off)
  onPointClick?: (index: number) => void; // 0..23, 24 = bar, -1 = tray
  /** Right-click (context menu) on a point / the bar / the tray; same numbering as onPointClick. */
  onPointRightClick?: (index: number) => void;
  onDragMove?: (from: number, to: number) => void;
  canDrag?: (from: number) => Set<number> | null; // destinations when dragging from `from`
  /**
   * The last move played, drawn as a faint trail. player 0 = gnubg, 1 = human;
   * from / to in the same numbering as onPointClick (0..23 human-perspective
   * points, 24 = bar, -1 = off), for that player's checkers.
   */
  lastMove?: LastMove | null;
}

interface Drag {
  from: number;
  x: number;
  y: number;
  active: boolean;
  dests: Set<number>;
}
interface Anim {
  gen: number;
  slides: Slide[];
  drop: { to: number; x: number; y: number } | null; // a drag ended here: slide from the drop point
}

function boardKey(b: Board) {
  return b[0].join(",") + "|" + b[1].join(",");
}

const EMPTY = new Set<number>();

export default function BoardView(props: BoardViewProps) {
  const { board, flipped, cube, cubeOwner, dice, diceOwner, usedDice = [], lastMove = null } = props;
  const sources = props.sources ?? EMPTY;
  const uid = "bd" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const down = useRef<{ index: number | null; x: number; y: number } | null>(null);
  const [lastDrop, setLastDrop] = useState<Anim["drop"]>(null);

  // ---- what moved since the last board? (state derived during render) ----
  const key = boardKey(board);
  const [seen, setSeen] = useState({ key, board });
  const [anim, setAnim] = useState<Anim>({ gen: 0, slides: [], drop: null });
  if (seen.key !== key) {
    setSeen({ key, board });
    setAnim({ gen: anim.gen + 1, slides: diffBoards(seen.board, board) ?? [], drop: lastDrop });
    if (lastDrop) setLastDrop(null);
  }

  // ---- new dice: bump a counter so the dice remount and roll in ----
  const diceSig = dice && diceOwner !== null ? `${diceOwner}:${dice[0]}${dice[1]}` : "";
  const [roll, setRoll] = useState({ sig: diceSig, gen: 0 });
  if (roll.sig !== diceSig) setRoll({ sig: diceSig, gen: roll.gen + 1 });

  // ---- pointer input -------------------------------------------------------
  const toSvg = (clientX: number, clientY: number) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  };

  // Pointer events cover mouse, pen and touch. A press that does not move
  // is a click; a press on a movable checker that moves is a drag. Only the
  // primary button: right-click (and ctrl-click on a Mac) is the context menu.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (lastDrop) setLastDrop(null);
    if (e.ctrlKey && e.pointerType === "mouse" && props.onPointRightClick) return;
    const { x, y } = toSvg(e.clientX, e.clientY);
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
    const { x, y } = toSvg(e.clientX, e.clientY);
    const moved = drag.active || Math.hypot(x - down.current.x, y - down.current.y) > 8;
    if (!moved) return;
    setDrag({ ...drag, x, y, active: true });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const start = down.current;
    down.current = null;
    if (!start) return; // not a primary press that started on the board
    const { x, y } = toSvg(e.clientX, e.clientY);
    if (drag && drag.active) {
      const to = indexAt(x, y, flipped);
      setDrag(null);
      if (to !== null && drag.dests.has(to)) {
        setLastDrop({ to, x, y });
        props.onDragMove?.(drag.from, to);
      }
      return;
    }
    setDrag(null);
    if (start.index !== null) props.onPointClick?.(start.index);
  };
  const onContextMenu = (e: React.MouseEvent) => {
    if (!props.onPointRightClick) return; // leave the browser's menu alone
    e.preventDefault();
    // a long press on a touch screen also lands here: it is not a click or drag
    down.current = null;
    setDrag(null);
    const { x, y } = toSvg(e.clientX, e.clientY);
    const index = indexAt(x, y, flipped);
    if (index !== null) props.onPointRightClick(index);
  };

  // ---- derived drawing state -----------------------------------------------
  const dragging = drag?.active ? drag : null;
  const targets = dragging ? dragging.dests : (props.targets ?? EMPTY);
  const dropHover = dragging ? indexAt(dragging.x, dragging.y, flipped) : null;
  const selected = dragging ? null : (props.selected ?? null);

  // arrivals of the latest board change, by "side:location"
  const arrivals = new Map<string, Slide[]>();
  for (const sl of anim.slides) {
    const k = `${sl.side}:${sl.to}`;
    arrivals.set(k, [...(arrivals.get(k) ?? []), sl]);
  }
  let dropUsed = false;
  /** Offset (from - to) for a checker arriving at slot `k` of a location, or null. */
  const arrivalOffset = (side: Side, loc: number, k: number, cap: number, at: Pt): Pt | null => {
    const list = arrivals.get(`${side}:${loc}`);
    const sl = list?.find((a) => Math.min(a.toSlot, cap) === k);
    if (!sl) return null;
    let from = slotAt(side, sl.from, sl.fromSlot, flipped);
    if (!dropUsed && anim.drop && side === 1 && anim.drop.to === loc) {
      from = { x: anim.drop.x, y: anim.drop.y };
      dropUsed = true;
    }
    return { x: from.x - at.x, y: from.y - at.y };
  };

  const pieces: React.ReactElement[] = [];
  const moving: React.ReactElement[] = []; // checkers sliding in: drawn above the others
  const overlays: React.ReactElement[] = []; // target tints (under the checkers)
  const landings: React.ReactElement[] = []; // landing rings (over the checkers)

  /** One checker, with its movable / selected decoration and arrival slide. */
  const drawChecker = (key: string, side: Side, loc: number, k: number, cap: number, at: Pt, opts: { movable?: boolean; selected?: boolean; count?: number }) => {
    const human = side === 1;
    const lifted = !!opts.selected;
    // the halo carries the test hooks (circle.checker-movable / circle.checker-selected)
    const halo = (opts.movable || opts.selected) && (
      <circle
        cx={at.x}
        cy={at.y}
        r={R + (opts.selected ? 5 : 3.5)}
        data-index={loc}
        className={`${s.halo} ${opts.selected ? `${s.haloSelected} checker-selected` : `${s.haloMovable} checker-movable`}`}
      />
    );
    const inner = (
      <g className={`${lifted ? s.lift : ""} ${opts.movable ? s.movable : ""}`}>
        {halo}
        <use href={`#${uid}-${human ? "human" : "bot"}`} x={at.x} y={at.y} />
        {opts.count !== undefined && (
          <text x={at.x} y={at.y + 5} textAnchor="middle" className={`${s.count} ${human ? s.inkOnIvory : s.inkOnWalnut}`}>
            {opts.count}
          </text>
        )}
      </g>
    );
    const off = arrivalOffset(side, loc, k, cap, at);
    if (!off) {
      pieces.push(<g key={key}>{inner}</g>);
      return;
    }
    moving.push(
      <g key={`a${anim.gen}-${key}`} className={s.arrive} style={{ "--dx": `${off.x}px`, "--dy": `${off.y}px` } as React.CSSProperties}>
        {inner}
      </g>
    );
  };

  // points
  for (let i = 0; i < 24; i++) {
    let n = board[1][i];
    let side: Side = 1;
    if (board[0][23 - i] > 0) {
      n = board[0][23 - i];
      side = 0;
    }
    if (dragging && dragging.from === i) n -= 1; // the dragged checker follows the pointer
    const shown = Math.min(n, STACK);
    for (let k = 0; k < shown; k++) {
      const top = k === shown - 1;
      const human = side === 1;
      drawChecker(`c${i}-${k}`, side, i, k, STACK - 1, pointSlot(i, k, flipped), {
        selected: top && human && selected === i,
        movable: top && human && sources.has(i) && !dragging,
        count: top && n > STACK ? n : undefined,
      });
    }
    if (targets.has(i)) {
      const { col, top } = place(i, flipped);
      const x = colX(col, flipped);
      const baseY = top ? FT : H - FT;
      const tipY = top ? FT + PLEN : H - FT - PLEN;
      overlays.push(
        <polygon
          key={`t${i}`}
          points={`${x + 2.5},${baseY} ${x + PW - 2.5},${baseY} ${x + PW / 2},${tipY}`}
          data-index={i}
          className={`${s.target} point-target`}
          style={dropHover === i ? { fill: "var(--bd-target-hover)" } : undefined}
        />
      );
      // where the checker lands: on top of the human's stack, or on the blot it hits
      const blot = board[0][23 - i] === 1;
      const slot = blot ? 0 : Math.min(countAt(board, 1, i) - (dragging?.from === i ? 1 : 0), STACK - 1);
      const p = pointSlot(i, Math.max(0, slot), flipped);
      landings.push(<circle key={`l${i}`} cx={p.x} cy={p.y} r={R - 2} className={s.landing} />);
    }
  }

  // bar: gnubg's checkers above the middle, the human's below
  for (const side of [0, 1] as Side[]) {
    let n = board[side][24];
    if (side === 1 && dragging?.from === 24) n -= 1;
    const shown = Math.min(n, BAR_STACK);
    for (let k = 0; k < shown; k++) {
      const top = k === shown - 1;
      drawChecker(`bar${side}-${k}`, side, 24, k, BAR_STACK - 1, barSlot(side, k, flipped), {
        selected: side === 1 && top && selected === 24,
        movable: side === 1 && top && sources.has(24) && !dragging,
        count: top && n > BAR_STACK ? n : undefined,
      });
    }
  }

  // bear-off trays: gnubg's at the top, the human's at the bottom
  const tx = trayX(flipped);
  const tray: React.ReactElement[] = [];
  const ghosts: React.ReactElement[] = [];
  for (const side of [0, 1] as Side[]) {
    const off = countAt(board, side, -1);
    const ivory = side === 1;
    for (let k = 0; k < off; k++) {
      const r = sliceRect(side, k, flipped);
      const at = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      const arr = arrivalOffset(side, -1, k, 14, at);
      tray.push(
        <g key={arr ? `a${anim.gen}-off${side}-${k}` : `off${side}-${k}`} className={arr ? s.sliceIn : undefined}>
          <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={r.h / 2} className={ivory ? s.sliceIvory : s.sliceWalnut} />
          <line x1={r.x + 6} y1={r.y + 3} x2={r.x + r.w - 6} y2={r.y + 3} className={ivory ? s.sliceHiIvory : s.sliceHiWalnut} />
        </g>
      );
      if (arr) {
        // the round checker slides to the tray and settles into the slice
        ghosts.push(
          <g key={`g${anim.gen}-${side}-${k}`} className={s.ghost} style={{ "--dx": `${arr.x}px`, "--dy": `${arr.y}px` } as React.CSSProperties}>
            <use href={`#${uid}-${ivory ? "human" : "bot"}`} x={at.x} y={at.y} />
          </g>
        );
      }
    }
    if (off > 0)
      tray.push(
        <text key={`offn${side}`} x={tx + TRAY_W / 2} y={side === 0 ? MID - 17 : MID + 27} textAnchor="middle" className={s.trayCount}>
          {off}
        </text>
      );
  }
  if (targets.has(-1)) {
    overlays.push(
      <rect
        key="tt"
        x={tx}
        y={MID + 5}
        width={TRAY_W}
        height={MID - 5 - FT}
        rx={6}
        data-index={-1}
        className={`${s.trayTarget} tray-target`}
        style={dropHover === -1 ? { fill: "var(--bd-target-hover)" } : undefined}
      />
    );
    const r = sliceRect(1, Math.min(14, countAt(board, 1, -1)), flipped);
    landings.push(<rect key="ltray" x={r.x} y={r.y} width={r.w} height={r.h} rx={r.h / 2} className={s.landing} />);
  }

  // ---- cube ----------------------------------------------------------------
  const bx = barX(flipped);
  let cubeEl: React.ReactElement;
  if (props.cubeOffered) {
    // the doubler: the cube's owner, or else whoever did not play the last move
    const doubler = cubeOwner !== -1 ? cubeOwner : lastMove ? 1 - lastMove.player : null;
    // (unknown: on the bar, as large as the bar allows)
    const c = doubler === null ? { x: bx + BAR / 2, y: MID } : halfCentre((doubler === 1) !== flipped, flipped);
    cubeEl = <Cube cx={c.x} cy={c.y} value={cube} size={doubler === null ? CUBE * 1.15 : CUBE * 1.3} offered />;
  } else {
    const label = cubeOwner === -1 && cube === 1 ? 64 : cube;
    const y = cubeOwner === -1 ? MID - 2 : cubeOwner === 0 ? FT + 8 + CUBE / 2 : H - FT - 12 - CUBE / 2;
    cubeEl = <Cube cx={bx + BAR / 2} cy={y} value={label} />;
  }

  // ---- dice: on the right half for the side to move (mirrored if flipped) ----
  const diceEls: React.ReactElement[] = [];
  if (dice && diceOwner !== null) {
    const c = halfCentre((diceOwner === 1) !== flipped, flipped);
    const double = dice[0] === dice[1];
    const faces = double ? [dice[0], dice[0], dice[0], dice[0]] : [dice[0], dice[1]];
    const gap = 10;
    const total = faces.length * DIE + (faces.length - 1) * gap;
    const used = usedDice.slice();
    faces.forEach((v, k) => {
      let faded = false;
      if (double) faded = used.length > k;
      else {
        const u = used.indexOf(v);
        if (u >= 0) {
          used.splice(u, 1);
          faded = true;
        }
      }
      const x = c.x - total / 2 + k * (DIE + gap);
      diceEls.push(
        <g
          key={`r${roll.gen}-${k}`}
          className={s.roll}
          style={{ "--rx": `${k % 2 ? 14 : -14}px`, animationDelay: `${k * 45}ms` } as React.CSSProperties}
        >
          <Die uid={uid} x={x} y={MID - DIE / 2} value={v} faded={faded} human={diceOwner === 1} />
        </g>
      );
    });
  }

  // ---- last-move trail -------------------------------------------------------
  const trailSig = lastMove ? `${lastMove.player}:${lastMove.steps.map((st) => `${st.from}/${st.to}`).join(",")}` : "";
  const trail = useMemo(
    () => (lastMove && trailSig ? layoutTrail(board, lastMove, flipped) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trailSig, key, flipped]
  );
  // origins: a dashed outline where a checker started; destinations: a thin halo around where it ended
  const trailOrigins: React.ReactElement[] = [];
  const trailEnds: React.ReactElement[] = [];
  trail.forEach((st, k) => {
    if (st.origin) trailOrigins.push(<circle key={`to${k}`} cx={st.from.x} cy={st.from.y} r={R - 1} className={s.trailOrigin} />);
    if (!st.final) return;
    if (st.toLoc === -1) {
      const w = TRAY_W - 8;
      trailEnds.push(<rect key={`te${k}`} x={st.to.x - w / 2} y={st.to.y - 9} width={w} height={18} rx={9} className={s.trailEnd} />);
    } else trailEnds.push(<circle key={`te${k}`} cx={st.to.x} cy={st.to.y} r={R + 2} className={s.trailEnd} />);
  });
  const trailDim = selected !== null || dragging ? s.trailDim : undefined;

  return (
    <svg
      ref={svgRef}
      className={`board ${s.root}`}
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
      onContextMenu={onContextMenu}
    >
      <Defs uid={uid} />
      <StaticLayer flipped={flipped} />
      {overlays}
      <g className={trailDim}>
        <g key={`tro-${trailSig}`} className={`${s.trail} ${s.trailIn}`}>
          {trailOrigins}
        </g>
      </g>
      {tray}
      {pieces}
      {cubeEl}
      {moving}
      {ghosts}
      {landings}
      <g className={trailDim}>
        <g key={`tre-${trailSig}`} className={`${s.trail} ${s.trailIn}`}>
          {trailEnds}
        </g>
      </g>
      {diceEls}
      {dragging && (
        <g className={s.dragging} transform={`translate(${dragging.x} ${dragging.y - 3})`}>
          <circle r={R + 5} className={`${s.halo} ${s.haloSelected}`} />
          <circle cx={1} cy={5} r={R} className={s.shadow} />
          <use href={`#${uid}-human`} x={0} y={0} />
        </g>
      )}
    </svg>
  );
}
