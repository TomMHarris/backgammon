// Board representation and gnubg's position/match IDs, in plain TypeScript.
//
// ---------------------------------------------------------------------------
// Board convention (the same as gnubg's TanBoard, see engine/api/gnubg_api_play.c)
//
//   board[side][i]   number of checkers of `side`
//     i = 0..23      that side's own point i+1, counted from ITS OWN home
//                    board (i = 0 is its ace point, i = 23 its 24-point)
//     i = 24         that side's bar
//   Checkers borne off = 15 - sum(board[side]).
//
// In every engine request, board[1] is the player ON ROLL and board[0] the
// opponent. A point is shared by both sides under two different numbers:
// my index i is the opponent's index 23 - i.
//
// Move pairs (from the engine and in game records) are [from, to] in the
// MOVER's numbering: 24 = from the bar, -1 = borne off.
//
// Players: as in desktop gnubg, player 0 is gnubg (the bot) and player 1 is
// the human. The app stores the board "as if player 1 were on roll", i.e.
// board[1] = human, board[0] = gnubg. For a request where gnubg is on roll we
// swap the two halves (swapSides). The screen mapping (which index is drawn
// where) lives in components/BoardView.tsx.
// ---------------------------------------------------------------------------

export type Side = 0 | 1;
/** board[0], board[1]: 25 numbers each (see above). */
export type Board = [number[], number[]];
export type Dice = [number, number];
/** [from, to] pairs in the mover's numbering: 24 = bar, -1 = off. */
export type MovePairs = [number, number][];

/** The standard starting position (the same for both sides). */
export function initialBoard(): Board {
  const side = () => {
    const s = new Array(25).fill(0);
    s[5] = 5; // 6-point
    s[7] = 3; // 8-point
    s[12] = 5; // mid-point (13)
    s[23] = 2; // back checkers (24)
    return s;
  };
  return [side(), side()];
}

export function cloneBoard(b: Board): Board {
  return [b[0].slice(), b[1].slice()];
}

/** The same position seen from the other player (gnubg's SwapSides). */
export function swapSides(b: Board): Board {
  return [b[1].slice(), b[0].slice()];
}

export function checkersLeft(side: number[]): number {
  return side.reduce((a, n) => a + n, 0);
}

export function borneOff(side: number[]): number {
  return 15 - checkersLeft(side);
}

/** Pip count of one side: a checker on index i needs i+1 pips (bar = 25). */
export function pipCount(side: number[]): number {
  let pips = 0;
  for (let i = 0; i < 25; i++) pips += side[i] * (i + 1);
  return pips;
}

/**
 * Apply move pairs for the player in board[1] (the mover), hitting single
 * opposing checkers on the way. Mirrors gnubg's ApplySubMove without the
 * legality checks: the moves come from the engine, which already checked them.
 * Returns a new board (still from the mover's perspective).
 */
export function applyPairs(b: Board, pairs: MovePairs): Board {
  const out = cloneBoard(b);
  for (const [from, to] of pairs) {
    out[1][from]--;
    if (to >= 0) {
      // My index `to` is the opponent's index 23 - to.
      if (out[0][23 - to] === 1) {
        out[0][23 - to] = 0;
        out[0][24]++; // hit: the opponent's checker goes to its bar
      }
      out[1][to]++;
    }
  }
  return out;
}

/**
 * Has the game ended, and how? gnubg's GameStatus/EvalOver (eval.c:2418,
 * eval.c:2158) for a board where `winner` has no checkers left:
 * 0 = still playing, 1 = single game, 2 = gammon (loser has borne off
 * nothing), 3 = backgammon (gammon, and the loser still has a checker on the
 * bar or in the winner's home board, i.e. loser indices 18..24).
 */
export function gameStatus(b: Board): { winner: Side; value: 1 | 2 | 3 } | null {
  for (const winner of [0, 1] as Side[]) {
    const loser = b[1 - winner];
    if (checkersLeft(b[winner]) > 0) continue;
    if (checkersLeft(loser) < 15) return { winner, value: 1 };
    for (let i = 18; i < 25; i++) if (loser[i] > 0) return { winner, value: 3 };
    return { winner, value: 2 };
  }
  return null;
}

/** A compact string key for a board (for comparing positions). */
export function boardKey(b: Board): string {
  return b[0].join(",") + "|" + b[1].join(",");
}

// ---------------------------------------------------------------------------
// gnubg position ID (positionid.c: oldPositionKey + oldPositionIDFromKey).
// For board[0] then board[1], for each of the 25 entries: n one-bits followed
// by a zero-bit. The 80 bits (little-endian within each byte) are written as
// 14 base64 characters.
// ---------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encode bytes the way gnubg does (3 bytes -> 4 characters, MSB first). */
function base64(bytes: number[], nChars: number): string {
  let out = "";
  let bitBuf = 0;
  let nBits = 0;
  for (const byte of bytes) {
    bitBuf = (bitBuf << 8) | byte;
    nBits += 8;
    while (nBits >= 6 && out.length < nChars) {
      out += B64[(bitBuf >> (nBits - 6)) & 63];
      nBits -= 6;
    }
    bitBuf &= (1 << nBits) - 1;
  }
  if (out.length < nChars && nBits > 0) out += B64[(bitBuf << (6 - nBits)) & 63];
  return out;
}

function unbase64(s: string, nBytes: number): number[] {
  const bytes: number[] = [];
  let bitBuf = 0;
  let nBits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error(`invalid ID character "${ch}"`);
    bitBuf = (bitBuf << 6) | v;
    nBits += 6;
    if (nBits >= 8) {
      bytes.push((bitBuf >> (nBits - 8)) & 255);
      nBits -= 8;
      bitBuf &= (1 << nBits) - 1;
    }
  }
  while (bytes.length < nBytes) bytes.push(0);
  return bytes.slice(0, nBytes);
}

/** gnubg position ID of a board (board[1] = player on roll). */
export function positionId(b: Board): string {
  const bytes = new Array(10).fill(0);
  let bit = 0;
  for (const side of [b[0], b[1]]) {
    for (let i = 0; i < 25; i++) {
      for (let k = 0; k < side[i]; k++, bit++) bytes[bit >> 3] |= 1 << (bit & 7);
      bit++; // the separating zero bit
    }
  }
  return base64(bytes, 14);
}

/** Decode a gnubg position ID (positionid.c: oldPositionFromKey). */
export function boardFromPositionId(id: string): Board {
  const bytes = unbase64(id, 10);
  const b: Board = [new Array(25).fill(0), new Array(25).fill(0)];
  let side = 0;
  let point = 0;
  for (let k = 0; k < 80 && side < 2; k++) {
    if (bytes[k >> 3] & (1 << (k & 7))) b[side][point]++;
    else if (++point === 25) {
      side++;
      point = 0;
    }
  }
  return b;
}

// ---------------------------------------------------------------------------
// gnubg match ID (matchid.c: MatchID). 66+1 bits, written as 12 base64
// characters. All player numbers are absolute (0 = gnubg, 1 = human here).
// ---------------------------------------------------------------------------

export interface MatchIdFields {
  cube: number; // 1, 2, 4, ...
  cubeOwner: -1 | Side;
  move: Side; // player on roll (whose perspective the position ID uses)
  turn: Side; // player who must act now (differs from `move` only while a double is pending)
  crawford: boolean; // this is the Crawford game
  gameState: number; // gnubg's gamestate enum: 1 = playing
  doubled: boolean;
  resigned: number;
  dice: Dice | null;
  matchLength: number; // 0 = money
  score: [number, number];
  jacoby: boolean;
}

export function matchId(f: MatchIdFields): string {
  const bytes = new Array(9).fill(0);
  const put = (pos: number, nBits: number, value: number) => {
    for (let i = 0; i < nBits; i++) {
      if (value & (1 << i)) bytes[(pos + i) >> 3] |= 1 << ((pos + i) & 7);
    }
  };
  const logCube = Math.round(Math.log2(f.cube));
  const [d0, d1] = f.dice ?? [0, 0];
  put(0, 4, logCube);
  put(4, 2, f.cubeOwner & 3); // -1 & 3 = 3 = centred
  put(6, 1, f.move);
  put(7, 1, f.crawford ? 1 : 0);
  put(8, 3, f.gameState);
  put(11, 1, f.turn);
  put(12, 1, f.doubled ? 1 : 0);
  put(13, 2, f.resigned);
  put(15, 3, Math.max(d0, d1) & 7); // gnubg stores the higher die first
  put(18, 3, Math.min(d0, d1) & 7);
  put(21, 15, f.matchLength & 0x7fff);
  put(36, 15, f.score[0] & 0x7fff);
  put(51, 15, f.score[1] & 0x7fff);
  put(66, 1, f.jacoby ? 0 : 1); // stored inverted
  return base64(bytes, 12);
}
