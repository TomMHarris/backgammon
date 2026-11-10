"use client";
// The current decision in detail: the move played against gnubg's best, the
// error and gnubg's mark, the luck of the roll, gnubg's top alternatives
// (clicking one shows it on the board) and, for cube actions, gnubg's three
// cube equities with its proper action. Every number is gnubg's
// (get_analysis); this component only lays them out.

import { useState } from "react";
import type { AnalysedMove, Cost, RecordCubeDecision, SkillMark } from "@/engine/types";
import {
  LUCK_TEXT,
  SKILL_TEXT,
  costText,
  percent,
  playedMove,
  playerName,
  resignOf,
  signed,
  type Decision,
  type LuckLabel,
  type MatchView,
} from "@/lib/analysisView";
import Outcome, { type Tone } from "./Outcome";
import s from "./Analysis.module.css";

export type Unit = "mwc" | "emg";
const FEW = 5; // alternatives shown before "show all"

interface Props {
  view: MatchView;
  d: Decision;
  unit: Unit; // match play: show MWC or EMG first (money: always equity)
  onUnit: (u: Unit) => void;
  shownMove: string | null; // the move drawn on the board, or null (position before)
  onShowMove: (move: string | null) => void;
  toneOf: (player: number) => Tone;
}

export function SkillMarkTag({ skill, what }: { skill: SkillMark; what?: string }) {
  if (skill === "none") return null;
  return (
    <span className={`${s.mark} ${s[`mk-${skill}`]}`} data-testid="skill-mark" title={what ? `${what}: ${SKILL_TEXT[skill]}` : undefined}>
      {SKILL_TEXT[skill]}
    </span>
  );
}
export function LuckTag({ luck }: { luck: LuckLabel }) {
  if (luck === "none") return null;
  return (
    <span className={`${s.mark} ${s[`lk-${luck}`]}`} data-testid="luck-mark">
      {LUCK_TEXT[luck]}
      {luck === "verylucky" ? " · joker" : luck === "veryunlucky" ? " · stinker" : ""}
    </span>
  );
}

export default function DecisionPanel({ view, d, unit, onUnit, shownMove, onShowMove, toneOf }: Props) {
  const match = view.matchLength > 0;
  const r = d.record;
  const who = playerName(view, d.player);
  const g = view.games[d.game];
  const score = match
    ? `score ${g.scoreBefore[0]}–${g.scoreBefore[1]} of ${view.matchLength}${g.crawfordGame ? " · Crawford" : ""}`
    : `score ${g.scoreBefore[0]}–${g.scoreBefore[1]}`;
  const cubeOwner = r.cubeOwner === -1 ? "centred" : `owned by ${playerName(view, r.cubeOwner)}`;
  const verb =
    d.kind === "move"
      ? r.dice
        ? `rolls ${r.dice[0]}${r.dice[1]}`
        : "moves"
      : d.kind === "double"
        ? `doubles to ${r.newCube ?? 2 * r.cube}`
        : d.kind === "take"
          ? `takes ${2 * r.cube}`
          : d.kind === "drop"
            ? "passes"
            : "resigns";

  return (
    <section className={s.panel} aria-labelledby="decision-title" data-testid="decision">
      <div className={s.panelHead}>
        <h2 className={s.panelTitle} id="decision-title">
          Decision
        </h2>
        {match && (
          <span className="segmented segmented-sm" role="radiogroup" aria-label="Units">
            {(["mwc", "emg"] as Unit[]).map((u) => (
              <label key={u} className={u === unit ? "on" : ""} title={u === "mwc" ? "Match winning chances" : "Equivalent to money game equity"}>
                <input type="radio" name="unit" checked={u === unit} onChange={() => onUnit(u)} data-testid={`unit-${u}`} />
                <span>{u.toUpperCase()}</span>
              </label>
            ))}
          </span>
        )}
      </div>
      <div className={s.panelBody}>
        <div className={s.decHead}>
          <span className={`piece ${toneOf(d.player) === "ivory" ? "piece-ivory" : "piece-walnut"}`} aria-hidden="true" />
          <span className={s.decWho} data-testid="decision-who">
            <span className={s.name}>{who}</span> {verb}
          </span>
          <SkillMarkTag skill={d.skill} />
          <LuckTag luck={d.luck} />
          <span className={`${s.decMeta} tnum`}>
            Game {d.game + 1} · move {d.row} · {score} · cube {r.cube} {cubeOwner}
          </span>
        </div>
        {!d.analysed && d.kind !== "resign" && (
          <p className={s.sub + " muted small"} data-testid="not-analysed">
            Not analysed yet
          </p>
        )}
        {d.kind === "move" && <MoveDetails key={d.seq} view={view} d={d} unit={unit} shownMove={shownMove} onShowMove={onShowMove} toneOf={toneOf} />}
        {(d.kind === "double" || d.kind === "take" || d.kind === "drop") && r.cubeDecision && (
          <CubeDetails view={view} d={d} cd={r.cubeDecision} unit={unit} toneOf={toneOf} />
        )}
        {d.kind === "resign" && <ResignDetails view={view} d={d} />}
      </div>
    </section>
  );
}

/** An error / equity in the chosen unit; the other unit (or money points) in brackets, as gnubg prints it. */
function costIn(c: Cost, match: boolean, unit: Unit): string {
  if (!match || unit === "emg" || c.mwc === undefined) return costText(c, match ? 1 : 0);
  return `${signed(100 * c.mwc, 2)}% (${signed(c.equity, 3)} EMG)`;
}

function MoveDetails({ view, d, unit, shownMove, onShowMove, toneOf }: Omit<Props, "onUnit">) {
  const r = d.record;
  const match = view.matchLength > 0;
  const ch = r.chequer;
  const played = playedMove(r);
  const best = ch?.moves?.[0] ?? null;
  const legal = ch?.legalMoves ?? 0;
  const useMwc = match && unit === "mwc";
  const eq = (m: AnalysedMove) => (useMwc && m.mwc !== undefined ? percent(m.mwc, 2) : signed(m.equity, 3));
  const diff = (m: AnalysedMove) =>
    m.rank === 0 || !best
      ? ""
      : useMwc && m.mwc !== undefined && best.mwc !== undefined
        ? `${signed(100 * (m.mwc - best.mwc), 2)}%`
        : signed(m.diff, 3);
  const tone = toneOf(d.player);
  const who = playerName(view, d.player);
  const [showAll, setShowAll] = useState(false);

  return (
    <>
      {ch?.analysed ? (
        <div className={s.verdict} data-testid="verdict">
          <span className={s.vLabel}>Played</span>
          <span className={`${s.vMove} mono`} data-testid="played-move">
            {r.move || "no legal move"}
          </span>
          <span className={s.vRight}>
            {played && played.rank > 0 ? (
              <>
                <SkillMarkTag skill={ch.skill} what="checker play" /> <span data-testid="move-error">{costIn(ch.error, match, unit)}</span>
              </>
            ) : legal > 1 ? (
              <span className="muted">gnubg&apos;s choice</span>
            ) : null}
          </span>
          {best && played && played.rank > 0 && (
            <>
              <span className={s.vLabel}>Best</span>
              <span className={`${s.vMove} mono`} data-testid="best-move">
                {best.move}
              </span>
              <span className={s.vRight} />
            </>
          )}
          {legal <= 1 && <span className={s.vNote}>{legal === 0 ? "No legal move: nothing to decide" : "Forced move: the only legal play"}</span>}
          {played && played.rank > 0 && (
            <span className={s.vNote}>
              gnubg ranks it #{played.rank + 1} of {legal} legal moves
            </span>
          )}
        </div>
      ) : null}

      {r.luck && (
        <p className={`${s.sub} small`} data-testid="luck">
          <span className="muted">Luck of the roll </span>
          <span className="tnum">{costIn(r.luck, match, unit)}</span> <LuckTag luck={r.luck.label as LuckLabel} />
        </p>
      )}

      {r.cubeDecision && <CubeDetails view={view} d={d} cd={r.cubeDecision} unit={unit} toneOf={toneOf} beforeRoll />}

      {ch?.analysed && ch.moves && ch.moves.length > 0 && (
        <div className={s.sub}>
          <div className={s.subHead}>
            <span>
              gnubg&apos;s ranking · {ch.eval.plies}-ply{ch.eval.cubeful ? " cubeful" : ""} · {useMwc ? "MWC" : match ? "EMG" : "equity"} for {who}
            </span>
            {shownMove !== null ? (
              <button className="flat flat-sm flat-quiet" onClick={() => onShowMove(null)} data-testid="show-before">
                Show position before
              </button>
            ) : (
              r.move && (
                <button className="flat flat-sm flat-quiet" onClick={() => onShowMove(r.move!)} data-testid="show-played">
                  Show played move
                </button>
              )
            )}
          </div>
          <ol className={s.alts} data-testid="alternatives">
            {ch.moves.filter((m, k) => showAll || k < FEW || m.rank === ch.playedIndex || m.move === shownMove).map((m) => {
              const isPlayed = m.rank === ch.playedIndex;
              const shown = shownMove === m.move;
              return (
                <li key={`${m.rank}-${m.move}`}>
                  <button
                    className={`${s.alt} ${shown ? s.shown : ""} ${isPlayed ? `${s.played} ${s[`err-${ch.skill}`] ?? ""}` : ""}`}
                    onClick={() => onShowMove(shown ? null : m.move)}
                    aria-pressed={shown}
                    data-testid="alternative"
                  >
                    <span className={s.altRank}>{m.rank + 1}</span>
                    <span className={s.altMove}>
                      {m.move || "no move"}
                      {isPlayed && <span className={s.altTag}>Played</span>}
                    </span>
                    <span className={s.altEq}>{eq(m)}</span>
                    <span className={s.altDiff}>{diff(m)}</span>
                    <span className={s.altOut}>
                      <Outcome probs={m.probs} tone={tone} who={who} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <p className={s.legend}>
            {ch.moves.length > FEW + 1 && (
              <button className={s.linkBtn} onClick={() => setShowAll(!showAll)} data-testid="more-alternatives">
                {showAll ? `Show top ${FEW}` : `Show all ${ch.moves.length} listed`}
              </button>
            )}
            {ch.moves.length < legal && <span>gnubg lists its top moves of {legal} legal ones</span>}
          </p>
        </div>
      )}
    </>
  );
}

const CUBE_ROWS: { key: "noDouble" | "doubleTake" | "doublePass"; label: string }[] = [
  { key: "noDouble", label: "No double" },
  { key: "doubleTake", label: "Double, take" },
  { key: "doublePass", label: "Double, pass" },
];
const ACTUAL_ROW: Record<string, "noDouble" | "doubleTake" | "doublePass" | null> = {
  "no double": "noDouble",
  double: null,
  take: "doubleTake",
  drop: "doublePass",
};

function CubeDetails({
  view,
  d,
  cd,
  unit,
  toneOf,
  beforeRoll,
}: {
  view: MatchView;
  d: Decision;
  cd: RecordCubeDecision & { raw?: { noDoubleProbs?: AnalysedMove["probs"] } };
  unit: Unit;
  toneOf: (p: number) => Tone;
  beforeRoll?: boolean;
}) {
  const match = view.matchLength > 0;
  const doubler = d.onRoll;
  const name = playerName(view, doubler);
  const actualRow = ACTUAL_ROW[cd.actual];
  const errored = cd.error && cd.error.equity < 0;
  const mwcFirst = match && unit === "mwc" && cd.mwc;
  const cols: { k: "eq" | "mwc"; label: string }[] = match && cd.mwc
    ? mwcFirst
      ? [
          { k: "mwc", label: "MWC" },
          { k: "eq", label: "EMG" },
        ]
      : [
          { k: "eq", label: "EMG" },
          { k: "mwc", label: "MWC" },
        ]
    : [{ k: "eq", label: "Equity" }];
  const val = (k: "eq" | "mwc", row: "noDouble" | "doubleTake" | "doublePass") =>
    k === "mwc" ? percent(cd.mwc![row], 2) : signed(cd.equities[row], 3);
  const actualText = { "no double": "No double", double: "Double", take: "Take", drop: "Pass" }[cd.actual] ?? cd.actual;
  const who = d.kind === "take" || d.kind === "drop" ? playerName(view, d.player) : name;

  // gnubg's verdict on a no-double that was right and not close: one line is enough
  if (beforeRoll && !cd.close && !errored) {
    return (
      <p className={`${s.sub} small`} data-testid="cube-line">
        <span className="muted">Cube before the roll · </span>
        no double · gnubg: {cd.proper.toLowerCase()}
        {cd.percent !== null && <span className="muted tnum"> ({percent(cd.percent, 1)})</span>}
      </p>
    );
  }
  return (
    <div className={s.sub} data-testid="cube-decision">
      <div className={s.subHead}>
        <span>
          {beforeRoll ? "Cube decision before the roll" : "Cube decision"} · {cd.eval.plies}-ply · from {name}&apos;s side
        </span>
      </div>
      <table className={s.cubeTable}>
        <thead>
          <tr>
            <th scope="col">Action</th>
            {cols.map((c) => (
              <th key={c.k} scope="col" className={s.num}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CUBE_ROWS.map((row) => {
            const best = cd.equities[row.key] === cd.equities.optimal;
            const actual = actualRow === row.key;
            return (
              <tr key={row.key} className={best ? s.best : ""}>
                <th scope="row">
                  {row.label}
                  {best && <span className={s.tag}>Best</span>}
                  {actual && <span className={s.tag}>{actualText}</span>}
                </th>
                {cols.map((c) => (
                  <td key={c.k} className={s.num}>
                    {val(c.k, row.key)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={s.verdict}>
        <span className={s.vLabel}>gnubg</span>
        <span className={s.vMove} data-testid="cube-proper">
          {cd.proper}
          {cd.percent !== null && <span className="muted tnum"> ({percent(cd.percent, 1)})</span>}
        </span>
        <span className={s.vRight}>{cd.close ? <span className="muted">Close</span> : null}</span>
        <span className={s.vLabel}>{who}</span>
        <span className={s.vMove} data-testid="cube-actual">
          {actualText}
        </span>
        <span className={s.vRight}>
          {errored ? (
            <>
              <span data-testid="cube-error">{costIn(cd.error, match, unit)}</span> <SkillMarkTag skill={cd.skill} what="cube" />
            </>
          ) : (
            <span className="muted">Correct</span>
          )}
        </span>
      </div>
      {cd.raw?.noDoubleProbs && (
        <div className={s.sub}>
          <div className={s.subHead}>
            <span>{name}&apos;s chances (cubeless)</span>
          </div>
          <Outcome probs={cd.raw.noDoubleProbs} tone={toneOf(doubler)} who={name} />
        </div>
      )}
    </div>
  );
}

function ResignDetails({ view, d }: { view: MatchView; d: Decision }) {
  const rs = resignOf(d.record);
  if (!rs) return null;
  const match = view.matchLength > 0;
  return (
    <div className={s.verdict} data-testid="resign">
      <span className={s.vLabel}>Offer</span>
      <span className={s.vMove}>{rs.type}</span>
      <span className={s.vRight}>
        <SkillMarkTag skill={rs.resignSkill ?? "none"} what="resignation" />
      </span>
      {rs.analysed && rs.equityBefore !== undefined && rs.equityAfter !== undefined && (
        <span className={s.vNote}>
          gnubg: equity {signed(rs.equityBefore, 3)} before, {signed(rs.equityAfter, 3)} after resigning
          {match ? " (EMG)" : ""}
        </span>
      )}
      {rs.acceptSkill && rs.acceptSkill !== "none" && (
        <span className={s.vNote}>
          Accepting: <SkillMarkTag skill={rs.acceptSkill} />
        </span>
      )}
    </div>
  );
}
