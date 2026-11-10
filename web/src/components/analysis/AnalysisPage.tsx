"use client";
// The analysis page (/analysis): load a match (a file, the sample match, or
// the game just played, handed over in sessionStorage), let gnubg analyse
// it game by game, then review every decision on the board with gnubg's
// verdicts, follow the game in a graph, read gnubg's statistics, and export
// the analysed match.
//
//   /analysis                    pick a file, drop one, or try the sample
//   /analysis?source=session     the game screen's "Full review" (REVIEW_KEY)
//   /analysis?source=sample      the sample match
//
// Engine calls: lib/analysisRun.ts. What is shown: lib/analysisView.ts
// (gnubg's numbers verbatim). Layout: Analysis.module.css.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BoardView from "@/components/BoardView";
import LoadingScreen from "@/components/LoadingScreen";
import { Segmented } from "@/components/ui/controls";
import type { AnalysisResult, MatchOverview, Preset } from "@/engine/types";
import { pipCount } from "@/game/board";
import { useEngine } from "@/lib/hooks";
import { levelLabel, useSettings } from "@/lib/settings";
import {
  ANALYSIS_PRESETS,
  analyseMatch,
  baseName,
  download,
  exportText,
  fetchAnalysis,
  loadSource,
  readSessionSource,
  sourceFromFile,
  type MatchSource,
  type RunProgress,
} from "@/lib/analysisRun";
import {
  boardAfter,
  boardBefore,
  buildMatchView,
  cubeOf,
  diceOf,
  matchKind,
  moveTrail,
  nextMarked,
  playerName,
  previousMove,
  type Player,
} from "@/lib/analysisView";
import DecisionPanel, { type Unit } from "./DecisionPanel";
import EquityGraph from "./EquityGraph";
import MoveList from "./MoveList";
import StatsPanel from "./StatsPanel";
import type { Tone } from "./Outcome";
import s from "./Analysis.module.css";

const PRESET_KEY = "gnubg-web.analysisPreset";
const SAMPLE = { url: "/samples/selfplay-7pt.sgf", name: "selfplay-7pt.sgf" };

interface RunState {
  running: boolean;
  stopping: boolean;
  preset: Preset;
  progress: RunProgress | null;
}
type AnalysedWith =
  | { kind: "file" }
  | { kind: "preset"; preset: Preset; plies: number; filter: string; completed: number; total: number };

export default function AnalysisPage() {
  const { engineRef, progress: dl, initError, ready } = useEngine();
  const [settings] = useSettings(); // theme + board direction, as on the game screen
  const [preset, setPresetState] = useState<Preset>("world class");
  const [source, setSource] = useState<MatchSource | null>(null);
  const [overview, setOverview] = useState<MatchOverview | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [analysedWith, setAnalysedWith] = useState<AnalysedWith | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  const [shownMove, setShownMove] = useState<string | null>(null);
  const [unit, setUnit] = useState<Unit>("mwc");
  const [side, setSide] = useState<Player>(1); // the player drawn at the bottom and the graph's point of view
  const [dropping, setDropping] = useState(false);
  const stopRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const running = !!run?.running;

  // leaving the page stops a running analysis after the current game (the engine is shared with the game screen)
  useEffect(
    () => () => {
      stopRef.current = true;
    },
    []
  );

  const view = useMemo(() => (result ? buildMatchView(result) : null), [result]);
  const d = view && view.decisions.length ? view.decisions[Math.min(seq, view.decisions.length - 1)] : null;

  useEffect(() => {
    try {
      const p = localStorage.getItem(PRESET_KEY) as Preset | null;
      if (p && ANALYSIS_PRESETS.some((x) => x.value === p)) setPresetState(p);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const setPreset = (p: Preset) => {
    setPresetState(p);
    try {
      localStorage.setItem(PRESET_KEY, p);
    } catch {
      /* ignore */
    }
  };

  // ---- engine work -------------------------------------------------------------
  const startAnalysis = useCallback(async (info: MatchOverview, p: Preset) => {
    const engine = engineRef.current;
    if (!engine) return;
    stopRef.current = false;
    setError(null);
    setRun({ running: true, stopping: false, preset: p, progress: null });
    try {
      const { settings: used, completed } = await analyseMatch(engine, info, p, {
        onProgress: (pr) => setRun((r) => (r ? { ...r, progress: pr } : r)),
        // show each game's analysis as soon as it is done
        afterGame: async () => setResult(await fetchAnalysis(engine)),
        shouldStop: () => stopRef.current,
      });
      setResult(await fetchAnalysis(engine));
      setAnalysedWith({
        kind: "preset",
        preset: p,
        plies: used.chequer.eval.plies,
        filter: used.chequer.moveFilterName,
        completed,
        total: info.games.length,
      });
    } catch (e) {
      setError(`Analysis failed: ${(e as Error).message}`);
    } finally {
      setRun((r) => (r ? { ...r, running: false, stopping: false } : r));
    }
  }, [engineRef]);

  const openSource = useCallback(
    async (src: MatchSource, presetForRun: Preset) => {
      const engine = engineRef.current;
      if (!engine) return;
      setError(null);
      setLoading(true);
      try {
        await engine.ready;
        const info = await loadSource(engine, src);
        const res = await fetchAnalysis(engine);
        const hasAnalysis = buildMatchView(res).analysed;
        setSource(src);
        setOverview(info);
        setResult(res);
        setSeq(0);
        setShownMove(null);
        setRun(null);
        setAnalysedWith(hasAnalysis ? { kind: "file" } : null);
        setUnit(info.matchLength > 0 ? "mwc" : "emg");
        if (!hasAnalysis) void startAnalysis(info, presetForRun);
      } catch (e) {
        setError(`Could not load ${src.name}: ${(e as Error).message}`);
      } finally {
        setLoading(false);
      }
    },
    [engineRef, startAnalysis]
  );

  const openFile = useCallback(
    async (file: File) => {
      if (running) return;
      try {
        const text = await file.text();
        await openSource(sourceFromFile(file.name, text), preset);
      } catch (e) {
        setError(`Could not read ${file.name}: ${(e as Error).message}`);
      }
    },
    [openSource, preset, running]
  );

  const openSample = useCallback(async () => {
    if (running) return;
    try {
      const res = await fetch(SAMPLE.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await openSource({ format: "sgf", text: await res.text(), name: SAMPLE.name }, preset);
    } catch (e) {
      setError(`Could not load the sample match: ${(e as Error).message}`);
    }
  }, [openSource, preset, running]);

  // ?source=session / ?source=sample, once the engine is up (once per page load)
  const started = useRef(false);
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    const src = new URLSearchParams(window.location.search).get("source");
    if (src === "session") {
      const m = readSessionSource();
      if (m) void openSource(m, readPreset());
      else setError("No match was handed over from the game (or this tab's session ended). Open a match file instead.");
    } else if (src === "sample") void openSample();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const doExport = async (format: "sgf" | "mat") => {
    const engine = engineRef.current;
    if (!engine || !source) return;
    try {
      const text = await exportText(engine, format);
      download(text, `${baseName(source.name)}.${format}`, format === "sgf" ? "application/x-go-sgf" : "text/plain");
    } catch (e) {
      setError(`Export failed: ${(e as Error).message}`);
    }
  };

  // ---- navigation --------------------------------------------------------------
  const jump = useCallback(
    (k: number) => {
      if (!view || k < 0 || k >= view.decisions.length) return;
      setSeq(k);
      setShownMove(null);
    },
    [view]
  );
  const gameDecisions = d && view ? view.games[d.game].decisions : [];
  const go = useMemo(
    () => ({
      prev: () => d && jump(d.seq - 1),
      next: () => d && jump(d.seq + 1),
      prevError: () => d && view && jump(nextMarked(view, d.seq, -1)),
      nextError: () => d && view && jump(nextMarked(view, d.seq, 1)),
      first: () => d && view && jump(view.games[d.game].decisions[0].seq),
      last: () => d && view && jump(view.games[d.game].decisions[view.games[d.game].decisions.length - 1].seq),
    }),
    [d, view, jump]
  );

  useEffect(() => {
    if (!view) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      if (k === "ArrowLeft") (e.shiftKey ? go.prevError : go.prev)();
      else if (k === "ArrowRight") (e.shiftKey ? go.nextError : go.next)();
      else if (k === "Home") go.first();
      else if (k === "End") go.last();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, go]);

  // ---- drag and drop anywhere on the page ------------------------------------------
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDropping(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget === e.target) setDropping(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropping(false);
      const f = e.dataTransfer.files?.[0];
      if (f) void openFile(f);
    },
  };

  if (!ready) return <LoadingScreen progress={dl} error={initError} />;

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept=".sgf,.mat,.txt"
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = "";
        if (f) void openFile(f);
      }}
      data-testid="file-input"
    />
  );

  const toneOf = (p: number): Tone => (p === side ? "ivory" : "walnut");
  const subtitle = view
    ? `${playerName(view, 0)} vs ${playerName(view, 1)} · ${matchKind(view.matchLength)} · ${view.games.length} game${view.games.length === 1 ? "" : "s"}${source ? ` · ${source.name}` : ""}`
    : "gnubg's verdict on every decision";

  return (
    <div className={`${s.page} ${dropping ? s.dropping : ""}`} {...dropProps} data-testid="analysis-page">
      {fileInput}
      <header className={s.top}>
        <div className={s.titleBlock}>
          <h1 className={s.title}>Analysis</h1>
          <span className={s.subtitle} data-testid="match-title">
            {subtitle}
          </span>
        </div>
        <div className={s.topActions}>
          <Link className="flat flat-sm flat-quiet" href="/" data-testid="back-to-play">
            ← Play
          </Link>
          {view && (
            <>
              <button className="flat flat-sm" onClick={() => fileRef.current?.click()} disabled={running || loading} data-testid="open-file">
                <span>
                  Open<span className={s.wideOnly}> match</span>
                </span>
              </button>
              <button className="flat flat-sm" onClick={() => doExport("sgf")} disabled={running} data-testid="export-sgf" title="gnubg's SGF with the analysis">
                <span>
                  <span className={s.wideOnly}>Save </span>.sgf
                </span>
              </button>
              <button className="flat flat-sm" onClick={() => doExport("mat")} disabled={running} data-testid="export-mat" title="Jellyfish .mat (moves only)">
                <span>
                  <span className={s.wideOnly}>Save </span>.mat
                </span>
              </button>
            </>
          )}
        </div>
      </header>

      {error && (
        <div className={s.wide}>
          <p className={s.errorBox} role="alert" data-testid="error">
            {error}
          </p>
        </div>
      )}

      {!view ? (
        <Picker
          preset={preset}
          setPreset={setPreset}
          loading={loading}
          onChoose={() => fileRef.current?.click()}
          onSample={openSample}
          dropping={dropping}
        />
      ) : (
        <>
          <RunBar
            run={run}
            preset={preset}
            setPreset={setPreset}
            analysedWith={analysedWith}
            onAnalyse={() => overview && startAnalysis(overview, preset)}
            onStop={() => {
              stopRef.current = true;
              setRun((r) => (r ? { ...r, stopping: true } : r));
            }}
          />
          {d ? (
            <>
              <div className={s.review}>
                <BoardColumn
                  view={view}
                  d={d}
                  side={side}
                  setSide={setSide}
                  flipped={settings.flipped}
                  shownMove={shownMove}
                  go={go}
                  gameDecisions={gameDecisions}
                  jump={jump}
                />
                <div className={s.side}>
                  <DecisionPanel view={view} d={d} unit={unit} onUnit={setUnit} shownMove={shownMove} onShowMove={setShownMove} toneOf={toneOf} />
                  <MoveList view={view} game={d.game} current={d} onGame={(g) => jump(view.games[g].decisions[0]?.seq ?? 0)} onJump={jump} />
                </div>
              </div>
              <div className={s.wide}>
                <EquityGraph view={view} current={d} onJump={jump} perspective={side} onPerspective={setSide} />
              </div>
              <div className={s.wide}>
                <StatsPanel view={view} game={d.game} />
              </div>
            </>
          ) : (
            <p className="empty">This match has no moves.</p>
          )}
          <footer className={s.footer}>
            Analysis by GNU Backgammon 1.08.003, running in your browser · every number is gnubg&apos;s own
          </footer>
        </>
      )}
    </div>
  );
}

function readPreset(): Preset {
  try {
    const p = localStorage.getItem(PRESET_KEY) as Preset | null;
    if (p && ANALYSIS_PRESETS.some((x) => x.value === p)) return p;
  } catch {
    /* ignore */
  }
  return "world class";
}

const PRESET_OPTIONS = ANALYSIS_PRESETS.map((p) => ({ value: p.value, label: p.label, title: p.detail }));

function Picker({
  preset,
  setPreset,
  loading,
  onChoose,
  onSample,
  dropping,
}: {
  preset: Preset;
  setPreset: (p: Preset) => void;
  loading: boolean;
  onChoose: () => void;
  onSample: () => void;
  dropping: boolean;
}) {
  return (
    <main className={s.picker} data-testid="picker">
      <p className={s.pickerLead}>Let gnubg review a match, move by move.</p>
      <p className={s.pickerText}>
        Open a match saved by gnubg (.sgf) or a Jellyfish .mat file. gnubg analyses every game in your browser: the moves you played
        against its best, cube decisions, luck, and its statistics. At the end of a game, &ldquo;Full review&rdquo; brings your match here.
      </p>
      <div className={`${s.dropZone} ${dropping ? s.over : ""}`}>
        <span>Drop a .sgf or .mat file here</span>
        <div className={s.pickerRow}>
          <button className="flat flat-primary" onClick={onChoose} disabled={loading} data-testid="choose-file">
            Choose a file
          </button>
          <button className="flat" onClick={onSample} disabled={loading} data-testid="sample">
            Try a sample match
          </button>
        </div>
        {loading && (
          <span className="small">
            <span className="spinner" /> Loading the match
          </span>
        )}
      </div>
      <div className={s.field}>
        <span className={s.fieldLabel}>Analysis strength</span>
        <Segmented label="Analysis strength" value={preset} onChange={setPreset} options={PRESET_OPTIONS} testId="preset" />
        <span className="small muted">{ANALYSIS_PRESETS.find((p) => p.value === preset)?.detail}</span>
      </div>
    </main>
  );
}

function RunBar({
  run,
  preset,
  setPreset,
  analysedWith,
  onAnalyse,
  onStop,
}: {
  run: RunState | null;
  preset: Preset;
  setPreset: (p: Preset) => void;
  analysedWith: AnalysedWith | null;
  onAnalyse: () => void;
  onStop: () => void;
}) {
  const running = !!run?.running;
  const p = run?.progress;
  const pct = p && p.totalRecords ? Math.round((100 * p.records) / p.totalRecords) : 0;
  let status: React.ReactNode;
  if (running) {
    status = (
      <>
        <span className="spinner" aria-hidden="true" />
        {run!.stopping
          ? `Stopping after game ${Math.min((p?.game ?? 0) + 1, p?.games ?? 1)}`
          : `Analysing at ${levelLabel(run!.preset)}: game ${Math.min((p?.game ?? 0) + 1, p?.games ?? 1)} of ${p?.games ?? "…"} · ${pct}%`}
      </>
    );
  } else if (analysedWith?.kind === "preset") {
    status =
      analysedWith.completed < analysedWith.total
        ? `Stopped: ${analysedWith.completed} of ${analysedWith.total} games analysed at ${levelLabel(analysedWith.preset)}`
        : `Analysed at ${levelLabel(analysedWith.preset)} · checker play ${analysedWith.plies}-ply, ${analysedWith.filter.toLowerCase()} filter`;
  } else if (analysedWith?.kind === "file") status = "Showing the analysis saved in the file";
  else status = "Not analysed";

  return (
    <div className={s.runBar} data-testid="run-bar">
      <Segmented size="sm" label="Analysis strength" value={preset} onChange={setPreset} options={PRESET_OPTIONS} testId="preset" />
      {running ? (
        <button className="flat flat-sm" onClick={onStop} disabled={run!.stopping} data-testid="stop">
          Stop
        </button>
      ) : (
        <button className="flat flat-sm flat-primary" onClick={onAnalyse} data-testid="analyse">
          {analysedWith ? "Analyse again" : "Analyse"}
        </button>
      )}
      <span className={s.runStatus} role="status" aria-live="polite" data-testid="run-status" data-running={running ? "1" : "0"}>
        {status}
      </span>
      {running && (
        <div className={s.runProgress} role="progressbar" aria-label="Analysis progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={s.runProgressBar} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function BoardColumn({
  view,
  d,
  side,
  setSide,
  flipped,
  shownMove,
  go,
  gameDecisions,
  jump,
}: {
  view: NonNullable<ReturnType<typeof buildMatchView>>;
  d: NonNullable<ReturnType<typeof buildMatchView>>["decisions"][number];
  side: Player;
  setSide: (p: Player) => void;
  flipped: boolean;
  shownMove: string | null;
  go: Record<"prev" | "next" | "prevError" | "nextError" | "first" | "last", () => void>;
  gameDecisions: { seq: number }[];
  jump: (k: number) => void;
}) {
  // the board: before the decision, or after the move being shown
  let board = boardBefore(d, side);
  let trail = null;
  try {
    if (shownMove !== null) {
      board = boardAfter(d, shownMove, side);
      trail = moveTrail(d, shownMove, side);
    } else {
      const prev = previousMove(view, d);
      if (prev?.record.move) trail = moveTrail(prev, prev.record.move, side);
    }
  } catch {
    board = boardBefore(d, side);
    trail = null;
  }
  const cube = cubeOf(d, side);
  const dice = diceOf(d, side);
  const used = shownMove !== null && dice.dice ? (dice.dice[0] === dice.dice[1] ? [1, 2, 3, 4].map(() => dice.dice![0]) : [...dice.dice]) : [];
  const g = view.games[d.game];
  const strip = (p: Player, screen: 0 | 1) => (
    <div className={`${s.strip} ${d.player === p ? s.on : ""}`} data-testid={`strip-${screen ? "bottom" : "top"}`}>
      <span className={`piece ${p === side ? "piece-ivory" : "piece-walnut"}`} aria-hidden="true" />
      <span className={`${s.stripName} ${s.name}`}>{playerName(view, p)}</span>
      {d.player === p && <span className="sr-only">(to act)</span>}
      <span className={s.stripMeta}>
        {view.matchLength ? `${g.scoreBefore[p]} / ${view.matchLength}` : `${g.scoreBefore[p]} pts`} · {pipCount(board[screen])} pips
      </span>
    </div>
  );
  return (
    <section className={s.boardCol} aria-label="Board">
      {strip((1 - side) as Player, 0)}
      <div className={s.boardBox} data-testid="board-box" data-shown={shownMove ?? ""}>
        <BoardView
          board={board}
          flipped={flipped}
          cube={cube.cube}
          cubeOwner={cube.owner}
          cubeOffered={cube.offered}
          dice={dice.dice}
          diceOwner={dice.owner}
          usedDice={used}
          lastMove={trail}
        />
      </div>
      {strip(side, 1)}
      <div className={s.nav}>
        <div className={s.navBtns}>
          <button className="flat flat-sq" onClick={go.first} aria-label="First decision of the game" title="First (Home)" data-testid="nav-first">
            ⏮
          </button>
          <button className="flat flat-sq" onClick={go.prevError} aria-label="Previous error" title="Previous error (Shift ←)" data-testid="nav-prev-error">
            ‹?
          </button>
          <button className="flat flat-sq" onClick={go.prev} aria-label="Previous decision" title="Previous (←)" data-testid="nav-prev">
            ←
          </button>
        </div>
        <input
          type="range"
          className={s.scrubber}
          min={0}
          max={Math.max(0, gameDecisions.length - 1)}
          value={d.gameSeq}
          onChange={(e) => jump(gameDecisions[Number(e.target.value)].seq)}
          aria-label={`Decision in game ${d.game + 1}`}
          aria-valuetext={`move ${d.row}: ${playerName(view, d.player)} ${d.text}`}
          data-testid="scrubber"
        />
        <div className={s.navBtns}>
          <button className="flat flat-sq" onClick={go.next} aria-label="Next decision" title="Next (→)" data-testid="nav-next">
            →
          </button>
          <button className="flat flat-sq" onClick={go.nextError} aria-label="Next error" title="Next error (Shift →)" data-testid="nav-next-error">
            ?›
          </button>
          <button className="flat flat-sq" onClick={go.last} aria-label="Last decision of the game" title="Last (End)" data-testid="nav-last">
            ⏭
          </button>
        </div>
        <div className={s.navInfo}>
          <span className="tnum" data-testid="nav-position">
            Game {d.game + 1}/{view.games.length} · decision {d.gameSeq + 1}/{gameDecisions.length}
          </span>
          <span>
            <span className={s.keys}>
              <kbd>←</kbd> <kbd>→</kbd> step · <kbd>Shift</kbd> errors ·{" "}
            </span>
            <button className={s.linkBtn} onClick={() => setSide((1 - side) as Player)} data-testid="swap-sides">
              View from {playerName(view, 1 - side)}
            </button>
          </span>
        </div>
      </div>
    </section>
  );
}
