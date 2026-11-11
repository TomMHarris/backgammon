"use client";
// Help: how to move, keyboard shortcuts and a word about the engine. All
// explanatory text lives here so the game screen stays clean.

import Link from "next/link";
import Dialog from "./ui/Dialog";

const REPO = "https://github.com/TomMHarris/backgammon";
const REPO_DICE = `${REPO}/blob/main/web/src/game/dice.ts`;

const SHORTCUTS: [string[], string][] = [
  [["R"], "Roll the dice"],
  [["D"], "Double"],
  [["Enter"], "Confirm your move"],
  [["U", "⌫"], "Undo the last checker"],
  [["B"], "Take back the last move played"],
  [["S"], "Swap which die a click or tap uses"],
  [["H"], "Hint"],
  [["T", "P"], "Take / pass a double"],
  [["N"], "Next game"],
  [["L"], "Show or hide the side panel"],
  [["Esc"], "Close dialogs and panels"],
  [["?"], "This help"],
];

export default function HelpDialog({ open, onClose, version }: { open: boolean; onClose: () => void; version: string | null }) {
  return (
    <Dialog open={open} onClose={onClose} title="Help" testId="help-dialog" className="dialog-help">
      <section className="help-section">
        <h3>Moving checkers</h3>
        <ul className="help-list">
          <li>
            <strong>Click</strong> a checker to move it by the <strong>higher</strong> die; <strong>right-click</strong> to move it by the{" "}
            <strong>lower</strong> die. If only one die can move that checker, either click uses it.
          </li>
          <li>
            On a touch screen a <strong>tap</strong> uses the higher die. The <strong>Die 6</strong> button in the bottom row (or the S
            key) shows which die a click or tap uses; press it to swap.
          </li>
          <li>
            <strong>Drag</strong> a checker to the point you want, e.g. to move one checker by both dice.
          </li>
          <li>
            Undo takes back the last checker; Confirm (or a click on the dice) plays the move. Click the cube to double. The list button (top
            right) shows the moves so far and gnubg&apos;s hints.
          </li>
          <li>
            Played the wrong move? <strong>Take back</strong> in the ⋯ menu (or B) returns to the position before your last move, with the
            same dice.
          </li>
        </ul>
      </section>
      <section className="help-section">
        <h3>Keyboard</h3>
        <dl className="shortcuts">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={what}>
              <dt>
                {keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="help-section">
        <h3>Settings</h3>
        <p>
          The gear button holds every option: automatic rolls and confirmation, animation, the tutor (warns before a mistake, at gnubg&apos;s
          doubtful / bad / very bad thresholds), hint strength, board orientation, light or dark theme, and sounds (on or off, with a volume
          slider).
        </p>
      </section>
      <section className="help-section">
        <h3>After each game</h3>
        <p>
          gnubg analyses the game with its own match analysis and shows error rates, luck and your biggest mistakes. Click a mistake to see the
          position. &ldquo;Analyse deeper&rdquo; repeats the analysis at your hint strength.
        </p>
      </section>
      <section className="help-section">
        <h3>The dice</h3>
        <p>
          The dice are rolled in your browser with its cryptographic random number generator (<code>crypto.getRandomValues</code>), the
          same way for you and for gnubg, and gnubg does not see a roll before it is made. gnubg&apos;s luck rating in the summary measures how
          good each side&apos;s rolls were; over a short match it can swing a long way either way. The code is{" "}
          <a href={REPO_DICE}>here</a>.
        </p>
      </section>
      <section className="help-section">
        <h3>Reviewing a match</h3>
        <p>
          &ldquo;Full review&rdquo; in the summary after a game opens the whole match on the review page. You can also{" "}
          <Link href="/analysis" prefetch={false}>
            review a match from a .mat file
          </Link>
          .
        </p>
      </section>
      <footer className="help-about">
        <span>GNU Backgammon {version ?? ""} runs entirely in your browser. This site is free software (GPL v3).</span>
        <span className="help-about-links">
          <a href={REPO} className="help-about-link" data-testid="source-link">
            Source on GitHub
          </a>
          <Link href="/about" prefetch={false} className="help-about-link" data-testid="about-link">
            About &amp; licence
          </Link>
        </span>
      </footer>
    </Dialog>
  );
}
