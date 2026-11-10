"use client";
// The play page: loads the engine, runs the match, and lets the human play
// gnubg. The rules and the game record live in web/src/game/ (match.ts is the
// state machine; its header lists the phases). This component holds the
// state and wires it to the screen; the pieces of the screen are separate
// components (AppHeader, PlayerBar, BoardView, ActionBar, SidePanel and the
// dialogs).
//
// State flow, in short:
//   match      the MatchState (game/match.ts). Every change goes through a
//              match.ts transition (roll, move, double, take, ...), applied
//              with setMatch / apply().
//   effects    run after each change of `match`:
//                - "gnubg's turn": if gnubg must act, ask the engine and apply
//                  its roll / move / cube action;
//                - "your legal moves": after your roll, ask the engine for the
//                  legal plays and build a PlayBuilder (game/partialMove.ts);
//                - sounds for what just happened;
//                - when a game ends, gnubg's analysis (lib/analysis.ts).
//   your move  is entered checker by checker into `groups` (one group of
//              single-die steps per click or drag). Confirm turns the
//              finished play into match.ts's move().
//   tutor      before your action is applied, optionally ask the engine how
//              good it is and show a warning (`warning`) instead.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BoardView from "./BoardView";
import HintPanel, { type Hint } from "./HintPanel";
import AppHeader from "./AppHeader";
import PlayerBar from "./PlayerBar";
import ActionBar, { type Actions, type Mode, type Severity, type Status, type TutorWarning } from "./ActionBar";
import SidePanel, { type PanelTab } from "./SidePanel";
import MoveLog from "./MoveLog";
import NewMatchDialog from "./NewMatchDialog";
import SettingsDialog from "./SettingsDialog";
import HelpDialog from "./HelpDialog";
import ResignDialog from "./ResignDialog";
import ResultDialog, { type AnalysisState } from "./ResultDialog";
import LoadingScreen from "./LoadingScreen";
import Icon from "./ui/Icon";
import type { CubeAnalysis, Preset } from "@/engine/types";
import type { Board, Dice, Side } from "@/game/board";
import { applyPairs, initialBoard, pipCount, swapSides } from "@/game/board";
import { rollDice, rollOpening } from "@/game/dice";
import {
  type MatchSettings,
  type MatchState,
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
import { lastMoveOf, type LastMove } from "@/game/lastMove";
import { doubleError, dropError, noDoubleError, skill, takeError, tutorWarns } from "@/game/tutor";
import { describeResult, fmtEq, matchLabel, NAMES, points } from "@/lib/format";
import { analyse, type Mistake } from "@/lib/analysis";
import { levelLabel, useSettings } from "@/lib/settings";
import { useBoardFit, useEngine, useMediaQuery } from "@/lib/hooks";
import { configureSound, playSound, unlockAudio, type SoundName } from "@/sound/sounds";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const START_BOARD = initialBoard();

/** The sound for one checker step: a hit, a bear-off or a plain placement. */
const stepSound = (hit: boolean, to: number): SoundName => (hit ? "hit" : to === -1 ? "bearoff" : "place");

export default function Game() {
  // ---- engine and settings ------------------------------------------------------
  const { engineRef, progress, version, initError, ready } = useEngine();
  const [error, setError] = useState<string | null>(null);
  // Bumped by "Retry" on an error: re-runs the engine request that failed.
  const [retry, setRetry] = useState(0);
  const fail = useCallback((e: unknown) => {
    setError(`Engine error: ${e instanceof Error ? e.message : String(e)}`);
  }, []);
  const [settings, setSetting] = useSettings();
  const animateRef = useRef(settings.animation);
  animateRef.current = settings.animation;

  useEffect(() => configureSound({ enabled: settings.sound, volume: settings.volume }), [settings.sound, settings.volume]);
  // Browsers allow audio only after a user gesture: unlock on the first one.
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // ---- match state -----------------------------------------------------------------
  const [match, setMatch] = useState<MatchState | null>(null);
  const [botLevel, setBotLevel] = useState<Preset>("expert"); // fixed per match
  const [notice, setNotice] = useState<string | null>(null); // the last event, e.g. "gnubg plays 6-4: ..."
  const [busy, setBusy] = useState<string | null>(null); // waiting for the engine
  const [anim, setAnim] = useState<{ board: Board; dice: Dice } | null>(null); // gnubg's move being shown
  const [hint, setHint] = useState<Hint | null>(null);
  const [warning, setWarning] = useState<TutorWarning | null>(null);

  // ---- screen state: dialogs and the side panel ---------------------------------------
  const [newMatchOpen, setNewMatchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [resignOpen, setResignOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("moves");
  const wide = useMediaQuery("(min-width: 1100px)"); // panel beside the board (else a sheet)

  // First visit: open the New match dialog as soon as the engine is ready.
  useEffect(() => {
    if (ready) setNewMatchOpen(true);
  }, [ready]);

  // ---- the human's move in progress ---------------------------------------------------
  // groups: one group of single-die steps per click or drag.
  const [builder, setBuilder] = useState<{ forMatch: MatchState; pb: PlayBuilder } | null>(null);
  const [groups, setGroups] = useState<Step[][]>([]);
  // false: a click (or tap) uses the higher die, a right-click the lower; true: swapped.
  const [dieSwap, setDieSwap] = useState(false);

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

  // ---- post-game analysis -----------------------------------------------------------------
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: "idle", scope: "game" });
  const [review, setReview] = useState<Mistake | null>(null); // a mistake shown on the board
  const analysisRun = useRef(0); // id of the latest run; older runs' results are dropped

  const runAnalysis = useCallback(
    async (m: MatchState, preset: Preset) => {
      const engine = engineRef.current;
      if (!engine) return;
      const id = ++analysisRun.current;
      const scope = m.phase === "matchOver" ? "match" : "game";
      setAnalysis({ status: "running", scope });
      try {
        const summary = await analyse(engine, m.record, scope, preset, (done, total) => {
          if (analysisRun.current === id) setAnalysis({ status: "running", scope, progress: [done, total] });
        });
        if (analysisRun.current === id) setAnalysis({ status: "done", scope, summary });
      } catch (e) {
        if (analysisRun.current === id) setAnalysis({ status: "error", scope, error: e instanceof Error ? e.message : String(e) });
      }
    },
    [engineRef]
  );

  // When a game (or the match) ends: open the summary and analyse at gnubg's
  // "expert" level (0-ply: well under a second). "Analyse deeper" re-runs it.
  const analysedFor = useRef<MatchState | null>(null);
  useEffect(() => {
    if (!ready || !match || (match.phase !== "gameOver" && match.phase !== "matchOver")) return;
    if (analysedFor.current === match) return;
    analysedFor.current = match;
    setResultOpen(true);
    void runAnalysis(match, "expert");
  }, [match, ready, runAnalysis]);

  const resetAnalysis = () => {
    analysisRun.current++;
    setAnalysis({ status: "idle", scope: "game" });
    setReview(null);
    setResultOpen(false);
  };

  // ---- starting matches and games ----------------------------------------------------------
  const startMatch = () => {
    const ms: MatchSettings = {
      matchLength: settings.matchLength,
      jacoby: settings.jacoby,
      beavers: settings.beavers,
      playerNames: NAMES,
    };
    setBotLevel(settings.botLevel);
    setError(null);
    setNewMatchOpen(false);
    resetAnalysis();
    const m = openingRoll(newMatch(ms), rollOpening());
    setNotice(openingNotice(m));
    setMatch(m);
  };

  const startNextGame = () => {
    if (!match || match.phase !== "gameOver") return;
    resetAnalysis();
    // (Dice are rolled outside the state updater: React may call updaters twice.)
    const n = openingRoll(nextGame(match), rollOpening());
    setNotice(openingNotice(n));
    setMatch(n);
  };

  // ---- gnubg's turn ---------------------------------------------------------------------------
  // Runs after every state change. If gnubg has to act, ask the engine, then
  // apply the result -- but only if the state is still the one we looked at
  // (cur === m), so a new match started meanwhile is never overwritten.
  useEffect(() => {
    const engine = engineRef.current;
    if (!ready || !engine || !match) return;
    const m = match;
    let cancelled = false;
    const applyIfCurrent = (f: (x: MatchState) => MatchState) => setMatch((cur) => (cur === m && !cancelled ? f(cur) : cur));

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
        const start = swapSides(m.board); // gnubg's view (board[1] = gnubg)
        if (animateRef.current) {
          // Show gnubg's move one checker at a time, with a sound per checker.
          for (let k = 1; k <= pairs.length; k++) {
            if (cancelled) return;
            const before = applyPairs(start, pairs.slice(0, k - 1));
            const [, to] = pairs[k - 1];
            playSound(stepSound(to >= 0 && before[0][23 - to] === 1, to));
            setAnim({ board: swapSides(applyPairs(start, pairs.slice(0, k))), dice: m.dice });
            await sleep(420);
          }
        } else if (pairs.length) {
          const hit = pairs.some(([, to], k) => to >= 0 && applyPairs(start, pairs.slice(0, k))[0][23 - to] === 1);
          playSound(hit ? "hit" : "place");
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
          setNotice(`gnubg beavers! The cube would be at ${m.cube * 4}, owned by gnubg.`);
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
  }, [match, ready, botLevel, fail, retry, engineRef]);

  // ---- sounds for match transitions -----------------------------------------------------------
  // (Checker sounds are played where the checkers move: in addGroup for you,
  // in the animation above for gnubg.)
  const prevMatch = useRef<MatchState | null>(null);
  useEffect(() => {
    const prev = prevMatch.current;
    prevMatch.current = match;
    if (!prev || !match || prev === match) return;
    if (prev.phase !== "moving" && match.phase === "moving") playSound("dice");
    const pg = prev.record.games[prev.record.games.length - 1];
    const cg = match.record.games[match.record.games.length - 1];
    if (pg && cg && pg.number === cg.number && cg.actions.length > pg.actions.length) {
      const a = cg.actions[cg.actions.length - 1];
      if (a.type === "double" || a.type === "beaver") playSound("cube");
      else if (a.type === "take") playSound("take");
      else if (a.type === "drop") playSound("pass");
    }
    if ((match.phase === "gameOver" || match.phase === "matchOver") && prev.phase !== match.phase) {
      const won = match.phase === "matchOver" ? matchWinner(match) === 1 : match.lastResult?.winner === 1;
      playSound(won ? "win" : "lose", 0.25);
    }
  }, [match]);

  // ---- the human's turn: legal moves once per roll --------------------------------------------
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
        setDieSwap(false);
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [match, ready, fail, retry, engineRef]);

  const pb = builder && match && builder.forMatch === match ? builder.pb : null;
  const steps = useMemo(() => groups.flat(), [groups]);
  const nextSteps = useMemo(() => (pb ? pb.nextSteps(steps) : []), [pb, steps]);
  const sources = useMemo(() => new Set(nextSteps.map((s) => s.from)), [nextSteps]);
  const completed = pb ? pb.completedMove(steps) : null;
  const remaining = pb ? [...new Set(pb.remainingDice(steps))].sort((a, b) => b - a) : [];

  const addGroup = (g: Step[]) => {
    setGroups((gs) => [...gs, g]);
    const last = g[g.length - 1];
    playSound(stepSound(g.some((s) => s.hit), last.to));
  };

  /**
   * Click-to-move: move the checker on `from` by one die. `high` = prefer the
   * higher of the dice still to play; if that die cannot move this checker,
   * use the other one. Legality comes only from the engine's plays
   * (PlayBuilder.nextSteps).
   */
  const moveByDie = (from: number, high: boolean) => {
    if (!pb || warning || review) return;
    const options = nextSteps.filter((s) => s.from === from);
    if (!options.length) return;
    const hi = remaining[0];
    const lo = remaining[remaining.length - 1];
    const step = options.find((s) => s.die === (high ? hi : lo)) ?? options.find((s) => s.die === (high ? lo : hi)) ?? options[0];
    addGroup([step]);
  };
  const onPointClick = (i: number) => moveByDie(i, !dieSwap);
  const onPointRightClick = (i: number) => moveByDie(i, dieSwap);
  const dragDests = (from: number) => {
    if (!pb || warning || review || !sources.has(from)) return null;
    return new Set(pb.destinations(steps, from).keys());
  };
  const onDragMove = (from: number, to: number) => {
    if (!pb) return;
    const path = pb.destinations(steps, from).get(to);
    if (path) addGroup(path);
  };
  const undo = () => {
    if (!groups.length) return;
    setGroups((g) => g.slice(0, -1));
    playSound("undo");
  };

  // ---- tutor ------------------------------------------------------------------------------------
  /** Warn (and wait for the human) if the action's error reaches the tutor level. */
  const tutorCheck = (error: number, what: string, best: string, confirmLabel: string, onConfirm: () => void, onCancel: () => void) => {
    const s = skill(error);
    if (settings.tutor && tutorWarns(s, settings.tutorLevel)) {
      const severity: Severity = s === "very bad" ? "verybad" : s === "bad" ? "bad" : "doubtful";
      playSound("warn");
      setWarning({
        severity,
        title: `${s[0].toUpperCase()}${s.slice(1)} ${what}`,
        loss: fmtEq(error),
        best,
        confirmLabel,
        onConfirm: () => {
          setWarning(null);
          onConfirm();
        },
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
    const key = `${ids.position}:${ids.match}:${settings.hintLevel}`;
    if (cubeCache.current?.key === key) return cubeCache.current.a;
    const a = await engineRef.current!.analyseCube({ ...ids, preset: settings.hintLevel });
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

  // ---- human actions ------------------------------------------------------------------------------
  const commitMove = () => {
    if (!match || !pb || busy) return;
    const lm = pb.completedMove(steps);
    if (!lm && pb.stepsNeeded > 0) return;
    const pairs = lm ? lm.pairs : [];
    const text = lm ? lm.move : "";
    const doIt = () => {
      setNotice(null);
      setGroups([]);
      apply((m) => move(m, pairs, text));
    };
    if (!settings.tutor || !lm || pb.legal.length < 2) return doIt();
    const m = match;
    void withBusy("Tutor: gnubg is checking your move…", async () => {
      const r = await engineRef.current!.rankMoves({ ...idsFor(m, 1, m.dice), dice: m.dice!, preset: settings.hintLevel });
      const mine = r.moves.find((x) => x.move === lm.move);
      if (!mine || !r.moves.length) return doIt();
      tutorCheck(mine.diff, "move", `gnubg prefers ${r.moves[0].move}`, "Play anyway", doIt, () => setGroups([]));
    });
  };

  // Auto-confirm a finished move (optional setting).
  useEffect(() => {
    if (settings.autoConfirm && completed && !warning && !busy) commitMove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completed, settings.autoConfirm]);

  const humanRoll = () => {
    if (!match || busy || match.phase !== "rolling" || match.turn !== 1) return;
    const m = match;
    const doIt = () => {
      setNotice(null);
      const dice = rollDice();
      apply((x) => roll(x, dice));
    };
    if (!settings.tutor || !canDouble(m, 1)) return doIt();
    void withBusy("Tutor: gnubg is checking the cube…", async () => {
      const a = await analyseCubeFor(m, 1);
      tutorCheck(noDoubleError(a.decision, a.equities), "decision not to double", `gnubg: ${a.recommendation}`, "Roll anyway", doIt, () => {});
    });
  };

  const humanDouble = () => {
    if (!match || busy || !canDouble(match, 1)) return;
    const m = match;
    const doIt = () => {
      setNotice(`You double to ${m.cube * 2}.`);
      apply(double);
    };
    if (!settings.tutor) return doIt();
    void withBusy("Tutor: gnubg is checking the cube…", async () => {
      const a = await analyseCubeFor(m, 1);
      tutorCheck(doubleError(a.decision, a.equities), "double", `gnubg: ${a.recommendation}`, "Double anyway", doIt, () => {});
    });
  };

  const humanAnswer = (action: "take" | "drop" | "beaver") => {
    if (!match || busy || match.phase !== "doubled" || responder(match) !== 1) return;
    if (action === "beaver" && !canBeaver(match)) return;
    const m = match;
    const doIt = () => {
      setNotice(action === "take" ? `You take. The cube is at ${m.cube * 2}.` : null);
      apply(action === "take" ? take : action === "drop" ? drop : beaver);
    };
    // gnubg's tutor does not judge beavers or answers to a beaver (gnubg.c find_skills).
    if (!settings.tutor || action === "beaver" || m.beavered) return doIt();
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

  // ---- hints and the side panel -------------------------------------------------------------------
  const humanMoving = !!(match && match.phase === "moving" && match.turn === 1);
  const humanTurnRolling = match?.phase === "rolling" && match.turn === 1;
  const humanAnswering = match?.phase === "doubled" && responder(match) === 1;
  const hintAvailable =
    !!match && !busy && !warning && ((humanMoving && !!pb && pb.stepsNeeded > 0) || (humanTurnRolling && canDouble(match, 1)) || (humanAnswering && !match.beavered));

  const showHint = () => {
    setPanelTab("hint");
    setPanelOpen(true);
    if (!match || !engineRef.current || !hintAvailable || hint) return;
    const m = match;
    const engine = engineRef.current;
    void withBusy("gnubg is working out a hint…", async () => {
      if (m.phase === "moving" && m.turn === 1 && m.dice) {
        const r = await engine.rankMoves({ ...idsFor(m, 1, m.dice), dice: m.dice, preset: settings.hintLevel });
        setHint({ kind: "moves", moves: r.moves, preset: settings.hintLevel });
      } else if (m.phase === "rolling" && m.turn === 1 && canDouble(m, 1)) {
        setHint({ kind: "cube", role: "doubler", analysis: await analyseCubeFor(m, 1), preset: settings.hintLevel });
      } else if (m.phase === "doubled" && responder(m) === 1 && !m.beavered) {
        setHint({ kind: "cube", role: "taker", analysis: await analyseCubeFor(m, 0), preset: settings.hintLevel });
      }
    });
  };

  const playHintMove = (text: string) => {
    if (!pb) return;
    const lm = pb.legal.find((m) => m.move === text);
    if (lm) {
      setGroups(pb.stepsForMove(lm).map((s) => [s]));
      playSound("place");
      if (!wide) setPanelOpen(false); // show the board on small screens
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
    if (!match || !settings.autoRoll || warning) return;
    if (match.phase === "rolling" && match.turn === 1 && !canDouble(match, 1)) {
      const dice = rollDice();
      const t = setTimeout(() => apply((m) => (m === match ? roll(m, dice) : m)), 500);
      return () => clearTimeout(t);
    }
  }, [match, settings.autoRoll, warning, apply]);

  // ---- what the action bar shows ---------------------------------------------------------------------
  const over = match?.phase === "gameOver" || match?.phase === "matchOver";
  const canResign = !!match && !busy && (humanTurnRolling || humanMoving);
  const mode: Mode = (() => {
    if (!match) return { kind: "idle" };
    if (review) return { kind: "review" };
    if (warning) return { kind: "warning", warning };
    if (match.phase === "gameOver") return { kind: "gameOver" };
    if (match.phase === "matchOver") return { kind: "matchOver" };
    if (humanTurnRolling) return { kind: "roll", canDouble: canDouble(match, 1), canHint: canDouble(match, 1) };
    if (humanMoving && pb)
      return {
        kind: "move",
        noMove: pb.stepsNeeded === 0,
        complete: !!completed,
        canUndo: groups.length > 0,
        dieChoice:
          remaining.length === 2 && !completed
            ? { primary: dieSwap ? remaining[1] : remaining[0], secondary: dieSwap ? remaining[0] : remaining[1] }
            : null,
      };
    if (humanAnswering) return { kind: "answer", canBeaver: canBeaver(match), canHint: !match.beavered };
    return { kind: "wait" };
  })();

  const status: Status = (() => {
    if (!match) return { title: "Start a new match to play gnubg" };
    if (review)
      return {
        title: `Your ${review.kind === "cube" ? "cube decision" : "move"} · game ${review.game + 1}, move ${review.row}${review.dice ? ` · ${review.dice[0]}-${review.dice[1]}` : ""}`,
        detail: `Played ${review.played || "—"} · gnubg: ${review.best} · ${fmtEq(review.error.equity)}`,
      };
    if (busy) return { title: busy, busy: true, detail: notice };
    switch (match.phase) {
      case "rolling":
        if (match.turn === 1) return { title: canDouble(match, 1) ? "Your turn — roll or double" : "Your turn — roll", detail: notice, tone: "prompt" };
        return { title: "gnubg to roll", detail: notice };
      case "moving": {
        if (match.turn !== 1) return { title: "gnubg is moving…", busy: true, detail: notice };
        const d = `${match.dice![0]}-${match.dice![1]}`;
        if (!pb) return { title: "Getting your legal moves…", busy: true, detail: notice };
        if (pb.stepsNeeded === 0) return { title: `You rolled ${d}: no legal moves`, detail: notice, tone: "prompt" };
        if (completed) return { title: "Confirm your move", detail: completed.move, tone: "prompt" };
        return { title: `Your move · ${d}`, detail: notice, tone: "prompt" };
      }
      case "doubled":
        if (responder(match) === 1)
          return match.beavered
            ? { title: `gnubg beavers: cube at ${match.cube * 2} — take or pass?`, detail: `If you pass, gnubg wins ${points(match.cube)}.` }
            : { title: `gnubg doubles to ${match.cube * 2} — take or pass?`, detail: `If you pass, gnubg wins ${points(match.cube)}.` };
        return { title: "gnubg is considering your double…", busy: true, detail: notice };
      case "gameOver":
        return { title: describeResult(match), detail: `Score: you ${match.score[1]}, gnubg ${match.score[0]}` };
      case "matchOver":
        return {
          title: `${matchWinner(match) === 1 ? "You win" : "gnubg wins"} the match ${Math.max(...match.score)}–${Math.min(...match.score)}`,
          detail: describeResult(match),
        };
      default:
        return { title: "" };
    }
  })();

  const actions: Actions = {
    roll: humanRoll,
    double: humanDouble,
    confirm: commitMove,
    undo,
    hint: showHint,
    resign: () => setResignOpen(true),
    take: () => humanAnswer("take"),
    pass: () => humanAnswer("drop"),
    beaver: () => humanAnswer("beaver"),
    nextGame: startNextGame,
    newMatch: () => {
      setResultOpen(false);
      setNewMatchOpen(true);
    },
    summary: () => {
      setReview(null);
      setResultOpen(true);
    },
    swapDie: () => setDieSwap((s) => !s),
  };

  // ---- keyboard shortcuts (see HelpDialog) -----------------------------------------------------------
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest("input, select, textarea, [contenteditable='true']")) return;
    if (document.querySelector("dialog[open]")) return; // dialogs handle their own keys (Esc closes)
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const onButton = !!t?.closest("button, a");
    const run = (f: () => void) => {
      e.preventDefault();
      f();
    };
    if (k === "?") return run(() => setHelpOpen(true));
    if (k === "l") return run(() => setPanelOpen((o) => !o));
    if (k === "Escape") {
      if (review) return run(actions.summary);
      if (panelOpen) return run(() => setPanelOpen(false));
      return;
    }
    switch (mode.kind) {
      case "roll":
        if (k === "r") return run(humanRoll);
        if (k === "d" && mode.canDouble) return run(humanDouble);
        if (k === "h" && mode.canHint) return run(showHint);
        break;
      case "move":
        if (k === "Enter" && !onButton) return run(commitMove);
        if (k === "u" || k === "Backspace") return run(undo);
        if (k === "h" && !mode.noMove) return run(showHint);
        if (k === "s") return run(actions.swapDie);
        break;
      case "answer":
        if (k === "t") return run(actions.take);
        if (k === "p") return run(actions.pass);
        if (k === "h" && mode.canHint) return run(showHint);
        break;
      case "warning":
        if (k === "u" || k === "Backspace") return run(mode.warning.onCancel);
        break;
      case "gameOver":
        if (k === "n") return run(startNextGame);
        break;
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ---- board layout ---------------------------------------------------------------------------------------
  const { stageRef, tableRef, width: boardW } = useBoardFit([ready, panelOpen, wide]);

  // ---- render ------------------------------------------------------------------------------------------------
  if (!ready) return <LoadingScreen progress={progress} error={initError} />;

  // What the board shows: a reviewed position, gnubg's move in progress, your
  // move in progress, or the match position.
  let shownBoard: Board = match ? match.board : START_BOARD;
  if (review) shownBoard = review.board;
  else if (anim) shownBoard = anim.board;
  else if (humanMoving && pb) shownBoard = pb.boardAfter(steps);
  const shownDice: Dice | null = review ? review.dice : anim ? anim.dice : match?.phase === "moving" ? match.dice : null;
  const diceOwner: 0 | 1 | null = review ? (review.dice ? 1 : null) : match?.phase === "moving" ? match.turn : null;
  const botThinking = !!busy && !!match && busy.startsWith("gnubg") && !busy.includes("hint");

  // Props that BoardView gains in the board redesign (lastMove, onPointRightClick).
  // TODO(board-merge): once BoardView declares these props, pass them directly
  // and drop the cast.
  const lastMove: LastMove | null = !match || review || anim ? null : lastMoveOf(match.record);
  const boardExtras = { lastMove, onPointRightClick } as Record<string, unknown>;

  return (
    <div className={`app ${wide && panelOpen ? "with-panel" : ""}`} style={{ ["--board-w" as string]: boardW ? `${boardW}px` : "100%" }}>
      <AppHeader
        status={match ? matchLabel(match) : ""}
        panelOpen={panelOpen}
        onNewMatch={actions.newMatch}
        onPanel={() => setPanelOpen((o) => !o)}
        onSettings={() => setSettingsOpen(true)}
        onHelp={() => setHelpOpen(true)}
      />
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => {
              setError(null);
              setRetry((r) => r + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}

      <div className="main">
        <main className="play" aria-label="Game">
          <div className="stage" ref={stageRef}>
            <div className="table" ref={tableRef}>
              <PlayerBar
                side={0}
                name="gnubg"
                detail={levelLabel(match ? botLevel : settings.botLevel)}
                score={match?.score[0] ?? 0}
                matchLength={match?.settings.matchLength ?? 0}
                pips={pipCount(shownBoard[0])}
                active={!!match && !over && ((match.phase !== "doubled" && match.turn === 0) || (match.phase === "doubled" && responder(match) === 0))}
                thinking={botThinking}
              />
              <div className={`board-wrap ${review ? "reviewing" : ""}`} onContextMenu={(e) => humanMoving && e.preventDefault()}>
                <BoardView
                  board={shownBoard}
                  flipped={settings.flipped}
                  cube={review ? review.cube : match?.phase === "doubled" ? match.cube * 2 : (match?.cube ?? 1)}
                  cubeOwner={review ? review.cubeOwner : (match?.cubeOwner ?? -1)}
                  cubeOffered={!review && match?.phase === "doubled"}
                  dice={shownDice}
                  diceOwner={diceOwner}
                  usedDice={humanMoving && !review ? steps.map((s) => s.die) : []}
                  sources={humanMoving && !warning && !review ? sources : undefined}
                  selected={null}
                  targets={undefined}
                  onPointClick={onPointClick}
                  onDragMove={onDragMove}
                  canDrag={dragDests}
                  {...boardExtras}
                />
                {review && (
                  <span className="review-tag">
                    <Icon name="arrowLeft" size={14} /> Reviewing a past position
                  </span>
                )}
              </div>
              <PlayerBar
                side={1}
                name="You"
                score={match?.score[1] ?? 0}
                matchLength={match?.settings.matchLength ?? 0}
                pips={pipCount(shownBoard[1])}
                active={!!match && !over && ((match.phase !== "doubled" && match.turn === 1) || (match.phase === "doubled" && responder(match) === 1))}
              />
            </div>
          </div>
          <ActionBar mode={mode} status={status} busy={!!busy} canResign={canResign} act={actions} />
        </main>

        <SidePanel
          open={panelOpen}
          docked={wide}
          tab={panelTab}
          onTab={setPanelTab}
          onClose={() => setPanelOpen(false)}
          hint={
            hint ? (
              <HintPanel hint={hint} onPlay={hint.kind === "moves" && pb ? playHintMove : undefined} />
            ) : (
              <div className="empty">
                <p>{hintAvailable ? "gnubg can suggest your best play." : "Hints are available on your turn."}</p>
                {hintAvailable && (
                  <button className="btn btn-secondary" onClick={showHint} data-testid="get-hint">
                    <Icon name="bulb" size={18} /> Get a hint
                  </button>
                )}
              </div>
            )
          }
          moves={<MoveLog match={match} onDownload={downloadMat} />}
        />
      </div>

      <NewMatchDialog
        open={newMatchOpen}
        settings={settings}
        set={setSetting}
        onStart={startMatch}
        onClose={() => setNewMatchOpen(false)}
        canCancel={!!match && !over}
      />
      <SettingsDialog open={settingsOpen} settings={settings} set={setSetting} onClose={() => setSettingsOpen(false)} />
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} version={version} />
      <ResignDialog open={resignOpen} cube={match?.cube ?? 1} onResign={humanResign} onClose={() => setResignOpen(false)} />
      {match && over && (
        <ResultDialog
          open={resultOpen}
          match={match}
          analysis={analysis}
          deeperLabel={analysis.summary && analysis.summary.preset !== deeperPreset(settings.hintLevel) ? levelLabel(deeperPreset(settings.hintLevel)) : null}
          onClose={() => setResultOpen(false)}
          onNext={startNextGame}
          onNewMatch={actions.newMatch}
          onDeeper={() => void runAnalysis(match, deeperPreset(settings.hintLevel))}
          onMistake={(m) => {
            setReview(m);
            setResultOpen(false);
          }}
          onDownload={downloadMat}
        />
      )}
    </div>
  );
}

/** The level for "Analyse deeper": the hint strength, but at least world class. */
function deeperPreset(hintLevel: Preset): Preset {
  return hintLevel === "expert" ? "world class" : hintLevel;
}

function openingNotice(m: MatchState): string {
  const d = m.openingDice!;
  return `Opening roll: you ${d[1]}, gnubg ${d[0]}. ${m.turn === 1 ? "You move first." : "gnubg moves first."}`;
}
