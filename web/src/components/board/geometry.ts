// Board geometry, in SVG user units (the SVG scales to its container).
//
// Locations ("loc") use BoardView's screen numbering, the same as
// onPointClick: 0..23 = points in the human's perspective (human point i+1),
// 24 = bar, -1 = off (the bear-off tray). A location plus a side (0 = gnubg,
// drawn from the top; 1 = human, from the bottom) says where a checker is.
//
// Layout, normal direction (left to right):
//   frame | 6 points | bar | 6 points | rail | tray | frame
// Flipped ("home board on the left"): the mirror image.

export const FS = 14; // side frame
export const FT = 22; // top / bottom frame (holds the point numbers)
export const PW = 52; // point width
export const R = 24; // checker radius (stack pitch = 2R)
export const BAR = 56; // middle bar
export const RAIL = 8; // strip between the field and the tray
export const TRAY_W = 58;
export const STACK = 5; // checkers drawn per point before a count is shown
export const BAR_STACK = 3; // the same on the bar
export const FIELD_H = 2 * STACK * 2 * R + 64; // both stacks plus the middle gap
export const PLEN = 4.55 * 2 * R; // point length
export const W = FS + 12 * PW + BAR + RAIL + TRAY_W + FS;
export const H = FT + FIELD_H + FT;
export const MID = H / 2;
export const DIE = 42;
export const CUBE = 40;
export const SLICE_H = 12; // a borne-off checker seen edge-on
export const SLICE_PITCH = 14.5;

export type Side = 0 | 1;
export interface Pt {
  x: number;
  y: number;
}

/** Left edge of the playing field (the 12 points and the bar). */
export function fieldX0(flipped: boolean): number {
  return flipped ? FS + TRAY_W + RAIL : FS;
}
export function barX(flipped: boolean): number {
  return fieldX0(flipped) + 6 * PW;
}
export function trayX(flipped: boolean): number {
  return flipped ? FS : W - FS - TRAY_W;
}

/** Column (0..11, left to right) and row of a point 0..23. */
export function place(i: number, flipped: boolean): { col: number; top: boolean } {
  const p = i + 1;
  if (p <= 12) return { col: flipped ? p - 1 : 12 - p, top: false };
  return { col: flipped ? 24 - p : p - 13, top: true };
}

export function colX(col: number, flipped: boolean): number {
  return fieldX0(flipped) + col * PW + (col >= 6 ? BAR : 0);
}

/** Which location is at SVG coordinates (x, y)? null = none. */
export function indexAt(x: number, y: number, flipped: boolean): number | null {
  const tx = trayX(flipped);
  // the tray column, including the rail next to it (a bigger touch target)
  if (flipped ? x < tx + TRAY_W + RAIL : x >= tx - RAIL) return x >= 0 && x <= W ? -1 : null;
  const bx = barX(flipped);
  if (x >= bx && x < bx + BAR) return 24;
  let col = -1;
  for (let c = 0; c < 12; c++) if (x >= colX(c, flipped) && x < colX(c, flipped) + PW) col = c;
  if (col < 0) {
    // the outer frame next to the field counts as the outermost column
    const x0 = fieldX0(flipped);
    const x1 = colX(11, flipped) + PW;
    if (x < x0 && x >= x0 - FS) col = 0;
    else if (x >= x1 && x < x1 + FS) col = 11;
    else return null;
  }
  const top = y < MID;
  for (let i = 0; i < 24; i++) {
    const pl = place(i, flipped);
    if (pl.col === col && pl.top === top) return i;
  }
  return null;
}

/** Centre of the k-th checker (0 = against the frame) on point i. */
export function pointSlot(i: number, k: number, flipped: boolean): Pt {
  const { col, top } = place(i, flipped);
  const kk = Math.min(k, STACK - 1);
  const x = colX(col, flipped) + PW / 2;
  const y = top ? FT + 1 + R + kk * 2 * R : H - FT - 1 - R - kk * 2 * R;
  return { x, y };
}

/** Bar checkers: gnubg's above the middle, the human's below, from the middle outwards. */
export function barSlot(side: Side, k: number, flipped: boolean): Pt {
  const kk = Math.min(k, BAR_STACK - 1);
  const d = CUBE / 2 + 10 + R + kk * 2 * R;
  return { x: barX(flipped) + BAR / 2, y: side === 0 ? MID - d : MID + d };
}

/** Borne-off checker k of a side, as an edge-on slice (top-left corner). */
export function sliceRect(side: Side, k: number, flipped: boolean): { x: number; y: number; w: number; h: number } {
  const w = TRAY_W - 14;
  const x = trayX(flipped) + 7;
  const y = side === 0 ? FT + 7 + k * SLICE_PITCH : H - FT - 7 - SLICE_H - k * SLICE_PITCH;
  return { x, y, w, h: SLICE_H };
}

/** Centre of the slot for checker k at a location of a side. */
export function slotAt(side: Side, loc: number, k: number, flipped: boolean): Pt {
  if (loc === 24) return barSlot(side, k, flipped);
  if (loc < 0) {
    const r = sliceRect(side, Math.max(0, Math.min(14, k)), flipped);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }
  return pointSlot(loc, k, flipped);
}

/** Centre of the left or right half of the field (dice, offered cube). */
export function halfCentre(rightHalf: boolean, flipped: boolean): Pt {
  const x0 = rightHalf ? barX(flipped) + BAR : fieldX0(flipped);
  return { x: x0 + 3 * PW, y: MID };
}
