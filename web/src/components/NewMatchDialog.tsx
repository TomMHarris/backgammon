"use client";
// "New match": the length (a match to 1, 3, 5, ... points, another length,
// or a money game with its Jacoby / beaver rules), the opponent (gnubg, or a
// second person at the same screen) and gnubg's strength. The choices are
// remembered in the settings.

import { useState } from "react";
import Dialog from "./ui/Dialog";
import { Switch } from "./ui/controls";
import { BOT_LEVELS, type Settings } from "@/lib/settings";
import type { Preset } from "@/engine/types";

const QUICK_LENGTHS = [1, 3, 5, 7, 9, 11];
const MAX_LENGTH = 25;

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
  const vsHuman = settings.opponent === "human";
  const vsOnline = settings.opponent === "online";
  const noBot = vsHuman || vsOnline;
  const len = settings.matchLength || 5;
  // "Other": a length chosen with the stepper (kept open until a preset is picked)
  const [otherOpen, setOtherOpen] = useState(false);
  const other = !money && (otherOpen || !QUICK_LENGTHS.includes(len));
  const setLen = (n: number) => set("matchLength", Math.max(1, Math.min(MAX_LENGTH, n)));

  const lengthOptions: { key: string; label: string; on: boolean; pick: () => void; testId: string; wide?: boolean }[] = [
    ...QUICK_LENGTHS.map((n) => ({
      key: String(n),
      label: String(n),
      on: !money && !other && len === n,
      pick: () => {
        setOtherOpen(false);
        setLen(n);
      },
      testId: `length-${n}`,
    })),
    {
      key: "other",
      label: "Other",
      on: other,
      pick: () => {
        setOtherOpen(true);
        if (money) setLen(len);
      },
      testId: "length-other",
      wide: true,
    },
    {
      key: "money",
      label: "Money",
      on: money,
      pick: () => {
        setOtherOpen(false);
        set("matchLength", 0);
      },
      testId: "length-money",
      wide: true,
    },
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New match"
      subtitle={canCancel ? "The current match will be abandoned." : undefined}
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
            {vsOnline ? "Create game link" : `Start ${money ? "money game" : `${len}-point match`}`}
          </button>
        </>
      }
    >
      <section className="field">
        <h3 className="field-label" id="opp-label">
          Opponent
        </h3>
        <div className="length-grid opponent-grid" role="radiogroup" aria-labelledby="opp-label">
          {(
            [
              ["gnubg", "gnubg"],
              ["human", "Two players"],
              ["online", "Online friend"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="radio"
              aria-checked={settings.opponent === value}
              className={`length-opt length-opt-wide ${settings.opponent === value ? "on" : ""}`}
              onClick={() => set("opponent", value)}
              data-testid={`opponent-${value}`}
            >
              {label}
            </button>
          ))}
        </div>
        {vsHuman && <p className="field-note">Two people take turns at this screen. gnubg still gives hints and analyses the games.</p>}
        {vsOnline && (
          <div className="online-fields">
            <p className="field-note">You get a link to send to a friend; the game starts when they open it. gnubg analyses each game for both of you.</p>
            <label className="setting-row online-name">
              <span className="setting-label">Your name</span>
              <input
                className="text-input"
                value={settings.playerName}
                maxLength={16}
                placeholder="Shown to your friend"
                onChange={(e) => set("playerName", e.target.value.replace(/\s+/g, ""))}
                data-testid="player-name"
              />
            </label>
            <Switch checked={settings.onlineHints} onChange={(v) => set("onlineHints", v)} label="Allow hints and the tutor" detail="For both players, during play" testId="online-hints" />
          </div>
        )}
      </section>

      <section className="field" role="radiogroup" aria-labelledby="len-label">
        <h3 className="field-label" id="len-label">
          Match length {!money && <span className="field-hint">Crawford rule</span>}
        </h3>
        <div className="length-grid">
          {lengthOptions.map((o) => (
            <button
              key={o.key}
              role="radio"
              aria-checked={o.on}
              className={`length-opt ${o.wide ? "length-opt-wide" : "num"} ${o.on ? "on" : ""}`}
              onClick={o.pick}
              data-testid={o.testId}
            >
              {o.label}
            </button>
          ))}
        </div>

        {other && (
          <div className="length-other">
            <span className="setting-label">Points</span>
            <div className="stepper">
              <button className="flat flat-sq" onClick={() => setLen(len - 1)} aria-label="One point fewer" disabled={len <= 1}>
                −
              </button>
              <output className="stepper-value num" aria-live="polite" data-testid="match-length">
                {len}
              </output>
              <button className="flat flat-sq" onClick={() => setLen(len + 1)} aria-label="One point more" disabled={len >= MAX_LENGTH}>
                +
              </button>
            </div>
          </div>
        )}

        {money && (
          <div className="money-rules">
            <Switch checked={settings.jacoby} onChange={(v) => set("jacoby", v)} label="Jacoby rule" testId="jacoby" />
            <Switch checked={settings.beavers} onChange={(v) => set("beavers", v)} label="Beavers" testId="beavers" />
          </div>
        )}
      </section>

      {!noBot && (
      <section className="field">
        <h3 className="field-label" id="level-label">
          gnubg&apos;s strength
        </h3>
        <div className="level-grid" role="radiogroup" aria-labelledby="level-label">
          {BOT_LEVELS.map((l) => {
            const on = settings.botLevel === l.value;
            return (
              <label key={l.value} className={`level ${on ? "on" : ""}`}>
                <input
                  type="radio"
                  name="bot-level"
                  value={l.value}
                  checked={on}
                  onChange={() => set("botLevel", l.value as Preset)}
                  data-testid={`level-${l.value.replace(/\s+/g, "-")}`}
                />
                <span className="level-dot" aria-hidden="true" />
                <span className="level-name">{l.label}</span>
                {l.slow && <span className="level-note">slower</span>}
              </label>
            );
          })}
        </div>
      </section>
      )}
    </Dialog>
  );
}
