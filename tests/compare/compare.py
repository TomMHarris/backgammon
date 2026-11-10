"""
compare.py - compare two Phase 2 result files and print markdown tables.

    python3 -I tests/compare/compare.py A.json B.json [--details N] [--title TEXT]

A and B are files written by tests/native/run_native.sh
(tests/reference/native-<variant>-<mode>.json) or by
tests/wasm/run_wasm_reference.mjs (tests/reference/wasm-strict.json).
Plain Python 3, no third-party packages.

What is compared
----------------
Positions are matched by (position id, query name); match records by
(file, game, record index). Numbers are compared exactly: "bit-identical"
means the two float32 values are the same number (both files store the
float32 value written with enough digits to round-trip). For differences
the largest absolute difference is reported. Nothing is rounded and there
is no tolerance.

Move lists (hints and the per-move analysis lists) are compared move by
move, matched on the move text, and their ORDER is compared separately.
An order difference is classified as

  - "exact tie":  the moves that changed places have exactly the same
                  equity in A and exactly the same equity in B, so both
                  programs consider them equal and only the order in which
                  the C library's qsort() leaves equal elements differs;
  - "real":       anything else.

Cube verdicts (gnubg's cubedecision value) and the skill / luck marks
("doubtful", "bad", "very bad", "lucky", ...) are counted as differences
when they are not equal.

Fields that exist in only one file are not compared; they are listed at the
end of the report.
"""

import json
import os
import sys
from collections import OrderedDict


# ---------------------------------------------------------------------------
# Collecting comparisons
# ---------------------------------------------------------------------------

class Tally:
    """Counts for one row of a table."""

    def __init__(self):
        self.n = 0                # numbers compared
        self.same = 0             # bit-identical numbers
        self.maxdiff = 0.0
        self.order_tie = 0        # move lists whose order differs only among exact ties
        self.order_depth = 0      # ... where tied moves also swapped evaluation depth
        self.order_real = 0
        self.lists = 0            # move lists compared
        self.verdicts = 0         # cube verdicts compared
        self.verdict_diff = 0
        self.labels = 0           # skill / luck marks compared
        self.label_diff = 0
        self.texts = 0            # exact strings compared (move text, statistics text, ...)
        self.text_diff = 0

    def add(self, other):
        for k, v in vars(other).items():
            if k == "maxdiff":
                self.maxdiff = max(self.maxdiff, v)
            else:
                setattr(self, k, getattr(self, k) + v)


class Comparison:
    def __init__(self):
        self.by_type = OrderedDict()       # output type -> Tally
        self.by_cat = OrderedDict()        # category -> Tally
        self.details = []                  # (output type, where, what)
        self.only_a = set()
        self.only_b = set()

    def _tallies(self, otype, cat):
        a = self.by_type.setdefault(otype, Tally())
        b = self.by_cat.setdefault(cat, Tally())
        return a, b

    def num(self, otype, cat, where, x, y):
        if x is None and y is None:
            return
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)) \
                or isinstance(x, bool) or isinstance(y, bool):
            self.text(otype, cat, where, x, y)
            return
        d = abs(float(x) - float(y))
        for t in self._tallies(otype, cat):
            t.n += 1
            if d == 0.0:
                t.same += 1
            t.maxdiff = max(t.maxdiff, d)
        if d:
            self.details.append((otype, where, "%r vs %r (diff %.3g)" % (x, y, d)))

    def nums(self, otype, cat, where, a, b, keys=None):
        """Compare all numeric leaves of two dicts/lists that exist in both."""
        if isinstance(a, dict) and isinstance(b, dict):
            for k in (keys or a.keys()):
                if k in b:
                    self.nums(otype, cat, where + "/" + str(k), a[k], b[k])
                else:
                    self.only_a.add(otype + ": " + str(k))
            for k in b:
                if k not in a and not keys:
                    self.only_b.add(otype + ": " + str(k))
        elif isinstance(a, list) and isinstance(b, list):
            if len(a) != len(b):
                self.text(otype, cat, where + " (length)", len(a), len(b))
                return
            for i, (x, y) in enumerate(zip(a, b)):
                self.nums(otype, cat, "%s[%d]" % (where, i), x, y)
        else:
            self.num(otype, cat, where, a, b)

    def text(self, otype, cat, where, x, y):
        for t in self._tallies(otype, cat):
            t.texts += 1
            if x != y:
                t.text_diff += 1
        if x != y:
            self.details.append((otype, where, "%r vs %r" % (str(x)[:80], str(y)[:80])))

    def verdict(self, otype, cat, where, x, y, xt="", yt=""):
        for t in self._tallies(otype, cat):
            t.verdicts += 1
            if x != y:
                t.verdict_diff += 1
        if x != y:
            self.details.append((otype, where, "verdict %r %s vs %r %s" % (x, xt, y, yt)))

    def label(self, otype, cat, where, x, y):
        for t in self._tallies(otype, cat):
            t.labels += 1
            if x != y:
                t.label_diff += 1
        if x != y:
            self.details.append((otype, where, "mark %r vs %r" % (x, y)))

    def move_list(self, otype, cat, where, la, lb, fields):
        """la, lb: lists of {move, equity, probs, plies, ...} in program order.

        Besides comparing each move's numbers (matched by move text), this
        classifies a list that differs as
          "exact tie":   only the order of moves with exactly equal equity differs;
          "depth swap":  some moves were evaluated at different depths, and at
                         the shallower depth they all had exactly the same
                         equity: gnubg's move filter promoted a different one
                         of several exactly tied candidates to the deeper
                         search (a consequence of tie ordering). Every move of
                         such a list whose numbers differ is reported in a
                         separate row marked "[tie depth swap]"; moves that
                         differ although evaluated at the same depth are named
                         in the details (see tests/reference/RESULTS.md);
          "real":        anything else.
        """
        ea = {m["move"]: m for m in la}
        eb = {m["move"]: m for m in lb}
        for t in self._tallies(otype, cat):
            t.lists += 1
        if set(ea) != set(eb):
            self.text(otype, cat, where + " (move set)", sorted(ea), sorted(eb))
            return

        def norm(v):   # 0 and 0.0, True and 1 are the same value here
            if isinstance(v, dict):
                return {k: norm(x) for k, x in v.items()}
            if isinstance(v, (int, float)):
                return float(v)
            return v

        def sig(m):
            return json.dumps([norm(m.get(f)) for f in ["equity", "plies"] + fields], sort_keys=True)

        changed = [mv for mv in ea if sig(ea[mv]) != sig(eb[mv])]
        deeper = [mv for mv in ea if ea[mv].get("plies") != eb[mv].get("plies")]
        # A depth swap: the moves whose numbers differ are exactly the moves
        # evaluated at different depths, and at the shallower depth (where the
        # move filter made its cut) they all had exactly the same equity.
        shallow = [(ea[m] if (ea[m].get("plies") or 0) < (eb[m].get("plies") or 0) else eb[m])["equity"]
                   for m in deeper]
        depth_swap = bool(deeper) and len(set(shallow)) == 1
        if depth_swap:
            others = [m for m in changed if m not in deeper]
            self.details.append((otype, where, "depth swap among tied moves: " + ", ".join(
                "%s (%s-ply %r vs %s-ply %r)" % (m, ea[m].get("plies"), ea[m]["equity"], eb[m].get("plies"), eb[m]["equity"])
                for m in deeper) + ("" if not others else
                "; other moves of this list that differ at the same depth: " + ", ".join(others))))
        for mv in la:
            name = otype + (" [tie depth swap]" if depth_swap and mv["move"] in changed else "")
            for f in fields:
                if f in mv and f in eb[mv["move"]]:
                    self.nums(name + " " + f, cat, "%s %s %s" % (where, mv["move"], f), mv[f], eb[mv["move"]][f])
            if not depth_swap and mv.get("plies") is not None and eb[mv["move"]].get("plies") is not None \
                    and mv["plies"] != eb[mv["move"]]["plies"]:
                self.details.append((otype, where, "move %s evaluated at %s plies vs %s plies"
                                     % (mv["move"], mv["plies"], eb[mv["move"]]["plies"])))
        oa = [m["move"] for m in la]
        ob = [m["move"] for m in lb]
        if oa != ob or depth_swap:
            if depth_swap:
                kind = "depth swap"
            else:
                kind = "exact tie"
                for i, (ma, mb) in enumerate(zip(oa, ob)):
                    if ma != mb and not (ea[ma]["equity"] == ea[mb]["equity"] and eb[ma]["equity"] == eb[mb]["equity"]):
                        kind = "real"
            for t in self._tallies(otype, cat):
                if kind == "exact tie":
                    t.order_tie += 1
                elif kind == "depth swap":
                    t.order_depth += 1
                else:
                    t.order_real += 1
            if oa != ob:
                first = next(i for i in range(len(oa)) if oa[i] != ob[i])
                self.details.append((otype, where, "order differs (%s) from rank %d: %s (%r) vs %s (%r)"
                                     % (kind, first + 1, oa[first], ea[oa[first]]["equity"],
                                        ob[first], eb[ob[first]]["equity"])))


# ---------------------------------------------------------------------------
# Positions
# ---------------------------------------------------------------------------

CUBEINFO_KEYS = ["cube", "cubeowner", "move", "matchto", "score", "crawford", "jacoby", "beavers"]


def query_type(q):
    if q.startswith("eval-"):
        return "eval " + q[5:].replace("ply-", "-ply ")
    if q.startswith("hint-"):
        return "hint " + ("expert" if q.endswith("expert") else "world class")
    return "cube " + q[5:].replace("ply", "-ply")


def compare_positions(c, A, B):
    pa, pb = A.get("positionsReference"), B.get("positionsReference")
    if not pa or not pb:
        return
    cats = {p["id"]: p.get("category", "?") for p in pa["positions"]}
    rb = {(r["positionKey"], r["query"]): r["result"] for r in pb["results"]}
    for r in pa["results"]:
        key = (r["positionKey"], r["query"])
        if key not in rb:
            c.only_a.add("query " + r["query"])
            continue
        x, y = r["result"], rb[key]
        cat, qt, where = cats.get(r["positionKey"], "?"), query_type(r["query"]), "%s %s" % key
        # the inputs: same cube information on both sides
        c.nums("inputs: cubeinfo", cat, where + " cubeinfo", x["cubeinfo"], y["cubeinfo"], keys=CUBEINFO_KEYS)
        if r["query"].startswith("eval"):
            c.nums(qt + ": probs", cat, where, x["probs"], y["probs"])
            c.num(qt + ": cubeless equity", cat, where, x["cubelessEquity"], y["cubelessEquity"])
            if x.get("cubefulEquity") is None or y.get("cubefulEquity") is None:
                c.only_a.add("eval: cubefulEquity (only one side reports it)")
            else:
                c.num(qt + ": cubeful equity", cat, where, x["cubefulEquity"], y["cubefulEquity"])
        elif r["query"].startswith("hint"):
            c.move_list(qt, cat, where, x["moves"], y["moves"], ["equity", "diff", "probs"])
            # evaluation depth of each move (move filter) and cubeful flag
            eb = {m["move"]: m for m in y["moves"]}
            for m in x["moves"]:
                if m["move"] in eb:
                    c.label(qt + ": plies evaluated", cat, where + " " + m["move"], m["plies"], eb[m["move"]]["plies"])
        else:
            c.nums(qt + ": equities", cat, where, x["equities"], y["equities"])
            if "mwc" in x and "mwc" in y:
                c.nums(qt + ": mwc", cat, where, x["mwc"], y["mwc"])
            c.num(qt + ": percent", cat, where, x.get("percent"), y.get("percent"))
            c.verdict(qt + ": verdict", cat, where, x["decision"], y["decision"],
                      x["recommendation"], y["recommendation"])
            c.text(qt + ": cube available", cat, where, x["cubeAvailable"], y["cubeAvailable"])
            if x.get("noDouble") is None or y.get("noDouble") is None:
                c.only_a.add("cube: noDouble probs (only one side reports them)")


# ---------------------------------------------------------------------------
# Matches
# ---------------------------------------------------------------------------

def compare_matches(c, A, B):
    mb = {m["file"]: m for m in B.get("matchesReference") or []}
    for ma in A.get("matchesReference") or []:
        f = ma["file"]
        if f not in mb:
            c.only_a.add("match " + f)
            continue
        y = mb[f]
        cat = "match " + os.path.basename(f)
        if ma.get("settings", {}).get("preset") != y.get("settings", {}).get("preset"):
            c.text("match: analysis settings", cat, f, ma["settings"].get("preset"), y["settings"].get("preset"))
        if len(ma["games"]) != len(y["games"]):
            c.text("match: number of games", cat, f, len(ma["games"]), len(y["games"]))
        for gi, (ga, gb) in enumerate(zip(ma["games"], y["games"])):
            if len(ga["records"]) != len(gb["records"]):
                c.text("match: number of records", cat, "%s game %d" % (f, gi), len(ga["records"]), len(gb["records"]))
            for ra, rb in zip(ga["records"], gb["records"]):
                compare_record(c, cat, "%s g%d r%d" % (os.path.basename(f), gi, ra["index"]), ra, rb)
        compare_statistics(c, cat, f, ma["statistics"], y["statistics"])


def compare_record(c, cat, where, ra, rb):
    c.text("match: record action/player", cat, where, (ra.get("action"), ra.get("player")),
           (rb.get("action"), rb.get("player")))
    if "dice" in ra and "dice" in rb:
        c.text("match: record action/player", cat, where + " dice", list(ra["dice"]), list(rb["dice"]))
    if "move" in ra and "move" in rb:
        c.text("match: move text", cat, where, ra["move"], rb["move"])
    for k in ("cube", "cubeowner"):
        if k in ra.get("cubeinfo", {}) and k in rb.get("cubeinfo", {}):
            c.text("inputs: cubeinfo", cat, where + " " + k, ra["cubeinfo"][k], rb["cubeinfo"][k])
    a, b = ra.get("analysis", {}), rb.get("analysis", {})
    if "moves" in a and "moves" in b:
        c.move_list("match: move list", cat, where, a["moves"], b["moves"], ["equity", "probs"])
        c.text("match: best move", cat, where, a["bestMove"], b["bestMove"])
        c.num("match: chequer error", cat, where, a["equityLoss"], b["equityLoss"])
        c.num("match: chequer error cost", cat, where, a["equityLossCost"], b["equityLossCost"])
    elif "moves" in a or "moves" in b:
        c.text("match: move analysed?", cat, where, "moves" in a, "moves" in b)
    if ra.get("action") == "move":
        c.label("match: chequer skill mark", cat, where, a.get("skill"), b.get("skill"))
        c.label("match: cube skill mark", cat, where, a.get("cube-skill"), b.get("cube-skill"))
    elif ra.get("action") in ("double", "take", "drop"):
        c.label("match: cube skill mark", cat, where, a.get("skill"), b.get("skill"))
    if "luck-value" in a or "luck-value" in b:
        c.num("match: luck", cat, where, a.get("luck-value"), b.get("luck-value"))
        c.num("match: luck cost", cat, where, a.get("luckCost"), b.get("luckCost"))
        c.label("match: luck mark", cat, where, a.get("luck"), b.get("luck"))
    ca, cb = a.get("cube"), b.get("cube")
    if ca and cb:
        if "stored" in ca and "stored" in cb:
            c.nums("match: cube evaluation (stored)", cat, where, ca["stored"], cb["stored"],
                   keys=["probs", "nd-cubeful-eq", "dt-cubeful-eq", "nd-match-eq", "dt-match-eq"])
        if "derived" in ca and "derived" in cb:
            c.nums("match: cube ND/DT/DP/optimal", cat, where, ca["derived"], cb["derived"])
        c.num("match: cube error", cat, where, ca.get("actionError"), cb.get("actionError"))
        c.num("match: cube error cost", cat, where, ca.get("actionErrorCost"), cb.get("actionErrorCost"))
        if "decision" in ca and "decision" in cb:
            c.verdict("match: cube verdict", cat, where, ca["decision"], cb["decision"])
    elif ca or cb:
        c.text("match: cube analysed?", cat, where, bool(ca), bool(cb))


def compare_statistics(c, cat, f, sa, sb):
    c.nums("match: statistics (sums, counts)", cat, f + " raw", sa["raw"], sb["raw"])
    for side in ("X", "O"):
        da, db = sa["derived"].get(side, {}), sb["derived"].get(side, {})
        for k in da:
            if k not in db:
                c.only_a.add("statistics: " + k)
            elif k.endswith("Rating"):
                c.label("match: statistics ratings", cat, "%s %s %s" % (f, side, k), da[k], db[k])
            else:
                c.nums("match: statistics (rates, totals)", cat, "%s %s %s" % (f, side, k), da[k], db[k])
        la = sa["luckLabelCountsFromRecords"].get(side, {})
        lb = sb["luckLabelCountsFromRecords"].get(side, {})
        for k in set(la) | set(lb):
            c.num("match: statistics (sums, counts)", cat, "%s %s luck %s" % (f, side, k), la.get(k, 0), lb.get(k, 0))
    ta = (sa.get("showStatisticsMatchText") or "").rstrip()
    tb = (sb.get("showStatisticsMatchText") or "").rstrip()
    c.text("match: 'show statistics match' text", cat, f, ta, tb)
    if ta != tb:
        la, lb = ta.splitlines(), tb.splitlines()
        for i, (x, y) in enumerate(zip(la, lb)):
            if x != y:
                c.details.append(("match: 'show statistics match' text", f, "line %d: %r vs %r" % (i + 1, x.strip(), y.strip())))


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def fmt_row(name, t):
    order = "%d / %d / %d" % (t.order_tie, t.order_depth, t.order_real) if t.lists else ""
    return "| %s | %s | %s | %s | %s | %s | %s | %s |" % (
        name,
        t.n or "",
        ("%d" % t.same) if t.n else "",
        ("%.3g" % t.maxdiff) if t.n else "",
        order,
        ("%d / %d" % (t.verdict_diff, t.verdicts)) if t.verdicts else "",
        ("%d / %d" % (t.label_diff, t.labels)) if t.labels else "",
        ("%d / %d" % (t.text_diff, t.texts)) if t.texts else "")


HEADER = ("| %s | numbers | bit-identical | max abs diff | order diffs (tie / depth swap / real) "
          "| verdict diffs | mark diffs | other diffs |\n|---|---:|---:|---:|---:|---:|---:|---:|")


def report(c, a_name, b_name, title, ndetails):
    out = []
    out.append("### %s" % (title or ("%s vs %s" % (a_name, b_name))))
    out.append("")
    out.append("A = `%s`, B = `%s`." % (a_name, b_name))
    out.append("")
    total = Tally()
    for t in c.by_type.values():
        total.add(t)
    out.append("**By output type**")
    out.append("")
    out.append(HEADER % "output")
    for k, t in c.by_type.items():
        out.append(fmt_row(k, t))
    out.append(fmt_row("**all**", total))
    out.append("")
    out.append("**By corpus category**")
    out.append("")
    out.append(HEADER % "category")
    for k, t in sorted(c.by_cat.items()):
        out.append(fmt_row(k, t))
    out.append("")
    if c.details:
        out.append("**Differences** (%d; first %d shown)" % (len(c.details), min(ndetails, len(c.details))))
        out.append("")
        for otype, where, what in c.details[:ndetails]:
            out.append("- %s | %s | %s" % (otype, where, what))
        out.append("")
    nc = sorted(c.only_a | c.only_b)
    if nc:
        out.append("**Not compared** (present in only one file): " + "; ".join(nc))
        out.append("")
    return "\n".join(out)


def main(argv):
    args, ndetails, title = [], 40, None
    i = 0
    while i < len(argv):
        if argv[i] == "--details":
            ndetails = int(argv[i + 1]); i += 2
        elif argv[i] == "--title":
            title = argv[i + 1]; i += 2
        else:
            args.append(argv[i]); i += 1
    if len(args) != 2:
        sys.exit(__doc__)
    with open(args[0]) as f:
        A = json.load(f)
    with open(args[1]) as f:
        B = json.load(f)
    c = Comparison()
    compare_positions(c, A, B)
    compare_matches(c, A, B)
    print(report(c, os.path.basename(args[0]), os.path.basename(args[1]), title, ndetails))


if __name__ == "__main__":
    main(sys.argv[1:])
