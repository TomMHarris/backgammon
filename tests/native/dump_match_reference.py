"""
dump_match_reference.py - native gnubg match analysis, as reference JSON.

Runs INSIDE native gnubg (embedded Python):

    MATCH=tests/corpus/matches/x.sgf OUT=/tmp/x.json HOME=$(mktemp -d) \
        engine/native/build/strict/gnubg -t -r -q -P engine/data \
        -p tests/native/dump_match_reference.py

Environment variables (gnubg passes no arguments to the script):

    MATCH            one match file, or several separated by ':' (analysed one
                     after the other in this same process = "single" mode).
                     .sgf is read with "load match", .mat with "import mat".
    OUT              output JSON file (required)
    ANALYSIS_PRESET  "world class" (default): 2-ply cubeful chequer and cube
                     analysis, normal move filter.
                     "supremo": gnubg's built-in analysis default
                     (EVALSETUP_SUPREMO + MOVEFILTER_LARGE, gnubg.c:460-464).
    JACOBY           "on" (gnubg's default) or "off": the global Jacoby
                     setting. It matters for .mat money sessions only: the
                     .mat format has no Jacoby field, so "import mat" gives
                     every money game the current global setting
                     (import.c:962), while an .sgf carries its own rule.
    CLEAR_CACHE      if 1: run "clear cache" before each match (so a match
                     analysed after another one in the same process starts
                     from an empty evaluation cache, like a fresh process)
    VARIANT, MODE    labels copied into the output

For each match: per game, per move record, gnubg's stored analysis (from
gnubg.match(analysis=1, verbose=1, statistics=1, boards=1)) plus a few values
derived from it with gnubg's own formulas (marked "derived", with the source
line); and the match statistics: gnubg's raw statcontext sums (float32, full
precision), the per-move rates "show statistics match" prints (derived from
the raw sums exactly as formatgs.c does), and the text of
"show statistics match" itself. Details: tests/native/PYTHON_INTERFACE.md.
"""

import json
import os
import struct
import sys
import tempfile

import gnubg

N_BEAVERS = 3   # gnubg.c:231

# Analysis evaluation contexts. Fields: cubeful, plies, deterministic, prune, noise.
ANALYSIS_PRESETS = {
    # eval.c:315-325 aecSettings["world class"] with MOVEFILTER_NORMAL (eval.c:333)
    "world class": {"evalContext": {"cubeful": 1, "plies": 2, "deterministic": 1, "prune": 1, "noise": 0.0},
                    "moveFilter": "normal"},
    # gnubg.c:405 EVALSETUP_SUPREMO (= its built-in analysis default), MOVEFILTER_LARGE
    "supremo": {"evalContext": {"cubeful": 1, "plies": 2, "deterministic": 1, "prune": 1, "noise": 0.0},
                "moveFilter": "large"},
}
# analysis.c:96  evalcontext ecLuck = { TRUE, 0, FALSE, TRUE, 0.0 };
LUCK_EVAL = {"cubeful": 1, "plies": 0, "deterministic": 0, "prune": 1, "noise": 0.0}

# movefilters.inc, as (ply, level, accept, extra, threshold); accept -1 = skip level
MOVEFILTERS = {
    "normal": [(1, 0, 0, 8, 0.16),
               (2, 0, 0, 8, 0.16), (2, 1, -1, 0, 0.0),
               (3, 0, 0, 8, 0.16), (3, 1, -1, 0, 0.0), (3, 2, 0, 2, 0.04),
               (4, 0, 0, 8, 0.16), (4, 1, -1, 0, 0.0), (4, 2, 0, 2, 0.04), (4, 3, -1, 0, 0.0)],
    "large": [(1, 0, 0, 16, 0.32),
              (2, 0, 0, 16, 0.32), (2, 1, -1, 0, 0.0),
              (3, 0, 0, 16, 0.32), (3, 1, -1, 0, 0.0), (3, 2, 0, 4, 0.08),
              (4, 0, 0, 16, 0.32), (4, 1, -1, 0, 0.0), (4, 2, 0, 4, 0.08), (4, 3, -1, 0, 0.0)],
}

# gnubg.c:276-287 (not changed here; listed so the wasm side can check)
THRESHOLDS = {
    "skill": {"doubtful": 0.03, "bad": 0.06, "very bad": 0.12},
    "luck": {"good/bad": 0.3, "very good/very bad": 0.6},
}

PROB_NAMES = ["win", "winGammon", "winBackgammon", "loseGammon", "loseBackgammon"]
SIDES = ["X", "O"]   # gnubg's Python names for player 0 and player 1


def f32(x):
    """Nearest float32 (C float arithmetic: one IEEE operation on two float32
    values, done in double and rounded once, gives the identical result)."""
    return struct.unpack("<f", struct.pack("<f", x))[0]


def cmd(text):
    gnubg.command(text)


def onoff(v):
    return "on" if v else "off"


def setup(preset_name, jacoby):
    preset = ANALYSIS_PRESETS[preset_name]
    ec = preset["evalContext"]
    cmds = ["set display off", "set confirm new off", "set beavers %d" % N_BEAVERS,
            "set jacoby %s" % jacoby,
            "set analysis moves on", "set analysis cube on", "set analysis luck on"]
    for what in ("chequerplay", "cubedecision"):
        cmds += ["set analysis %s type evaluation" % what,
                 "set analysis %s evaluation cubeful %s" % (what, onoff(ec["cubeful"])),
                 "set analysis %s evaluation plies %d" % (what, ec["plies"]),
                 "set analysis %s evaluation prune %s" % (what, onoff(ec["prune"])),
                 "set analysis %s evaluation deterministic %s" % (what, onoff(ec["deterministic"])),
                 "set analysis %s evaluation noise %r" % (what, ec["noise"])]
    for ply, level, accept, extra, thr in MOVEFILTERS[preset["moveFilter"]]:
        if accept < 0:
            cmds.append("set analysis movefilter %d %d -1" % (ply, level))
        else:
            cmds.append("set analysis movefilter %d %d %d %d %r" % (ply, level, accept, extra, thr))
    cmds += ["set analysis luckanalysis cubeful %s" % onoff(LUCK_EVAL["cubeful"]),
             "set analysis luckanalysis plies %d" % LUCK_EVAL["plies"],
             "set analysis luckanalysis prune %s" % onoff(LUCK_EVAL["prune"]),
             "set analysis luckanalysis deterministic %s" % onoff(LUCK_EVAL["deterministic"]),
             "set analysis luckanalysis noise %r" % LUCK_EVAL["noise"]]
    for c in cmds:
        cmd(c)
    return {"preset": preset_name, "chequerplay": ec, "cubedecision": ec,
            "moveFilter": [list(x) for x in MOVEFILTERS[preset["moveFilter"]]],
            "luckAnalysis": LUCK_EVAL, "thresholds": THRESHOLDS, "beavers": N_BEAVERS,
            "globalJacoby": jacoby,
            "commands": cmds,
            "showAnalysis": gnubg.show("analysis")}


# --------------------------------------------------------------------------
# Re-creating the cube decision of a move record (FindCubeDecision, eval.c:3513)
# --------------------------------------------------------------------------

class MET:
    """gnubg.met(n) returns [pre-Crawford table, post-Crawford row for
    player 0, row for player 1] (gnubgmodule.c:1517-1559)."""

    def __init__(self, n):
        t = gnubg.met(n)
        self.pre, self.post = t[0], [t[1], t[2]]

    def get_me(self, s0, s1, n, player, points, who_wins, crawford):
        """matchequity.c getME(): table lookups only (plus 1.0f - x)."""
        n0 = n - (s0 + (who_wins == 0) * points) - 1
        n1 = n - (s1 + (who_wins == 1) * points) - 1
        if n0 < 0:
            return 0.0 if player else 1.0
        if n1 < 0:
            return 1.0 if player else 0.0
        if crawford or n - s0 == 1 or n - s1 == 1:
            if n0 == 0:
                return self.post[1][n1] if player else f32(1.0 - self.post[1][n1])
            return f32(1.0 - self.post[0][n0]) if player else self.post[0][n0]
        return f32(1.0 - self.pre[n0][n1]) if player else self.pre[n0][n1]


def make_cubeinfo(cube, owner, fmove, matchto, score, crawford, jacoby, bgv=0):
    """Same as GetMatchStateCubeInfo at that record: SetCubeInfo with the
    game's Jacoby flag and nBeavers. gnubg.cubeinfo() takes Jacoby from the
    *current* ms and beavers from ms.cBeavers, so both are overwritten and the
    gammon prices recomputed with gnubg.calcgammonprice() (which calls
    SetCubeInfo on the dict's own fields, gnubgmodule.c:1196-1217)."""
    ci = gnubg.cubeinfo(cube, owner, fmove, matchto, tuple(score), int(crawford), bgv)
    if matchto == 0:
        ci["jacoby"] = int(jacoby)
        ci["beavers"] = N_BEAVERS
    else:
        ci["jacoby"] = 0       # SetCubeInfoMatch forces both FALSE (eval.c:3284)
        ci["beavers"] = 0
    return gnubg.calcgammonprice(ci)


def cube_decision(nd_raw, dt_raw, ci, met):
    """FindCubeDecision (eval.c:3513-3530) and the optimal equity of
    FindBestCubeDecision (eval.c:3356-3505), cube known to be available.
    Returns normalised (EMG) equities ND, DT, DP and optimal."""
    if ci["matchto"]:
        s0, s1 = ci["score"]
        dp_mwc = met.get_me(s0, s1, ci["matchto"], ci["move"], ci["cube"], ci["move"], ci["crawford"])
        nd = gnubg.mwc2eq(nd_raw, ci)
        dt = gnubg.mwc2eq(dt_raw, ci)
        dp = gnubg.mwc2eq(dp_mwc, ci)
    else:
        nd, dt, dp = nd_raw, dt_raw, 1.0
    if dt >= nd and dp >= nd:
        optimal = dt if dp > dt else dp
    else:
        optimal = nd
    return {"noDouble": nd, "doubleTake": dt, "doublePass": dp, "optimal": optimal}


def cost(r, ci):
    """Equity -> cost as updateStatcontext computes it (analysis.c:388):
    match: eq2mwc(r) - eq2mwc(0) (MWC); money: nCube * r (points)."""
    if ci["matchto"]:
        return f32(gnubg.eq2mwc(r, ci) - gnubg.eq2mwc(0.0, ci))
    return f32(ci["cube"] * r)


# --------------------------------------------------------------------------
# One match
# --------------------------------------------------------------------------

def load(path):
    if path.lower().endswith(".sgf"):
        cmd('load match "%s"' % path)
    elif path.lower().endswith(".mat"):
        cmd('import mat "%s"' % path)
    else:
        raise ValueError("unknown match file type: " + path)
    # Drop any analysis stored in the file (e.g. an .sgf written by gnubg),
    # so everything below is computed now with the settings above.
    cmd("analyse clear match")


def records_for_game(game, match_info, met):
    info = game["info"]
    matchto = match_info["match-length"]
    jacoby = "Jacoby" in match_info.get("rules", ())
    score = (info["score-X"], info["score-O"])
    crawford = bool(info.get("crawford", False))
    cube, owner = info.get("initial-cube", 1), -1
    default_ctx = match_info.get("default-eval-context") or {}
    last_double = None           # (ci, decision) of the double a take/drop answers
    out = []
    for ri, rec in enumerate(game["game"]):
        r = {"index": ri, "action": rec.get("action"), "player": rec.get("player")}
        for k in ("dice", "board", "comment", "points", "cube", "cube-owner"):
            if k in rec:
                r[k] = rec[k]
        a = rec.get("analysis", {})
        fmove = SIDES.index(rec["player"]) if "player" in rec else None
        ci = make_cubeinfo(cube, owner, fmove, matchto, score, crawford, jacoby) if fmove is not None else None
        if ci is not None:
            r["cubeinfo"] = ci

        if rec.get("action") == "move":
            board = gnubg.positionfromid(rec["board"])
            r["move"] = gnubg.movetupletostring(rec["move"], board) if rec["move"] else ""
            if "moves" in a:
                moves = []
                for m in a["moves"]:
                    # gnubg reports a move's evaluation context only where it
                    # differs from the match default (diffContext, gnubgmodule.c:1914)
                    ctx = dict(default_ctx)
                    ctx.update(m.get("evalcontext") or {})
                    moves.append({"move": gnubg.movetupletostring(m["move"], board),
                                  "equity": m["score"],
                                  "probs": dict(zip(PROB_NAMES, m["probs"])),
                                  "plies": ctx.get("plies"), "cubeful": int(ctx.get("cubeful", 0)),
                                  "evalContext": m.get("evalcontext")})
                imove = a["imove"]
                r["analysis"] = {
                    "moves": moves,              # gnubg's stored order (see doc)
                    "playedIndex": imove,
                    "bestMove": moves[0]["move"],
                    # derived: AnalyzeMove's rChequerSkill (analysis.c:733)
                    "equityLoss": f32(moves[imove]["equity"] - moves[0]["equity"]),
                }
                r["analysis"]["equityLossCost"] = cost(r["analysis"]["equityLoss"], ci)
        if a:
            ra = r.setdefault("analysis", {})
            for k in ("skill", "cube-skill", "luck", "luck-value"):
                if k in a:
                    ra[k] = a[k]
            if "luck-value" in a:
                ra["luckCost"] = cost(a["luck-value"], ci)    # derived, analysis.c:414
            if "nd-cubeful-eq" in a:
                raw = {"type": a["type"], "probs": dict(zip(PROB_NAMES, a["probs"])),
                       "nd-cubeful-eq": a["nd-cubeful-eq"], "dt-cubeful-eq": a["dt-cubeful-eq"],
                       "nd-match-eq": a.get("nd-match-eq"), "dt-match-eq": a.get("dt-match-eq"),
                       "eval-context": a.get("eval-context")}
                dec = cube_decision(a["nd-cubeful-eq"], a["dt-cubeful-eq"], ci, met)
                ra["cube"] = {"stored": raw, "derived": dec}
                if rec["action"] == "move":       # player did not double
                    err = f32(dec["noDouble"] - dec["optimal"])
                elif rec["action"] == "double":
                    err = f32((dec["doubleTake"] if dec["doubleTake"] < dec["doublePass"]
                               else dec["doublePass"]) - dec["optimal"])
                    last_double = (ci, dec)
                ra["cube"]["actionError"] = err      # <= 0; 0 = right decision
                ra["cube"]["actionErrorCost"] = cost(err, ci)

        # take/drop: judged on the double's equities (analysis.c:519-580)
        if rec.get("action") in ("take", "drop") and last_double is not None:
            dci, dec = last_double
            dt, dp = dec["doubleTake"], dec["doublePass"]
            if rec["action"] == "take":
                err = f32(dt - dp) if dt > dp else 0.0
            else:
                err = f32(dp - dt) if dp > dt else 0.0
            r.setdefault("analysis", {})["cube"] = {"basedOnDoubleRecord": True,
                                                    "actionError": f32(-err) if err else 0.0,
                                                    "actionErrorCost": cost(f32(-err), dci) if err else 0.0}

        # follow the cube through the game
        if rec.get("action") == "take":
            cube, owner = cube * 2, fmove
        if "cube" in rec and rec.get("action") == "set":
            cube = rec["cube"]
        if "cube-owner" in rec:
            owner = {"centered": -1, "X": 0, "O": 1}[rec["cube-owner"]]
        out.append(r)
    return out


def derived_statistics(stats, match_length):
    """The per-move rates and ratings 'show statistics match' prints, computed
    from gnubg's raw statcontext sums exactly as getMWCFromError
    (analysis.c:1434) and formatGS (formatgs.c:133-560) do, in float32.
    Sign convention: gnubg stores errors as positive sums and prints them
    negated; here the stored (positive) sign is kept."""
    out = {}
    for side in SIDES:
        s = stats.get(side, {})
        mv, cu, di = s.get("moves"), s.get("cube"), s.get("dice")
        d = {}
        unforced = mv["unforced-moves"] if mv else 0
        close = cu["close-cube"] if cu else 0
        chq = [mv["error-skill"], mv["error-cost"]] if mv else [0.0, 0.0]
        if cu:
            keys = ["missed-double-below-cp", "missed-double-above-cp", "wrong-double-below-dp",
                    "wrong-double-above-tg", "wrong-take", "wrong-drop"]
            cube_tot = []
            for j, suffix in enumerate(("skill", "cost")):
                t = cu["err-%s-%s" % (keys[0], suffix)]
                for k in keys[1:]:
                    t = f32(t + cu["err-%s-%s" % (k, suffix)])
                cube_tot.append(t)
        else:
            cube_tot = [0.0, 0.0]
        if mv:
            d["chequerErrorTotal"] = chq
            d["chequerErrorPerMove"] = [f32(x / unforced) if unforced else 0.0 for x in chq]
            d["chequerRating"] = gnubg.errorrating(d["chequerErrorPerMove"][0]) if unforced else None
        if cu:
            d["cubeErrorTotal"] = cube_tot
            d["cubeErrorPerDecision"] = [f32(x / close) if close else 0.0 for x in cube_tot]
            d["cubeRating"] = gnubg.errorrating(d["cubeErrorPerDecision"][0]) if close else None
        comb = [f32(chq[j] + cube_tot[j]) for j in range(2)]
        n = unforced + close
        d["overallErrorTotal"] = comb
        d["overallErrorPerDecision"] = [f32(x / n) if n else 0.0 for x in comb]
        d["overallRating"] = gnubg.errorrating(d["overallErrorPerDecision"][0]) if n else None
        both = sum(stats[x]["moves"]["total-moves"] for x in SIDES if "moves" in stats.get(x, {}))
        d["snowieErrorRate"] = f32(comb[0] / both) if both else None
        if di and mv:
            tm = mv["total-moves"]
            d["luckTotal"] = [di["luck"], di["luck-cost"]]
            d["luckPerMove"] = [f32(di["luck"] / tm), f32(di["luck-cost"] / tm)] if tm else None
            d["luckRating"] = gnubg.luckrating(d["luckPerMove"][0]) if tm else None
            d["actualResult"] = di["actual-result"]
            d["luckAdjustedResult"] = di["luck-adjusted-result"]
        out[side] = d
    out["ratingNames"] = "gnubg.errorrating()/luckrating() return indexes into aszRating/aszLuckRating (analysis.c); see showStatisticsMatchText for the words"
    return out


def parse_statistics_text(text):
    """'show statistics match' lines are "%-40s %-23s %-23s" (analysis.c:1480):
    label, X column, O column. Returns {section: {label: [X, O]}}."""
    sections, current = {}, None
    for line in text.splitlines():
        if not line.strip():
            continue
        if len(line) <= 40 and line.strip().endswith("statistics"):
            current = sections.setdefault(line.strip(), {})
            continue
        label, x, o = line[:40].strip(), line[41:64].strip(), line[65:].strip()
        if current is None:
            sections.setdefault("header", {})[label] = [x, o]
        else:
            current[label] = [x, o]
    return sections


def count_luck_labels(games):
    """Per-player counts of luck labels from the move records. Needed because
    gnubg.match()'s 'marked-rolls' uses player 0's counts for both players
    (gnubgmodule.c:2496, sc->anLuck[0][lt])."""
    counts = {s: {} for s in SIDES}
    for g in games:
        for r in g["records"]:
            a = r.get("analysis", {})
            if "luck-value" in a:
                lab = a.get("luck", "unmarked")
                counts[r["player"]][lab] = counts[r["player"]].get(lab, 0) + 1
    return counts


def command_stdout(text):
    """Run a gnubg command and return what it printed.

    gnubg.show() would be the natural way, but it returns "" for
    "statistics match": that command prints its whole report with one
    outputl() call, and outputl() starts its memory buffer with
    g_strconcat("", szMemOutput, ...), which stops at the NULL buffer
    (output.c:107). So we point file descriptor 1 at a temporary file while
    the command runs (gnubg flushes stdout after every line when it is not a
    terminal, output.c:125)."""
    sys.stdout.flush()
    saved = os.dup(1)
    with tempfile.TemporaryFile(mode="w+") as tmp:
        os.dup2(tmp.fileno(), 1)
        try:
            cmd(text)
        finally:
            os.dup2(saved, 1)
            os.close(saved)
        tmp.seek(0)
        return tmp.read()


def cross_check(games, raw, derived):
    """Re-add the per-record values the way updateStatcontext does (float32,
    per game, then games added in order by AddStatcontext) and compare with
    gnubg's own statistics. All three must agree exactly; if they do, the
    per-record "derived" values are the ones gnubg's statistics are built on."""
    tot = {s: [0.0, 0.0, 0.0] for s in SIDES}
    for g in games:
        gt = {s: [0.0, 0.0, 0.0] for s in SIDES}
        for r in g["records"]:
            a, p = r.get("analysis", {}), r.get("player")
            if "equityLoss" in a and len(a["moves"]) > 1:      # unforced moves only
                gt[p][0] = f32(gt[p][0] - a["equityLoss"])
            if "cube" in a and a["cube"]["actionError"]:
                gt[p][1] = f32(gt[p][1] - a["cube"]["actionError"])
            if "luck-value" in a:
                gt[p][2] = f32(gt[p][2] + a["luck-value"])
        for p in SIDES:
            for i in range(3):
                tot[p][i] = f32(tot[p][i] + gt[p][i])
    out = {}
    for p in SIDES:
        st = raw.get(p, {})
        gnubg_vals = [st.get("moves", {}).get("error-skill"),
                      None, st.get("dice", {}).get("luck")]
        out[p] = {"chequerErrorFromRecords": tot[p][0], "chequerErrorGnubg": gnubg_vals[0],
                  "cubeErrorFromRecords": tot[p][1],
                  "cubeErrorGnubg": derived[p].get("cubeErrorTotal", [None])[0],
                  "luckFromRecords": tot[p][2], "luckGnubg": gnubg_vals[2]}
    return out


def analyse_one(path, settings):
    load(path)
    cmd("analyse match")
    m = gnubg.match(analysis=1, boards=1, statistics=1, verbose=1)
    info = m["match-info"]
    met = MET(info["match-length"]) if info["match-length"] else None
    games = []
    for g in m["games"]:
        games.append({"info": g["info"], "statistics": g.get("stats"),
                      "records": records_for_game(g, info, met)})
    text = command_stdout("show statistics match")
    stats = m.get("stats", {})
    derived = derived_statistics(stats, info["match-length"])
    return {
        "file": path,
        "format": "sgf" if path.lower().endswith(".sgf") else "mat",
        "matchInfo": info,
        "settings": settings,
        "games": games,
        "statistics": {
            "raw": stats,           # gnubg.match(statistics=1)["stats"], full precision
            "derived": derived,
            "luckLabelCountsFromRecords": count_luck_labels(games),
            "crossCheck": cross_check(games, stats, derived),
            "showStatisticsMatchText": text,
            "showStatisticsMatchParsed": parse_statistics_text(text),
        },
    }


def main():
    paths = [p for p in os.environ["MATCH"].split(":") if p]
    preset = os.environ.get("ANALYSIS_PRESET", "world class")
    settings = setup(preset, os.environ.get("JACOBY", "on"))
    clear = os.environ.get("CLEAR_CACHE") == "1"
    matches = []
    for p in paths:
        if clear:
            cmd("clear cache")
        matches.append(analyse_one(p, settings))
    out = {"generator": "tests/native/dump_match_reference.py",
           "variant": os.environ.get("VARIANT", "unknown"),
           "mode": os.environ.get("MODE", "single" if len(paths) > 1 else "fresh"),
           "clearCacheBeforeEachMatch": clear,
           "matches": matches}
    with open(os.environ["OUT"], "w") as f:
        json.dump(out, f, indent=1)


main()
