// TypeScript types for the gnubg engine's JSON API (engine/api/*.c).
// Each request/response here mirrors one C function; the C files' header
// comments are the authoritative description of what each field means.

/** gnubg's predefined evaluation settings (eval.c aszSettings). */
export type Preset =
  | "beginner"
  | "casual play"
  | "intermediate"
  | "advanced"
  | "expert"
  | "world class"
  | "supremo"
  | "grandmaster"
  | "4ply";

/** Explicit evaluation settings (gnubg's evalcontext). */
export interface EvalSettings {
  plies?: number; // 0..4
  cubeful?: boolean;
  prune?: boolean;
  deterministic?: boolean;
  noise?: number;
}

/** The settings the engine actually used (echoed back in replies). */
export interface EvalSettingsUsed {
  plies: number;
  cubeful: boolean;
  prune: boolean;
  deterministic: boolean;
  noise: number;
}

/** A position as gnubg IDs. Without `match`: money game, cube centred, player 0 on roll. */
export interface PositionRef {
  position: string; // gnubg position ID, e.g. "4HPwATDgc/ABMA"
  match?: string; // gnubg match ID (cube, score, dice, who is on roll, ...)
}

/** Either a preset or explicit settings; neither = gnubg's default chequer settings. */
export interface WithSettings {
  preset?: Preset;
  eval?: EvalSettings;
}

/** Outcome probabilities for the player on roll (gnubg's 5 network outputs). */
export interface Probabilities {
  win: number;
  winGammon: number;
  winBackgammon: number;
  loseGammon: number;
  loseBackgammon: number;
}

export type Dice = [number, number];
/** A move as gnubg's (from, to) pairs, 0-based from the mover's side: 24 = bar, -1 = off. */
export type MovePairs = [number, number][];
/** board[1] = player on roll, board[0] = opponent; 25 entries each (index 24 = bar). */
export type Board = [number[], number[]];

// ---- evaluate / rank moves / cube --------------------------------------

export interface EvaluateResult {
  probs: Probabilities;
  cubelessEquity: number;
  /** Value after the player's best cube action; in match play a match-winning chance (MWC).
   *  null when the evaluation was cubeless. */
  cubefulEquity: number | null;
  /** The same value as an equity (match play: gnubg's EMG), on the scale of rankMoves and
   *  analyseCube. For desktop eval's "no double" cubeful value use analyseCube().equities.noDouble. */
  cubefulOptimal: number | null;
  eval: EvalSettingsUsed;
}

export interface RankedMove {
  move: string; // gnubg notation, e.g. "8/5 6/5"
  equity: number;
  diff: number; // equity minus the best move's equity (<= 0)
  probs: Probabilities;
  plies: number; // ply the move was finally evaluated at (gnubg's move filter)
  cubeful: boolean;
}
export interface RankMovesResult {
  moves: RankedMove[];
  eval: EvalSettingsUsed;
}

export interface CubeEquities {
  optimal: number;
  noDouble: number;
  doubleTake: number;
  doublePass: number;
}
export interface CubeAnalysis {
  equities: CubeEquities; // normalised money equity (match play: gnubg's EMG)
  mwc?: CubeEquities; // match winning chances, match play only
  decision: number; // gnubg's cubedecision enum
  recommendation: string; // e.g. "Double, take", "Too good to double, pass"
  percent: number | null;
  cubeAvailable: boolean;
  noDouble: { probs: Probabilities; cubelessEquity: number };
  eval: EvalSettingsUsed;
}

// ---- play mode ------------------------------------------------------------

export interface MatchInfo {
  matchId: string;
  dice: Dice; // [0, 0] = not rolled
  turn: number;
  move: number;
  resigned: number;
  doubled: boolean;
  cube: number;
  cubeOwner: number; // -1 centred, 0 or 1
  crawford: boolean;
  matchLength: number; // 0 = money
  score: [number, number];
  jacoby: boolean;
  gameState: number;
}

export interface PositionInfo {
  positionId: string;
  board: Board;
  pips: [number, number]; // [opponent, player on roll]
  borneOff: [number, number];
  positionClass: number;
  match?: MatchInfo;
}

export interface MakeIdsRequest {
  board?: Board;
  position?: string;
  dice?: Dice;
  turn?: number;
  move?: number;
  resigned?: number;
  doubled?: boolean;
  cube?: number;
  cubeOwner?: number;
  crawford?: boolean;
  matchLength?: number;
  score?: [number, number];
  jacoby?: boolean;
  gameState?: number;
}
export interface Ids {
  positionId: string;
  matchId: string;
}

export interface LegalMove {
  move: string;
  pairs: MovePairs;
  positionAfter: string; // mover's perspective
  positionAfterSwapped: string; // next player's perspective
}
export interface LegalMovesResult {
  count: number;
  moves: LegalMove[];
}

export interface BotMove {
  move: string | null; // null = no legal move
  pairs: MovePairs;
  positionAfter: string;
  positionAfterSwapped: string;
  equity?: number;
  eval: EvalSettingsUsed;
}
export interface BotDouble {
  double: boolean;
  reason: string;
  recommendation: string | null;
}
export interface BotTake {
  action: "take" | "drop" | "beaver";
  recommendation: string;
}

/** Progress while the engine downloads its data files. */
export interface LoadProgress {
  loaded: number;
  total: number;
  file: string;
}
