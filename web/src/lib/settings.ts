// The user's settings, remembered in this browser (localStorage).
//
// One object holds both the "New match" choices (so the dialog opens with the
// last match's settings) and the preferences from the Settings dialog.
// Storage can be unavailable (private windows, blocked cookies): every access
// is wrapped in try/catch and the app then simply uses the defaults.

import { useCallback, useEffect, useState } from "react";
import type { Preset } from "@/engine/types";
import type { Skill } from "@/game/tutor";

export type Theme = "auto" | "light" | "dark";

export interface Settings {
  // New match
  matchLength: number; // 0 = money session
  jacoby: boolean;
  beavers: boolean;
  botLevel: Preset;
  opponent: "gnubg" | "human"; // "human": two players take turns at this screen
  // Play
  autoConfirm: boolean;
  autoRoll: boolean;
  animation: boolean; // show gnubg's move checker by checker
  // Tutor and hints
  tutor: boolean;
  tutorLevel: Exclude<Skill, "none">;
  hintLevel: Preset; // hints, tutor checks and "Analyse deeper"
  // Display
  flipped: boolean; // home board on the left
  theme: Theme;
  // Sound
  sound: boolean;
  volume: number; // 0..1
}

export const DEFAULT_SETTINGS: Settings = {
  matchLength: 5,
  jacoby: true,
  beavers: true,
  botLevel: "expert",
  opponent: "gnubg",
  autoConfirm: false,
  autoRoll: true,
  animation: true,
  tutor: false,
  tutorLevel: "doubtful", // gnubg's default tutor skill (gnubg.c:266)
  hintLevel: "world class",
  flipped: false,
  theme: "auto",
  sound: true,
  volume: 0.35, // quiet by default
};

// The same key as before the redesign, so existing preferences carry over.
export const SETTINGS_KEY = "gnubg-web.options";

/** gnubg's playing strengths, with a short description for the New match dialog. */
export const BOT_LEVELS: { value: Preset; label: string; detail: string; slow?: boolean }[] = [
  { value: "beginner", label: "Beginner", detail: "Plays with a lot of noise" },
  { value: "casual play", label: "Casual", detail: "Noisy; makes regular mistakes" },
  { value: "intermediate", label: "Intermediate", detail: "Some noise; club strength" },
  { value: "advanced", label: "Advanced", detail: "Little noise; strong club player" },
  { value: "expert", label: "Expert", detail: "Neural net, no noise" },
  { value: "world class", label: "World class", detail: "Looks two rolls ahead" },
  { value: "supremo", label: "Supremo", detail: "Deeper search · slow", slow: true },
  { value: "grandmaster", label: "Grandmaster", detail: "Deepest search · very slow", slow: true },
];
export const HINT_LEVELS = BOT_LEVELS.filter((l) => ["expert", "world class", "supremo", "grandmaster"].includes(l.value));
export const levelLabel = (p: Preset) => BOT_LEVELS.find((l) => l.value === p)?.label ?? p;

/** Apply the theme choice to <html data-theme>; "auto" follows the system. */
export function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === "auto") delete el.dataset.theme;
  else el.dataset.theme = t;
}

/** Settings state that is loaded from and saved to localStorage. */
export function useSettings(): [Settings, <K extends keyof Settings>(k: K, v: Settings[K]) => void] {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_KEY);
      if (saved) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(saved) });
    } catch {
      /* storage unavailable or corrupt: keep the defaults */
    }
  }, []);
  useEffect(() => applyTheme(settings.theme), [settings.theme]);
  const set = useCallback(<K extends keyof Settings>(k: K, v: Settings[K]) => {
    setSettings((old) => {
      const next = { ...old, [k]: v };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  return [settings, set];
}
