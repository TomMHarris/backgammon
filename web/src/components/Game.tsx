"use client";
// The play page: loads the engine, runs the match, and lets the human play
// gnubg. The rules and the game record live in web/src/game/ (match.ts is the
// state machine; its header lists the phases). This component holds the
// state and wires it to the screen; the pieces of the screen are separate
// components (TopBar, BoardView, StatusLine + ButtonRow in ActionBar.tsx,
// SidePanel and the dialogs).
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
//   preview    a hinted move (or the tutor's better move) drawn on the board
//              as ghosts and arrows: `hoverPv` while the pointer / keyboard
//              focus is on it, `pinPv` after a click or tap.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import BoardView from "./BoardView";
import HintPanel, { cubeChoice, type CubeAction, type Hint } from "./HintPanel";
import TopBar, { Seat, type PlayerInfo } from "./TopBar";
import { ButtonRow, StatusLine, type Actions, type Mode, type Severity, type Status, type TutorWarning } from "./ActionBar";
import SidePanel, { type PanelTab } from "./SidePanel";
import MoveLog from "./MoveLog";
import NewMatchDialog from "./NewMatchDialog";
import SettingsDialog from "./SettingsDialog";
import HelpDialog from "./HelpDialog";
import ResignDialog from "./ResignDialog";
import ResultDialog, { type AnalysisState } from "./ResultDialog";
import LoadingScreen from "./LoadingScreen";
import type { CubeAnalysis, Preset } from "@/engine/types";
import type { Board, Dice, Side } from "@/game/board";
import { applyPairs, initialBoard, pipCount, swapSides } from "@/game/board";
import { rollDice, rollOpening } from "@/game/dice";
import {
  type MatchSettings,
  type MatchState,
  beaver,
  boardFor,
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
import { botAcceptsResignation } from "@/game/bot";
import { toMatText } from "@/game/matFile";
import { lastMoveOf, toBoardIndex } from "@/game/lastMove";
import { doubleError, dropError, noDoubleError, skill, takeError, tutorWarns } from "@/game/tutor";
import { describeResult, fmtEq, matchLabel, NAMES, points, says, TWO_PLAYER_NAMES } from "@/lib/format";
import { analyse, type Mistake } from "@/lib/analysis";
import { levelLabel, useSettings } from "@/lib/settings";
import { useBoardFit, useEngine, useMediaQuery } from "@/lib/hooks";
import { parseMove } from "@/lib/analysisView";
import { cubeDid, cubeOptions, cubeShould, isTaker } from "@/lib/cubeText";
import { useMoveReplay } from "@/lib/useMoveReplay";
import { useOnlineGame } from "@/lib/useOnlineGame";
import { inviteLink, pollRoom, roomInUrl, savedSeat, setRoomInUrl } from "@/lib/online";
import type { RoomSettings } from "@/game/online";
import { InviteDialog, JoinDialog } from "./OnlineDialogs";
import { configureSound, playSound, unlockAudio } from "@/sound/sounds";
import { useMatchSounds } from "@/sound/useMatchSounds";
import { stepSound, useGnubgTurn } from "@/lib/useGnubgTurn";

const START_BOARD = initialBoard();


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
  // the move previewed on the board (gnubg notation): hovered / focused, or pinned
  const [hoverPv, setHoverPv] = useState<string | null>(null);
  const [pinPv, setPinPv] = useState<string | null>(null);

  // ---- screen state: dialogs and the side panel ---------------------------------------
  const [newMatchOpen, setNewMatchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [resignOpen, setResignOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("moves");
  // Screen layouts:
  //   wide   (>= 900px, not short): top line, board, status and buttons under
  //          it, the panel docked on the right
  //   phone  (narrower, or portrait): a one-line top bar, then the players
  //          above and below the board, the status and the buttons directly
  //          under it, all centred; the panel is a sheet over the lower part
  //   land   (landscape phones, height <= 500px): the board fits the height;
  //          players, status and buttons in a slim column on the right; the
  //          panel is a sheet over that column
  const land = useMediaQuery("(orientation: landscape) and (max-height: 500px)");
  const wideQuery = useMediaQuery("(min-width: 900px)");
  const wide = wideQuery && !land; // panel beside the board
  const layout: "wide" | "phone" | "land" = land ? "land" : wide ? "wide" : "phone";


  // ---- the human's move in progress ---------------------------------------------------
  // groups: one group of single-die steps per click or drag.
  const [builder, setBuilder] = useState<{ forMatch: MatchState; pb: PlayBuilder } | null>(null);
  const [groups, setGroups] = useState<Step[][]>([]);
  // false: a click (or tap) uses the higher die, a right-click the lower; true: swapped.
  const [dieSwap, setDieSwap] = useState(false);
  // "Take back": the match just before each move played in this game, latest
  // last (at most TAKE_BACK_DEPTH). Taking back returns to that position with
  // the same dice, so the move can be entered again.
  const [history, setHistory] = useState<MatchState[]>([]);

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

  // Who the person at the screen acts for. Against gnubg: always side 1
  // ("You", the bottom player). Two players: whoever is to act now (on roll,
  // moving, or answering a double), so everything below that says "the
  // human" means "the side being played at the screen".
  const two = !!match?.settings.twoPlayer;
  const N = match?.record.playerNames ?? NAMES; // [player 0, player 1]
  const me: Side = !match || !two ? 1 : match.phase === "doubled" ? responder(match) : match.turn;

  // Clear per-turn UI state whenever the match moves on.
  useEffect(() => {
    setHint(null);
    setWarning(null);
    setResignOpen(false);
    setHoverPv(null);
    setPinPv(null);
  }, [match]);

  // ---- post-game analysis -----------------------------------------------------------------
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: "idle", scope: "game" });
  const [review, setReview] = useState<Mistake | null>(null); // a mistake shown on the board
  // A reviewed move can be played on the board, checker by checker: yours
  // ("played") or gnubg's ("best"). Otherwise both are drawn as arrows.
  const replay = useMoveReplay<"played" | "best">(review);
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
    if (settings.opponent === "online") return void hostOnline();
    online.leave();
    const twoPlayer = settings.opponent === "human";
    const ms: MatchSettings = {
      matchLength: settings.matchLength,
      jacoby: settings.jacoby,
      beavers: settings.beavers,
      playerNames: twoPlayer ? TWO_PLAYER_NAMES : NAMES,
      twoPlayer,
    };
    setBotLevel(settings.botLevel);
    setError(null);
    setNewMatchOpen(false);
    resetAnalysis();
    setHistory([]);
    const m = openingRoll(newMatch(ms), rollOpening());
    setNotice(openingNotice(m));
    setMatch(m);
  };

  const startNextGame = () => {
    if (!match || match.phase !== "gameOver") return;
    if (online.state) return void online.send({ t: "next" }); // (the new game starts when the server's opening roll arrives)
    resetAnalysis();
    setHistory([]);
    // (Dice are rolled outside the state updater: React may call updaters twice.)
    const n = openingRoll(nextGame(match), rollOpening());
    setNotice(openingNotice(n));
    setMatch(n);
  };

  // ---- online games with a friend (lib/useOnlineGame.ts) ----------------------------------------------
  const online = useOnlineGame({
    engineRef,
    match,
    setMatch,
    setNotice,
    setAnim,
    setBusy,
    animate: animateRef,
    onNewMatch: () => {
      resetAnalysis();
      setHistory([]);
      setError(null);
    },
    onGameStart: (m) => {
      resetAnalysis();
      setNotice(openingNotice(m));
    },
  });
  const isOnline = !!online.state;
  const hintsAllowed = !online.state || online.state.settings.hints;
  const tutorOn = settings.tutor && hintsAllowed;
  const [inviteOpen, setInviteOpen] = useState(false);
  const [join, setJoin] = useState<{ room: string; info: { host: string; settings: RoomSettings } | null; error: string | null; joining: boolean } | null>(null);

  const hostOnline = async () => {
    setNewMatchOpen(false);
    try {
      await online.host({ matchLength: settings.matchLength, jacoby: settings.jacoby, beavers: settings.beavers, hints: settings.onlineHints }, settings.playerName);
      setInviteOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Opened with ?room=...: back into your seat, or the Join dialog. */
  const openRoomLink = (room: string) => {
    const seat = savedSeat(room);
    if (seat) {
      online.join(room, settings.playerName, seat.token).catch((e) => setJoin({ room, info: null, error: e.message, joining: false }));
      return;
    }
    setJoin({ room, info: null, error: null, joining: false });
    pollRoom(room, 0)
      .then((v) =>
        setJoin((j) => j && { ...j, info: { host: v.names[1] || "your friend", settings: v.settings }, error: v.joined ? "This game already has two players." : null })
      )
      .catch((e) => setJoin((j) => j && { ...j, error: e.message }));
  };
  const joinNow = () => {
    if (!join || join.joining) return;
    setJoin({ ...join, joining: true });
    online
      .join(join.room, settings.playerName)
      .then(() => setJoin(null))
      .catch((e) => setJoin((j) => j && { ...j, joining: false, error: e.message }));
  };

  // When the engine is ready: an online game from the link, or carry on with
  // the match saved in this browser (e.g. after "Full review" or a reload),
  // or else open the New match dialog.
  useEffect(() => {
    if (!ready) return;
    const room = roomInUrl();
    if (room) return openRoomLink(room);
    const saved = loadSavedMatch();
    if (saved) {
      setBotLevel(saved.botLevel);
      setNotice("Welcome back: your match continues.");
      setMatch(saved.match);
    } else setNewMatchOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  // Save the match after every change (only this browser keeps it). Online
  // games are kept by the server instead (the link brings them back).
  useEffect(() => {
    if (match && !isOnline) saveMatch(match, botLevel);
  }, [match, botLevel, isOnline]);

  // ---- gnubg's turn (lib/useGnubgTurn.ts) and the sounds of each transition ----------------------
  useGnubgTurn({ engineRef, ready, match: two || isOnline ? null : match, botLevel, retry, animate: animateRef, setMatch, setBusy, setNotice, setAnim, fail });
  useMatchSounds(match);

  // ---- the human's turn: legal moves once per roll --------------------------------------------
  useEffect(() => {
    const engine = engineRef.current;
    if (!ready || !engine || !match || match.phase !== "moving" || !match.dice) return;
    if (match.turn !== 1 && !match.settings.twoPlayer) return;
    const m = match;
    const dice = m.dice!;
    let cancelled = false;
    engine
      .legalMoves({ ...idsFor(m, m.turn, dice), dice })
      .then((r) => {
        if (cancelled) return;
        // (all in the mover's numbering: board[1] = the side to move)
        setBuilder({ forMatch: m, pb: new PlayBuilder(boardFor(m, m.turn), dice, r.moves) });
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
    if (!options.length) {
      // no checker of yours to move there: bring checkers to it instead
      // (makes the point when the dice allow; the tray bears off one)
      const seq = pb.toPoint(steps, from);
      if (seq) addGroup(seq);
      return;
    }
    const hi = remaining[0];
    const lo = remaining[remaining.length - 1];
    const step = options.find((s) => s.die === (high ? hi : lo)) ?? options.find((s) => s.die === (high ? lo : hi)) ?? options[0];
    addGroup([step]);
  };
  /**
   * A click on the board while a move is previewed first clears the preview.
   * If the board then looks different (part of your move was entered), the
   * click does nothing else.
   */
  const previewShown = () => {
    if (!preview) return false; // (`preview` is worked out below, before the board is drawn)
    setHoverPv(null);
    setPinPv(null);
    return steps.length > 0 || !!warning;
  };
  const onPointClick = (i: number) => {
    if (!previewShown()) moveByDie(i, !dieSwap);
  };
  const onPointRightClick = (i: number) => {
    if (!previewShown()) moveByDie(i, dieSwap);
  };
  const dragDests = (from: number) => {
    if (previewShown()) return null;
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

  /**
   * Take back the last move played (and everything after it, e.g. gnubg's
   * reply): back to the position before it, with the same dice. Whatever
   * gnubg was doing meanwhile is dropped (useGnubgTurn only applies its
   * result to the match it started from).
   */
  const takeBack = () => {
    const prev = history[history.length - 1];
    if (!prev || !match) return;
    setHistory((h) => h.slice(0, -1));
    analysisRun.current++;
    analysedFor.current = null;
    setAnalysis({ status: "idle", scope: "game" });
    setReview(null);
    setResultOpen(false);
    setResignOpen(false);
    setBusy(null);
    setAnim(null);
    setGroups([]);
    setNotice("Move taken back: play it again.");
    setMatch(prev);
    playSound("undo");
  };
  const canTakeBack = history.length > 0 && !!match && !isOnline;

  // ---- tutor ------------------------------------------------------------------------------------
  /** Warn (and wait for the human) if the action's error reaches the tutor level. */
  const tutorCheck = (
    error: number,
    what: string,
    best: string,
    confirmLabel: string,
    onConfirm: () => void,
    onCancel: () => void,
    bestMove?: string
  ) => {
    const s = skill(error);
    if (tutorOn && tutorWarns(s, settings.tutorLevel)) {
      const severity: Severity = s === "very bad" ? "verybad" : s === "bad" ? "bad" : "doubtful";
      playSound("warn");
      setWarning({
        severity,
        title: `${s[0].toUpperCase()}${s.slice(1)} ${what}`,
        loss: fmtEq(error),
        best,
        bestMove,
        confirmLabel,
        onConfirm: () => {
          setWarning(null);
          setHoverPv(null);
          setPinPv(null);
          onConfirm();
        },
        onCancel: () => {
          setWarning(null);
          setHoverPv(null);
          setPinPv(null);
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
    const before = match;
    const doIt = () => {
      setNotice(null);
      // online: the move is sent; the board keeps showing it until the server's copy is applied
      if (isOnline) return void online.send({ t: "move", pairs, text });
      setGroups([]);
      if (lm) setHistory((h) => [...h.slice(1 - TAKE_BACK_DEPTH), before]); // (a dance is not worth taking back)
      apply((m) => move(m, pairs, text));
    };
    if (!tutorOn || !lm || pb.legal.length < 2) return doIt();
    const m = match;
    void withBusy("tutor: gnubg is checking your move", async () => {
      const r = await engineRef.current!.rankMoves({ ...idsFor(m, m.turn, m.dice), dice: m.dice!, preset: settings.hintLevel });
      const mine = r.moves.find((x) => x.move === lm.move);
      if (!mine || !r.moves.length) return doIt();
      tutorCheck(mine.diff, "move", `gnubg prefers ${r.moves[0].move}`, "Play anyway", doIt, () => setGroups([]), r.moves[0].move);
    });
  };

  // Auto-confirm a finished move (optional setting).
  useEffect(() => {
    if (settings.autoConfirm && completed && !warning && !busy) commitMove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completed, settings.autoConfirm]);

  // A dance (no legal move after your roll): show the roll and the status
  // for a moment, then pass the turn to gnubg with no click needed. It is the
  // same transition as the "No move" button (an empty move), so the game
  // record and the .mat file are exactly as before.
  const commitRef = useRef(commitMove);
  commitRef.current = commitMove;
  const danceFor = pb && pb.stepsNeeded === 0 && match?.phase === "moving" && match.turn === me ? match : null;
  useEffect(() => {
    if (!danceFor) return;
    playSound("undo", 350);
    const t = setTimeout(() => commitRef.current(), NO_MOVE_PAUSE_MS);
    return () => clearTimeout(t);
  }, [danceFor]);

  const humanRoll = () => {
    if (!match || busy || match.phase !== "rolling" || match.turn !== me) return;
    const m = match;
    const doIt = () => {
      setNotice(null);
      if (isOnline) return void online.send({ t: "roll" }); // the server rolls
      const dice = rollDice();
      apply((x) => roll(x, dice));
    };
    if (!tutorOn || !canDouble(m, me)) return doIt();
    void withBusy("tutor: gnubg is checking the cube", async () => {
      const a = await analyseCubeFor(m, me);
      tutorCheck(noDoubleError(a.decision, a.equities), "decision not to double", `gnubg: ${a.recommendation}`, "Roll anyway", doIt, () => {});
    });
  };

  const humanDouble = () => {
    if (!match || busy || !canDouble(match, me)) return;
    const m = match;
    const doIt = () => {
      setNotice(`${says(N[me], "double")} to ${m.cube * 2}.`);
      if (isOnline) return void online.send({ t: "double" });
      apply(double);
    };
    if (!tutorOn) return doIt();
    void withBusy("tutor: gnubg is checking the cube", async () => {
      const a = await analyseCubeFor(m, me);
      tutorCheck(doubleError(a.decision, a.equities), "double", `gnubg: ${a.recommendation}`, "Double anyway", doIt, () => {});
    });
  };

  const humanAnswer = (action: "take" | "drop" | "beaver") => {
    if (!match || busy || match.phase !== "doubled" || responder(match) !== me) return;
    if (action === "beaver" && !canBeaver(match)) return;
    const m = match;
    const doIt = () => {
      if (isOnline) return void online.send({ t: action });
      setNotice(action === "take" ? `${says(N[me], "take")}. The cube is at ${m.cube * 2}.` : null);
      apply(action === "take" ? take : action === "drop" ? drop : beaver);
    };
    // gnubg's tutor does not judge beavers or answers to a beaver (gnubg.c find_skills).
    if (!tutorOn || action === "beaver" || m.beavered) return doIt();
    void withBusy("tutor: gnubg is checking the cube", async () => {
      const a = await analyseCubeFor(m, m.turn); // (from the doubler's side)
      const err = action === "take" ? takeError(a.decision, a.equities) : dropError(a.decision, a.equities);
      tutorCheck(err, action === "take" ? "take" : "pass", `gnubg: ${a.recommendation}`, action === "take" ? "Take anyway" : "Pass anyway", doIt, () => {});
    });
  };

  const humanResign = (value: 1 | 2 | 3) => {
    if (!match) return;
    const m = match;
    setResignOpen(false);
    // two players: the other player accepts (there is no one to ask); online: likewise
    if (isOnline) return void online.send({ t: "resign", value });
    if (two) return apply((x) => resign(x, me, value));
    void withBusy("gnubg is considering your resignation", async () => {
      const ok = await botAcceptsResignation(engineRef.current!, m, 1, value);
      if (ok) apply((x) => resign(x, 1, value));
      else setNotice("gnubg declines your resignation. Play on!");
    });
  };

  // ---- hints and the side panel -------------------------------------------------------------------
  const humanMoving = !!(match && match.phase === "moving" && match.turn === me);
  const humanTurnRolling = match?.phase === "rolling" && match.turn === me;
  const humanAnswering = match?.phase === "doubled" && responder(match) === me;
  const hintAvailable =
    !!match && hintsAllowed && !busy && !warning && ((humanMoving && !!pb && pb.stepsNeeded > 0) || (humanTurnRolling && canDouble(match, me)) || (humanAnswering && !match.beavered));

  const showHint = () => {
    setPanelTab("hint");
    setPanelOpen(true);
    if (!match || !engineRef.current || !hintAvailable || hint) return;
    const m = match;
    const engine = engineRef.current;
    void withBusy("gnubg is working out a hint", async () => {
      if (m.phase === "moving" && m.turn === me && m.dice) {
        const r = await engine.rankMoves({ ...idsFor(m, me, m.dice), dice: m.dice, preset: settings.hintLevel });
        setHint({ kind: "moves", moves: r.moves, preset: settings.hintLevel });
        setPinPv(r.moves[0]?.move ?? null); // show gnubg's best move on the board straight away
      } else if (m.phase === "rolling" && m.turn === me && canDouble(m, me)) {
        setHint({ kind: "cube", role: "doubler", analysis: await analyseCubeFor(m, me), preset: settings.hintLevel });
      } else if (m.phase === "doubled" && responder(m) === me && !m.beavered) {
        setHint({ kind: "cube", role: "taker", analysis: await analyseCubeFor(m, m.turn), preset: settings.hintLevel });
      }
    });
  };

  const playHintMove = (text: string) => {
    if (!pb) return;
    const lm = pb.legal.find((m) => m.move === text);
    if (lm) {
      setGroups(pb.stepsForMove(lm).map((s) => [s]));
      setHoverPv(null);
      setPinPv(null);
      playSound("place");
      if (!wide) setPanelOpen(false); // give the board its full size on small screens
    }
  };

  const cubeAction = (a: CubeAction) => {
    if (a === "roll") humanRoll();
    else if (a === "double") humanDouble();
    else humanAnswer(a === "take" ? "take" : "drop");
    if (!wide) setPanelOpen(false);
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
    if (match.phase === "rolling" && (match.turn === 1 || match.settings.twoPlayer) && !canDouble(match, match.turn)) {
      if (isOnline) {
        const t = setTimeout(() => void online.send({ t: "roll" }), 500);
        return () => clearTimeout(t);
      }
      const dice = rollDice();
      const t = setTimeout(() => apply((m) => (m === match ? roll(m, dice) : m)), 500);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match, settings.autoRoll, warning, apply, isOnline]);

  // ---- what the action bar shows ---------------------------------------------------------------------
  const over = match?.phase === "gameOver" || match?.phase === "matchOver";
  const canResign = !!match && !busy && (humanTurnRolling || humanMoving);
  const mode: Mode = (() => {
    if (!match) return isOnline ? { kind: "invite" } : { kind: "idle" };
    if (review) return { kind: "review", next: match.phase === "gameOver" ? "nextGame" : match.phase === "matchOver" ? "newMatch" : null };
    if (warning) return { kind: "warning", warning };
    if (match.phase === "gameOver") return { kind: "gameOver" };
    if (match.phase === "matchOver") return { kind: "matchOver" };
    if (humanTurnRolling) return { kind: "roll", canDouble: canDouble(match, me), canHint: canDouble(match, me) };
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
    if (online.state?.error) return { title: "The online game cannot go on", detail: online.state.error };
    if (!match && isOnline) return { title: "Waiting for your friend to join", detail: "Send them the invite link", busy: true };
    if (!match) return { title: "Start a new match to play gnubg" };
    if (review)
      return {
        title: `${two ? `${N[review.player]}'s` : "Your"} ${review.kind === "cube" ? "cube decision" : "move"} · game ${review.game + 1}, move ${review.row}${review.dice ? ` · ${review.dice[0]}-${review.dice[1]}` : ""}`,
        detail: `Played ${review.played || "—"} · gnubg: ${review.best} · ${fmtEq(review.error.equity)}`,
      };
    if (busy) return { title: busy, busy: true, detail: notice };
    switch (match.phase) {
      case "rolling":
        if (match.turn === me) {
          const dbl = canDouble(match, me);
          if (two) return { title: `${N[me]} to roll${dbl ? " or double" : ""}`, detail: notice };
          return { title: dbl ? "Your turn — roll or double" : "Your turn — roll", detail: notice };
        }
        return { title: `${N[0]} to roll`, detail: notice, busy: isOnline };
      case "moving": {
        if (match.turn !== me) return { title: `${N[0]} is moving`, busy: true, detail: notice };
        const d = `${match.dice![0]}-${match.dice![1]}`;
        if (!pb) return { title: "Getting the legal moves", busy: true, detail: notice };
        if (pb.stepsNeeded === 0) return { title: `${N[me]} rolled ${d} — no legal move`, detail: `Passing the turn to ${N[1 - me]}…` };
        if (completed) return { title: two ? `${N[me]}: confirm the move` : "Confirm your move", detail: completed.move };
        return { title: two ? `${N[me]} to move · ${d}` : `Your move · ${d}`, detail: notice };
      }
      case "doubled": {
        if (responder(match) !== me) return { title: `${N[0]} is considering your double`, busy: true, detail: notice };
        const by = N[1 - me]; // the doubler (or, after a beaver, the beaverer)
        const ask = two ? `${N[me]}, take or pass?` : "take or pass?";
        const ifPass = `If ${N[me] === "You" ? "you pass" : `${N[me]} passes`}, ${says(by, "win")} ${points(match.cube)}.`;
        return match.beavered
          ? { title: `${says(by, "beaver")}: cube at ${match.cube * 2} — ${ask}`, detail: ifPass }
          : { title: `${says(by, "double")} to ${match.cube * 2} — ${ask}`, detail: ifPass };
      }
      case "gameOver":
        return { title: describeResult(match), detail: `Score: ${N[1]} ${match.score[1]}, ${N[0]} ${match.score[0]}` };
      case "matchOver":
        return {
          title: `${says(N[matchWinner(match) ?? 0], "win")} the match ${Math.max(...match.score)}–${Math.min(...match.score)}`,
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
    download: match ? downloadMat : undefined,
    takeBack: canTakeBack ? takeBack : undefined,
    invite: isOnline ? () => setInviteOpen(true) : undefined,
    rematch: isOnline ? () => void online.rematch() : undefined,
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
    if (k === "b" && canTakeBack && mode.kind !== "review") return run(takeBack);
    if (k === "Escape") {
      if (review) return run(actions.summary);
      if (preview && pinPv && !panelOpen) return run(() => setPinPv(null));
      if (panelOpen) return run(() => setPanelOpen(false));
      return;
    }
    switch (mode.kind) {
      case "roll":
        if (k === "r" || k === " ") return run(humanRoll);
        if (k === "d" && mode.canDouble) return run(humanDouble);
        if (k === "h" && mode.canHint) return run(showHint);
        break;
      case "move":
        if (k === "Enter" && !onButton) return run(commitMove);
        if (k === " " && (mode.complete || mode.noMove)) return run(commitMove);
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
        if (k === "n" || k === " ") return run(startNextGame);
        break;
      case "review":
        if (k === "n" && mode.next === "nextGame") return run(startNextGame);
        break;
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // The move previewed on the board: the tutor's better move, or a hinted move
  // while the Hint tab is open.
  const pvText = (() => {
    if (!pb || review || anim) return null;
    if (warning) return warning.bestMove ? (hoverPv ?? pinPv) : null;
    if (!humanMoving || !panelOpen || panelTab !== "hint" || hint?.kind !== "moves") return null;
    return hoverPv ?? pinPv;
  })();
  const pvMove = pvText && pb ? pb.legal.find((m) => m.move === pvText) : undefined;
  const preview = pvMove
    ? { player: me, steps: pvMove.pairs.map(([from, to]) => ({ from: toBoardIndex(me, from), to: toBoardIndex(me, to) })) }
    : null;

  // Reviewing a mistaken move: gnubg's best move as the usual preview arrows,
  // the move you played as the second, muted dashed one. (gnubg's move text,
  // from your side: the same numbering as the board's preview.)
  const reviewArrows = (() => {
    if (!review || review.kind !== "move") return null;
    const who = review.player ?? 1;
    const pv = (text: string) => {
      try {
        const steps = parseMove(text).map(([from, to]) => ({ from: toBoardIndex(who, from), to: toBoardIndex(who, to) }));
        return steps.length ? { player: who, steps } : null;
      } catch {
        return null;
      }
    };
    // the same moves as the engine's pairs (mover's numbering), to play them on the board
    const pairs = (text: string) => {
      try {
        return parseMove(text);
      } catch {
        return [];
      }
    };
    return { best: pv(review.best), played: pv(review.played), pairs: { best: pairs(review.best), played: pairs(review.played) } };
  })();

  // ---- board layout ---------------------------------------------------------------------------------------
  const { stageRef, tableRef, width: boardW } = useBoardFit([ready, wide ? panelOpen : false, layout]);

  // Where the panel's sheet starts on phones: under the board (portrait) or
  // right of it (landscape), so a previewed move stays in view.
  const [sheetAt, setSheetAt] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (wide || !panelOpen) return;
    const measure = () => {
      const r = tableRef.current?.querySelector("svg.board")?.getBoundingClientRect();
      if (r) setSheetAt({ top: Math.round(r.bottom), left: Math.round(r.right) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [wide, panelOpen, layout, boardW, tableRef]);

  // ---- render ------------------------------------------------------------------------------------------------
  if (!ready) return <LoadingScreen progress={progress} error={initError} />;

  // What the board shows: a reviewed position, gnubg's move in progress, your
  // move in progress, or the match position.
  let shownBoard: Board = match ? match.board : START_BOARD;
  if (review) shownBoard = review.board;
  if (review && replay.which && reviewArrows) {
    // a reviewed move being played: the position after its first `step` checkers
    const who = review.player ?? 1;
    const start = who === 1 ? review.board : swapSides(review.board); // the mover's view
    const after = applyPairs(start, reviewArrows.pairs[replay.which].slice(0, replay.step));
    shownBoard = who === 1 ? after : swapSides(after);
  }
  else if (anim) shownBoard = anim.board;
  else if (humanMoving && pb) shownBoard = me === 1 ? pb.boardAfter(steps) : swapSides(pb.boardAfter(steps));
  const shownDice: Dice | null = review ? review.dice : anim ? anim.dice : match?.phase === "moving" ? match.dice : null;
  const diceOwner: 0 | 1 | null = review ? (review.dice ? review.player : null) : match?.phase === "moving" ? match.turn : null;
  // reviewing a take or a pass: the cube is shown as offered
  const reviewTake = !!review?.cubeInfo && isTaker(review.cubeInfo.actual);
  const botThinking = !!busy && !!match && busy.startsWith("gnubg") && !busy.includes("hint");

  // A click on the dice confirms a finished move, or else swaps which die a
  // click uses (as in gnubg); a click on the cube doubles.
  const boardFree = !busy && !warning && !review && !preview;
  const onDiceClick =
    humanMoving && pb && boardFree && (completed || remaining.length === 2)
      ? () => (completed ? commitMove() : setDieSwap((s) => !s))
      : undefined;
  const onCubeClick = match && humanTurnRolling && canDouble(match, me) && boardFree ? humanDouble : undefined;

  if (preview && pb) shownBoard = me === 1 ? pb.start : swapSides(pb.start); // the preview starts from the position before the move

  // The last completed move (gnubg's or yours), for the board to mark faintly.
  // (a reviewed move that has been played on the board: its landing rings)
  const lastMove =
    review && replay.done && reviewArrows
      ? reviewArrows[replay.which!]
      : !match || review || anim
        ? null
        : lastMoveOf(match.record);
  const onTurn = (side: 0 | 1) =>
    !!match && !over && (match.phase === "doubled" ? responder(match) === side : match.turn === side);

  const players: [PlayerInfo, PlayerInfo] = [
    { name: N[1], score: match?.score[1] ?? 0, pips: pipCount(shownBoard[1]), active: onTurn(1) },
    {
      name: !match && online.state ? online.state.friend : N[0],
      level: two || isOnline ? undefined : levelLabel(match ? botLevel : settings.botLevel),
      score: match?.score[0] ?? 0,
      pips: pipCount(shownBoard[0]),
      active: onTurn(0),
      thinking: botThinking && !two && !isOnline,
    },
  ];

  const panel = (
    <SidePanel
      open={panelOpen}
      variant={layout === "wide" ? "docked" : layout === "phone" ? "sheet" : "side"}
      tab={panelTab}
      onTab={setPanelTab}
      onClose={() => setPanelOpen(false)}
      hint={
        hint ? (
          <HintPanel
            hint={hint}
            onPlay={hint.kind === "moves" && pb ? playHintMove : undefined}
            preview={
              hint.kind === "moves" && pb && humanMoving
                ? { active: pvText, pinned: pinPv, onHover: setHoverPv, onPin: setPinPv }
                : undefined
            }
            onCubeAction={hint.kind === "cube" && !busy ? cubeAction : undefined}
          />
        ) : (
          <div className="empty">
            <p>{hintAvailable ? "gnubg can suggest your best play." : "Hints are available on your turn."}</p>
            {hintAvailable && (
              <button className="flat" onClick={showHint} data-testid="get-hint">
                Get a hint
              </button>
            )}
          </div>
        )
      }
      moves={<MoveLog match={match} onDownload={downloadMat} />}
    />
  );

  const topBar = (
    <TopBar
      players={players}
      match={match ? `${isOnline ? "Online · " : ""}${matchLabel(match)}` : isOnline ? "Online game" : ""}
      panelOpen={panelOpen}
      onPanel={() => setPanelOpen((o) => !o)}
      onSettings={() => setSettingsOpen(true)}
      onHelp={() => setHelpOpen(true)}
      showPlayers={layout !== "phone"}
    />
  );
  const statusLine = (
    <StatusLine
      mode={mode}
      status={status}
      review={
        review && reviewArrows
          ? {
              kind: "move",
              playedLabel: two ? N[review.player ?? 1] : "Your move",
              played: review.played || "no move",
              best: review.best,
              loss: fmtEq(review.error.equity),
              where: `Game ${review.game + 1}, move ${review.row}`,
              showing: replay.which,
              canPlay: { played: reviewArrows.pairs.played.length > 0, best: reviewArrows.pairs.best.length > 0 },
              onShow: (w) => (w === null || (replay.which === w && replay.done) ? replay.clear() : replay.play(w, reviewArrows.pairs[w].length)),
            }
          : review?.cubeInfo
            ? {
                kind: "cube",
                did: cubeDid(review.cubeInfo.actual, N[review.player ?? 1], review.cube),
                should: cubeShould(review.cubeInfo.actual, review.cubeInfo.proper),
                proper: review.cubeInfo.proper,
                loss: fmtEq(review.error.equity),
                where: `Game ${review.game + 1}, move ${review.row}`,
                options: cubeOptions(review.cubeInfo.actual, review.cubeInfo.equities),
                mwc: (match?.settings.matchLength ?? 0) > 0,
              }
            : undefined
      }
      preview={
        warning?.bestMove
          ? {
              pinned: pinPv === warning.bestMove,
              onHover: (on) => setHoverPv(on ? warning.bestMove! : null),
              onPin: (on) => setPinPv(on ? warning.bestMove! : null),
            }
          : undefined
      }
    />
  );
  const buttons = (
    <ButtonRow mode={mode} busy={!!busy} canResign={canResign} canHint={hintAvailable} act={actions} suggest={hint?.kind === "cube" ? cubeChoice(hint).action : null} />
  );
  const vars: Record<string, string> = { "--board-w": boardW ? `${boardW}px` : "100%" };
  if (sheetAt) {
    vars["--sheet-top"] = `${sheetAt.top}px`;
    vars["--sheet-left"] = `${sheetAt.left}px`;
  }

  return (
    <div className={`app app-${layout} ${wide && panelOpen ? "with-panel" : ""}`} style={vars} data-layout={layout}>
      {layout !== "land" && topBar}
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button
            className="flat"
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
        <main className="play" aria-label="game">
          <div className="stage" ref={stageRef}>
            <div className="table" ref={tableRef}>
              {layout === "phone" && <Seat p={players[1]} you={false} />}
              <div className={`board-wrap ${review ? "reviewing" : ""}`}>
                <BoardView
                  board={shownBoard}
                  flipped={settings.flipped}
                  cube={reviewTake ? review!.cube * 2 : review ? review.cube : match?.phase === "doubled" ? match.cube * 2 : (match?.cube ?? 1)}
                  cubeOwner={review ? review.cubeOwner : (match?.cubeOwner ?? -1)}
                  cubeOffered={reviewTake || (!review && match?.phase === "doubled")}
                  dice={shownDice}
                  diceOwner={diceOwner}
                  usedDice={humanMoving && !review && !preview ? steps.map((s) => s.die) : []}
                  sources={humanMoving && !warning && !review && !preview ? sources : undefined}
                  selected={null}
                  targets={undefined}
                  onPointClick={onPointClick}
                  onPointRightClick={onPointRightClick}
                  onDragMove={onDragMove}
                  canDrag={dragDests}
                  lastMove={lastMove}
                  preview={reviewArrows ? (replay.which ? null : reviewArrows.best) : preview}
                  previewAlt={reviewArrows && !replay.which ? reviewArrows.played : null}
                  active={me}
                  onDiceClick={onDiceClick}
                  onCubeClick={onCubeClick}
                />
              </div>
              {layout === "phone" && <Seat p={players[0]} you />}
              {layout !== "land" && statusLine}
              {layout === "phone" && buttons}
            </div>
          </div>
        </main>

        {layout === "wide" && panel}
        {layout === "land" && (
          <div className="land-col" data-testid="land-column">
            {topBar}
            {statusLine}
            {buttons}
          </div>
        )}
      </div>
      {layout !== "wide" && panel}
      {layout === "wide" && buttons}

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
      {online.state && (
        <InviteDialog
          open={inviteOpen}
          link={inviteLink(online.state.room)}
          settings={online.state.settings}
          joined={online.state.joined}
          onClose={() => setInviteOpen(false)}
        />
      )}
      <JoinDialog
        open={!!join}
        info={join?.info ?? null}
        name={settings.playerName}
        setName={(v) => setSetting("playerName", v)}
        error={join?.error ?? null}
        joining={!!join?.joining}
        onJoin={joinNow}
        onClose={() => {
          setJoin(null);
          setRoomInUrl(null);
          if (!match) setNewMatchOpen(true);
        }}
      />
      <ResignDialog open={resignOpen} cube={match?.cube ?? 1} onResign={humanResign} onClose={() => setResignOpen(false)} />
      {match && over && (
        <ResultDialog
          open={resultOpen}
          match={match}
          analysis={analysis}
          deeperLabel={analysis.summary && analysis.summary.preset !== deeperPreset(settings.hintLevel) ? levelLabel(deeperPreset(settings.hintLevel)) : null}
          onClose={() => setResultOpen(false)}
          onNext={startNextGame}
          onNewMatch={isOnline ? actions.rematch! : actions.newMatch}
          newMatchLabel={isOnline ? "Rematch" : "New match"}
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

/** How many moves "Take back" can go back in a game. */
const TAKE_BACK_DEPTH = 30;

// ---- the match in progress, saved in this browser ----------------------------------------------
// So a reload, or a visit to the review page ("Full review"), does not lose
// the match. Bump SAVE_VERSION when MatchState changes shape: older saves are
// then ignored.
const SAVE_KEY = "gnubg-web.match";
const SAVE_VERSION = 1;

function saveMatch(match: MatchState, botLevel: Preset) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ v: SAVE_VERSION, match, botLevel }));
  } catch {
    // storage unavailable or full: the match just is not kept
  }
}

/** The saved match, unless there is none, it is finished, or it is from an older version. */
function loadSavedMatch(): { match: MatchState; botLevel: Preset } | null {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) ?? "null");
    if (!s || s.v !== SAVE_VERSION || !s.match?.record?.games?.length || !Array.isArray(s.match.board)) return null;
    if (s.match.phase === "matchOver") return null;
    return { match: s.match as MatchState, botLevel: s.botLevel as Preset };
  } catch {
    return null;
  }
}

/** How long a roll with no legal move stays on screen before the turn passes to gnubg. */
const NO_MOVE_PAUSE_MS = 1200;

/** The level for "Analyse deeper": the hint strength, but at least world class. */
function deeperPreset(hintLevel: Preset): Preset {
  return hintLevel === "expert" ? "world class" : hintLevel;
}

function openingNotice(m: MatchState): string {
  const d = m.openingDice!;
  const N = m.record.playerNames;
  return `Opening roll: ${N[1]} ${d[1]}, ${N[0]} ${d[0]}. ${says(N[m.turn], "move")} first.`;
}
