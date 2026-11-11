"use client";
// Settings: every preference lives here (nothing on the game screen).
// Changes apply immediately and are remembered in this browser.

import Dialog from "./ui/Dialog";
import { Segmented, SettingRow, Switch } from "./ui/controls";
import { HINT_LEVELS, type BoardColours, type Settings, type Theme } from "@/lib/settings";

/** The board colour choices, each with its two point tones (light mode) for the swatch. */
const BOARD_COLOURS: { value: BoardColours; label: string; a: string; b: string; panel: string }[] = [
  { value: "linen", label: "Sand", a: "#e3d8c3", b: "#c5ae88", panel: "#f0ebe0" },
  { value: "blue", label: "Blue", a: "#bfd2e4", b: "#55789b", panel: "#eaeff4" },
  { value: "rose", label: "Rose", a: "#f3cdbb", b: "#b65a50", panel: "#f7eee9" },
  { value: "green", label: "Green", a: "#cbdcc0", b: "#5e7f57", panel: "#e9eee5" },
];
import type { Preset } from "@/engine/types";
import { playSound, unlockAudio } from "@/sound/sounds";

export default function SettingsDialog({
  open,
  settings: s,
  set,
  onClose,
}: {
  open: boolean;
  settings: Settings;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Settings"
      testId="settings-dialog"
      className="dialog-settings"
      footer={
        <button className="flat flat-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <section className="settings-group" aria-labelledby="sg-play">
        <h3 id="sg-play">Play</h3>
        <Switch checked={s.autoRoll} onChange={(v) => set("autoRoll", v)} label="Roll automatically" detail="When you cannot double" testId="auto-roll" />
        <Switch checked={s.autoConfirm} onChange={(v) => set("autoConfirm", v)} label="Confirm moves automatically" testId="auto-confirm" />
        <Switch checked={s.animation} onChange={(v) => set("animation", v)} label="Animate gnubg's moves" detail="Checker by checker" testId="animation" />
      </section>

      <section className="settings-group" aria-labelledby="sg-tutor">
        <h3 id="sg-tutor">Tutor and hints</h3>
        <Switch checked={s.tutor} onChange={(v) => set("tutor", v)} label="Tutor" detail="Warn before a mistake" testId="tutor" />
        {s.tutor && (
          <SettingRow label="Warn from" detail="gnubg's error thresholds">
            <Segmented
              label="Warn from"
              size="sm"
              value={s.tutorLevel}
              onChange={(v) => set("tutorLevel", v)}
              options={[
                { value: "doubtful", label: "Doubtful", title: "Equity loss of 0.03 or more" },
                { value: "bad", label: "Bad", title: "0.06 or more" },
                { value: "very bad", label: "Very bad", title: "0.12 or more" },
              ]}
              testId="tutor-level"
            />
          </SettingRow>
        )}
        <SettingRow label="Hint strength" detail="Hints, tutor and deeper analysis">
          <Segmented
            label="Hint strength"
            size="sm"
            value={s.hintLevel}
            onChange={(v) => set("hintLevel", v as Preset)}
            options={HINT_LEVELS.map((l) => ({ value: l.value, label: l.label, title: l.detail }))}
            testId="hint-level"
          />
        </SettingRow>
      </section>

      <section className="settings-group" aria-labelledby="sg-display">
        <h3 id="sg-display">Display</h3>
        <Switch checked={s.flipped} onChange={(v) => set("flipped", v)} label="Home board on the left" testId="flip" />
        <SettingRow label="Board">
          <div className="swatches" role="radiogroup" aria-label="Board colours" data-testid="board-colours">
            {BOARD_COLOURS.map((c) => (
              <button
                key={c.value}
                role="radio"
                aria-checked={s.boardColours === c.value}
                className={`swatch ${s.boardColours === c.value ? "on" : ""}`}
                onClick={() => set("boardColours", c.value)}
                title={c.label}
                data-testid={`board-${c.value}`}
              >
                <svg viewBox="0 0 36 24" aria-hidden="true">
                  <rect x="0.5" y="0.5" width="35" height="23" rx="3" fill={c.panel} stroke="rgba(0,0,0,0.12)" />
                  <polygon points="4,2 12,2 8,17" fill={c.a} />
                  <polygon points="14,2 22,2 18,17" fill={c.b} />
                  <polygon points="24,2 32,2 28,17" fill={c.a} />
                </svg>
                <span>{c.label}</span>
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow label="Theme">
          <Segmented
            label="Theme"
            size="sm"
            value={s.theme}
            onChange={(v) => set("theme", v as Theme)}
            options={[
              { value: "auto", label: "Auto" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            testId="theme"
          />
        </SettingRow>
      </section>

      <section className="settings-group" aria-labelledby="sg-sound">
        <h3 id="sg-sound">Sound</h3>
        <Switch
          checked={s.sound}
          onChange={(v) => {
            set("sound", v);
            unlockAudio();
          }}
          label="Sounds"
          detail="Dice, checkers, cube and results"
          testId="sound"
        />
        {s.sound && (
          <SettingRow label="Volume">
            <input
              type="range"
              className="range"
              min={0}
              max={1}
              step={0.05}
              value={s.volume}
              aria-label="Volume"
              onChange={(e) => set("volume", Number(e.target.value))}
              onPointerUp={() => {
                unlockAudio();
                playSound("place");
              }}
              onKeyUp={() => playSound("place")}
            />
          </SettingRow>
        )}
      </section>
    </Dialog>
  );
}
