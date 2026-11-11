// "Click an empty point": PlayBuilder.toPoint (web/src/game/partialMove.ts)
// on the opening position, with the engine's legal moves.
//   node tests/point_click.mjs        (Node 24: runs the .ts modules directly)
import assert from "node:assert/strict";
import { loadEngine, ROOT } from "./lib/engine-node.mjs";

const { PlayBuilder } = await import(ROOT + "/web/src/game/partialMove.ts");
const { initialBoard, positionId } = await import(ROOT + "/web/src/game/board.ts");
const engine = await loadEngine();

const start = initialBoard(); // board[1] = the side to move
const pos = positionId(start);
const builder = (dice) => {
  const r = engine.call("gnubg_api_legal_moves", { position: pos, dice });
  assert.ok(r.ok, JSON.stringify(r));
  return new PlayBuilder(start, dice, r.moves);
};
// gnubg-style text of steps (mover's numbering: index i = point i+1, 24 = bar, -1 = off)
const text = (steps) => (steps ? steps.map((s) => `${s.from + 1}/${s.to + 1}`).join(" ") : "none");

const cases = [
  // [dice, clicked point (1..24), expected steps]
  [[3, 1], 5, "8/5 6/5"], // make the 5-point
  [[6, 1], 7, "13/7 8/7"], // make the bar point
  [[4, 2], 4, "8/4 6/4"], // make the 4-point
  [[5, 3], 3, "8/3 6/3"], // make the 3-point
  [[6, 4], 2, "8/2 6/2"], // make the 2-point
  [[5, 5], 3, "8/3 8/3"], // doubles: two checkers, two dice; the other two stay free
  [[6, 5], 18, "24/18"], // only one checker can get there: one step
  [[6, 2], 11, "13/11"], // likewise
  [[2, 1], 20, "none"], // out of reach (24/22/21 at most)
];
let n = 0;
for (const [dice, point, want] of cases) {
  const pb = builder(dice);
  const got = pb.toPoint([], point - 1);
  assert.equal(text(got), want, `${dice.join("-")} click ${point}`);
  // what was entered can always be completed to a legal play
  if (got) assert.ok(pb.nextSteps(got).length > 0 || pb.completedMove(got), "partial play must stay legal");
  n++;
}
// the tray: nothing to bear off at the start
assert.equal(builder([6, 5]).toPoint([], -1), null);
console.log(`point click test passed (${n} checked cases)`);
