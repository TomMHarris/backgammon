# make_corpus.py -- build the verification corpus with NATIVE gnubg.
#
# Every position and match written here comes out of native gnubg itself
# (self-play games, gnubg's own position/match IDs, gnubg's own exporters).
# Nothing is typed in by hand except gnubg's standard opening position ID,
# which is used only to *recognise* opening positions found in self-play.
#
# Run from the repository root (takes well under a minute):
#
#   HOME=$(mktemp -d) engine/native/build/strict/gnubg -t -r -q -P engine/data \
#       -p tests/corpus/make_corpus.py
#
#   -t  text mode, -r  ignore ~/.gnubgrc etc., -q  quiet, -P  data directory,
#   -p  run this Python file.  A throwaway HOME keeps user settings out.
#
# Output:
#   tests/corpus/positions.json      positions (move and cube decisions)
#   tests/corpus/matches/*.sgf|.mat  sample self-play matches
#
# How it works:
#   1. Sample matches: gnubg plays itself (0-ply, cube in use) with fixed
#      seeds; each match is saved as .sgf ("save match") and Jellyfish .mat
#      ("export match mat").
#   2. Pool: many more self-play matches and money sessions.  We walk through
#      every game record with gnubg.navigate() and note the position ID and
#      match ID gnubg reports *before* each move (dice rolled -> "move"
#      candidate) and before each roll (no dice -> "cube" candidate).
#   3. Every candidate is loaded back into gnubg (gnubg.setgnubgid) and must
#      round-trip exactly.  gnubg then classifies it (classifypos), counts the
#      legal moves (0-ply hint) and, for cube candidates, gives its cube
#      verdict (cfevaluate, first 0-ply as a cheap filter, then 2-ply).
#   4. Positions are picked per category with a seeded random generator,
#      preferring a spread of score situations; duplicates are skipped.
#   5. Every selected entry is round-tripped once more and written to JSON,
#      together with gnubg's 2-ply hint / cube verdict at creation time.

import gnubg
import json
import os
import random
import sys
import time

T0 = time.time()
SEED = 12345            # base seed; every match below uses SEED + something
GNUBG_VERSION = "1.08.003"
OUT_DIR = os.path.join("tests", "corpus")
MATCH_DIR = os.path.join(OUT_DIR, "matches")
OPENING_POSITION_ID = "4HPwATDgc/ABMA"   # gnubg's standard starting position

if not os.path.isdir(OUT_DIR):
    sys.exit("make_corpus.py: run me from the repository root")

# gnubg's positionclass enum (eval.h), indexed by gnubg.classifypos() result.
CLASS_NAMES = ["CLASS_OVER", "CLASS_HYPERGAMMON1", "CLASS_HYPERGAMMON2",
               "CLASS_HYPERGAMMON3", "CLASS_BEAROFF2", "CLASS_BEAROFF_TS",
               "CLASS_BEAROFF1", "CLASS_BEAROFF_OS", "CLASS_RACE",
               "CLASS_CRASHED", "CLASS_CONTACT"]

# gnubg's cubedecision enum (eval.h), indexed by cfevaluate()[4].
CUBE_DECISIONS = ["DOUBLE_TAKE", "DOUBLE_PASS", "NODOUBLE_TAKE",
                  "TOOGOOD_TAKE", "TOOGOOD_PASS", "DOUBLE_BEAVER",
                  "NODOUBLE_BEAVER", "REDOUBLE_TAKE", "REDOUBLE_PASS",
                  "NO_REDOUBLE_TAKE", "TOOGOODRE_TAKE", "TOOGOODRE_PASS",
                  "NO_REDOUBLE_BEAVER", "NODOUBLE_DEADCUBE",
                  "NO_REDOUBLE_DEADCUBE", "NOT_AVAILABLE",
                  "OPTIONAL_DOUBLE_TAKE", "OPTIONAL_REDOUBLE_TAKE",
                  "OPTIONAL_DOUBLE_BEAVER", "OPTIONAL_DOUBLE_PASS",
                  "OPTIONAL_REDOUBLE_PASS"]
CUBE_NOT_USABLE = {"NOT_AVAILABLE", "NODOUBLE_DEADCUBE", "NO_REDOUBLE_DEADCUBE"}


def cmd(s):
    """Run one gnubg command (same language as the gnubg command line)."""
    gnubg.command(s)


def log(*args):
    print("[make_corpus %5.1fs]" % (time.time() - T0), *args)
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# 1. Bot settings and self-play helpers
# ---------------------------------------------------------------------------

def setup_bots():
    cmd("set display off")                     # don't print every board
    cmd("set rng mersenne")                    # gnubg's default RNG, made explicit
    # Player 1 would otherwise be named after the OS login; fixed names keep
    # the exported files reproducible and anonymous.
    cmd("set defaultnames gnubgA gnubgB")
    for p in (0, 1):
        cmd("set player %d gnubg" % p)         # gnubg plays both sides
        cmd("set player %d chequerplay evaluation plies 0" % p)
        cmd("set player %d cubedecision evaluation plies 0" % p)


def play_match(length, seed):
    """Self-play one whole match.  With automatic games on, the single
    'new match' command plays every game until the match is over."""
    cmd("set automatic game on")
    # Jacoby only matters for money play, but gnubg still writes the current
    # Jacoby flag into match-play match IDs; keep it off so they are uniform.
    cmd("set jacoby off")
    cmd("set seed %d" % seed)
    cmd("new match %d" % length)


def play_session(games, jacoby, seed):
    """Self-play a money session of `games` games.  Automatic games must be
    OFF here: otherwise a money session never ends."""
    cmd("set jacoby %s" % ("on" if jacoby else "off"))
    cmd("set automatic game off")
    cmd("set seed %d" % seed)
    cmd("new session")                          # plays game 1
    for _ in range(games - 1):
        cmd("new game")                         # plays one more game each


def save_match(basename):
    """Save the current match as .sgf and .mat, without the bots' move lists."""
    cmd("analyse clear match")   # drop the candidate-move lists the bots stored
    for ext, command in (("sgf", "save match"), ("mat", "export match mat")):
        path = os.path.join(MATCH_DIR, basename + "." + ext)
        if os.path.exists(path):
            os.remove(path)       # gnubg may ask before overwriting; avoid that
        cmd('%s "%s"' % (command, path))
        if not os.path.exists(path):
            sys.exit("could not write " + path)


def match_actions():
    """List of (game number, action) for the current match, e.g. 'drop'."""
    m = gnubg.match(analysis=0, boards=0, statistics=0, verbose=0)
    return [(gi + 1, r["action"]) for gi, g in enumerate(m["games"])
            for r in g["game"]]


def harvest(source):
    """Walk every record of the current match/session with gnubg.navigate()
    and return candidate positions as dicts {pos, mid, kind, source}.

    After navigating, gnubg's state is the position *before* that record; for
    a chequer move gnubg also sets the dice of that move (see PythonNavigate).
    So: before a 'move' record we get a move candidate (match ID with dice) and
    the same board before rolling is a cube candidate (match ID without dice,
    produced by gnubg.matchid() from gnubg's own cube-info and pos-info).
    """
    out = []
    m = gnubg.match(analysis=0, boards=1, statistics=0, verbose=0)
    for gi, game in enumerate(m["games"]):
        gnubg.navigate()                  # start of the match/session
        if gi:
            gnubg.navigate(game=gi)       # NB: keyword is 'game', records: 'next'
        else:
            gnubg.navigate(next=0)        # no-op move, but loads the dice
        for k, rec in enumerate(game["game"]):
            if k:
                gnubg.navigate(next=1)
            pos, mid = gnubg.positionid(), gnubg.matchid()
            if "board" in rec and rec["board"] != pos:
                sys.exit("navigation out of step in %s game %d record %d"
                         % (source, gi, k))
            info = {"source": source, "first": k == 0}
            if rec["action"] == "move":
                if gnubg.posinfo()["dice"] != tuple(rec["dice"]):
                    sys.exit("dice not loaded in %s game %d record %d" % (source, gi, k))
                out.append(dict(info, kind="move", pos=pos, mid=mid))
                pinfo = gnubg.posinfo()
                pinfo["dice"] = (0, 0)
                mid = gnubg.matchid(gnubg.cubeinfo(), pinfo)
            # Cube candidate: not before a game's first move (the opening
            # roll decides who moves first, so nobody may double there).
            if rec["action"] in ("move", "double") and k > 0:
                ci = gnubg.cubeinfo()
                if ci["cubeowner"] in (-1, ci["move"]) and not ci["crawford"]:
                    out.append(dict(info, kind="cube", pos=pos, mid=mid))
    return out


# ---------------------------------------------------------------------------
# 2. Describing a position that gnubg has loaded
# ---------------------------------------------------------------------------

def load(pos, mid):
    """Load position+match ID into gnubg and check that they round-trip."""
    gnubg.setgnubgid("%s:%s" % (pos, mid))
    return gnubg.positionid() == pos and gnubg.matchid() == mid


def trapping_prime(board, side):
    """Length of `side`'s longest run of made points (2+ checkers) that has at
    least one opposing checker behind it.  board[side][i] is point i+1 seen
    from `side`; the opponent's point k is `side`'s point 24-k (index 23-k)."""
    mine, theirs = board[side], board[1 - side]
    best = run = 0
    for i in range(24):
        run = run + 1 if mine[i] >= 2 else 0
        start = i - run + 1                 # lowest index of the current run
        trapped = theirs[24] > 0 or any(theirs[k] > 0 and 23 - k < start
                                        for k in range(24))
        if run and trapped:
            best = max(best, run)
    return best


def outside_home(points):
    """Checkers not yet in the home board (points 7..24 plus the bar)."""
    return sum(points[6:25])


def features(kind):
    """Facts about the currently loaded position, all read from gnubg."""
    board = gnubg.board()          # board[1] = player on roll, board[0] = opponent
    ci = gnubg.cubeinfo()
    pi = gnubg.posinfo()
    me = ci["move"]                # 0 or 1: who is on roll
    mto = ci["matchto"]
    score = ci["score"]
    f = {
        "class": gnubg.classifypos(board),
        "matchTo": mto,
        "me": me,
        "myScore": score[me], "oppScore": score[1 - me],
        "cube": ci["cube"], "owner": ci["cubeowner"],
        "crawford": ci["crawford"], "jacoby": ci["jacoby"],
        "dice": tuple(pi["dice"]),
        "onBar": board[1][24] > 0,
        "prime": max(trapping_prime(board, 0), trapping_prime(board, 1)),
        # "middle game": the player on roll still has 3+ checkers to bring home
        "middle": outside_home(board[1]) >= 3,
    }
    one_away = mto > 1 and (score[0] == mto - 1 or score[1] == mto - 1)
    if mto == 0:
        f["scoreType"] = "money-jacoby" if ci["jacoby"] else "money-nojacoby"
    elif mto == 1 or (score[0] == mto - 1 and score[1] == mto - 1):
        f["scoreType"] = "dmp"
    elif ci["crawford"]:
        f["scoreType"] = "crawford"
    elif one_away:
        f["scoreType"] = "postcrawford"
    else:
        f["scoreType"] = "match%d" % mto
    # Cubeless 0-ply gammon chances, only used to tag 'gammonish' positions.
    p = gnubg.evaluate(board, ci, gnubg.evalcontext(0, 0, 1, 1, 0.0))
    f["gammons"] = p[1] + p[3]
    if kind == "move":
        try:
            f["legal"] = len(gnubg.hint(9999)["hint"])   # 0-ply: lists all moves
        except Exception:
            f["legal"] = 0                               # gnubg: no legal moves
    return f


def cube_verdict(plies):
    """gnubg's cube decision for the loaded position (player on roll, before
    rolling).  Money play is evaluated with beavers allowed, like gnubg's own
    default ('set beavers 3'): gnubg.cubeinfo() would report beavers=0 here."""
    ci = gnubg.cubeinfo()
    if ci["matchto"] == 0:
        ci["beavers"] = 1
    r = gnubg.cfevaluate(gnubg.board(), ci, gnubg.evalcontext(1, plies, 1, 1, 0.0))
    return {"plies": plies, "cubeful": 1, "beavers": ci["beavers"],
            "optimal": r[0], "noDouble": r[1], "doubleTake": r[2],
            "doublePass": r[3], "decision": CUBE_DECISIONS[r[4]],
            "verdict": r[5]}


def describe(kind, f, verdict=None):
    """Short human description, from the on-roll player's point of view."""
    who = "player %d" % f["me"]
    if f["matchTo"] == 0:
        s = "Money game, Jacoby %s" % ("on" if f["jacoby"] else "off")
        if kind == "cube":
            s += ", beavers allowed"
    else:
        s = "%d-point match, score %d-%d (on-roll %d-away, opponent %d-away)" % (
            f["matchTo"], f["myScore"], f["oppScore"],
            f["matchTo"] - f["myScore"], f["matchTo"] - f["oppScore"])
        if f["scoreType"] == "dmp":
            s += ", DMP"
        elif f["crawford"]:
            s += ", Crawford game"
        elif f["scoreType"] == "postcrawford":
            s += ", post-Crawford"
    if f["owner"] == -1:
        s += "; cube %d centred" % f["cube"]
    else:
        s += "; cube %d owned by %s" % (
            f["cube"], "player on roll" if f["owner"] == f["me"] else "opponent")
    if kind == "move":
        s += "; %s on roll with %d-%d" % (who, f["dice"][0], f["dice"][1])
        if f["onBar"]:
            s += " (on the bar)"
        if f["legal"] <= 1:
            s += " (%s)" % ("no legal move" if f["legal"] == 0 else "one legal move")
    else:
        s += "; %s on roll, before rolling; native 2-ply: %s" % (who, verdict)
    s += "; %s" % CLASS_NAMES[f["class"]]
    if f["scoreType"] == "dmp":
        s += ", gammons irrelevant (DMP)"
    elif f["gammons"] >= 0.30:
        s += ", gammonish"           # 0-ply cubeless P(win gammon)+P(lose gammon)
    elif f["gammons"] < 0.01:
        s += ", gammon-free"
    return s


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

setup_bots()

# ---- 1. Sample matches ----------------------------------------------------
os.makedirs(MATCH_DIR, exist_ok=True)
samples = [("match5", "5-point match", lambda: play_match(5, SEED + 5)),
           ("match7", "7-point match", lambda: play_match(7, SEED + 7)),
           ("money4", "money session, Jacoby off",
            lambda: play_session(4, False, SEED))]
sample_notes = []
for name, label, play in samples:
    play()
    acts = match_actions()
    drops = [g for g, a in acts if a == "drop"]
    resigns = [g for g, a in acts if a == "resign"]
    save_match(name)
    note = "%s.sgf/.mat: %s, %d games" % (name, label, len(set(g for g, _ in acts)))
    if drops:
        note += ", double/pass in game(s) %s" % sorted(set(drops))
    if resigns:
        note += ", resignation in game(s) %s" % sorted(set(resigns))
    sample_notes.append(note)
    log(note)

# ---- 2. Pool of candidate positions from more self-play -------------------
pool = []
plan = [(1, 20), (3, 10), (5, 25), (7, 20)]       # (match length, how many)
n = 0
for length, count in plan:
    for i in range(count):
        n += 1
        play_match(length, SEED + 1000 + n)
        pool += harvest("match%d-%d" % (length, i))
for jacoby in (True, False):
    play_session(40, jacoby, SEED + 2000 + int(jacoby))
    pool += harvest("money-%s" % ("jacoby" if jacoby else "nojacoby"))
log("harvested %d candidate states" % len(pool))

# Dedupe on (kind, position ID, match ID), keeping first occurrence.
seen = set()
cands = []
for c in pool:
    key = (c["kind"], c["pos"], c["mid"])
    if key not in seen:
        seen.add(key)
        cands.append(c)

# ---- 3. Load every candidate, check round trip, describe ------------------
cmd("set evaluation chequerplay evaluation plies 0")   # cheap legal-move count
bad = 0
for c in cands:
    if not load(c["pos"], c["mid"]):
        bad += 1
        c["f"] = None
        continue
    c["f"] = features(c["kind"])
    if c["kind"] == "cube":
        c["v0"] = cube_verdict(0)["decision"]
cands = [c for c in cands if c["f"] is not None]
log("%d unique candidates, %d failed the round trip (dropped)" % (len(cands), bad))

# 2-ply cube verdicts for a stratified sample (by 0-ply verdict, score type
# and cube value) -- evaluating every candidate at 2-ply is unnecessary.
rng = random.Random(SEED)
strata = {}
for c in cands:
    if c["kind"] == "cube" and c["v0"] not in CUBE_NOT_USABLE:
        strata.setdefault((c["v0"], c["f"]["scoreType"], c["f"]["cube"]), []).append(c)
n2 = 0
for key in sorted(strata):
    group = strata[key]
    rng.shuffle(group)
    for c in group[:40]:
        load(c["pos"], c["mid"])
        c["v2"] = cube_verdict(2)
        n2 += 1
log("2-ply cube evaluations: %d" % n2)

# ---- 4. Selection ---------------------------------------------------------
# two-sided / one-sided bearoff database classes (in memory or on disk)
TWO_SIDED = ("CLASS_BEAROFF2", "CLASS_BEAROFF_TS")
ONE_SIDED = ("CLASS_BEAROFF1", "CLASS_BEAROFF_OS")


def cls(c):
    return CLASS_NAMES[c["f"]["class"]]


def is_double(c):
    return c["f"]["dice"][0] == c["f"]["dice"][1]


def verdict_in(*names):
    return lambda c: "v2" in c and c["v2"]["decision"] in names


# Requests: (category, how many, predicate, preferred score types in turn).
# "legal" = number of legal moves; "first" = a game's first move.
MOVE_REQUESTS = [
    ("opening", 2, lambda c: c["pos"] == OPENING_POSITION_ID and c["first"],
     ["money-jacoby", "match5"]),
    ("contact", 6, lambda c: cls(c) == "CLASS_CONTACT" and c["f"]["middle"]
     and not c["f"]["onBar"] and c["f"]["legal"] > 1,
     ["money-nojacoby", "match5", "money-jacoby", "match7", "crawford", "postcrawford"]),
    ("contact", 1, lambda c: cls(c) == "CLASS_CONTACT" and c["f"]["middle"]
     and c["f"]["gammons"] >= 0.30 and c["f"]["legal"] > 1, ["match7"]),
    ("contact", 1, lambda c: cls(c) == "CLASS_CONTACT" and c["f"]["middle"]
     and c["f"]["cube"] == 4 and c["f"]["legal"] > 1, ["money-nojacoby", "match7"]),
    ("dmp", 1, lambda c: cls(c) == "CLASS_CONTACT" and c["f"]["middle"]
     and c["f"]["legal"] > 1, ["dmp"]),
    ("crashed", 2, lambda c: cls(c) == "CLASS_CRASHED" and c["f"]["legal"] > 1,
     ["money-jacoby", "match5"]),
    ("prime", 2, lambda c: cls(c) == "CLASS_CONTACT" and c["f"]["prime"] >= 5
     and c["f"]["legal"] > 1, ["match7", "money-nojacoby"]),
    ("race", 4, lambda c: cls(c) == "CLASS_RACE" and c["f"]["legal"] > 1,
     ["money-nojacoby", "match5", "money-jacoby", "crawford"]),
    ("bearoff-ts", 3, lambda c: cls(c) in TWO_SIDED and c["f"]["legal"] > 1,
     ["money-jacoby", "match5", "dmp"]),
    ("bearoff-os", 3, lambda c: cls(c) in ONE_SIDED and c["f"]["legal"] > 1,
     ["money-nojacoby", "match7", "postcrawford"]),
    ("doubles", 2, lambda c: is_double(c) and not c["first"] and c["f"]["legal"] > 1
     and cls(c) == "CLASS_CONTACT", ["match5", "money-jacoby"]),
    ("no-move", 1, lambda c: c["f"]["legal"] == 0, ["money-nojacoby", "match7"]),
    ("forced", 1, lambda c: c["f"]["legal"] == 1, ["match5", "money-jacoby"]),
    ("bar", 1, lambda c: c["f"]["onBar"] and c["f"]["legal"] > 1, ["money-jacoby"]),
]
CUBE_REQUESTS = [
    ("cube-no-double", 2, verdict_in("NODOUBLE_TAKE", "NO_REDOUBLE_TAKE"),
     ["money-nojacoby", "match7"]),
    ("cube-double-take", 2, verdict_in("DOUBLE_TAKE", "REDOUBLE_TAKE"),
     ["money-jacoby", "match5"]),
    ("cube-double-pass", 2, verdict_in("DOUBLE_PASS", "REDOUBLE_PASS"),
     ["money-nojacoby", "match7"]),
    ("cube-too-good-take", 1, verdict_in("TOOGOOD_TAKE", "TOOGOODRE_TAKE"),
     ["money-nojacoby", "match5"]),
    ("cube-too-good-pass", 1, verdict_in("TOOGOOD_PASS", "TOOGOODRE_PASS"),
     ["match7", "money-nojacoby"]),
    ("cube-beaver", 2, verdict_in("DOUBLE_BEAVER", "NODOUBLE_BEAVER",
                                  "NO_REDOUBLE_BEAVER", "OPTIONAL_DOUBLE_BEAVER"),
     ["money-jacoby", "money-nojacoby"]),
    ("cube-optional", 1, verdict_in("OPTIONAL_DOUBLE_TAKE", "OPTIONAL_REDOUBLE_TAKE",
                                    "OPTIONAL_DOUBLE_BEAVER", "OPTIONAL_DOUBLE_PASS",
                                    "OPTIONAL_REDOUBLE_PASS"), ["postcrawford"]),
    ("cube-redouble", 1, lambda c: "v2" in c and c["f"]["cube"] == 2
     and c["f"]["owner"] == c["f"]["me"], ["match7", "money-nojacoby"]),
    ("cube-redouble", 1, lambda c: "v2" in c and c["f"]["cube"] == 4
     and c["f"]["owner"] == c["f"]["me"], ["money-nojacoby", "match7"]),
]

used = set()   # (board, dice): a board recurs only with other dice (openings)
selected = []
shortfalls = []


def pick(kind, category, count, pred, prefs):
    pool_k = [c for c in cands if c["kind"] == kind and pred(c)]
    got = 0
    for i in range(count):
        want = prefs[i % len(prefs)]
        options = [c for c in pool_k if (c["pos"], c["f"]["dice"]) not in used]
        preferred = [c for c in options if c["f"]["scoreType"] == want]
        choice_from = preferred or options
        if not choice_from:
            break
        c = rng.choice(choice_from)
        used.add((c["pos"], c["f"]["dice"]))
        selected.append((category, c))
        got += 1
    if got < count:
        shortfalls.append("%s %s: wanted %d, found %d" % (kind, category, count, got))


for category, count, pred, prefs in MOVE_REQUESTS:
    pick("move", category, count, pred, prefs)
for category, count, pred, prefs in CUBE_REQUESTS:
    pick("cube", category, count, pred, prefs)

# ---- 5. Final round trip, native hints, JSON --------------------------------
cmd("set evaluation chequerplay evaluation plies 2")   # gnubg's default (world class)
entries = []
counters = {}
for category, c in selected:
    if not load(c["pos"], c["mid"]):
        sys.exit("round trip failed for %s %s:%s" % (category, c["pos"], c["mid"]))
    dice = gnubg.posinfo()["dice"]
    if (c["kind"] == "move") != (dice[0] > 0):
        sys.exit("dice state wrong for %s %s:%s" % (category, c["pos"], c["mid"]))
    f = c["f"]
    if c["kind"] == "move":
        # gnubg's default hint (world class, 2-ply); empty when no legal move
        try:
            top = gnubg.hint(3)["hint"]
        except Exception:
            top = []
        hint = {"context": top[0]["context"] if top else None, "top": [
            {"move": m["move"], "equity": m["equity"], "probs": list(m["details"]["probs"])}
            for m in top]}
        verdict = None
    else:
        hint = cube_verdict(2)                   # recomputed in this final pass
        verdict = hint["verdict"]
    counters[category] = counters.get(category, 0) + 1
    entries.append({
        "id": "%s-%02d" % (category, counters[category]),
        "kind": c["kind"],
        "category": category,
        "positionId": c["pos"],
        "matchId": c["mid"],
        "matchLength": f["matchTo"],
        "description": describe(c["kind"], f, verdict),
        "nativeClass": CLASS_NAMES[f["class"]],
        "scoreType": f["scoreType"],
        "source": c["source"],
        "nativeHintAtCreation": hint,
    })

doc = {"generator": "tests/corpus/make_corpus.py", "gnubg": GNUBG_VERSION,
       "seed": SEED, "positions": entries}
with open(os.path.join(OUT_DIR, "positions.json"), "w") as fh:
    json.dump(doc, fh, indent=1)
    fh.write("\n")

# ---- Summary ----------------------------------------------------------------
log("wrote %d positions" % len(entries))
tally = {}
for e in entries:
    for key in ("%s/%s" % (e["kind"], e["category"]), "score/" + e["scoreType"],
                "class/" + e["nativeClass"]):
        tally[key] = tally.get(key, 0) + 1
for key in sorted(tally):
    log("  %-28s %d" % (key, tally[key]))
for note in sample_notes:
    log("sample " + note)
for s in shortfalls:
    log("SHORTFALL " + s)
log("done")
