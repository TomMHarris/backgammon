"use client";
// Settings: every preference lives here (nothing on the game screen).
// Changes apply immediately and are remembered in this browser.

import Dialog from "./ui/Dialog";
import { Segmented, SettingRow, Switch } from "./ui/controls";
import { HINT_LEVELS, type Settings, type Theme } from "@/lib/settings";
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
        <button className="btn btn-primary" onClick={onClose}>
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
