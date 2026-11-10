"use client";
// The play page: loads the engine, runs the match, and lets the human play
// gnubg. The rules and the game record live in web/src/game/ (match.ts is the
// state machine; its header lists the phases). This component:
//   - keeps the MatchState in React state and applies match.ts transitions;
//   - asks the engine for gnubg's actions whenever it is gnubg's turn
//     (an effect that runs on every state change, see "gnubg's turn");
//   - asks the engine for the human's legal moves once per roll and lets the
//     human enter a move checker by checker (PlayBuilder);
//   - shows hints and, in tutor mode, warns before a bad move or cube action.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BoardView from "./BoardView";
import HintPanel, { type Hint } from "./HintPanel";
import { EngineClient, getEngine } from "@/engine/client";
import type { CubeAnalysis, LoadProgress, Preset } from "@/engine/types";
import type { Board, Dice, Side } from "@/game/board";
import { applyPairs, pipCount, swapSides } from "@/game/board";
import { rollDice, rollOpening } from "@/game/dice";
import {
  type MatchSettings,
  type MatchState,
  type GameAction,
  beaver,
  canBeaver,
  canDouble,
  double,
  drop,
  idsFor,
  matchWinner,
  move,
  newMatch,
  nextGame,
  openingRoll,
  resign,
  responder,
  roll,
  take,
} from "@/game/match";
import { PlayBuilder, type Step } from "@/game/partialMove";
import { botAcceptsResignation, botAnswerDouble, botChooseMove, botWantsToDouble } from "@/game/bot";
import { toMatText } from "@/game/matFile";
import { doubleError, dropError, noDoubleError, skill, takeError, tutorWarns, type Skill } from "@/game/tutor";

const BOT_LEVELS: { value: Preset; label: string }[] = [
  { value: "beginner", label: "Beginner" },
  { value: "casual play", label: "Casual play" },
  { value: "intermediate", label: "Intermediate" },
  { value: "advanced", label: "Advanced" },
  { value: "expert", label: "Expert" },
  { value: "world class", label: "World class" },
  { value: "supremo", label: "Supremo (slow)" },
  { value: "grandmaster", label: "Grandmaster (very slow)" },
];
const HINT_LEVELS = BOT_LEVELS.filter((l) => ["expert", "world class", "supremo", "grandmaster"].includes(l.value));

interface Options {
  matchLength: number; // 0 = money
  jacoby: boolean;
  beavers: boolean;
  botLevel: Preset;
  autoConfirm: boolean;
  autoRoll: boolean;
  flipped: boolean;
  tutor: boolean;
  tutorLevel: Exclude<Skill, "none">;
  hintLevel: Preset;
}

const DEFAULT_OPTIONS: Options = {
  matchLength: 5,
  jacoby: true,
  beavers: true,
  botLevel: "expert",
  autoConfirm: false,
  autoRoll: true,
  flipped: false,
  tutor: false,
  tutorLevel: "doubtful", // gnubg's default tutor skill (gnubg.c:266)
  hintLevel: "world class",
};

const OPTIONS_KEY = "gnubg-web.options";
const NAMES: [string, string] = ["gnubg", "You"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmtEq = (x: number) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(3);
const points = (n: number) => `${n} point${n === 1 ? "" : "s"}`;

/** "You win" / "gnubg wins" */
const verb = (side: Side, you: string, it: string) => (side === 1 ? `You ${you}` : `gnubg ${it}`);

function describeResult(m: MatchState): string {
  const r = m.lastResult;
  if (!r) return "";
  const pts = points(r.points);
  switch (r.how) {
    case "drop":
      return r.winner === 1 ? `gnubg passes. You win ${pts}.` : `You pass. gnubg wins ${pts}.`;
    case "resign":
      return r.winner === 1 ? `gnubg resigns. You win ${pts}.` : `You resign. gnubg wins ${pts}.`;
    default: {
      const kind = r.how === "single" ? "a single game" : `a ${r.how}`;
      return `${verb(r.winner, "win", "wins")} ${kind} (${pts}).`;
    }
  }
}

function describeAction(a: GameAction): string {
  const who = a.player === 1 ? "You" : "gnubg";
  switch (a.type) {
    case "move":
      return `${who} ${a.dice[0]}-${a.dice[1]}: ${a.move || "(no move)"}`;
    case "double":
      return `${who} double${a.player ? "" : "s"} to ${a.cube}`;
    case "beaver":
      return `${who} beaver${a.player ? "" : "s"} (cube ${a.cube})`;
    case "take":
      return `${who} take${a.player ? "" : "s"}`;
    case "drop":
      return `${who} pass${a.player ? "" : "es"}`;
    case "resign":
      return `${who} resign${a.player ? "" : "s"} (${["single", "gammon", "backgammon"][a.value - 1]})`;
  }
}

interface TutorWarning {
  text: string;
  best: string;
  confirmLabel: string;
  onConfirm: () => void;
  cancelLabel: string;
  onCancel: () => void;
}

export default function Game() {
  // ---- engine -----------------------------------------------------------------
  const engineRef = useRef<EngineClient | null>(null);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const engine = getEngine();
    engineRef.current = engine;
    engine.onProgress = setProgress;
    engine.ready.then(setVersion).catch((e: Error) => setError(`The engine could not start: ${e.message}`));
  }, []);
  const ready = version !== null;
  const fail = useCallback((e: unknown) => {
    setError(`Engine error: ${e instanceof Error ? e.message : String(e)}`);
  }, []);

  // ---- options (remembered in this browser only) -----------------------------
  const [opts, setOpts] = useState<Options>(DEFAULT_OPTIONS);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(OPTIONS_KEY);
      if (saved) setOpts({ ...DEFAULT_OPTIONS, ...JSON.parse(saved) });
    } catch {
      /* storage unavailable: use defaults */
    }
  }, []);
  const setOpt = <K extends keyof Options>(k: K, v: Options[K]) =>
    setOpts((o) => {
      const n = { ...o, [k]: v };
      try {
        localStorage.setItem(OPTIONS_KEY, JSON.stringify(n));
      } catch {
        /* ignore */
      }
      return n;
    });

  // ---- match state ------------------------------------------------------------
  const [match, setMatch] = useState<MatchState | null>(null);
  const [botLevel, setBotLevel] = useState<Preset>("expert"); // fixed per match
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [anim, setAnim] = useState<{ board: Board; dice: Dice } | null>(null);
  const [hint, setHint] = useState<Hint | null>(null);
  const [warning, setWarning] = useState<TutorWarning | null>(null);
  const [resignOpen, setResignOpen] = useState(false);
  const [showSetup, setShowSetup] = useState(true);

  // The human's move in progress: groups of steps (one group per checker moved).
  const [builder, setBuilder] = useState<{ forMatch: MatchState; pb: PlayBuilder } | null>(null);
  const [groups, setGroups] = useState<Step[][]>([]);
  const [selected, setSelected] = useState<number | null>(null);

  /** Apply a transition, reporting rule errors instead of crashing. */
  const apply = useCallback((f: (m: MatchState) => MatchState) => {
    setMatch((m) => {
      if (!m) return m;
      try {
        return f(m);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return m;
      }
    });
  }, []);

  // Clear per-turn UI state whenever the match moves on.
  useEffect(() => {
    setHint(null);
    setWarning(null);
    setResignOpen(false);
  }, [match]);

  const startMatch = () => {
    const settings: MatchSettings = {
      matchLength: opts.matchLength,
      jacoby: opts.jacoby,
      beavers: opts.beavers,
      playerNames: NAMES,
    };
    setBotLevel(opts.botLevel);
    setError(null);
    setShowSetup(false);
    const m = openingRoll(newMatch(settings), rollOpening());
    setNotice(openingNotice(m));
    setMatch(m);
  };

  const startNextGame = () => {
    if (!match) return;
    // (Dice are rolled outside the state updater: React may call updaters twice.)
    const n = openingRoll(nextGame(match), rollOpening());
    setNotice(openingNotice(n));
    setMatch(n);
  };

  // ---- gnubg's turn ---------------------------------------------------------------
  // Runs after every state change. If gnubg has to act, ask the engine, then
  // apply the result -- but only if the state is still the one we looked at
  // (cur === m), so a new match started meanwhile is never overwritten.
  useEffect(() => {
    const engine = engineRef.current;
    if (!ready || !engine || !match) return;
    const m = match;
    let cancelled = false;
    const applyIfCurrent = (f: (x: MatchState) => MatchState) =>
      setMatch((cur) => (cur === m && !cancelled ? f(cur) : cur));

    async function run() {
      if (!engine) return;
      if (m.phase === "rolling" && m.turn === 0) {
        if (canDouble(m, 0)) {
          setBusy("gnubg is considering the cube…");
          const dbl = await botWantsToDouble(engine, m, 0, botLevel);
          if (cancelled) return;
          if (dbl) {
            setNotice(null);
            applyIfCurrent(double);
            return;
          }
        }
        setBusy("gnubg rolls…");
        await sleep(400);
        const dice = rollDice();
        applyIfCurrent((x) => roll(x, dice));
      } else if (m.phase === "moving" && m.turn === 0 && m.dice) {
        setBusy("gnubg is thinking…");
        const t0 = Date.now();
        const { pairs, move: text } = await botChooseMove(engine, m, botLevel);
        if (cancelled) return;
        if (Date.now() - t0 < 300) await sleep(300 - (Date.now() - t0));
        // Show gnubg's move one checker at a time.
        const start = swapSides(m.board); // gnubg's view
        for (let k = 1; k <= pairs.length; k++) {
          if (cancelled) return;
          setAnim({ board: swapSides(applyPairs(start, pairs.slice(0, k))), dice: m.dice });
          await sleep(420);
        }
        if (cancelled) return;
        setAnim(null);
        setNotice(text ? `gnubg plays ${m.dice[0]}-${m.dice[1]}: ${text}` : `gnubg rolls ${m.dice[0]}-${m.dice[1]} and cannot move.`);
        applyIfCurrent((x) => move(x, pairs, text));
      } else if (m.phase === "doubled" && responder(m) === 0) {
        setBusy("gnubg is considering your double…");
        const a = await botAnswerDouble(engine, m, botLevel);
        if (cancelled) return;
        if (a === "take") {
          setNotice(m.beavered ? "gnubg accepts your beaver." : `gnubg takes. The cube is at ${m.cube * 2}.`);
          applyIfCurrent(take);
        } else if (a === "drop") {
          applyIfCurrent(drop);
        } else {
          setNotice(`gnubg beavers! The cube would be at ${m.cube * 4}, owned by gnubg. Take or pass?`);
          applyIfCurrent(beaver);
        }
      }
    }
    run()
      .catch((e) => {
        if (!cancelled) fail(e);
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => {
      cancelled = true;
      setAnim(null);
    };
  }, [match, ready, botLevel, fail]);

  // ---- the human's turn: legal moves once per roll ------------------------------
  useEffect(() => {
    const engine = engineRef.current;
    if (!ready || !engine || !match || match.phase !== "moving" || match.turn !== 1 || !match.dice) return;
    const m = match;
    const dice = m.dice!;
    let cancelled = false;
    engine
      .legalMoves({ ...idsFor(m, 1, dice), dice })
      .then((r) => {
        if (cancelled) return;
        setBuilder({ forMatch: m, pb: new PlayBuilder(m.board, dice, r.moves) });
        setGroups([]);
        setSelected(null);
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [match, ready, fail]);

  const pb = builder && match && builder.forMatch === match ? builder.pb : null;
  const steps = useMemo(() => groups.flat(), [groups]);
  const nextSteps = useMemo(() => (pb ? pb.nextSteps(steps) : []), [pb, steps]);
  const sources = useMemo(() => new Set(nextSteps.map((s) => s.from)), [nextSteps]);
  const destMap = useMemo(
    () => (pb && selected !== null ? pb.destinations(steps, selected) : new Map<number, Step[]>()),
    [pb, steps, selected]
  );
  const completed = pb ? pb.completedMove(steps) : null;

  const addGroup = (g: Step[]) => {
    setGroups((gs) => [...gs, g]);
    setSelected(null);
  };

  const onPointClick = (i: number) => {
    if (!pb || warning) return;
    if (selected !== null && destMap.has(i)) return addGroup(destMap.get(i)!);
    if (sources.has(i)) return setSelected(selected === i ? null : i);
    setSelected(null);
  };
  const dragDests = (from: number) => {
    if (!pb || warning || !sources.has(from)) return null;
    return new Set(pb.destinations(steps, from).keys());
  };
  const onDragMove = (from: number, to: number) => {
    if (!pb) return;
    const path = pb.destinations(steps, from).get(to);
    if (path) addGroup(path);
  };

  // ---- tutor ----------------------------------------------------------------------
  /** Warn (and wait for the human) if the action's error reaches the tutor level. */
  const tutorCheck = (error: number, what: string, best: string, confirmLabel: string, onConfirm: () => void, onCancel: () => void) => {
    const s = skill(error);
    if (opts.tutor && tutorWarns(s, opts.tutorLevel)) {
      setWarning({
        text: `gnubg thinks this is a ${s.toUpperCase()} ${what} (${fmtEq(error)}).`,
        best,
        confirmLabel,
        onConfirm: () => {
          setWarning(null);
          onConfirm();
        },
        cancelLabel: "Undo",
        onCancel: () => {
          setWarning(null);
          onCancel();
        },
      });
      return;
    }
    onConfirm();
  };

  const cubeCache = useRef<{ key: string; a: CubeAnalysis } | null>(null);
  const analyseCubeFor = async (m: MatchState, doubler: Side): Promise<CubeAnalysis> => {
    const ids = idsFor(m, doubler, null);
    const key = `${ids.position}:${ids.match}:${opts.hintLevel}`;
    if (cubeCache.current?.key === key) return cubeCache.current.a;
    const a = await engineRef.current!.analyseCube({ ...ids, preset: opts.hintLevel });
    cubeCache.current = { key, a };
    return a;
  };

  /** Run an async step with a busy message and error reporting. */
  const withBusy = async (msg: string, f: () => Promise<void>) => {
    setBusy(msg);
    try {
      await f();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  // ---- human actions --------------------------------------------------------------
  const commitMove = () => {
    if (!match || !pb) return;
    const lm = pb.completedMove(steps);
    if (!lm && pb.stepsNeeded > 0) return;
    const pairs = lm ? lm.pairs : [];
    const text = lm ? lm.move : "";
    const doIt = () => {
      setNotice(null);
      setGroups([]);
      setSelected(null);
      apply((m) => move(m, pairs, text));
    };
    if (!opts.tutor || !lm || pb.legal.length < 2) return doIt();
    const m = match;
    void withBusy("Tutor: gnubg is checking your move…", async () => {
      const r = await engineRef.current!.rankMoves({ ...idsFor(m, 1, m.dice), dice: m.dice!, preset: opts.hintLevel });
      const mine = r.moves.find((x) => x.move === lm.move);
      if (!mine || !r.moves.length) return doIt();
      tutorCheck(mine.diff, "move", `Best: ${r.moves[0].move}`, "Play anyway", doIt, () => setGroups([]));
    });
  };

  // Auto-confirm a finished move (optional setting).
  useEffect(() => {
    if (opts.autoConfirm && completed && !warning && !busy) commitMove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completed, opts.autoConfirm]);

  const humanRoll = () => {
    if (!match) return;
    const m = match;
    const doIt = () => {
      setNotice(null);
      const dice = rollDice();
      apply((x) => roll(x, dice));
    };
    if (!opts.tutor || !canDouble(m, 1)) return doIt();
    void withBusy("Tutor: gnubg is checking the cube…", async () => {
      const a = await analyseCubeFor(m, 1);
      tutorCheck(noDoubleError(a.decision, a.equities), "decision not to double", `gnubg: ${a.recommendation}`, "Roll anyway", doIt, () => {});
    });
  };

  const humanDouble = () => {
    if (!match) return;
    const m = match;
    const doIt = () => {
      setNotice(`You double to ${m.cube * 2}.`);
      apply(double);
    };
    if (!opts.tutor) return doIt();
    void withBusy("Tutor: gnubg is checking the cube…", async () => {
      const a = await analyseCubeFor(m, 1);
      tutorCheck(doubleError(a.decision, a.equities), "double", `gnubg: ${a.recommendation}`, "Double anyway", doIt, () => {});
    });
  };

  const humanAnswer = (action: "take" | "drop" | "beaver") => {
    if (!match) return;
    const m = match;
    const doIt = () => {
      setNotice(action === "take" ? `You take. The cube is at ${m.cube * 2}.` : null);
      apply(action === "take" ? take : action === "drop" ? drop : beaver);
    };
    // gnubg's tutor does not judge beavers or answers to a beaver (gnubg.c find_skills).
    if (!opts.tutor || action === "beaver" || m.beavered) return doIt();
    void withBusy("Tutor: gnubg is checking the cube…", async () => {
      const a = await analyseCubeFor(m, 0);
      const err = action === "take" ? takeError(a.decision, a.equities) : dropError(a.decision, a.equities);
      tutorCheck(err, action === "take" ? "take" : "pass", `gnubg: ${a.recommendation}`, action === "take" ? "Take anyway" : "Pass anyway", doIt, () => {});
    });
  };

  const humanResign = (value: 1 | 2 | 3) => {
    if (!match) return;
    const m = match;
    setResignOpen(false);
    void withBusy("gnubg is considering your resignation…", async () => {
      const ok = await botAcceptsResignation(engineRef.current!, m, 1, value);
      if (ok) apply((x) => resign(x, 1, value));
      else setNotice("gnubg declines your resignation. Play on!");
    });
  };

  const showHint = () => {
    if (!match || !engineRef.current) return;
    const m = match;
    const engine = engineRef.current;
    void withBusy("gnubg is thinking about a hint…", async () => {
      if (m.phase === "moving" && m.turn === 1 && m.dice) {
        const r = await engine.rankMoves({ ...idsFor(m, 1, m.dice), dice: m.dice, preset: opts.hintLevel });
        setHint({ kind: "moves", moves: r.moves, preset: opts.hintLevel });
      } else if (m.phase === "rolling" && m.turn === 1 && canDouble(m, 1)) {
        setHint({ kind: "cube", role: "doubler", analysis: await analyseCubeFor(m, 1), preset: opts.hintLevel });
      } else if (m.phase === "doubled" && responder(m) === 1 && !m.beavered) {
        setHint({ kind: "cube", role: "taker", analysis: await analyseCubeFor(m, 0), preset: opts.hintLevel });
      }
    });
  };

  const playHintMove = (text: string) => {
    if (!pb) return;
    const lm = pb.legal.find((m) => m.move === text);
    if (lm) {
      setGroups(pb.stepsForMove(lm).map((s) => [s]));
      setSelected(null);
    }
  };

  const downloadMat = () => {
    if (!match) return;
    const blob = new Blob([toMatText(match.record)], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `gnubg-web-${match.record.date}.mat`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // Auto-roll when the human cannot double (like gnubg's "set auto roll").
  useEffect(() => {
    if (!match || !opts.autoRoll || warning) return;
    if (match.phase === "rolling" && match.turn === 1 && !canDouble(match, 1)) {
      const dice = rollDice();
      const t = setTimeout(() => apply((m) => (m === match ? roll(m, dice) : m)), 500);
      return () => clearTimeout(t);
    }
  }, [match, opts.autoRoll, warning, apply]);

  // ---- what to draw -----------------------------------------------------------------
  const humanMoving = !!(match && match.phase === "moving" && match.turn === 1);
  let shownBoard: Board | null = match ? match.board : null;
  if (anim) shownBoard = anim.board;
  else if (humanMoving && pb) shownBoard = pb.boardAfter(steps);
  const shownDice: Dice | null = anim ? anim.dice : match?.phase === "moving" ? match.dice : null;
  const diceOwner: 0 | 1 | null = match?.phase === "moving" ? match.turn : null;

  const n = match?.settings.matchLength ?? 0;
  const matchLabel = !match
    ? ""
    : n === 0
      ? `Money session${match.record.jacoby ? " (Jacoby rule)" : ""}${match.settings.beavers ? ", beavers allowed" : ""}`
      : `${n}-point match${match.crawford ? " · Crawford game" : match.postCrawford ? " · post-Crawford" : ""}`;

  const statusText = (() => {
    if (!match) return "";
    if (busy) return busy;
    switch (match.phase) {
      case "rolling":
        return match.turn === 1 ? (canDouble(match, 1) ? "Your turn: roll the dice or double." : "Your turn: roll the dice.") : "";
      case "moving":
        if (match.turn !== 1) return "";
        if (!pb) return "Getting your legal moves…";
        if (pb.stepsNeeded === 0) return `You rolled ${match.dice![0]}-${match.dice![1]}: no legal moves.`;
        if (completed) return `Move complete: ${completed.move}. Confirm, or undo.`;
        return `You rolled ${match.dice![0]}-${match.dice![1]}. ${selected !== null ? "Now click a highlighted destination." : "Click or drag a checker."}`;
      case "doubled":
        if (responder(match) === 1)
          return match.beavered
            ? `gnubg beavered: the cube goes to ${match.cube * 2}, owned by gnubg. Take or pass?`
            : `gnubg doubles to ${match.cube * 2}. Take or pass?`;
        return "";
      case "gameOver":
        return describeResult(match);
      case "matchOver": {
        const w = matchWinner(match);
        return `${describeResult(match)} ${w === 1 ? "You win" : "gnubg wins"} the match: you ${match.score[1]}, gnubg ${match.score[0]}.`;
      }
      default:
        return "";
    }
  })();

  // ---- render ---------------------------------------------------------------------
  if (!ready) {
    const pct = progress ? Math.round((100 * progress.loaded) / Math.max(1, progress.total)) : 0;
    return (
      <main className="app">
        <Header />
        <section className="loading" data-testid="loading">
          <h2>Loading GNU Backgammon…</h2>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : (
            <>
              <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="progress-bar" style={{ width: `${pct}%` }} />
              </div>
              <p className="muted small">
                {pct}% {progress ? `· ${progress.file}` : ""} · about 9 MB, downloaded once and then cached by your browser.
              </p>
            </>
          )}
        </section>
      </main>
    );
  }

  const record = match?.record.games[match.record.games.length - 1];
  const humanTurnRolling = match?.phase === "rolling" && match.turn === 1;
  const humanAnswering = match?.phase === "doubled" && responder(match) === 1;
  const canResign = !!match && !busy && (humanTurnRolling || humanMoving);
  const hintAvailable =
    !!match && !busy && (humanMoving || (humanTurnRolling && canDouble(match, 1)) || (humanAnswering && !match.beavered));

  return (
    <main className="app">
      <Header version={version} />
      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button className="link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </p>
      )}
      <div className="layout">
        <section className="play" aria-label="Game">
          <PlayerStrip
            name={`gnubg (${BOT_LEVELS.find((l) => l.value === botLevel)?.label ?? botLevel})`}
            score={match?.score[0] ?? 0}
            pips={shownBoard ? pipCount(shownBoard[0]) : 167}
            active={!!match && (match.phase === "rolling" || match.phase === "moving") && match.turn === 0}
            info={matchLabel}
            side={0}
          />
          <BoardView
            board={shownBoard ?? [[0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0], [0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0]]}
            flipped={opts.flipped}
            cube={match?.phase === "doubled" ? match.cube * 2 : (match?.cube ?? 1)}
            cubeOwner={match?.cubeOwner ?? -1}
            cubeOffered={match?.phase === "doubled"}
            dice={shownDice}
            diceOwner={diceOwner}
            usedDice={humanMoving ? steps.map((s) => s.die) : []}
            sources={humanMoving && !warning ? sources : undefined}
            selected={selected}
            targets={new Set(destMap.keys())}
            onPointClick={onPointClick}
            onDragMove={onDragMove}
            canDrag={dragDests}
          />
          <PlayerStrip
            name="You"
            score={match?.score[1] ?? 0}
            pips={shownBoard ? pipCount(shownBoard[1]) : 167}
            active={!!match && (match.phase === "rolling" || match.phase === "moving") && match.turn === 1}
            side={1}
          />

          <div className="status" aria-live="polite" data-testid="status">
            {busy && <span className="spinner" aria-hidden="true" />}
            <span>{statusText}</span>
          </div>
          {notice && !busy && (
            <p className="notice" data-testid="notice">
              {notice}
            </p>
          )}

          {warning && (
            <div className="warning" role="alertdialog" aria-label="Tutor warning" data-testid="tutor-warning">
              <p>
                <strong>{warning.text}</strong> {warning.best}
              </p>
              <div className="buttons">
                <button onClick={warning.onConfirm}>{warning.confirmLabel}</button>
                <button className="primary" onClick={warning.onCancel}>
                  {warning.cancelLabel}
                </button>
              </div>
            </div>
          )}

          <div className="actions" data-testid="actions">
            {!match && <p>Choose the match settings below and press Start.</p>}
            {match && humanTurnRolling && !warning && (
              <>
                <button className="primary" onClick={humanRoll} disabled={!!busy} data-testid="roll">
                  Roll
                </button>
                {canDouble(match, 1) && (
                  <button onClick={humanDouble} disabled={!!busy} data-testid="double">
                    Double
                  </button>
                )}
              </>
            )}
            {match && humanMoving && pb && !warning && (
              <>
                {pb.stepsNeeded === 0 ? (
                  <button className="primary" onClick={commitMove} data-testid="pass">
                    OK (no move)
                  </button>
                ) : (
                  <button className="primary" onClick={commitMove} disabled={!completed || !!busy} data-testid="confirm">
                    Confirm move
                  </button>
                )}
                <button
                  onClick={() => {
                    setGroups((g) => g.slice(0, -1));
                    setSelected(null);
                  }}
                  disabled={groups.length === 0 || !!busy}
                  data-testid="undo"
                >
                  Undo
                </button>
              </>
            )}
            {match && humanAnswering && !warning && (
              <>
                <button className="primary" onClick={() => humanAnswer("take")} disabled={!!busy} data-testid="take">
                  Take
                </button>
                <button onClick={() => humanAnswer("drop")} disabled={!!busy} data-testid="drop">
                  Pass
                </button>
                {canBeaver(match) && (
                  <button onClick={() => humanAnswer("beaver")} disabled={!!busy} data-testid="beaver">
                    Beaver
                  </button>
                )}
              </>
            )}
            {match?.phase === "gameOver" && (
              <button className="primary" onClick={startNextGame} data-testid="next-game">
                Next game
              </button>
            )}
            {match?.phase === "matchOver" && (
              <button className="primary" onClick={() => setShowSetup(true)} data-testid="new-match">
                New match…
              </button>
            )}
            {match && (
              <span className="secondary-actions">
                <button onClick={showHint} disabled={!hintAvailable} data-testid="hint">
                  Hint
                </button>
                <button onClick={() => setResignOpen((o) => !o)} disabled={!canResign} aria-expanded={resignOpen}>
                  Resign…
                </button>
              </span>
            )}
          </div>
          {resignOpen && (
            <div className="resign" role="group" aria-label="Resign">
              <span>Resign and give gnubg:</span>
              <button onClick={() => humanResign(1)}>a single game ({match!.cube})</button>
              <button onClick={() => humanResign(2)}>a gammon ({2 * match!.cube})</button>
              <button onClick={() => humanResign(3)}>a backgammon ({3 * match!.cube})</button>
            </div>
          )}
          {hint && <HintPanel hint={hint} onPlay={hint.kind === "moves" && pb ? playHintMove : undefined} onClose={() => setHint(null)} />}
        </section>

        <aside className="side">
          {(showSetup || !match) && (
            <section className="panel" aria-label="New match">
              <h2>New match</h2>
              <label>
                Match length{" "}
                <select value={opts.matchLength} onChange={(e) => setOpt("matchLength", Number(e.target.value))} data-testid="match-length">
                  <option value={0}>Money session</option>
                  {Array.from({ length: 25 }, (_, k) => k + 1).map((k) => (
                    <option key={k} value={k}>
                      {k} point{k > 1 ? "s" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {opts.matchLength === 0 ? (
                <>
                  <label className="check">
                    <input type="checkbox" checked={opts.jacoby} onChange={(e) => setOpt("jacoby", e.target.checked)} /> Jacoby rule
                    (gammons count only after a double)
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={opts.beavers} onChange={(e) => setOpt("beavers", e.target.checked)} /> Beavers (one
                    per double; no raccoons)
                  </label>
                </>
              ) : (
                <p className="muted small">Crawford rule: on (automatic).</p>
              )}
              <label>
                gnubg plays at{" "}
                <select value={opts.botLevel} onChange={(e) => setOpt("botLevel", e.target.value as Preset)} data-testid="bot-level">
                  {BOT_LEVELS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              {(opts.botLevel === "supremo" || opts.botLevel === "grandmaster") && (
                <p className="muted small">This level searches deeper and can take many seconds per move in the browser.</p>
              )}
              <div className="buttons">
                <button className="primary" onClick={startMatch} data-testid="start">
                  Start
                </button>
                {match && (
                  <button onClick={() => setShowSetup(false)} disabled={match.phase === "matchOver"}>
                    Cancel
                  </button>
                )}
              </div>
            </section>
          )}

          {match && (
            <section className="panel" aria-label="Game record">
              <div className="panel-head">
                <h2>
                  Game {record?.number}
                  {n > 0 ? ` · ${n}-point match` : " · money"}
                </h2>
                <button className="link" onClick={downloadMat} data-testid="download-mat">
                  Download .mat
                </button>
              </div>
              <ol className="log">
                {record?.actions.map((a, k) => (
                  <li key={k} className={a.player === 1 ? "log-human" : "log-bot"}>
                    {describeAction(a)}
                  </li>
                ))}
              </ol>
              {match.phase !== "matchOver" && !showSetup && (
                <button className="link" onClick={() => setShowSetup(true)}>
                  Start a new match…
                </button>
              )}
            </section>
          )}

          <section className="panel" aria-label="Options">
            <h2>Options</h2>
            <label className="check">
              <input type="checkbox" checked={opts.tutor} onChange={(e) => setOpt("tutor", e.target.checked)} data-testid="tutor" /> Tutor mode:
              warn before a mistake
            </label>
            {opts.tutor && (
              <label>
                Warn from{" "}
                <select value={opts.tutorLevel} onChange={(e) => setOpt("tutorLevel", e.target.value as Options["tutorLevel"])}>
                  <option value="doubtful">doubtful (0.03)</option>
                  <option value="bad">bad (0.06)</option>
                  <option value="very bad">very bad (0.12)</option>
                </select>
              </label>
            )}
            <label>
              Hint and tutor strength{" "}
              <select value={opts.hintLevel} onChange={(e) => setOpt("hintLevel", e.target.value as Preset)}>
                {HINT_LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={opts.autoConfirm} onChange={(e) => setOpt("autoConfirm", e.target.checked)} /> Confirm moves
              automatically
            </label>
            <label className="check">
              <input type="checkbox" checked={opts.autoRoll} onChange={(e) => setOpt("autoRoll", e.target.checked)} /> Roll automatically when I
              cannot double
            </label>
            <label className="check">
              <input type="checkbox" checked={opts.flipped} onChange={(e) => setOpt("flipped", e.target.checked)} /> Home board on the left
            </label>
          </section>
          <p className="muted small about">
            Moving: click a checker, then a highlighted point; or drag it. Moving a checker by both dice at once is one click. Undo takes back
            the last checker. The engine is GNU Backgammon {version}, running in your browser; this site is free software (GPL v3).
          </p>
        </aside>
      </div>
    </main>
  );
}

function openingNotice(m: MatchState): string {
  const d = m.openingDice!;
  return `Opening roll: you ${d[1]}, gnubg ${d[0]}. ${m.turn === 1 ? "You move first" : "gnubg moves first"}.`;
}

function Header({ version }: { version?: string | null }) {
  return (
    <header className="header">
      <h1>gnubg-web</h1>
      <span className="muted small">Play GNU Backgammon{version ? ` ${version}` : ""} in your browser</span>
    </header>
  );
}

function PlayerStrip(p: { name: string; score: number; pips: number; active: boolean; info?: string; side: 0 | 1 }) {
  return (
    <div className={`player ${p.active ? "player-active" : ""}`} data-testid={`player-${p.side}`}>
      <span className={`swatch ${p.side ? "checker-human" : "checker-bot"}`} aria-hidden="true" />
      <strong>{p.name}</strong>
      <span>score {p.score}</span>
      <span>pips {p.pips}</span>
      {p.info && <span className="muted small player-info">{p.info}</span>}
    </div>
  );
}
