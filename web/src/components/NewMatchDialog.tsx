"use client";
// "New match": format (match play / money), length, money-play rules and
// gnubg's strength. The choices are remembered in the settings.

import Dialog from "./ui/Dialog";
import { Segmented, Switch } from "./ui/controls";
import { BOT_LEVELS, type Settings } from "@/lib/settings";
import type { Preset } from "@/engine/types";

const QUICK_LENGTHS = [1, 3, 5, 7, 9, 11];

export default function NewMatchDialog({
  open,
  settings,
  set,
  onStart,
  onClose,
  canCancel,
}: {
  open: boolean;
  settings: Settings;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  onStart: () => void;
  onClose: () => void;
  canCancel: boolean; // a match is in progress
}) {
  const money = settings.matchLength === 0;
  const len = settings.matchLength || 5;
  const setLen = (n: number) => set("matchLength", Math.max(1, Math.min(25, n)));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New match"
      subtitle={canCancel ? "The current match will be abandoned." : "Play GNU Backgammon in your browser."}
      testId="new-match-dialog"
      className="dialog-newmatch"
      footer={
        <>
          {canCancel && (
            <button className="flat flat-quiet" onClick={onClose}>
              Cancel
            </button>
          )}
          <button className="flat flat-primary" onClick={onStart} data-testid="start" data-autofocus>
            Start {money ? "money game" : `${len}-point match`}
          </button>
        </>
      }
    >
      <section className="field">
        <h3 className="field-label">Format</h3>
        <Segmented
          label="Format"
          value={money ? "money" : "match"}
          onChange={(v) => set("matchLength", v === "money" ? 0 : len)}
          options={[
            { value: "match", label: "Match play" },
            { value: "money", label: "Money game" },
          ]}
          testId="format"
        />
      </section>

      {money ? (
        <section className="field field-switches">
          <Switch checked={settings.jacoby} onChange={(v) => set("jacoby", v)} label="Jacoby rule" detail="Gammons count only after the cube is turned" />
          <Switch checked={settings.beavers} onChange={(v) => set("beavers", v)} label="Beavers" detail="One beaver per double; no raccoons" />
        </section>
      ) : (
        <section className="field">
          <h3 className="field-label" id="len-label">
            Match length <span className="field-hint">Crawford rule applies</span>
          </h3>
          <div className="length-row" role="group" aria-labelledby="len-label">
            <div className="chips">
              {QUICK_LENGTHS.map((n) => (
                <button
                  key={n}
                  className={`chip ${settings.matchLength === n ? "on" : ""}`}
                  aria-pressed={settings.matchLength === n}
                  onClick={() => setLen(n)}
                  data-testid={`length-${n}`}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="stepper">
              <button className="flat flat-sq" onClick={() => setLen(len - 1)} aria-label="One point fewer" disabled={len <= 1}>
                −
              </button>
              <output className="stepper-value tnum" aria-live="polite" data-testid="match-length">
                {len}
              </output>
              <button className="flat flat-sq" onClick={() => setLen(len + 1)} aria-label="One point more" disabled={len >= 25}>
                +
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="field">
        <h3 className="field-label" id="level-label">
          gnubg&apos;s strength
        </h3>
        <div className="level-grid" role="radiogroup" aria-labelledby="level-label">
          {BOT_LEVELS.map((l) => (
            <label key={l.value} className={`level ${settings.botLevel === l.value ? "on" : ""}`}>
              <input
                type="radio"
                name="bot-level"
                value={l.value}
                checked={settings.botLevel === l.value}
                onChange={() => set("botLevel", l.value as Preset)}
                data-testid={`level-${l.value.replace(/\s+/g, "-")}`}
              />
              <span className="level-name">
                {l.label}
              </span>
              <span className="level-detail">{l.detail}</span>
            </label>
          ))}
        </div>
      </section>
    </Dialog>
  );
}
