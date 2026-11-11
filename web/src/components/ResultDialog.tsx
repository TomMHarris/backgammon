"use client";
// The summary shown when a game or the match ends: who won, the score, and
// gnubg's analysis of the game (or of the whole match): your winning chances
// over the game as a small graph (a click opens the full review at that
// decision), error rates with gnubg's rating labels, luck, and your biggest
// mistakes. The numbers are
// gnubg's statistics, verbatim (see lib/analysis.ts); rates are shown x1000
// in mEMG, negated for errors, as gnubg's "show statistics" prints them.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Cost, PlayerStatistics } from "@/engine/types";
import type { MatchState } from "@/game/match";
import type { AnalysisSummary, Mistake } from "@/lib/analysis";
import { matchWinner } from "@/game/match";
import { toMatText } from "@/game/matFile";
import { fmtEq, pct, points, possessive, resultKind, says } from "@/lib/format";
import { levelLabel } from "@/lib/settings";
import { graphPoints, percent, SKILL_TEXT } from "@/lib/analysisView";
import { useElementWidth } from "@/lib/hooks";
import Dialog from "./ui/Dialog";
import WinGraph, { markTitle } from "./WinGraph";

export interface AnalysisState {
  status: "idle" | "running" | "done" | "error";
  scope: "game" | "match";
  progress?: [number, number];
  summary?: AnalysisSummary;
  error?: string;
}

/** sessionStorage key read by the analysis page (/analysis?source=session). */
export const REVIEW_KEY = "gnubg-web.reviewMatch";

export default function ResultDialog({
  open,
  match,
  analysis,
  deeperLabel,
  onClose,
  onNext,
  onNewMatch,
  newMatchLabel = "New match",
  onDeeper,
  onMistake,
  onDownload,
}: {
  open: boolean;
  match: MatchState;
  analysis: AnalysisState;
  deeperLabel: string | null; // e.g. "World class"; null = no deeper level available
  onClose: () => void;
  onNext: () => void;
  onNewMatch: () => void;
  newMatchLabel?: string; // "Rematch" in an online game
  onDeeper: () => void;
  onMistake: (m: Mistake) => void;
  onDownload: () => void;
}) {
  const over = match.phase === "matchOver";
  const r = match.lastResult;
  const N = match.record.playerNames; // [player 0, player 1]
  const two = !!match.settings.twoPlayer;
  const winner = over ? matchWinner(match) : (r?.winner ?? null);
  const youWon = two || winner === 1; // (the "won" look: always, when two people play)
  const n = match.settings.matchLength;
  const title = winner === null ? "" : `${says(N[winner], "win")} the ${over ? "match" : "game"}`;
  const kind = r ? `${resultKind(match)} · ${points(r.points)}` : "";
  const router = useRouter();

  // "Full review": hand the match (as .mat text) to the analysis page,
  // optionally with the decision to open at (game index, decision within it).
  const fullReview = (at?: { game: number; decision: number }) => {
    try {
      sessionStorage.setItem(REVIEW_KEY, JSON.stringify({ format: "mat", text: toMatText(match.record), name: `Game of ${match.record.date}`, ...at }));
    } catch {
      /* storage unavailable: the analysis page then asks for a file */
    }
    router.push("/analysis?source=session");
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={<span data-testid="result-title">{title}</span>}
      testId="result-dialog"
      className="dialog-result"
      footer={
        <>
          <button className="flat flat-quiet" onClick={onClose} data-testid="view-board">
            View board
          </button>
          {over && (
            <button className="flat" onClick={onDownload} title="Download the match as a .mat file">
              .mat
            </button>
          )}
          <button className="flat" onClick={() => fullReview()} title="Analyse every move of the match on the review page" data-testid="full-review">
            Full review
          </button>
          {over ? (
            <button className="flat flat-primary" onClick={onNewMatch} data-testid="new-match" data-autofocus>
              {newMatchLabel}
            </button>
          ) : (
            <button className="flat flat-primary" onClick={onNext} data-testid="next-game" data-autofocus>
              Next game
            </button>
          )}
        </>
      }
    >
      <div className={`result-hero ${youWon ? "won" : "lost"}`}>
        <p className="result-kind">{over ? `Last game: ${kind}` : kind}</p>
        <p className="result-score tnum" aria-label={`score: ${N[1]} ${match.score[1]}, ${N[0]} ${match.score[0]}`}>
          <span className="piece piece-ivory" aria-hidden="true" />
          <span>{N[1]}</span>
          <strong>{match.score[1]}</strong>
          <span className="result-dash">–</span>
          <strong>{match.score[0]}</strong>
          <span>{N[0]}</span>
          <span className="piece piece-walnut" aria-hidden="true" />
          {n > 0 && <span className="result-to">· to {n}</span>}
        </p>
      </div>

      <AnalysisView analysis={analysis} deeperLabel={deeperLabel} onDeeper={onDeeper} onMistake={onMistake} onReviewAt={fullReview} />
    </Dialog>
  );
}

function AnalysisView({
  analysis: a,
  deeperLabel,
  onDeeper,
  onMistake,
  onReviewAt,
}: {
  analysis: AnalysisState;
  deeperLabel: string | null;
  onDeeper: () => void;
  onMistake: (m: Mistake) => void;
  onReviewAt: (at: { game: number; decision: number }) => void;
}) {
  const s = a.summary;
  const heading = a.scope === "match" ? "Match analysis" : "Game analysis";
  return (
    <section className="analysis" aria-label={heading} data-testid="analysis">
      <header className="analysis-head">
        <h3>{heading}</h3>
        {s && (
          <span className="badge" data-testid="analysis-level">
            gnubg {levelLabel(s.preset)} · {s.plies}-ply
          </span>
        )}
        {deeperLabel && a.status !== "running" && (
          <button className="flat flat-sm" onClick={onDeeper} data-testid="analyse-deeper">
            Analyse deeper ({deeperLabel})
          </button>
        )}
      </header>

      {a.status === "running" && (
        <div className="analysis-running" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>
            gnubg is analysing{a.progress && a.progress[1] > 1 ? ` game ${Math.min(a.progress[0] + 1, a.progress[1])} of ${a.progress[1]}` : ""}…
          </span>
          {a.progress && a.progress[1] > 1 && (
            <div className="progress progress-sm">
              <div className="progress-bar" style={{ width: `${(100 * a.progress[0]) / a.progress[1]}%` }} />
            </div>
          )}
        </div>
      )}
      {a.status === "error" && (
        <p className="error-text" role="alert">
          The analysis failed: {a.error}
        </p>
      )}
      {s && a.status !== "running" && <MiniGraph s={s} onPick={onReviewAt} />}
      {s && a.status !== "running" && <Stats s={s} />}
      {s && a.status !== "running" && <Mistakes s={s} onMistake={onMistake} />}
    </section>
  );
}

/**
 * Your winning chances after each decision of the game (or the match), from
 * the same analysis (analysisView.graphPoints over gnubg's get_analysis
 * reply), with gnubg's error marks. A click or tap opens the full review at
 * that decision.
 */
function MiniGraph({ s, onPick }: { s: AnalysisSummary; onPick: (at: { game: number; decision: number }) => void }) {
  const { ref, w } = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pts = useMemo(() => graphPoints(s.view.decisions, "win", s.human, s.matchLength), [s]);
  if (!pts.some((p) => p.y !== null)) return null;
  const who = (p: number) => (p === s.human ? s.names[1] : s.names[0]);
  const chances = s.twoPlayer && s.names[1] !== "You" ? `${s.names[1]} wins` : "you win";
  const hp = hover !== null ? pts[hover] : null;
  const readout = hp
    ? [
        s.scope === "match" ? `Game ${hp.d.game + 1}` : null,
        `Move ${hp.d.row}`,
        `${who(hp.d.player)} ${hp.d.text}`,
        hp.y !== null ? `${chances} ${percent(hp.y, 1)}` : null,
        hp.d.skill !== "none" ? SKILL_TEXT[hp.d.skill] : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "Dots: errors (doubtful · bad · very bad). Tap a point to review it.";
  return (
    <div className="mini-graph" data-testid="mini-graph">
      <h4>
        {possessive(s.names[1])} winning chances over the {s.scope === "match" ? "match" : "game"}
      </h4>
      <div className="mini-graph-box" ref={ref}>
        {w > 0 && (
          <WinGraph
            pts={pts}
            width={w}
            height={w < 400 ? 104 : 116}
            domain={[0, 1]}
            ticks={[0, 0.5, 1]}
            reference={0.5}
            fmtTick={(v) => percent(v, 0)}
            perspective={s.human}
            hover={hover}
            onHover={setHover}
            onPick={(i) => onPick({ game: pts[i].d.game, decision: pts[i].d.gameSeq })}
            compact
            zoneLabels={[`${s.names[1]} ahead`, `${s.names[0]} ahead`]}
            pointTitle={(p, what) => markTitle(who(p.d.player), p, what)}
            ariaLabel={`${possessive(s.names[1])} winning chances after each move; activate a point to open the full review there`}
            testId="mini-graph-svg"
          />
        )}
      </div>
      <p className="mini-graph-readout tnum" aria-live="polite">
        {readout}
      </p>
    </div>
  );
}

/**
 * gnubg's rates: x errorRateFactor (mEMG), errors negated as gnubg prints them.
 * A per-move rate is missing (null) when a player made no moves, e.g. after
 * resigning at once: shown as a dash.
 */
function rate(c: Cost | null | undefined, f: number, sign: -1 | 1) {
  if (!c || typeof c.equity !== "number") return "—";
  const v = sign * c.equity * f;
  return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1);
}

function Stats({ s }: { s: AnalysisSummary }) {
  const f = s.errorRateFactor;
  const [bot, you] = s.stats;
  const result = (p: PlayerStatistics, key: "actualResult" | "luckAdjustedResult") => {
    const v = p.overall[key];
    if (typeof v !== "number") return "—";
    return s.matchLength ? (v >= 0 ? "+" : "−") + pct(Math.abs(v), 1) : fmtEq(v, 3);
  };
  const rows: { label: string; hint?: string; cells: [React.ReactNode, React.ReactNode] }[] = [
    {
      label: "Overall",
      hint: "gnubg's rating of all decisions",
      cells: [<Rating key="y" label={you.overall.rating} />, <Rating key="b" label={bot.overall.rating} />],
    },
    {
      label: "Checker play",
      hint: "Error rate, mEMG per move",
      cells: [<Rate key="y" v={rate(you.chequer.errorPerMove, f, -1)} label={you.chequer.rating} />, <Rate key="b" v={rate(bot.chequer.errorPerMove, f, -1)} label={bot.chequer.rating} />],
    },
    {
      label: "Cube",
      hint: "Error rate, mEMG per close decision",
      cells: [
        you.cube.close ? <Rate key="y" v={rate(you.cube.errorPerDecision, f, -1)} label={you.cube.rating} /> : <span className="muted" title="no close cube decisions">—</span>,
        bot.cube.close ? <Rate key="b" v={rate(bot.cube.errorPerDecision, f, -1)} label={bot.cube.rating} /> : <span className="muted" title="no close cube decisions">—</span>,
      ],
    },
    {
      label: "Errors",
      hint: "Doubtful · bad · very bad moves",
      cells: [<Marks key="y" p={you} />, <Marks key="b" p={bot} />],
    },
    {
      label: "Luck",
      hint: "mEMG per move",
      cells: [<Rate key="y" v={rate(you.luck.perMove, f, 1)} label={you.luck.rating} />, <Rate key="b" v={rate(bot.luck.perMove, f, 1)} label={bot.luck.rating} />],
    },
    {
      label: "Luck-adjusted result",
      hint: s.matchLength ? "Match winning chances" : "Points",
      cells: [
        <span key="y" className="tnum">
          {result(you, "luckAdjustedResult")}
        </span>,
        <span key="b" className="tnum">
          {result(bot, "luckAdjustedResult")}
        </span>,
      ],
    },
    {
      label: "Actual result",
      hint: s.matchLength ? "Match winning chances" : "Points",
      cells: [
        <span key="y" className="tnum">
          {result(you, "actualResult")}
        </span>,
        <span key="b" className="tnum">
          {result(bot, "actualResult")}
        </span>,
      ],
    },
  ];
  return (
    <>
    <table className="stats-table" data-testid="stats">
      <thead>
        <tr>
          <th scope="col">
            <span className="sr-only">Statistic</span>
          </th>
          <th scope="col">{s.names[1]}</th>
          <th scope="col">{s.names[0]}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <th scope="row" title={r.hint}>
              {r.label}
            </th>
            <td>{r.cells[0]}</td>
            <td>{r.cells[1]}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <p className="stats-note">
      Error and luck rates in mEMG per decision, as gnubg&apos;s statistics show them. Errors: doubtful · bad · very bad.
    </p>
    </>
  );
}

function Rating({ label }: { label: string | null }) {
  return <span className="rating">{label ?? "n/a"}</span>;
}
function Rate({ v, label }: { v: string; label: string | null }) {
  return (
    <span className="rate">
      <span className="tnum rate-v">{v}</span>
      {label && <span className="rate-label">{label}</span>}
    </span>
  );
}
function Marks({ p }: { p: PlayerStatistics }) {
  const m = p.chequer.marked;
  return (
    <span className="marks tnum" aria-label={`${m.doubtful} doubtful, ${m.bad} bad, ${m.veryBad} very bad`}>
      <span className="mark mark-doubtful">{m.doubtful}</span>
      <span className="mark mark-bad">{m.bad}</span>
      <span className="mark mark-verybad">{m.veryBad}</span>
    </span>
  );
}

const SEV: Record<string, string> = { doubtful: "Doubtful", bad: "Bad", verybad: "Very bad", none: "" };

function Mistakes({ s, onMistake }: { s: AnalysisSummary; onMistake: (m: Mistake) => void }) {
  if (!s.mistakes.length)
    return (
      <p className="analysis-clean" data-testid="no-mistakes">
        No errors by gnubg&apos;s reckoning. Well played!
      </p>
    );
  return (
    <div className="mistakes">
      <h4>{s.twoPlayer ? "Biggest mistakes" : "Your biggest mistakes"}</h4>
      <ol className="mistake-list" data-testid="mistakes">
        {s.mistakes.map((m, k) => (
          <li key={k}>
            <button className="mistake" onClick={() => onMistake(m)} data-testid="mistake">
              <span className={`sev sev-${m.skill === "none" ? "doubtful" : m.skill}`}>{SEV[m.skill] || "minor"}</span>
              <span className="mistake-main">
                <span className="mistake-where">
                  {s.twoPlayer ? `${s.names[m.player]} · ` : ""}
                  {s.scope === "match" ? `Game ${m.game + 1} · ` : ""}Move {m.row}
                  {m.dice ? ` · ${m.dice[0]}-${m.dice[1]}` : " · cube"}
                </span>
                <span className="mistake-moves">
                  <span>
                    Played <span className="mono">{m.played || "—"}</span>
                  </span>
                  <span>
                    Best <span className="mono">{m.best}</span>
                  </span>
                </span>
              </span>
              <span className="mistake-loss tnum">
                {fmtEq(m.error.equity)}
                {m.error.mwc !== undefined && <small>−{pct(Math.abs(m.error.mwc), 2)} MWC</small>}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
