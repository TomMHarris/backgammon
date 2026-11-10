// Dice from the browser's cryptographic random number generator.
//
// crypto.getRandomValues gives uniformly distributed bytes. 256 is not a
// multiple of 6, so taking `byte % 6` would make 1-4 slightly more likely
// than 5-6. Rejection sampling fixes that: bytes 252..255 are thrown away and
// redrawn, and 0..251 (42 full sets of 6) map evenly to 1..6.

import type { Dice } from "./board.ts";

export type DieSource = () => number;

export function cryptoDie(): number {
  const buf = new Uint8Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < 252) return (buf[0] % 6) + 1;
  }
}

export function rollDice(die: DieSource = cryptoDie): Dice {
  return [die(), die()];
}

/**
 * The opening roll: each player rolls one die; ties are rolled again.
 * Returns [gnubg's die, human's die] (player 0, player 1), never equal.
 */
export function rollOpening(die: DieSource = cryptoDie): Dice {
  for (;;) {
    const d: Dice = [die(), die()];
    if (d[0] !== d[1]) return d;
  }
}
