// Write a match record as a Jellyfish .mat file, the text format gnubg imports
// with "import mat" (import.c ImportMat) and writes with "export match mat".
//
// This is a line-by-line port of gnubg's own writer, ExportGameJF and
// ExportMatchMat in export.c (gnubg 1.08.003, lines 1035-1240 and 1295-1380),
// so the layout matches files exported by desktop gnubg (compare
// tests/corpus/matches/*.mat). Column positions matter: gnubg's importer
// finds the right-hand player's entry either by a second "NN:" dice field or
// by a double space after column 15 (import.c ImportGame).
//
// Layout of one game:
//    Game 1
//    gnubg : 0                     You : 0
//     1) 31: 8/5 6/5               64: 24/18 13/9
//     2)  Doubles => 2              Takes
//   ...
// Left column = player 0, right column = player 1. Points are numbered from
// the mover's side, 25 = bar, 0 = off; "*" marks a hit.

import type { Board } from "./board.ts";
import { applyPairs, gameStatus, initialBoard, swapSides } from "./board.ts";
import type { GameRecord, MatchRecord } from "./match.ts";

/** gnubg's FormatMovePlain (drawboard.c:533): "24/18* 18/15 " etc. */
export function formatMovePlain(board: Board, pairs: [number, number][]): string {
  let s = "";
  for (let i = 0; i < pairs.length; i++) {
    const [from, to] = pairs[i];
    s += `${from + 1}/${to + 1}`;
    // A hit: an opposing checker on the destination in the position before
    // the move, marked only the first time a checker lands there.
    if (to >= 0 && board[0][23 - to] > 0) {
      let earlier = false;
      for (let j = 0; j < i; j++) if (pairs[j][1] === to) earlier = true;
      if (!earlier) s += "*";
    }
    if (i < 3) s += " "; // gnubg adds a space after each of the first 3 parts
  }
  return s;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const plural = (n: number) => (n === 1 ? "" : "s");

/** Player names cannot contain ':' in a .mat file (it separates name and score). */
function cleanName(n: string): string {
  return n.replace(/[:\r\n]/g, " ").trim() || "Player";
}

function exportGame(g: GameRecord, names: [string, string]): string {
  let out = ` Game ${g.number}\n`;
  const left = `${names[0]} : ${g.score[0]}`;
  out += ` ${pad(left, 31)}${names[1]} : ${g.score[1]}\n`;

  let board: Board = initialBoard(); // from the side of the player to move next
  let i = 0; // gnubg's column counter: even = left (player 0), odd = right
  let fileCube = 1;
  let nDoubles = 0;

  for (let k = 0; k < g.actions.length; k++) {
    const a = g.actions[k];
    let sz = "";
    switch (a.type) {
      case "move": {
        sz = `${a.dice[0]}${a.dice[1]}: ` + formatMovePlain(board, a.pairs);
        board = swapSides(applyPairs(board, a.pairs));
        nDoubles = 0;
        break;
      }
      case "double":
      case "beaver":
        fileCube *= 2;
        // Jellyfish writes "Beavers" for a redouble within the same cube action.
        // One deviation from gnubg's exporter: a beaver that is then DROPPED
        // is written as "Doubles". gnubg 1.08.003's importer remembers a
        // "Beavers" line in a static flag (import.c ParseMatMove, fBeaver)
        // that only a following roll or "Takes" clears; after "Drops" it
        // stays set and corrupts the next game. The importer treats a second
        // "Doubles" in the same cube action as a beaver anyway
        // (play.c ApplyMoveRecord, MOVE_DOUBLE with fDoubled set).
        if (nDoubles === 0 || g.actions[k + 1]?.type === "drop") sz = ` Doubles => ${fileCube}`;
        else sz = ` Beavers => ${fileCube}`;
        nDoubles++;
        break;
      case "take":
        // After a beaver no "Takes" is written (export.c: "Don't print Takes
        // after a beaver or the following moves will be swapped").
        if (nDoubles % 2) {
          sz = nDoubles === 1 ? " Takes" : "  ";
        } else {
          nDoubles = 0;
          continue;
        }
        nDoubles = 0;
        break;
      case "drop":
        sz =
          " Drops" +
          (i & 1 ? "\n      " : "                       ") +
          `Wins ${fileCube / 2} point${plural(fileCube / 2)}`;
        break;
      case "resign": {
        const pts = a.value * fileCube;
        const w = `Wins ${pts} point${plural(pts)}\n`;
        // The winner's "Wins" goes in the winner's column (export.c:1143-1150;
        // we never record dice rolled before a resignation, so diceRolled = 0).
        if (a.player === 1) sz = (i & 1 ? "\n" : "") + "      " + w; // player 0 wins: left
        else sz = (i & 1 ? " " : " ".repeat(34)) + w; // player 1 wins: right
        break;
      }
    }

    // Player 1 moves first: leave the left half of line 1 empty.
    if (i === 0 && a.type === "move" && a.player === 1) {
      out += "  1)" + " ".repeat(29);
      i++;
    }

    if (i & 1 || a.type === "resign") {
      out += sz + "\n";
    } else {
      out += `${String((i >> 1) + 1).padStart(3)}) ${pad(sz, 27)} `;
    }

    if (a.type === "drop") {
      out += "\n";
      if (!(i & 1)) out += "\n";
    }

    if (a.type === "move") {
      const over = gameStatus(board);
      if (over) {
        const pts = over.value * fileCube;
        out += (i & 1 ? " ".repeat(34) : "\n      ") + `Wins ${pts} point${plural(pts)}\n\n`;
      }
    }
    i++;
  }
  return out;
}

/** The whole match as .mat text. */
export function toMatText(rec: MatchRecord, site = "gnubg-web"): string {
  const names: [string, string] = [cleanName(rec.playerNames[0]), cleanName(rec.playerNames[1])];
  let out = "";
  out += `; [Site "${site}"]\n`;
  out += `; [EventDate "${rec.date.replace(/-/g, ".")}"]\n`;
  // gnubg's importer ignores this tag (import.c), but it documents the
  // setting for human readers; re-import with "set jacoby" to match it.
  if (rec.matchLength === 0) out += `; [Jacoby "${rec.jacoby ? "On" : "Off"}"]\n`;
  out += "\n";
  out += ` ${rec.matchLength} point match\n\n`;
  for (const g of rec.games) out += exportGame(g, names);
  return out;
}
