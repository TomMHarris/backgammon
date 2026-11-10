// Engine side of the analysis page: load a match into gnubg, analyse it game
// by game (so the page can show progress and stop between games), fetch the
// analysis, export it. The same sequence as lib/analysis.ts (the game
// screen's end-of-game card) and engine/api/MATCH_API.md:
//   load_match -> set_analysis_settings -> analyse_game(0..n-1) -> get_analysis -> export_match

import type { EngineClient } from "@/engine/client";
import type { AnalysisResult, AnalysisSettingsEcho, MatchOverview, Preset } from "@/engine/types";

export interface MatchSource {
  format: "sgf" | "mat";
  text: string;
  name: string; // file name (or a description) shown on the page and used for downloads
}

/** The analysis strengths offered on the page (gnubg presets). */
export const ANALYSIS_PRESETS: { value: Preset; label: string; detail: string }[] = [
  { value: "expert", label: "Expert", detail: "0-ply · fast" },
  { value: "world class", label: "World class", detail: "2-ply" },
  { value: "supremo", label: "Supremo", detail: "2-ply, wider search · slow" },
];

/** sessionStorage hand-off from the game screen ("Full review"). */
export const REVIEW_KEY = "gnubg-web.reviewMatch";

/** How many alternatives get_analysis returns per move (plus the played move). */
const MAX_MOVES = 8;

/** Guess the format of a dropped / picked file from its name, then its content. */
export function sourceFromFile(name: string, text: string): MatchSource {
  const lower = name.toLowerCase();
  const format: "sgf" | "mat" =
    lower.endsWith(".sgf") ? "sgf" : lower.endsWith(".mat") || lower.endsWith(".txt") ? "mat" : text.trimStart().startsWith("(;") ? "sgf" : "mat";
  return { format, text, name };
}

/** Read the game screen's hand-off from sessionStorage (null if absent or invalid). */
export function readSessionSource(): MatchSource | null {
  try {
    const raw = sessionStorage.getItem(REVIEW_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<MatchSource>;
    if ((v.format !== "mat" && v.format !== "sgf") || typeof v.text !== "string" || !v.text) return null;
    return { format: v.format, text: v.text, name: typeof v.name === "string" && v.name ? v.name : "your match" };
  } catch {
    return null;
  }
}

export async function loadSource(engine: EngineClient, src: MatchSource): Promise<MatchOverview> {
  const info = await engine.loadMatch({ format: src.format, text: src.text });
  if (!info.games.length) throw new Error("gnubg found no games in this file.");
  return info;
}

export function fetchAnalysis(engine: EngineClient): Promise<AnalysisResult> {
  return engine.getAnalysis({ maxMoves: MAX_MOVES, text: true });
}

export interface RunProgress {
  game: number; // games finished
  games: number;
  records: number; // records finished (gnubg's unit for progress)
  totalRecords: number;
}

/**
 * Analyse every game of the loaded match with `preset` for chequer play and
 * cube decisions (gnubg's other analysis defaults: luck at 0-ply, the usual
 * thresholds). Existing analysis is cleared first, so the result is exactly
 * what this preset gives. `afterGame` runs after each game; returning false
 * (or `shouldStop()` turning true) stops before the next game.
 */
export async function analyseMatch(
  engine: EngineClient,
  info: MatchOverview,
  preset: Preset,
  opts: { onProgress?: (p: RunProgress) => void; afterGame?: () => Promise<void>; shouldStop?: () => boolean } = {}
): Promise<{ settings: AnalysisSettingsEcho; completed: number }> {
  await engine.clearAnalysis();
  const { settings } = await engine.setAnalysisSettings({ defaults: true, chequer: { preset }, cube: { preset } });
  const totalRecords = info.games.reduce((n, g) => n + g.records, 0);
  let records = 0;
  let completed = 0;
  opts.onProgress?.({ game: 0, games: info.games.length, records, totalRecords });
  for (const g of info.games) {
    if (opts.shouldStop?.()) break;
    await engine.analyseGame({ game: g.index });
    completed++;
    records += g.records;
    opts.onProgress?.({ game: completed, games: info.games.length, records, totalRecords });
    await opts.afterGame?.();
  }
  return { settings, completed };
}

export async function exportText(engine: EngineClient, format: "sgf" | "mat"): Promise<string> {
  return (await engine.exportMatch({ format })).text;
}

/** Save text as a file in the browser. */
export function download(text: string, fileName: string, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "selfplay-7pt.sgf" -> "selfplay-7pt-analysed". */
export function baseName(name: string): string {
  const base = name.replace(/\.(sgf|mat|txt)$/i, "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "match";
  return `${base}-analysed`;
}
