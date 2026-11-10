// Typed client for the gnubg engine running in a Web Worker.
//
//   const engine = getEngine();                 // starts loading (once)
//   engine.onProgress = (p) => ...;             // data download progress
//   await engine.ready;                         // resolves with gnubg's version
//   const r = await engine.rankMoves({ position, match, preset: "world class" });
//
// Every method returns a Promise. Requests run one at a time, in order, in
// the worker (public/engine/engine.worker.mjs). An engine-side error (reply
// with ok: false) rejects the promise with an EngineError.

import type {
  AnalysisResult,
  AnalysisSettingsEcho,
  AnalysisSettingsRequest,
  BotDouble,
  BotMove,
  BotTake,
  CubeAnalysis,
  Dice,
  EvaluateResult,
  Ids,
  LegalMovesResult,
  LoadProgress,
  MakeIdsRequest,
  MatchOverview,
  PositionInfo,
  PositionRef,
  RankMovesResult,
  WithSettings,
} from "./types";

export class EngineError extends Error {}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class EngineClient {
  /** Resolves with gnubg's version string once data files are loaded. */
  readonly ready: Promise<string>;
  /** Called repeatedly while the data files download. */
  onProgress: ((p: LoadProgress) => void) | null = null;

  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(workerUrl = "/engine/engine.worker.mjs") {
    this.worker = new Worker(workerUrl, { type: "module" });
    let resolveReady!: (v: string) => void;
    let rejectReady!: (e: Error) => void;
    this.ready = new Promise<string>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    this.worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      switch (msg.type) {
        case "progress":
          this.onProgress?.({ loaded: msg.loaded, total: msg.total, file: msg.file });
          break;
        case "ready":
          resolveReady(msg.version);
          break;
        case "init-error":
          rejectReady(new EngineError(msg.error));
          break;
        case "result": {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (!p) break;
          if (msg.result && msg.result.ok) p.resolve(msg.result);
          else p.reject(new EngineError(msg.result?.error ?? "engine error"));
          break;
        }
        case "error": {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          p?.reject(new EngineError(msg.error));
          break;
        }
      }
    };
    this.worker.onerror = (e) => rejectReady(new EngineError(e.message || "worker failed to start"));
  }

  /** Low-level call of any gnubg_api_* function. */
  call<T>(fn: string, req: object): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, fn, req });
    });
  }

  evaluate(req: PositionRef & WithSettings) {
    return this.call<EvaluateResult>("gnubg_api_evaluate", req);
  }
  rankMoves(req: PositionRef & WithSettings & { dice?: Dice }) {
    return this.call<RankMovesResult>("gnubg_api_rank_moves", req);
  }
  analyseCube(req: PositionRef & WithSettings) {
    return this.call<CubeAnalysis>("gnubg_api_analyse_cube", req);
  }
  positionInfo(req: PositionRef) {
    return this.call<PositionInfo>("gnubg_api_position_info", req);
  }
  makeIds(req: MakeIdsRequest) {
    return this.call<Ids>("gnubg_api_make_ids", req);
  }
  legalMoves(req: PositionRef & { dice?: Dice }) {
    return this.call<LegalMovesResult>("gnubg_api_legal_moves", req);
  }
  botMove(req: PositionRef & WithSettings & { dice?: Dice }) {
    return this.call<BotMove>("gnubg_api_bot_move", req);
  }
  botDouble(req: PositionRef & WithSettings) {
    return this.call<BotDouble>("gnubg_api_bot_double", req);
  }
  /** Position/match of the DOUBLER, on roll, cube as before the double. */
  botTake(req: PositionRef & WithSettings & { beaversSoFar?: number }) {
    return this.call<BotTake>("gnubg_api_bot_take", req);
  }

  // ---- match import and analysis (engine/api/MATCH_API.md) ----------------
  /** Load a match as gnubg's current match ("load match" for SGF, "import mat" for .mat). */
  loadMatch(req: { format: "sgf" | "mat"; text: string }) {
    return this.call<MatchOverview>("gnubg_api_load_match", req);
  }
  matchInfo() {
    return this.call<MatchOverview>("gnubg_api_match_info", {});
  }
  clearMatch() {
    return this.call<{ ok: true }>("gnubg_api_clear_match", {});
  }
  setAnalysisSettings(req: AnalysisSettingsRequest) {
    return this.call<{ settings: AnalysisSettingsEcho }>("gnubg_api_set_analysis_settings", req);
  }
  /** "analyse game" for game `game` (0-based) of the current match. */
  analyseGame(req: { game: number; settings?: AnalysisSettingsRequest }) {
    return this.call<{ settings: AnalysisSettingsEcho }>("gnubg_api_analyse_game", req);
  }
  analyseMatch(req: { settings?: AnalysisSettingsRequest } = {}) {
    return this.call<{ settings: AnalysisSettingsEcho }>("gnubg_api_analyse_match", req);
  }
  clearAnalysis() {
    return this.call<{ ok: true }>("gnubg_api_clear_analysis", {});
  }
  /** The analysis plus gnubg's statistics (the "show statistics match/game" values). */
  getAnalysis(req: { maxMoves?: number; game?: number; text?: boolean } = {}) {
    return this.call<AnalysisResult>("gnubg_api_get_analysis", req);
  }
  exportMatch(req: { format: "sgf" | "mat" }) {
    return this.call<{ format: string; text: string }>("gnubg_api_export_match", req);
  }

  terminate() {
    this.worker.terminate();
  }
}

let shared: EngineClient | null = null;
/** The page-wide engine instance (created on first use, browser only). */
export function getEngine(): EngineClient {
  if (!shared) shared = new EngineClient();
  return shared;
}
