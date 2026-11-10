# Phase 2 results: WebAssembly gnubg vs native gnubg 1.08.003

Generated 2026-11-10 from the 43-position corpus (`tests/corpus/positions.json`) and
the 8 match files in `tests/corpus/matches/` (4 matches, each as `.sgf` and `.mat`).
How to reproduce: `tests/README.md`. The tables below are the output of
`tests/compare/compare.py`.

## Summary

**The WebAssembly engine computes exactly the same numbers as native gnubg built from the
same source with the same floating-point rules (the "strict" build).** Of 193,883 numbers
compared, 193,851 are bit-identical, and every one of the 32 others is explained below
by two properties of the C library, not of gnubg or of the port.

| | positions (eval, hint, cube) | match analysis (per move) | match statistics |
|---|---|---|---|
| numbers compared | 8,303 | 181,466 | 1,018 |
| bit-identical | **8,303 (all)** | 181,436 | 1,016 |
| cube verdicts that differ | 0 of 26 | 0 | – |
| skill / luck marks that differ | – | 0 of 5,334 | 0 of 64 ratings |
| hint moves evaluated at a different depth | 0 of 940 | – | – |
| move lists ordered differently | 1 of 60, exact tie | 18 of 1,524: 12 exact ties, 6 tie "depth swaps" | – |
| "show statistics match" text | – | – | identical for all 8 files |

The two explanations (each has a minimal reproduction in `tests/compare/repro/`):

1. **Tie ordering.** When two moves have exactly the same equity, gnubg has no rule for
   which one to list first: its comparison function (`CompareMoves`, `eval.c:2811`)
   never says "equal", so the order comes from the C library's sorting routine
   (`qsort`), and macOS and Emscripten sort ties differently
   (`repro/qsort_ties.c`: 8 equal moves come out as `7 1 2 3 0 5 6 4` natively and
   `0 2 1 4 3 5 7 6` in WebAssembly). This changes the *order* of tied moves (and so
   the "best move" text in 8 records), never an equity: every chequer error,
   skill mark and statistic is identical.
   A knock-on effect ("depth swap", 6 lists in 3 positions, each counted twice
   because each match exists as .sgf and .mat): gnubg's move filter keeps the best
   few moves from a quick 0-ply evaluation and re-evaluates them at 2-ply. When
   several candidates are exactly tied at the cut, the sort order decides which of
   them get the 2-ply evaluation, so a move can carry a 0-ply value on one side and a
   2-ply value on the other. All 30 differing numbers inside move lists are in these 6
   lists (differences up to 9.5e-7 in equity and 9.5e-4 in a gammon probability, in
   positions where every candidate has the same equity, e.g. exactly −1).
2. **`log10f`.** The "luck based FIBS rating diff." statistic uses the C function
   `log10f`. macOS returns the correctly rounded result; Emscripten's C library
   returns the float one step lower for the argument that occurs in match7
   (`repro/log10f.c`). Result: −149.73588 vs −149.73587 (difference 1.5e-5 rating
   points; the printed value is the same). These are the 2 differing statistics.

Everything else is identical bit for bit: every evaluation (0/1/2-ply, cubeless and
cubeful), every hint list (equities, probabilities, evaluation depth), every cube
decision (equities, MWC, percentage, verdict), every per-move analysis value (move
lists, errors, luck, cube evaluations), every statistic and the statistics text.

**What "bit-identical" means.** Computers store these numbers as 32-bit floating-point
values ("floats"), about 7 significant digits. Two results are bit-identical when
all 32 bits are the same, i.e. the numbers are exactly equal, not merely equal after
rounding. The comparison uses no tolerance at all.

**What "tie ordering" means.** If two moves are exactly equally good, either order is
correct; only the order in which they are listed differs (see 1. above).

**Desktop builds.** gnubg's official builds use `-O3 -ffast-math` (the "release"
build), which lets the compiler reorder arithmetic. Comparing native strict with
native release (table (c)) shows what that costs: about two thirds of all numbers
change in the last digits (typically 1e-7; at most 6.6e-6 for the corpus positions and,
apart from the case below, 3.3e-4 in match analysis), no cube verdict or skill/luck mark
changes, 7 move lists reorder moves whose equities differ by less than 1e-6, and the
"show statistics match" text differs in 5 of 8 files (last printed digit). One position
type is fragile: in money play with the Jacoby rule and a centred cube, near the end of a
game, all candidate moves can have exactly the same cubeful equity, and the
release build then picks different moves inside the 2-ply search
(`money4.mat` game 3: gammon probability 0.447 vs 0.342, double/take equity −2.89 vs
−2.68; see `tests/native/PYTHON_INTERFACE.md`, open question 5). Our WebAssembly
build matches the strict build, so these numbers can differ from a desktop gnubg
in the same way the two native builds differ from each other.

**Comparisons run**

- (a) WebAssembly vs native strict, one fresh native process per query (the reference).
- (b) WebAssembly vs native strict in one native process that flushes gnubg's cache
  before every query: **identical to (a) in every number and every difference**, as
  expected (the API flushes the cache at the start of every call).
- (c) native strict vs native release (`-O3 -ffast-math`).
- (d) WebAssembly vs native strict with gnubg's own default analysis settings
  ("supremo": 2-ply, large move filter) for all 8 match files: same picture as (a)
  (10 exact ties, 8 depth swaps, 0 real differences, the same `log10f` statistic).
  In one depth-swap list (match5, game 4, move 46) one move evaluated at 2-ply on
  both sides also differs by one float step in one probability; in that list the two
  sides evaluated different moves at 2-ply first, so gnubg's evaluation cache held
  different entries (history dependence, `PYTHON_INTERFACE.md` section 9).

Analysis settings for (a)–(c): chequer and cube 2-ply cubeful ("world class", normal
move filter), luck 0-ply, gnubg's default thresholds; Jacoby on for `.mat` money
sessions (gnubg's default; `.mat` files have no Jacoby flag).

Run times (Apple Silicon, Node 24; see `tests/README.md`): native strict reference
41 s (12 s positions in 344 separate processes, 29 s matches); WebAssembly replay
48 s (1.4 s positions, 46 s matches); comparison 0.5 s. With gnubg's default
analysis settings: native 52 s, WebAssembly 84 s for the 8 match files.

Fields that only one side reports and that are therefore not compared:
the cubeful equity of a plain evaluation and the probabilities of a cube evaluation
(gnubg's Python interface does not return them); native's per-game statistics;
wasm's variances and per-move MWC. The per-move "marked rolls" counts from gnubg's
Python interface are wrong for player O (a gnubg bug), so the counts recomputed from
the move records are compared instead.


## How to read the tables

- **numbers**: how many floating-point values were compared; **bit-identical**: how
  many were exactly equal; **max abs diff**: the largest difference among the rest.
- **order diffs (tie / depth swap / real)**: move lists whose order differs, split into
  exact ties, tie-induced depth swaps (see the summary) and anything else ("real").
- **verdict diffs**: cube decisions with a different gnubg verdict (e.g. "Double, take").
- **mark diffs**: labels compared exactly: skill marks (doubtful/bad/very bad), luck
  marks, statistics ratings, and for hints the depth (plies) each move was evaluated at.
- **other diffs**: other exact comparisons: the inputs (cube value, owner, score,
  Jacoby, beavers), move texts, the best move's text, record types, statistics text.
- Rows marked **[tie depth swap]** hold the numbers of the moves in depth-swap lists,
  kept apart so that the other rows show the comparison of everything else.
- In "Differences", `g3 r46` means game index 3 (the 4th game), record index 46.

## (a) WebAssembly vs native strict build, fresh native process per query

A = `wasm-strict.json`, B = `native-strict-fresh.json`.

**By output type**

| output | numbers | bit-identical | max abs diff | order diffs (tie / depth swap / real) | verdict diffs | mark diffs | other diffs |
|---|---:|---:|---:|---:|---:|---:|---:|
| inputs: cubeinfo | 3096 | 3096 | 0 |  |  |  | 0 / 3700 |
| eval 0-ply cubeless: probs | 215 | 215 | 0 |  |  |  |  |
| eval 0-ply cubeless: cubeless equity | 43 | 43 | 0 |  |  |  |  |
| eval 0-ply cubeful: probs | 215 | 215 | 0 |  |  |  |  |
| eval 0-ply cubeful: cubeless equity | 43 | 43 | 0 |  |  |  |  |
| eval 1-ply cubeless: probs | 215 | 215 | 0 |  |  |  |  |
| eval 1-ply cubeless: cubeless equity | 43 | 43 | 0 |  |  |  |  |
| eval 1-ply cubeful: probs | 215 | 215 | 0 |  |  |  |  |
| eval 1-ply cubeful: cubeless equity | 43 | 43 | 0 |  |  |  |  |
| eval 2-ply cubeless: probs | 215 | 215 | 0 |  |  |  |  |
| eval 2-ply cubeless: cubeless equity | 43 | 43 | 0 |  |  |  |  |
| eval 2-ply cubeful: probs | 215 | 215 | 0 |  |  |  |  |
| eval 2-ply cubeful: cubeless equity | 43 | 43 | 0 |  |  |  |  |
| hint expert |  |  |  | 0 / 0 / 0 |  |  |  |
| hint expert equity | 470 | 470 | 0 |  |  |  |  |
| hint expert diff | 470 | 470 | 0 |  |  |  |  |
| hint expert probs | 2350 | 2350 | 0 |  |  |  |  |
| hint expert: plies evaluated |  |  |  |  |  | 0 / 470 |  |
| hint world class |  |  |  | 1 / 0 / 0 |  |  |  |
| hint world class equity | 470 | 470 | 0 |  |  |  |  |
| hint world class diff | 470 | 470 | 0 |  |  |  |  |
| hint world class probs | 2350 | 2350 | 0 |  |  |  |  |
| hint world class: plies evaluated |  |  |  |  |  | 0 / 470 |  |
| cube 0-ply: equities | 52 | 52 | 0 |  |  |  |  |
| cube 0-ply: percent | 8 | 8 | 0 |  |  |  |  |
| cube 0-ply: verdict |  |  |  |  | 0 / 13 |  |  |
| cube 0-ply: cube available |  |  |  |  |  |  | 0 / 13 |
| cube 2-ply: equities | 52 | 52 | 0 |  |  |  |  |
| cube 2-ply: percent | 7 | 7 | 0 |  |  |  |  |
| cube 2-ply: verdict |  |  |  |  | 0 / 13 |  |  |
| cube 2-ply: cube available |  |  |  |  |  |  | 0 / 13 |
| cube 0-ply: mwc | 28 | 28 | 0 |  |  |  |  |
| cube 2-ply: mwc | 28 | 28 | 0 |  |  |  |  |
| match: record action/player |  |  |  |  |  |  | 0 / 3600 |
| match: move text |  |  |  |  |  |  | 0 / 1750 |
| match: move list |  |  |  | 12 / 6 / 0 |  |  |  |
| match: move list equity | 27128 | 27128 | 0 |  |  |  |  |
| match: move list probs | 135640 | 135640 | 0 |  |  |  |  |
| match: best move |  |  |  |  |  |  | 8 / 1524 |
| match: chequer error | 1524 | 1524 | 0 |  |  |  |  |
| match: chequer error cost | 1524 | 1524 | 0 |  |  |  |  |
| match: chequer skill mark |  |  |  |  |  | 0 / 1750 |  |
| match: cube skill mark |  |  |  |  |  | 0 / 1834 |  |
| match: luck | 1750 | 1750 | 0 |  |  |  |  |
| match: luck cost | 1750 | 1750 | 0 |  |  |  |  |
| match: luck mark |  |  |  |  |  | 0 / 1750 |  |
| match: cube evaluation (stored) | 7146 | 7146 | 0 |  |  |  |  |
| match: cube ND/DT/DP/optimal | 3176 | 3176 | 0 |  |  |  |  |
| match: cube error | 836 | 836 | 0 |  |  |  |  |
| match: cube error cost | 836 | 836 | 0 |  |  |  |  |
| match: move list [tie depth swap] equity | 26 | 6 | 9.54e-07 |  |  |  |  |
| match: move list [tie depth swap] probs | 130 | 120 | 0.000945 |  |  |  |  |
| match: statistics (sums, counts) | 714 | 712 | 1.53e-05 |  |  |  |  |
| match: statistics (rates, totals) | 304 | 304 | 0 |  |  |  |  |
| match: statistics ratings |  |  |  |  |  | 0 / 64 |  |
| match: 'show statistics match' text |  |  |  |  |  |  | 0 / 8 |
| **all** | 193883 | 193851 | 0.000945 | 13 / 6 / 0 | 0 / 26 | 0 / 6338 | 8 / 10608 |

**By corpus category**

| category | numbers | bit-identical | max abs diff | order diffs (tie / depth swap / real) | verdict diffs | mark diffs | other diffs |
|---|---:|---:|---:|---:|---:|---:|---:|
| bar | 150 | 150 | 0 | 0 / 0 / 0 |  | 0 / 6 |  |
| bearoff-os | 702 | 702 | 0 | 0 / 0 / 0 |  | 0 / 54 |  |
| bearoff-ts | 478 | 478 | 0 | 1 / 0 / 0 |  | 0 / 22 |  |
| contact | 3580 | 3580 | 0 | 0 / 0 / 0 |  | 0 / 388 |  |
| crashed | 272 | 272 | 0 | 0 / 0 / 0 |  | 0 / 8 |  |
| cube-beaver | 236 | 236 | 0 |  | 0 / 4 |  | 0 / 4 |
| cube-double-pass | 240 | 240 | 0 |  | 0 / 4 |  | 0 / 4 |
| cube-double-take | 241 | 241 | 0 |  | 0 / 4 |  | 0 / 4 |
| cube-no-double | 244 | 244 | 0 |  | 0 / 4 |  | 0 / 4 |
| cube-optional | 124 | 124 | 0 |  | 0 / 2 |  | 0 / 2 |
| cube-redouble | 244 | 244 | 0 |  | 0 / 4 |  | 0 / 4 |
| cube-too-good-pass | 126 | 126 | 0 |  | 0 / 2 |  | 0 / 2 |
| cube-too-good-take | 124 | 124 | 0 |  | 0 / 2 |  | 0 / 2 |
| dmp | 416 | 416 | 0 | 0 / 0 / 0 |  | 0 / 44 |  |
| doubles | 1910 | 1910 | 0 | 0 / 0 / 0 |  | 0 / 242 |  |
| forced | 122 | 122 | 0 | 0 / 0 / 0 |  | 0 / 2 |  |
| match match5.mat | 20095 | 20090 | 0.000945 | 0 / 1 / 0 |  | 0 / 643 | 0 / 1255 |
| match match5.sgf | 20095 | 20090 | 0.000945 | 0 / 1 / 0 |  | 0 / 643 | 0 / 1255 |
| match match7.mat | 11872 | 11869 | 1.53e-05 | 1 / 1 / 0 |  | 0 / 387 | 1 / 751 |
| match match7.sgf | 11872 | 11869 | 1.53e-05 | 1 / 1 / 0 |  | 0 / 387 | 1 / 751 |
| match money4.mat | 19567 | 19567 | 0 | 3 / 0 / 0 |  | 0 / 519 | 2 / 1022 |
| match money4.sgf | 19567 | 19567 | 0 | 3 / 0 / 0 |  | 0 / 519 | 2 / 1022 |
| match selfplay-7pt.mat | 39708 | 39700 | 4.77e-07 | 2 / 1 / 0 |  | 0 / 1150 | 1 / 2263 |
| match selfplay-7pt.sgf | 39708 | 39700 | 4.77e-07 | 2 / 1 / 0 |  | 0 / 1150 | 1 / 2263 |
| no-move | 108 | 108 | 0 | 0 / 0 / 0 |  |  |  |
| opening | 552 | 552 | 0 | 0 / 0 / 0 |  | 0 / 48 |  |
| prime | 622 | 622 | 0 | 0 / 0 / 0 |  | 0 / 58 |  |
| race | 908 | 908 | 0 | 0 / 0 / 0 |  | 0 / 68 |  |

**Differences** (65; first 65 shown)

- hint world class | bearoff-ts-03 hint-worldclass | order differs (exact tie) from rank 4: 5/2 3/2 (-1) vs 5/2 4/3 (-1.0)
- match: move list | match5.mat g3 r46 | depth swap among tied moves: bar/22(2) 20/17 6/3 (2-ply -1 vs 0-ply -1.0), bar/22(2) 20/17(2) (0-ply -1 vs 2-ply -1.0), bar/22(2) 4/1(2) (0-ply -1 vs 2-ply -1.0)
- match: move list [tie depth swap] probs | match5.mat g3 r46 bar/22(2) 20/17 6/3 probs/loseGammon | 0.9352536797523499 vs 0.9354331493377686 (diff 0.000179)
- match: move list [tie depth swap] probs | match5.mat g3 r46 bar/22(2) 20/17 6/3 probs/loseBackgammon | 2.4446906081720954e-06 vs 2.7655669327941723e-06 (diff 3.21e-07)
- match: move list [tie depth swap] probs | match5.mat g3 r46 bar/22(2) 20/17(2) probs/loseGammon | 0.9074668288230896 vs 0.9079505205154419 (diff 0.000484)
- match: move list [tie depth swap] probs | match5.mat g3 r46 bar/22(2) 4/1(2) probs/loseGammon | 0.9565648436546326 vs 0.9556198120117188 (diff 0.000945)
- match: move list [tie depth swap] probs | match5.mat g3 r46 bar/22(2) 4/1(2) probs/loseBackgammon | 9.333788329968229e-05 vs 0.0006093390984460711 (diff 0.000516)
- match: move list | match5.mat g3 r46 | order differs (depth swap) from rank 5: bar/19 bar/22 5/2 (-1) vs bar/22(2) 20/14 (-1.0)
- match: move list | match5.sgf g3 r46 | depth swap among tied moves: bar/22(2) 20/17 6/3 (2-ply -1 vs 0-ply -1.0), bar/22(2) 20/17(2) (0-ply -1 vs 2-ply -1.0), bar/22(2) 4/1(2) (0-ply -1 vs 2-ply -1.0)
- match: move list [tie depth swap] probs | match5.sgf g3 r46 bar/22(2) 20/17 6/3 probs/loseGammon | 0.9352536797523499 vs 0.9354331493377686 (diff 0.000179)
- match: move list [tie depth swap] probs | match5.sgf g3 r46 bar/22(2) 20/17 6/3 probs/loseBackgammon | 2.4446906081720954e-06 vs 2.7655669327941723e-06 (diff 3.21e-07)
- match: move list [tie depth swap] probs | match5.sgf g3 r46 bar/22(2) 20/17(2) probs/loseGammon | 0.9074668288230896 vs 0.9079505205154419 (diff 0.000484)
- match: move list [tie depth swap] probs | match5.sgf g3 r46 bar/22(2) 4/1(2) probs/loseGammon | 0.9565648436546326 vs 0.9556198120117188 (diff 0.000945)
- match: move list [tie depth swap] probs | match5.sgf g3 r46 bar/22(2) 4/1(2) probs/loseBackgammon | 9.333788329968229e-05 vs 0.0006093390984460711 (diff 0.000516)
- match: move list | match5.sgf g3 r46 | order differs (depth swap) from rank 5: bar/19 bar/22 5/2 (-1) vs bar/22(2) 20/14 (-1.0)
- match: move list | match7.mat g0 r59 | order differs (exact tie) from rank 61: bar/17 6/2(2) (-2.073824644088745) vs bar/21 6/2 5/1(2) (-2.073824644088745)
- match: move list | match7.mat g0 r61 | depth swap among tied moves: 21/17 13/7 (2-ply -2.0738232135772705 vs 0-ply -2.073824167251587), 21/15 5/1 (0-ply -2.073824167251587 vs 2-ply -2.0738232135772705)
- match: move list [tie depth swap] equity | match7.mat g0 r61 21/17 13/7 equity | -2.0738232135772705 vs -2.073824167251587 (diff 9.54e-07)
- match: move list [tie depth swap] equity | match7.mat g0 r61 21/15 5/1 equity | -2.073824167251587 vs -2.0738232135772705 (diff 9.54e-07)
- match: move list | match7.mat g0 r61 | order differs (depth swap) from rank 1: 21/11 (-2.0738232135772705) vs 13/7 10/6 (-2.0738232135772705)
- match: best move | match7.mat g0 r61 | '21/11' vs '13/7 10/6'
- match: statistics (sums, counts) | tests/corpus/matches/match7.mat raw/X/dice/fibs-rating-difference | -149.73587036132812 vs -149.7358856201172 (diff 1.53e-05)
- match: move list | match7.sgf g0 r59 | order differs (exact tie) from rank 61: bar/17 6/2(2) (-2.073824644088745) vs bar/21 6/2 5/1(2) (-2.073824644088745)
- match: move list | match7.sgf g0 r61 | depth swap among tied moves: 21/17 13/7 (2-ply -2.0738232135772705 vs 0-ply -2.073824167251587), 21/15 5/1 (0-ply -2.073824167251587 vs 2-ply -2.0738232135772705)
- match: move list [tie depth swap] equity | match7.sgf g0 r61 21/17 13/7 equity | -2.0738232135772705 vs -2.073824167251587 (diff 9.54e-07)
- match: move list [tie depth swap] equity | match7.sgf g0 r61 21/15 5/1 equity | -2.073824167251587 vs -2.0738232135772705 (diff 9.54e-07)
- match: move list | match7.sgf g0 r61 | order differs (depth swap) from rank 1: 21/11 (-2.0738232135772705) vs 13/7 10/6 (-2.0738232135772705)
- match: best move | match7.sgf g0 r61 | '21/11' vs '13/7 10/6'
- match: statistics (sums, counts) | tests/corpus/matches/match7.sgf raw/X/dice/fibs-rating-difference | -149.73587036132812 vs -149.7358856201172 (diff 1.53e-05)
- match: move list | money4.mat g1 r47 | order differs (exact tie) from rank 1: 10/8 6/5 3/2 (-1.1388888359069824) vs 10/8 4/3 2/1 (-1.1388888359069824)
- match: best move | money4.mat g1 r47 | '10/8 6/5 3/2' vs '10/8 4/3 2/1'
- match: move list | money4.mat g1 r49 | order differs (exact tie) from rank 1: 8/6 3/off (-0.9999998807907104) vs 8/5 2/off (-0.9999998807907104)
- match: best move | money4.mat g1 r49 | '8/6 3/off' vs '8/5 2/off'
- match: move list | money4.mat g2 r43 | order differs (exact tie) from rank 2: 11/5 4/2 (-1) vs 11/3 (-1.0)
- match: move list | money4.sgf g1 r47 | order differs (exact tie) from rank 1: 10/8 6/5 3/2 (-1.1388888359069824) vs 10/8 4/3 2/1 (-1.1388888359069824)
- match: best move | money4.sgf g1 r47 | '10/8 6/5 3/2' vs '10/8 4/3 2/1'
- match: move list | money4.sgf g1 r49 | order differs (exact tie) from rank 1: 8/6 3/off (-0.9999998807907104) vs 8/5 2/off (-0.9999998807907104)
- match: best move | money4.sgf g1 r49 | '8/6 3/off' vs '8/5 2/off'
- match: move list | money4.sgf g2 r43 | order differs (exact tie) from rank 3: 11/5 4/2 (-1.9444419145584106) vs 11/5 6/4 (-1.9444419145584106)
- match: move list | selfplay-7pt.mat g1 r71 | order differs (exact tie) from rank 2: 12/4 11/7 5/1 (-1.1818338632583618) vs 12/8 11/3 6/2 (-1.1818338632583618)
- match: move list | selfplay-7pt.mat g1 r73 | order differs (exact tie) from rank 1: 8/4 5/off (-0.9999996423721313) vs 8/3 4/off (-0.9999996423721313)
- match: best move | selfplay-7pt.mat g1 r73 | '8/4 5/off' vs '8/3 4/off'
- match: move list | selfplay-7pt.mat g5 r72 | depth swap among tied moves: 19/17 18/15 (2-ply -1.1991455554962158 vs 0-ply -1.1991450786590576), 19/17 15/12 (2-ply -1.1991455554962158 vs 0-ply -1.1991450786590576), 19/17 5/2 (2-ply -1.1991455554962158 vs 0-ply -1.1991450786590576), 19/17 4/1 (2-ply -1.1991455554962158 vs 0-ply -1.1991450786590576), 19/16 18/16 (0-ply -1.1991450786590576 vs 2-ply -1.1991455554962158), 19/17 11/8 (0-ply -1.1991450786590576 vs 2-ply -1.1991455554962158), 19/14 (0-ply -1.1991450786590576 vs 2-ply -1.1991455554962158), 19/16 11/9 (0-ply -1.1991450786590576 vs 2-ply -1.1991455554962158)
- match: move list [tie depth swap] equity | selfplay-7pt.mat g5 r72 19/17 18/15 equity | -1.1991455554962158 vs -1.1991450786590576 (diff 4.77e-07)
- match: move list [tie depth swap] equity | selfplay-7pt.mat g5 r72 19/17 15/12 equity | -1.1991455554962158 vs -1.1991450786590576 (diff 4.77e-07)
- match: move list [tie depth swap] equity | selfplay-7pt.mat g5 r72 19/17 5/2 equity | -1.1991455554962158 vs -1.1991450786590576 (diff 4.77e-07)
- match: move list [tie depth swap] equity | selfplay-7pt.mat g5 r72 19/17 4/1 equity | -1.1991455554962158 vs -1.1991450786590576 (diff 4.77e-07)
- match: move list [tie depth swap] equity | selfplay-7pt.mat g5 r72 19/16 18/16 equity | -1.1991450786590576 vs -1.1991455554962158 (diff 4.77e-07)
- match: move list [tie depth swap] equity | selfplay-7pt.mat g5 r72 19/17 11/8 equity | -1.1991450786590576 vs -1.1991455554962158 (diff 4.77e-07)
- match: move list [tie depth swap] equity | selfplay-7pt.mat g5 r72 19/14 equity | -1.1991450786590576 vs -1.1991455554962158 (diff 4.77e-07)
- match: move list [tie depth swap] equity | selfplay-7pt.mat g5 r72 19/16 11/9 equity | -1.1991450786590576 vs -1.1991455554962158 (diff 4.77e-07)
- match: move list | selfplay-7pt.mat g5 r72 | order differs (depth swap) from rank 5: 19/17 18/15 (-1.1991455554962158) vs 19/16 18/16 (-1.1991455554962158)
- match: move list | selfplay-7pt.sgf g1 r71 | order differs (exact tie) from rank 2: 12/4 11/7 5/1 (-1.1818338632583618) vs 12/8 11/3 6/2 (-1.1818338632583618)
- match: move list | selfplay-7pt.sgf g1 r73 | order differs (exact tie) from rank 1: 8/4 5/off (-0.9999996423721313) vs 8/3 4/off (-0.9999996423721313)
- match: best move | selfplay-7pt.sgf g1 r73 | '8/4 5/off' vs '8/3 4/off'
- match: move list | selfplay-7pt.sgf g5 r72 | depth swap among tied moves: 19/17 18/15 (2-ply -1.1991455554962158 vs 0-ply -1.1991450786590576), 19/17 15/12 (2-ply -1.1991455554962158 vs 0-ply -1.1991450786590576), 19/17 5/2 (2-ply -1.1991455554962158 vs 0-ply -1.1991450786590576), 19/17 4/1 (2-ply -1.1991455554962158 vs 0-ply -1.1991450786590576), 19/16 18/16 (0-ply -1.1991450786590576 vs 2-ply -1.1991455554962158), 19/17 11/8 (0-ply -1.1991450786590576 vs 2-ply -1.1991455554962158), 19/14 (0-ply -1.1991450786590576 vs 2-ply -1.1991455554962158), 19/16 11/9 (0-ply -1.1991450786590576 vs 2-ply -1.1991455554962158)
- match: move list [tie depth swap] equity | selfplay-7pt.sgf g5 r72 19/17 18/15 equity | -1.1991455554962158 vs -1.1991450786590576 (diff 4.77e-07)
- match: move list [tie depth swap] equity | selfplay-7pt.sgf g5 r72 19/17 15/12 equity | -1.1991455554962158 vs -1.1991450786590576 (diff 4.77e-07)
- match: move list [tie depth swap] equity | selfplay-7pt.sgf g5 r72 19/17 5/2 equity | -1.1991455554962158 vs -1.1991450786590576 (diff 4.77e-07)
- match: move list [tie depth swap] equity | selfplay-7pt.sgf g5 r72 19/17 4/1 equity | -1.1991455554962158 vs -1.1991450786590576 (diff 4.77e-07)
- match: move list [tie depth swap] equity | selfplay-7pt.sgf g5 r72 19/16 18/16 equity | -1.1991450786590576 vs -1.1991455554962158 (diff 4.77e-07)
- match: move list [tie depth swap] equity | selfplay-7pt.sgf g5 r72 19/17 11/8 equity | -1.1991450786590576 vs -1.1991455554962158 (diff 4.77e-07)
- match: move list [tie depth swap] equity | selfplay-7pt.sgf g5 r72 19/14 equity | -1.1991450786590576 vs -1.1991455554962158 (diff 4.77e-07)
- match: move list [tie depth swap] equity | selfplay-7pt.sgf g5 r72 19/16 11/9 equity | -1.1991450786590576 vs -1.1991455554962158 (diff 4.77e-07)
- match: move list | selfplay-7pt.sgf g5 r72 | order differs (depth swap) from rank 5: 19/17 18/15 (-1.1991455554962158) vs 19/16 18/16 (-1.1991455554962158)

**Not compared** (present in only one file): cube: noDouble probs (only one side reports them); eval: cubefulEquity (only one side reports it); match: statistics (sums, counts): fibs-rating-difference; match: statistics (sums, counts): marked-rolls; match: statistics (sums, counts): ppg-advantage



## (b) WebAssembly vs native strict build, one native process with cache flushes

Identical to (a): same counts, same maximum differences, same list of differences (compare.py output differs only in the file name).

## (c) native strict build vs native release build (-O3 -ffast-math)

A = `native-strict-fresh.json`, B = `native-release-fresh.json`.

**By output type**

| output | numbers | bit-identical | max abs diff | order diffs (tie / depth swap / real) | verdict diffs | mark diffs | other diffs |
|---|---:|---:|---:|---:|---:|---:|---:|
| inputs: cubeinfo | 3096 | 3096 | 0 |  |  |  | 0 / 3700 |
| eval 0-ply cubeless: probs | 215 | 98 | 4.47e-07 |  |  |  |  |
| eval 0-ply cubeless: cubeless equity | 43 | 17 | 7.15e-07 |  |  |  |  |
| eval 0-ply cubeful: probs | 215 | 98 | 4.47e-07 |  |  |  |  |
| eval 0-ply cubeful: cubeless equity | 43 | 17 | 7.15e-07 |  |  |  |  |
| eval 1-ply cubeless: probs | 215 | 88 | 2.38e-07 |  |  |  |  |
| eval 1-ply cubeless: cubeless equity | 43 | 15 | 5.57e-07 |  |  |  |  |
| eval 1-ply cubeful: probs | 215 | 87 | 1.84e-07 |  |  |  |  |
| eval 1-ply cubeful: cubeless equity | 43 | 13 | 4.77e-07 |  |  |  |  |
| eval 2-ply cubeless: probs | 215 | 90 | 7.15e-07 |  |  |  |  |
| eval 2-ply cubeless: cubeless equity | 43 | 15 | 1.52e-06 |  |  |  |  |
| eval 2-ply cubeful: probs | 215 | 82 | 6.85e-07 |  |  |  |  |
| eval 2-ply cubeful: cubeless equity | 43 | 15 | 1.48e-06 |  |  |  |  |
| hint expert |  |  |  | 0 / 0 / 1 |  |  |  |
| hint expert equity | 470 | 132 | 1.91e-06 |  |  |  |  |
| hint expert diff | 470 | 111 | 1.91e-06 |  |  |  |  |
| hint expert probs | 2350 | 765 | 5.07e-07 |  |  |  |  |
| hint expert: plies evaluated |  |  |  |  |  | 0 / 470 |  |
| hint world class |  |  |  | 0 / 0 / 1 |  |  |  |
| hint world class equity | 470 | 140 | 1.67e-06 |  |  |  |  |
| hint world class diff | 470 | 119 | 2.15e-06 |  |  |  |  |
| hint world class probs | 2350 | 785 | 1.61e-06 |  |  |  |  |
| hint world class: plies evaluated |  |  |  |  |  | 0 / 470 |  |
| cube 0-ply: equities | 52 | 32 | 1.67e-06 |  |  |  |  |
| cube 0-ply: percent | 8 | 4 | 5.48e-07 |  |  |  |  |
| cube 0-ply: verdict |  |  |  |  | 0 / 13 |  |  |
| cube 0-ply: cube available |  |  |  |  |  |  | 0 / 13 |
| cube 2-ply: equities | 52 | 30 | 6.62e-06 |  |  |  |  |
| cube 2-ply: percent | 7 | 3 | 7.45e-07 |  |  |  |  |
| cube 2-ply: verdict |  |  |  |  | 0 / 13 |  |  |
| cube 2-ply: cube available |  |  |  |  |  |  | 0 / 13 |
| cube 0-ply: mwc | 28 | 18 | 1.79e-07 |  |  |  |  |
| cube 2-ply: mwc | 28 | 14 | 5.96e-08 |  |  |  |  |
| match: record action/player |  |  |  |  |  |  | 0 / 3600 |
| match: move text |  |  |  |  |  |  | 0 / 1750 |
| match: move list |  |  |  | 2 / 0 / 5 |  |  |  |
| match: move list equity | 27154 | 13028 | 0.000271 |  |  |  |  |
| match: move list probs | 135770 | 40152 | 0.0837 |  |  |  |  |
| match: best move |  |  |  |  |  |  | 2 / 1524 |
| match: chequer error | 1524 | 1203 | 3.19e-05 |  |  |  |  |
| match: chequer error cost | 1524 | 1219 | 6.38e-05 |  |  |  |  |
| match: chequer skill mark |  |  |  |  |  | 0 / 1750 |  |
| match: cube skill mark |  |  |  |  |  | 0 / 1834 |  |
| match: luck | 1750 | 48 | 3.01e-05 |  |  |  |  |
| match: luck cost | 1750 | 552 | 3.01e-05 |  |  |  |  |
| match: luck mark |  |  |  |  |  | 0 / 1750 |  |
| match: cube evaluation (stored) | 7146 | 1909 | 0.21 |  |  |  |  |
| match: cube ND/DT/DP/optimal | 3176 | 1715 | 0.21 |  |  |  |  |
| match: cube error | 836 | 821 | 2.03e-06 |  |  |  |  |
| match: cube error cost | 836 | 821 | 2.98e-07 |  |  |  |  |
| match: statistics (sums, counts) | 808 | 634 | 0.00555 |  |  |  |  |
| match: statistics (rates, totals) | 304 | 48 | 6.48e-05 |  |  |  |  |
| match: statistics ratings |  |  |  |  |  | 0 / 64 |  |
| match: 'show statistics match' text |  |  |  |  |  |  | 5 / 8 |
| **all** | 193977 | 68034 | 0.21 | 2 / 0 / 7 | 0 / 26 | 0 / 6338 | 7 / 10608 |

**By corpus category**

| category | numbers | bit-identical | max abs diff | order diffs (tie / depth swap / real) | verdict diffs | mark diffs | other diffs |
|---|---:|---:|---:|---:|---:|---:|---:|
| bar | 150 | 82 | 9.54e-07 | 0 / 0 / 0 |  | 0 / 6 |  |
| bearoff-os | 702 | 587 | 5.96e-07 | 0 / 0 / 0 |  | 0 / 54 |  |
| bearoff-ts | 478 | 463 | 1.79e-07 | 0 / 0 / 0 |  | 0 / 22 |  |
| contact | 3580 | 1332 | 1.91e-06 | 0 / 0 / 0 |  | 0 / 388 |  |
| crashed | 272 | 190 | 1.43e-06 | 0 / 0 / 0 |  | 0 / 8 |  |
| cube-beaver | 236 | 193 | 6.62e-06 |  | 0 / 4 |  | 0 / 4 |
| cube-double-pass | 240 | 197 | 4.77e-07 |  | 0 / 4 |  | 0 / 4 |
| cube-double-take | 241 | 164 | 7.75e-07 |  | 0 / 4 |  | 0 / 4 |
| cube-no-double | 244 | 186 | 6.56e-07 |  | 0 / 4 |  | 0 / 4 |
| cube-optional | 124 | 84 | 1.79e-07 |  | 0 / 2 |  | 0 / 2 |
| cube-redouble | 244 | 200 | 2.38e-07 |  | 0 / 4 |  | 0 / 4 |
| cube-too-good-pass | 126 | 97 | 9.54e-07 |  | 0 / 2 |  | 0 / 2 |
| cube-too-good-take | 124 | 91 | 7.15e-07 |  | 0 / 2 |  | 0 / 2 |
| dmp | 416 | 144 | 4.77e-07 | 0 / 0 / 0 |  | 0 / 44 |  |
| doubles | 1910 | 449 | 2.15e-06 | 0 / 0 / 0 |  | 0 / 242 |  |
| forced | 122 | 77 | 2.98e-07 | 0 / 0 / 0 |  | 0 / 2 |  |
| match match5.mat | 20105 | 6273 | 0.000401 | 0 / 0 / 0 |  | 0 / 643 | 1 / 1255 |
| match match5.sgf | 20105 | 6273 | 0.000401 | 0 / 0 / 0 |  | 0 / 643 | 1 / 1255 |
| match match7.mat | 11882 | 3878 | 0.00105 | 0 / 0 / 1 |  | 0 / 387 | 2 / 751 |
| match match7.sgf | 11882 | 3878 | 0.00105 | 0 / 0 / 1 |  | 0 / 387 | 2 / 751 |
| match money4.mat | 19584 | 6763 | 0.21 | 2 / 0 / 1 |  | 0 / 519 | 1 / 1022 |
| match money4.sgf | 19584 | 6413 | 0.000328 | 0 / 0 / 2 |  | 0 / 519 | 0 / 1022 |
| match selfplay-7pt.mat | 39718 | 14336 | 0.00555 | 0 / 0 / 0 |  | 0 / 1150 | 0 / 2263 |
| match selfplay-7pt.sgf | 39718 | 14336 | 0.00555 | 0 / 0 / 0 |  | 0 / 1150 | 0 / 2263 |
| no-move | 108 | 85 | 4.17e-07 | 0 / 0 / 0 |  |  |  |
| opening | 552 | 247 | 7.75e-07 | 0 / 0 / 0 |  | 0 / 48 |  |
| prime | 622 | 267 | 7.23e-07 | 0 / 0 / 0 |  | 0 / 58 |  |
| race | 908 | 749 | 5.96e-07 | 0 / 0 / 2 |  | 0 / 68 |  |

**Not compared** (present in only one file): cube: noDouble probs (only one side reports them); eval: cubefulEquity (only one side reports it)


## (d) WebAssembly vs native strict build, matches analysed with gnubg's default settings

A = `wasm-strict-supremo.json`, B = `native-strict-fresh-supremo.json`.

**By output type**

| output | numbers | bit-identical | max abs diff | order diffs (tie / depth swap / real) | verdict diffs | mark diffs | other diffs |
|---|---:|---:|---:|---:|---:|---:|---:|
| match: record action/player |  |  |  |  |  |  | 0 / 3600 |
| match: move text |  |  |  |  |  |  | 0 / 1750 |
| inputs: cubeinfo |  |  |  |  |  |  | 0 / 3700 |
| match: move list |  |  |  | 10 / 8 / 0 |  |  |  |
| match: move list equity | 27128 | 27128 | 0 |  |  |  |  |
| match: move list probs | 135640 | 135640 | 0 |  |  |  |  |
| match: best move |  |  |  |  |  |  | 12 / 1524 |
| match: chequer error | 1524 | 1524 | 0 |  |  |  |  |
| match: chequer error cost | 1524 | 1524 | 0 |  |  |  |  |
| match: chequer skill mark |  |  |  |  |  | 0 / 1750 |  |
| match: cube skill mark |  |  |  |  |  | 0 / 1834 |  |
| match: luck | 1750 | 1750 | 0 |  |  |  |  |
| match: luck cost | 1750 | 1750 | 0 |  |  |  |  |
| match: luck mark |  |  |  |  |  | 0 / 1750 |  |
| match: cube evaluation (stored) | 7146 | 7146 | 0 |  |  |  |  |
| match: cube ND/DT/DP/optimal | 3176 | 3176 | 0 |  |  |  |  |
| match: cube error | 836 | 836 | 0 |  |  |  |  |
| match: cube error cost | 836 | 836 | 0 |  |  |  |  |
| match: move list [tie depth swap] equity | 26 | 6 | 7.63e-06 |  |  |  |  |
| match: move list [tie depth swap] probs | 130 | 108 | 0.000945 |  |  |  |  |
| match: statistics (sums, counts) | 714 | 712 | 1.53e-05 |  |  |  |  |
| match: statistics (rates, totals) | 304 | 304 | 0 |  |  |  |  |
| match: statistics ratings |  |  |  |  |  | 0 / 64 |  |
| match: 'show statistics match' text |  |  |  |  |  |  | 0 / 8 |
| **all** | 182484 | 182440 | 0.000945 | 10 / 8 / 0 |  | 0 / 5398 | 12 / 10582 |

**By corpus category**

| category | numbers | bit-identical | max abs diff | order diffs (tie / depth swap / real) | verdict diffs | mark diffs | other diffs |
|---|---:|---:|---:|---:|---:|---:|---:|
| match match5.mat | 20095 | 20090 | 0.000945 | 0 / 1 / 0 |  | 0 / 643 | 1 / 1255 |
| match match5.sgf | 20095 | 20090 | 0.000945 | 0 / 1 / 0 |  | 0 / 643 | 1 / 1255 |
| match match7.mat | 11872 | 11867 | 1.53e-05 | 1 / 1 / 0 |  | 0 / 387 | 1 / 751 |
| match match7.sgf | 11872 | 11867 | 1.53e-05 | 1 / 1 / 0 |  | 0 / 387 | 1 / 751 |
| match money4.mat | 19567 | 19557 | 7.63e-06 | 2 / 1 / 0 |  | 0 / 519 | 2 / 1022 |
| match money4.sgf | 19567 | 19557 | 7.63e-06 | 2 / 1 / 0 |  | 0 / 519 | 2 / 1022 |
| match selfplay-7pt.mat | 39708 | 39706 | 4.77e-07 | 2 / 1 / 0 |  | 0 / 1150 | 2 / 2263 |
| match selfplay-7pt.sgf | 39708 | 39706 | 4.77e-07 | 2 / 1 / 0 |  | 0 / 1150 | 2 / 2263 |

**Differences** (82; first 82 shown)

- match: move list | match5.mat g3 r46 | depth swap among tied moves: bar/22(2) 20/17 6/3 (2-ply -1 vs 0-ply -1.0), bar/22(2) 4/1(2) (0-ply -1 vs 2-ply -1.0); other moves of this list that differ at the same depth: bar/22(2) 20/17 5/2
- match: move list [tie depth swap] probs | match5.mat g3 r46 bar/22(2) 20/17 6/3 probs/loseGammon | 0.9352536797523499 vs 0.9354331493377686 (diff 0.000179)
- match: move list [tie depth swap] probs | match5.mat g3 r46 bar/22(2) 20/17 6/3 probs/loseBackgammon | 2.4446906081720954e-06 vs 2.7655669327941723e-06 (diff 3.21e-07)
- match: move list [tie depth swap] probs | match5.mat g3 r46 bar/22(2) 20/17 5/2 probs/loseGammon | 0.9355134963989258 vs 0.9355136156082153 (diff 1.19e-07)
- match: move list [tie depth swap] probs | match5.mat g3 r46 bar/22(2) 4/1(2) probs/loseGammon | 0.9565648436546326 vs 0.9556198120117188 (diff 0.000945)
- match: move list [tie depth swap] probs | match5.mat g3 r46 bar/22(2) 4/1(2) probs/loseBackgammon | 9.333788329968229e-05 vs 0.0006093390984460711 (diff 0.000516)
- match: move list | match5.mat g3 r46 | order differs (depth swap) from rank 1: bar/19(2) (-1) vs bar/22(2) 5/2 4/1 (-1.0)
- match: best move | match5.mat g3 r46 | 'bar/19(2)' vs 'bar/22(2) 5/2 4/1'
- match: move list | match5.sgf g3 r46 | depth swap among tied moves: bar/22(2) 20/17 6/3 (2-ply -1 vs 0-ply -1.0), bar/22(2) 4/1(2) (0-ply -1 vs 2-ply -1.0); other moves of this list that differ at the same depth: bar/22(2) 20/17 5/2
- match: move list [tie depth swap] probs | match5.sgf g3 r46 bar/22(2) 20/17 6/3 probs/loseGammon | 0.9352536797523499 vs 0.9354331493377686 (diff 0.000179)
- match: move list [tie depth swap] probs | match5.sgf g3 r46 bar/22(2) 20/17 6/3 probs/loseBackgammon | 2.4446906081720954e-06 vs 2.7655669327941723e-06 (diff 3.21e-07)
- match: move list [tie depth swap] probs | match5.sgf g3 r46 bar/22(2) 20/17 5/2 probs/loseGammon | 0.9355134963989258 vs 0.9355136156082153 (diff 1.19e-07)
- match: move list [tie depth swap] probs | match5.sgf g3 r46 bar/22(2) 4/1(2) probs/loseGammon | 0.9565648436546326 vs 0.9556198120117188 (diff 0.000945)
- match: move list [tie depth swap] probs | match5.sgf g3 r46 bar/22(2) 4/1(2) probs/loseBackgammon | 9.333788329968229e-05 vs 0.0006093390984460711 (diff 0.000516)
- match: move list | match5.sgf g3 r46 | order differs (depth swap) from rank 1: bar/19(2) (-1) vs bar/22(2) 5/2 4/1 (-1.0)
- match: best move | match5.sgf g3 r46 | 'bar/19(2)' vs 'bar/22(2) 5/2 4/1'
- match: move list | match7.mat g0 r59 | order differs (exact tie) from rank 61: bar/17 6/2(2) (-2.073824644088745) vs bar/21 6/2 5/1(2) (-2.073824644088745)
- match: move list | match7.mat g0 r61 | depth swap among tied moves: 13/3 (2-ply -2.0738232135772705 vs 0-ply -2.073824644088745), 13/7 5/1 (2-ply -2.0738232135772705 vs 0-ply -2.073824644088745), 13/7 6/2 (0-ply -2.073824644088745 vs 2-ply -2.0738232135772705), 8/2 6/2 (0-ply -2.073824644088745 vs 2-ply -2.0738232135772705)
- match: move list [tie depth swap] equity | match7.mat g0 r61 13/3 equity | -2.0738232135772705 vs -2.073824644088745 (diff 1.43e-06)
- match: move list [tie depth swap] equity | match7.mat g0 r61 13/7 5/1 equity | -2.0738232135772705 vs -2.073824644088745 (diff 1.43e-06)
- match: move list [tie depth swap] equity | match7.mat g0 r61 13/7 6/2 equity | -2.073824644088745 vs -2.0738232135772705 (diff 1.43e-06)
- match: move list [tie depth swap] equity | match7.mat g0 r61 8/2 6/2 equity | -2.073824644088745 vs -2.0738232135772705 (diff 1.43e-06)
- match: move list | match7.mat g0 r61 | order differs (depth swap) from rank 1: 21/11 (-2.0738232135772705) vs 13/7 6/2 (-2.0738232135772705)
- match: best move | match7.mat g0 r61 | '21/11' vs '13/7 6/2'
- match: statistics (sums, counts) | tests/corpus/matches/match7.mat raw/X/dice/fibs-rating-difference | -150.63209533691406 vs -150.63211059570312 (diff 1.53e-05)
- match: move list | match7.sgf g0 r59 | order differs (exact tie) from rank 61: bar/17 6/2(2) (-2.073824644088745) vs bar/21 6/2 5/1(2) (-2.073824644088745)
- match: move list | match7.sgf g0 r61 | depth swap among tied moves: 13/3 (2-ply -2.0738232135772705 vs 0-ply -2.073824644088745), 13/7 5/1 (2-ply -2.0738232135772705 vs 0-ply -2.073824644088745), 13/7 6/2 (0-ply -2.073824644088745 vs 2-ply -2.0738232135772705), 8/2 6/2 (0-ply -2.073824644088745 vs 2-ply -2.0738232135772705)
- match: move list [tie depth swap] equity | match7.sgf g0 r61 13/3 equity | -2.0738232135772705 vs -2.073824644088745 (diff 1.43e-06)
- match: move list [tie depth swap] equity | match7.sgf g0 r61 13/7 5/1 equity | -2.0738232135772705 vs -2.073824644088745 (diff 1.43e-06)
- match: move list [tie depth swap] equity | match7.sgf g0 r61 13/7 6/2 equity | -2.073824644088745 vs -2.0738232135772705 (diff 1.43e-06)
- match: move list [tie depth swap] equity | match7.sgf g0 r61 8/2 6/2 equity | -2.073824644088745 vs -2.0738232135772705 (diff 1.43e-06)
- match: move list | match7.sgf g0 r61 | order differs (depth swap) from rank 1: 21/11 (-2.0738232135772705) vs 13/7 6/2 (-2.0738232135772705)
- match: best move | match7.sgf g0 r61 | '21/11' vs '13/7 6/2'
- match: statistics (sums, counts) | tests/corpus/matches/match7.sgf raw/X/dice/fibs-rating-difference | -150.63209533691406 vs -150.63211059570312 (diff 1.53e-05)
- match: move list | money4.mat g1 r47 | order differs (exact tie) from rank 1: 10/8 6/5 3/2 (-1.1388888359069824) vs 10/7 4/3 (-1.1388888359069824)
- match: best move | money4.mat g1 r47 | '10/8 6/5 3/2' vs '10/7 4/3'
- match: move list | money4.mat g1 r49 | depth swap among tied moves: 8/5 4/2 (2-ply -1.1666666269302368 vs 0-ply -1.166674256324768), 8/3 (2-ply -1.1666666269302368 vs 0-ply -1.166674256324768), 8/6 4/1 (0-ply -1.166674256324768 vs 2-ply -1.1666666269302368), 8/6 5/2 (0-ply -1.166674256324768 vs 2-ply -1.1666666269302368)
- match: move list [tie depth swap] equity | money4.mat g1 r49 8/5 4/2 equity | -1.1666666269302368 vs -1.166674256324768 (diff 7.63e-06)
- match: move list [tie depth swap] probs | money4.mat g1 r49 8/5 4/2 probs/win | 1.1920928955078125e-07 vs 0.0 (diff 1.19e-07)
- match: move list [tie depth swap] probs | money4.mat g1 r49 8/5 4/2 probs/loseGammon | 0.1666666716337204 vs 0.16667430102825165 (diff 7.63e-06)
- match: move list [tie depth swap] equity | money4.mat g1 r49 8/3 equity | -1.1666666269302368 vs -1.166674256324768 (diff 7.63e-06)
- match: move list [tie depth swap] probs | money4.mat g1 r49 8/3 probs/loseGammon | 0.1666666716337204 vs 0.16667430102825165 (diff 7.63e-06)
- match: move list [tie depth swap] equity | money4.mat g1 r49 8/6 4/1 equity | -1.166674256324768 vs -1.1666666269302368 (diff 7.63e-06)
- match: move list [tie depth swap] probs | money4.mat g1 r49 8/6 4/1 probs/loseGammon | 0.16667430102825165 vs 0.1666666716337204 (diff 7.63e-06)
- match: move list [tie depth swap] equity | money4.mat g1 r49 8/6 5/2 equity | -1.166674256324768 vs -1.1666666269302368 (diff 7.63e-06)
- match: move list [tie depth swap] probs | money4.mat g1 r49 8/6 5/2 probs/win | 0 vs 1.1920928955078125e-07 (diff 1.19e-07)
- match: move list [tie depth swap] probs | money4.mat g1 r49 8/6 5/2 probs/loseGammon | 0.16667430102825165 vs 0.1666666716337204 (diff 7.63e-06)
- match: move list | money4.mat g1 r49 | order differs (depth swap) from rank 1: 8/6 3/off (-0.9999998807907104) vs 8/5 2/off (-0.9999998807907104)
- match: best move | money4.mat g1 r49 | '8/6 3/off' vs '8/5 2/off'
- match: move list | money4.mat g2 r43 | order differs (exact tie) from rank 2: 11/5 4/2 (-1) vs 11/3 (-1.0)
- match: move list | money4.sgf g1 r47 | order differs (exact tie) from rank 1: 10/8 6/5 3/2 (-1.1388888359069824) vs 10/7 4/3 (-1.1388888359069824)
- match: best move | money4.sgf g1 r47 | '10/8 6/5 3/2' vs '10/7 4/3'
- match: move list | money4.sgf g1 r49 | depth swap among tied moves: 8/5 4/2 (2-ply -1.1666666269302368 vs 0-ply -1.166674256324768), 8/3 (2-ply -1.1666666269302368 vs 0-ply -1.166674256324768), 8/6 4/1 (0-ply -1.166674256324768 vs 2-ply -1.1666666269302368), 8/6 5/2 (0-ply -1.166674256324768 vs 2-ply -1.1666666269302368)
- match: move list [tie depth swap] equity | money4.sgf g1 r49 8/5 4/2 equity | -1.1666666269302368 vs -1.166674256324768 (diff 7.63e-06)
- match: move list [tie depth swap] probs | money4.sgf g1 r49 8/5 4/2 probs/win | 1.1920928955078125e-07 vs 0.0 (diff 1.19e-07)
- match: move list [tie depth swap] probs | money4.sgf g1 r49 8/5 4/2 probs/loseGammon | 0.1666666716337204 vs 0.16667430102825165 (diff 7.63e-06)
- match: move list [tie depth swap] equity | money4.sgf g1 r49 8/3 equity | -1.1666666269302368 vs -1.166674256324768 (diff 7.63e-06)
- match: move list [tie depth swap] probs | money4.sgf g1 r49 8/3 probs/loseGammon | 0.1666666716337204 vs 0.16667430102825165 (diff 7.63e-06)
- match: move list [tie depth swap] equity | money4.sgf g1 r49 8/6 4/1 equity | -1.166674256324768 vs -1.1666666269302368 (diff 7.63e-06)
- match: move list [tie depth swap] probs | money4.sgf g1 r49 8/6 4/1 probs/loseGammon | 0.16667430102825165 vs 0.1666666716337204 (diff 7.63e-06)
- match: move list [tie depth swap] equity | money4.sgf g1 r49 8/6 5/2 equity | -1.166674256324768 vs -1.1666666269302368 (diff 7.63e-06)
- match: move list [tie depth swap] probs | money4.sgf g1 r49 8/6 5/2 probs/win | 0 vs 1.1920928955078125e-07 (diff 1.19e-07)
- match: move list [tie depth swap] probs | money4.sgf g1 r49 8/6 5/2 probs/loseGammon | 0.16667430102825165 vs 0.1666666716337204 (diff 7.63e-06)
- match: move list | money4.sgf g1 r49 | order differs (depth swap) from rank 1: 8/6 3/off (-0.9999998807907104) vs 8/5 2/off (-0.9999998807907104)
- match: best move | money4.sgf g1 r49 | '8/6 3/off' vs '8/5 2/off'
- match: move list | money4.sgf g2 r43 | order differs (exact tie) from rank 3: 11/5 4/2 (-1.9444419145584106) vs 11/5 6/4 (-1.9444419145584106)
- match: move list | selfplay-7pt.mat g1 r71 | order differs (exact tie) from rank 2: 12/4 11/7 5/1 (-1.1818338632583618) vs 12/8 11/3 6/2 (-1.1818338632583618)
- match: move list | selfplay-7pt.mat g1 r73 | order differs (exact tie) from rank 1: 8/4 5/off (-0.9999996423721313) vs 8/3 4/off (-0.9999996423721313)
- match: best move | selfplay-7pt.mat g1 r73 | '8/4 5/off' vs '8/3 4/off'
- match: move list | selfplay-7pt.mat g5 r72 | depth swap among tied moves: 19/16 5/3 (2-ply -1.1991455554962158 vs 0-ply -1.1991450786590576), 19/16 4/2 (0-ply -1.1991450786590576 vs 2-ply -1.1991455554962158)
- match: move list [tie depth swap] equity | selfplay-7pt.mat g5 r72 19/16 5/3 equity | -1.1991455554962158 vs -1.1991450786590576 (diff 4.77e-07)
- match: move list [tie depth swap] equity | selfplay-7pt.mat g5 r72 19/16 4/2 equity | -1.1991450786590576 vs -1.1991455554962158 (diff 4.77e-07)
- match: move list | selfplay-7pt.mat g5 r72 | order differs (depth swap) from rank 1: 23/18 (-1.0814127922058105) vs 23/20 19/17 (-1.0814127922058105)
- match: best move | selfplay-7pt.mat g5 r72 | '23/18' vs '23/20 19/17'
- match: move list | selfplay-7pt.sgf g1 r71 | order differs (exact tie) from rank 2: 12/4 11/7 5/1 (-1.1818338632583618) vs 12/8 11/3 6/2 (-1.1818338632583618)
- match: move list | selfplay-7pt.sgf g1 r73 | order differs (exact tie) from rank 1: 8/4 5/off (-0.9999996423721313) vs 8/3 4/off (-0.9999996423721313)
- match: best move | selfplay-7pt.sgf g1 r73 | '8/4 5/off' vs '8/3 4/off'
- match: move list | selfplay-7pt.sgf g5 r72 | depth swap among tied moves: 19/16 5/3 (2-ply -1.1991455554962158 vs 0-ply -1.1991450786590576), 19/16 4/2 (0-ply -1.1991450786590576 vs 2-ply -1.1991455554962158)
- match: move list [tie depth swap] equity | selfplay-7pt.sgf g5 r72 19/16 5/3 equity | -1.1991455554962158 vs -1.1991450786590576 (diff 4.77e-07)
- match: move list [tie depth swap] equity | selfplay-7pt.sgf g5 r72 19/16 4/2 equity | -1.1991450786590576 vs -1.1991455554962158 (diff 4.77e-07)
- match: move list | selfplay-7pt.sgf g5 r72 | order differs (depth swap) from rank 1: 23/18 (-1.0814127922058105) vs 23/20 19/17 (-1.0814127922058105)
- match: best move | selfplay-7pt.sgf g5 r72 | '23/18' vs '23/20 19/17'

**Not compared** (present in only one file): match: statistics (sums, counts): fibs-rating-difference; match: statistics (sums, counts): marked-rolls; match: statistics (sums, counts): ppg-advantage

