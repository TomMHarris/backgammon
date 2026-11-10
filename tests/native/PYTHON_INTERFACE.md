# gnubg's Python interface: what the native reference really computes

Notes for writing the WebAssembly side of the Phase 2 comparison so that it
produces *identical* numbers to native gnubg 1.08.003. Every statement cites
the gnubg source (paths relative to `engine/build/src/gnubg/`). Where I
checked something by running native gnubg, it says "(checked)".

Files in this directory:

| File | What it does |
|---|---|
| `dump_reference.py` | Runs inside gnubg. Evaluations, hints and cube decisions for every corpus position. |
| `dump_match_reference.py` | Runs inside gnubg. Loads a match, analyses it, dumps per-move analysis and match statistics. |
| `run_native.sh` | Runs both, writes `tests/reference/native-<variant>-<mode>.json`. |
| `sample/` | Tiny corpus + one 3-point match, used before the real corpus existed. |

Run: `tests/native/run_native.sh <strict|release> <fresh|single|single-clear>`.

---

## 1. Running Python inside gnubg

`HOME=$(mktemp -d) engine/native/build/strict/gnubg -t -r -q -P engine/data -p script.py`

- `-p` runs the script and exits. gnubg passes **no arguments** to it, so the
  scripts read environment variables (`CORPUS`, `OUT`, `MATCH`, ...).
- gnubg exits with status 0 even when the script raises an exception. The
  wrapper therefore checks that the output file was written.
- `gnubg.command("...")` runs any command as if typed (`gnubgmodule.c:949-983`).
  After the command it runs `NextTurn` while `fNextTurn` is set, so if a
  gnubg-controlled player is on roll it may move by itself. The scripts set
  both players to `human` to rule that out.
- `gnubg.show("x")` runs `show x` and returns the text (`gnubgmodule.c:985-1015`).
  **Bug:** it returns `""` for commands that print everything with a single
  `outputl()`, e.g. `show statistics match`. `outputl()` builds the buffer
  with `g_strconcat("", szMemOutput, szt, NULL)` (`output.c:107`), and when
  `szMemOutput` is still NULL that call stops at the NULL. `output()` handles
  NULL correctly, so commands that use `outputf` work (`show beavers` does).
  `dump_match_reference.py` captures stdout instead (fd redirection).
- `gnubg.setevalhintfilter(list)` cannot be used: it returns `NULL` without
  setting an exception **on success** (`if (!PyToMoveFilters(...)) return NULL;`,
  `gnubgmodule.c:499`; `PyToMoveFilters` returns 0 on success). Use
  `set evaluation movefilter <ply> <level> <accept> [<extra> <threshold>]`.
- The default player-1 name is the login name (`gnubg.c:4555`); `new match`
  resets names to `default_names` (`play.c:2885`). Use `set defaultnames`.

## 2. Setting a position and match ID

`gnubg.command("set gnubgid <PositionID>:<MatchID>")` or `gnubg.setgnubgid(...)`
(`gnubgmodule.c:1017`), both → `SetGNUbgID` (`set.c:4787`):

1. `SetMatchID(matchid)` (`play.c:4116`): decodes the match ID
   (`matchid.c:176-230`), starts a new one-game match, sets `ms.nMatchTo`,
   scores, cube value/owner, `fMove`, `fTurn`, dice, `gs`, Crawford.
   - **Jacoby comes from the match ID**: bit 66, stored inverted
     (`matchid.c:169`, `matchid.c:203-204`); the global `fJacoby` is only the
     starting value (`play.c:4137`).
   - **Beavers are not in the match ID.** They are the global `nBeavers`
     (`gnubg.c:231`, default **3**, `set beavers N`).
   - Crawford: `ms.fCrawford = fCrawford && oneAway`; a 1-point match forces
     it off (`play.c:4166-4185`).
   - A match ID with "doubled" set is stepped back to before the double
     (`play.c:4159-4164`).
2. `SetBoard(posid)` (`set.c:592`): adds a `MOVE_SETBOARD` record.

Both steps throw away gnubg's cached hint record (`pmr_hint`): `SetMatchID`
→ `PopGame` → `pmr_hint_destroy` (`play.c:504`), and `AddMoveRecord` of the
setboard record → `add_moverecord_get_cur` default branch (`play.c:592`).
This matters because `hint_move` reuses a stored move list if the current
record already has one (`gnubg.c:2350`, `if (pmr->esChequer.et == EVAL_NONE)`):
calling `gnubg.hint()` twice on one position with different settings returns
the **first** list again. `dump_reference.py` re-sends `set gnubgid` before
every query.

`gnubg.gnubgid()` (`gnubgmodule.c:1664`) returns the IDs of the current state;
the scripts record it after setting (checked: it reads back unchanged for all
43 corpus positions).

## 3. Board orientation

`gnubg.board()` returns `ms.anBoard` as `(board[0], board[1])`, two 25-tuples
(`BoardToPy`, `gnubgmodule.c:64-81`; `PythonBoard`, `:1083-1097`).

- **`board[1]` is the player on roll, `board[0]` the opponent**, whichever of
  player 0 / player 1 is on roll. (Checked: I put one checker on the bar in
  `board[1]` only; with either player on roll, `hint` returns `bar/...` moves,
  and `board()` returns the tuple unchanged.)
- Index `i` (0..23) is point `i+1` counted from that player's own home board;
  index 24 is the bar. Borne-off checkers are not stored.
- `gnubg.positionfromid(id)` returns the same layout (`gnubgmodule.c:1771`);
  `PositionID` writes `anBoard[0]` first, then `anBoard[1]` (`positionid.c`,
  `oldPositionKey`).
- All evaluation results are from the point of view of `board[1]`, the player
  on roll, with `cubeinfo["move"]` saying whether that is player 0 or 1 (it
  selects that player's score and gammon prices in match play).

## 4. cubeinfo

`gnubg.cubeinfo()` returns (`CubeInfoToPy`, `gnubgmodule.c:208-224`):

```
{"cube": int, "cubeowner": -1|0|1, "move": 0|1, "matchto": int, "score": (s0, s1),
 "crawford": 0|1, "jacoby": 0|1, "beavers": int,
 "gammonprice": ((gp[0], gp[2]), (gp[1], gp[3])), "bgv": int}
```

Note the gammonprice order: `((arGammonPrice[0], arGammonPrice[2]), (arGammonPrice[1], arGammonPrice[3]))`.

**Arguments** (`PythonCubeInfo`, `gnubgmodule.c:718-747`): all optional,
`cubeinfo(cube, cubeowner, move, matchto, (score0, score1), crawford, bgv)`;
missing ones default to the current match state `ms`. Jacoby and beavers can
**not** be passed: they are always `ms.fJacoby` and **`ms.cBeavers`**
(`:729-730`). Do not pass more than 7 arguments: the format string
`"|iiii(ii)iiii"` has two more `i` than there are pointers (`:736-737`).
The values go through `SetCubeInfo` (`eval.c:3318`):

- **Money** (`SetCubeInfoMoney`, `eval.c:3248-3268`): copies `fJacoby`,
  `fBeavers`; forces matchto, scores, Crawford to 0. Gammon prices are all
  `0.0` if Jacoby is on and the cube is centred, else all `1.0`.
- **Match** (`SetCubeInfoMatch`, `eval.c:3272-3314`): forces
  `fJacoby = fBeavers = FALSE`; gammon prices from the MET tables
  (post-Crawford table if one side is 1-away and it is not the Crawford game).

**Why `gnubg.cubeinfo()` reported `beavers: 0`.** It passes `ms.cBeavers`, the
number of beavers *already made in the current game* (`gnubg.c:170`, normally 0),
where desktop gnubg's eval/hint/analysis use `GetMatchStateCubeInfo`
(`gnubg.c:1328-1333`), which passes the **global `nBeavers` (default 3)**.
Effects of the mismatch:
1. Cube verdicts: `FindBestCubeDecision` only returns the beaver verdicts when
   `pci->fBeavers` is non-zero (`eval.c:3412`, `eval.c:3490`). Opening
   position, money: `beavers 0` → "No double, take" (2); `beavers 3` → "No
   double, beaver" (6), identical equities (checked).
2. The last bit of other results: `fBeavers` is part of the cubeful cache key
   (`eval.c:2335`), so it changes which cache entries collide (see NOTES.md).

**Rule used by the scripts:** after `set gnubgid`, take `gnubg.cubeinfo()` and,
in money play, set `ci["beavers"] = 3`. Because `SetCubeInfoMoney` only copies
the field, this is exactly `GetMatchStateCubeInfo`. In match play leave it 0
(SetCubeInfoMatch would force 0). The full dict is written into every query
result as `"cubeinfo"`.

When a dict is passed *in* (`PyToCubeInfo`, `gnubgmodule.c:227-320`), its keys
are copied raw into the C struct **without** calling `SetCubeInfo`: gammon
prices are taken as given, not recomputed. Unknown keys raise. To change
Jacoby and get consistent gammon prices, call `gnubg.calcgammonprice(ci)`
(`gnubgmodule.c:1196-1217`), which runs `SetCubeInfo` on the dict's own fields
and writes the prices back (used in `dump_match_reference.py`).

## 5. evalcontext

`gnubg.evalcontext(cubeful, plies, deterministic, prune, noise)`
(`gnubgmodule.c:928-947`), positional, in that order; omitted ones default
to the current `eval`/`hint` chequer settings `GetEvalChequer()->ec`. So
`gnubg.evalcontext()` with no arguments shows the settings `hint` uses.
Returns `{"cubeful", "plies", "deterministic", "prune", "noise"}`
(`EvalContextToPy`, `:623-630`). Plies are capped at 7; flags become 0/1.

Presets (`eval.c:315-325`, move filters `eval.c:328-338`, `movefilters.inc`):

| preset | cubeful | plies | deterministic | prune | noise | move filter |
|---|---|---|---|---|---|---|
| expert | 1 | 0 | **0** | 1 | 0 | none |
| world class | 1 | 2 | 1 | 1 | 0 | Normal |
| supremo | 1 | 2 | 1 | 1 | 0 | Large |
| gnubg default eval/hint (`gnubg.c:350, 458-463`) | 1 | 2 | 1 | 1 | 0 | Normal |
| gnubg default analysis (`gnubg.c:405, 460-464`) | 1 | 2 | 1 | 1 | 0 | Large |
| luck analysis `ecLuck` (`analysis.c:96`) | 1 | 0 | 0 | 1 | 0 | n/a |

`deterministic` has no effect when noise is 0: it is ignored by
`cmp_evalcontext` (only compared when noise > 0, `eval.c:4326-4333`) and is not part of the cache key
(`EvalKey`, `eval.c:2299-2340`).

Move filter Normal, as `(accept, extra, threshold)` per (ply, level): ply 1:
L0 (0, 8, 0.16); ply 2: L0 (0, 8, 0.16), L1 skip; ply 3: L0 (0, 8, 0.16),
L1 skip, L2 (0, 2, 0.04); ply 4: as ply 3 plus L3 skip. Large: 16/0.32 and
4/0.08 instead of 8/0.16 and 2/0.04. A 2-ply search uses row `aamf[1]`
(`eval.c:5755-5756`). `gnubg.getevalhintfilter()` shows the current filter.

## 6. What each call returns

Probability order everywhere (`eval.h:46-50`): `win, winGammon,
winBackgammon, loseGammon, loseBackgammon`, cumulative (winGammon includes
backgammons), for the player the result is "for".

### gnubg.evaluate(board, cubeinfo, evalcontext) (`gnubgmodule.c:1219-1271`)

Calls `GeneralEvaluationE` (`eval.c:5922`) for the player on roll **before
rolling**. Returns a 6-tuple: the 5 probabilities and `arOutput[5]` =
`UtilityME` (`eval.c:2480-2496`), the **cubeless** equity:
- money: `2·win − 1 + (wg − lg) + (wbg − lbg)`: gammons always count, even
  with Jacoby (UtilityME ignores the gammon price), per unit cube;
- match: `Utility` with the score's gammon prices (`eval.c:2446-2473`),
  i.e. cubeless normalised ("EMG") equity.

**The cubeful equity is not returned**: `GeneralEvaluationE` fills 7 outputs,
the loop copies `k < 6` (`gnubgmodule.c:1264-1268`). For a cubeful context,
`arOutput[6]` would be normalised money equity (money) or **MWC** (match:
`eval.c:6073-6076`). With `cubeful=1` the *probabilities* still differ from a
cubeless search at ≥ 2 ply, because each look-ahead move is chosen by cubeful
equity (NOTES.md).

Arguments are all optional and default to `ms` and `GetEvalChequer()->ec`;
passing `None` is an error, so pass the board explicitly when passing a
context.

### gnubg.cfevaluate(board, cubeinfo, evalcontext) (`gnubgmodule.c:1273-1333`)

Calls `GeneralCubeDecisionE` (`eval.c:5877-5918`) then `FindCubeDecision`
(`eval.c:3513-3530`). Default context: `GetEvalCube()->ec`. Returns
`(optimal, noDouble, doubleTake, doublePass, decision, text)`:
- equities for the player on roll, **normalised to the current cube**:
  money: ND = cubeful equity, DT = 2 × cubeful equity with the cube doubled
  (`eval.c:5900-5901`), DP = `1.0` (`GetDPEq`, `eval.c:3554-3572`);
  match: the MWCs are converted with `mwc2eq` (`eval.c:3521-3527`) to
  normalised money equity ("EMG"); DP = `mwc2eq(getME(win nCube points))`,
  which need not be exactly `1.0` (checked: `1.0000001192092896` occurs).
- `decision`: the `cubedecision` enum (`eval.h:194-216`): 0 DOUBLE_TAKE,
  1 DOUBLE_PASS, 2 NODOUBLE_TAKE, 3 TOOGOOD_TAKE, 4 TOOGOOD_PASS,
  5 DOUBLE_BEAVER, 6 NODOUBLE_BEAVER, 7 REDOUBLE_TAKE, 8 REDOUBLE_PASS,
  9 NO_REDOUBLE_TAKE, 10 TOOGOODRE_TAKE, 11 TOOGOODRE_PASS,
  12 NO_REDOUBLE_BEAVER, 13 NODOUBLE_DEADCUBE, 14 NO_REDOUBLE_DEADCUBE,
  15 NOT_AVAILABLE, 16 OPTIONAL_DOUBLE_TAKE, 17 OPTIONAL_REDOUBLE_TAKE,
  18 OPTIONAL_DOUBLE_BEAVER, 19 OPTIONAL_DOUBLE_PASS, 20 OPTIONAL_REDOUBLE_PASS.
- `text`: `GetCubeRecommendation(decision)` (`eval.c:3128-3177`).
- `optimal` is set by `FindBestCubeDecision` (`eval.c:3356-3490`): DT if
  `DT >= ND and DP >= ND and DP > DT`; DP if `DT >= ND and DP >= ND and
  DP <= DT`; ND otherwise, and ND when the cube is not available.

Not returned: the probabilities and cubeless equities of the cube search
(`aarOutput[0][0..5]`), and the raw MWCs. `dump_reference.py` adds, for the
wasm `gnubg_api_analyse_cube` fields:
- `mwc` (match only): `gnubg.eq2mwc(x, ci)` for each equity, i.e. C `eq2mwc`
  on the float32 value (`gnubgmodule.c:1582`, `eval.c:2536`), the same
  expression the wasm API uses.
- `percent`: `getPercent` (`eval.c:4952-5004`) recomputed in float32
  (`f32()`; a single IEEE operation on two float32s computed in double and
  rounded once is exactly the float32 result). `null` where gnubg returns −1.
- `cubeAvailable`: `decision not in {13, 14, 15}`; `FindBestCubeDecision`
  returns exactly those when `GetDPEq` is false (`eval.c:3382-3394`).
- `noDouble`: `null` (not obtainable at full precision from Python; see Open
  questions).

Desktop's `eval` command prints the cube-search numbers: `DumpPosition`
calls `GeneralCubeDecisionE` per ply (`format.c:1189-1196`), so desktop's
"Cubeful" column is the cube search's ND, not `GeneralEvaluationE`.

### gnubg.hint([n]) (`gnubgmodule.c:853-911`)

Only for chequer play (raises for cube, take and resignation decisions,
`:872-884`). Calls `hint_move(sz, FALSE, &prochint)` (`gnubg.c:2328-2438`),
the function behind the desktop `hint` command:

1. cubeinfo = `GetMatchStateCubeInfo` (i.e. `nBeavers`, `gnubg.c:2344`);
2. `FindnSaveBestMoves(dice, board, keyMove=NULL, rThr=arSkillLevel[SKILL_DOUBTFUL]=0.03, ci, GetEvalChequer()->ec, GetEvalMoveFilter())`
   (`gnubg.c:2350-2368`, `eval.c:5719-5873`). `rThr` only matters with a key
   move; for a freshly set position the record has no move
   (`NewMoveRecord`: `anMove[0] = -1`, `play.c:169`), so the second
   key-move search (`gnubg.c:2374-2391`) does not run.
3. `RefreshMoveList` (`gnubg.c:2398-2402`, `eval.c:5026`) sorts with
   `CompareMovesGeneral` (`eval.c:2819-2867`):
   1. moves evaluated with the "better" eval setup first (`cmp_evalsetup`/
      `cmp_evalcontext`, higher ply first), so all moves evaluated at the top
      ply come before the ones the filter dropped at a lower ply;
   2. a move that bears off the last checker before anything else;
   3. higher `rScore`, then higher `rScore2` (cubeless) (`CompareMoves`, `eval.c:2811`);
   4. exact ties: more checkers borne off first, then the lower "back"
      checker first.

**The move filter** (`eval.c:5758-5798`): at each level `iPly` the moves are
scored at that ply, sorted by `CompareMoves`, and the list is cut to
`max(accept, …)` + up to `extra` more whose score is within `threshold` of
the best. If only one move survives, the search stops ("no need to
continue", `eval.c:5794-5796`), so all moves keep their 0-ply evaluation even at
"world class" (checked: opening 3-1, money: every move reports `plies: 0`).
Moves cut by the filter keep their lower-ply evaluation and appear after
the top-ply ones.

Each list entry (`PythonHint_Callback`, `gnubgmodule.c:789-851`):
```
{"movenum": i+1, "type": "eval", "move": "8/5 6/5",
 "equity": rScore, "eqdiff": rScore - rScore_of_first (float32 subtraction),
 "context": {evalcontext the move was scored with; "plies" = plies actually used},
 "details": {"probs": (5 probs), "score": rScore}}
```
`ScoreMove` (`eval.c:5559-5594`) evaluates the position after the move from
the opponent's side and inverts it (`InvertEvaluationR`, `eval.c:2398`), so
probabilities and equity are **for the player making the move**. `rScore` is
the cubeful equity if `cubeful` (money: normalised to the current cube;
match: MWC converted with `mwc2eq`, i.e. EMG, `eval.c:5576-5577`), else the
cubeless `UtilityME`. Not returned: `rScore2` and `arEvalMove[5..6]`.
Whole result: `{"hinttype": "chequer", "gnubgid": ..., "hint": [...]}`.
`gnubg.hint()` without an argument returns **all** moves (`nMaxMoves` =
`MAX_MOVES`); the desktop text command shows 10 by default (`gnubg.c:2333`).

### gnubg.findbestmove(board, cubeinfo, evalcontext, dice, filters) (`gnubgmodule.c:1335-1420`)

`FindnSaveBestMoves` with `rThr = 0`, `keyMove = NULL`, then
`RefreshMoveList` (`asyncFindBestMoves`, `gnubg.c:5551-5558`). Returns only
the first move as a flat tuple of 1-based points, e.g. `(8, 5, 6, 5)`.
Defaults: `ms` board, `GetMatchStateCubeInfo`, `GetEvalChequer()->ec`,
`ms.anDice`, `GetEvalMoveFilter()`. Not used by the harness.

### gnubg.match(analysis=1, boards=1, statistics=0, verbose=0) (`gnubgmodule.c:2889-3061`)

```
{"match-info": {"X": {"name", "rating"?}, "O": {...}, "match-length", "date"?,
                "event"?, ..., "result": -1|0|1, "variation", "rules"?: ("NoCube"|"Crawford"|"Jacoby", ...),
                "default-eval-context"?},
 "games": ({"info": {"score-X", "score-O", "crawford"? (only if a side is 1-away),
                     "winner": "X"|"O"|None, "points-won", "resigned", "initial-cube"?},
            "stats"?: per-game statistics (statistics=1),
            "game": (record, ...)}, ...),
 "stats"?: match statistics (statistics=1)}
```
"X" is player 0, "O" is player 1. `match-info.rules` comes from the **first
game's** `g.fJacoby`/`g.fCrawford`/`g.fCubeUse` (`:2980-2998`).

Records (`PythonGame`, `:2585-2877`): `{"action": "move"|"double"|"take"|"drop"|"resign"|"set",
"player": "X"|"O", "dice", "move": ((from, to), ...) 1-based, "board": PositionID
before the record from the mover's side (boards=1; `:2689-2694`), "analysis"?, "comment"?}`.

`analysis` for a `move` record:
- `"moves"`: one dict per evaluated move (`PyMoveAnalysis`, `:2208-2305`):
  `{"type": "eval", "move": tuple, "probs": 5, "score": rScore, "evalcontext"?}`
  (`evalcontext` only where it differs from the match default). Order is
  the stored list: `FindnSaveBestMoves`' `CompareMoves` order with the played
  move moved up among the top-ply moves (`eval.c:5825-5868`), **not**
  `RefreshMoveList`.
- `"imove"`: index of the played move in that list.
- cube analysis (if the cube was available and it is not the opening move,
  `analysis.c:661`), from `PyDoubleAnalysis` (`:2307-2380`): `"type"`,
  `"probs"` (cube search, cubeless probabilities), `"nd-cubeful-eq"`,
  `"dt-cubeful-eq"` = the **raw stored** `aarOutput[0|1][6]`: money:
  normalised cubeful equity (DT already ×2); match: **MWC**. With verbose=1:
  `"nd-match-eq"`, `"dt-match-eq"` = `aarOutput[0|1][5]` = cubeless
  `UtilityME` (despite the name, not MWC).
- `"luck-value"`: `rLuck` (normalised equity, EMG in match; for the player
  who rolled), `"luck"`: `"verybad"|"bad"|"good"|"verygood"` (absent if unmarked).
- `"skill"`: chequer play `"very bad"|"bad"|"doubtful"` (absent = unmarked);
  `"cube-skill"`: same for the (no-)double decision.

`double` records carry the cube analysis and `"skill"` (of the double);
`take`/`drop` records only `"skill"`. Not included anywhere: the ND/DT/DP
equities after `FindCubeDecision`, the optimal action, and per-record error
sizes. `dump_match_reference.py` derives them (section 8).

Statistics (`PyGameStats`, `:2382-2577`), per side `"X"`/`"O"`, are the raw
`statcontext` sums (float32, full precision):
- `"moves"`: `unforced-moves`, `total-moves`, `error-skill` (=
  `arErrorCheckerplay[side][0]`, **total**, normalised, positive = error),
  `error-cost` (`[1]`, total, MWC in match / points in money), `marked`.
- `"cube"`: counts and the six `err-*-skill/-cost` totals, plus `error-skill`
  / `error-cost` = **per close decision** (`getMWCFromError`, PERMOVE).
- `"dice"`: `luck`, `luck-cost` (totals), `actual-result`,
  `luck-adjusted-result`, `fibs-rating-difference` (match),
  `marked-rolls` — **bug: uses player 0's counts for both sides**
  (`sc->anLuck[0][lt]`, `:2496`).
- `"ppg-advantage"` (money, more than one game), `"error-based-fibs-rating"`
  (match: `total`, `chequer`, `cube`).

`gnubg.match(statistics=1)` computes the match statistics exactly the way
`show statistics match` does: `updateStatisticsGame` per game, then
`AddStatcontext` in game order (`:2630-2634` vs. `updateStatisticsMatch`,
`analysis.c:1742-1763`). It does **not** include the derived per-move rates
and ratings `show statistics match` prints (chequer error per unforced move,
overall/combined totals and rates, Snowie rate, luck rate, rating words).

## 7. Units and perspective summary

| value | money | match |
|---|---|---|
| `evaluate()[5]`, hint `equity` when cubeless | UtilityME (gammons count fully), per unit cube | cubeless EMG (`Utility`) |
| hint `equity` when cubeful, match `moves[].score` | cubeful equity, normalised to the current cube | MWC → EMG via `mwc2eq` |
| `cfevaluate` ND/DT/DP/optimal | normalised to current cube; DP = 1 | EMG via `mwc2eq` |
| match `nd/dt-cubeful-eq` (stored) | normalised; DT ×2 | **MWC** (raw) |
| `luck-value`, error "skill" sums | normalised equity | EMG |
| error/luck "cost" sums | `nCube × skill` (points) | `eq2mwc(skill) − eq2mwc(0)` (MWC, fraction) |

Perspective: evaluate/cfevaluate: player on roll (`board[1]`, `ci.move`);
hint/match moves: the player moving; luck: the player who rolled; statistics:
per player X (0) / O (1). Normalised money equity is per 1-cube times the
current cube factor, i.e. "per cube unit"; desktop prints it with 3 decimals
by default (`fOutputDigits`) and match statistics as mEMG (×1000) and MWC %.

## 8. Match analysis: settings and derived values

`dump_match_reference.py` sets everything explicitly (`set analysis ...`,
`set.c:3269-3340`, luck `set.c:356`): chequer and cube 2-ply cubeful,
prune, noise 0, move filter Normal ("world class") or Large ("supremo",
gnubg's built-in default), luck analysis 0-ply as `ecLuck`; moves, cube and
luck analysis on (`gnubg.c:186-188`); thresholds left at the defaults
(`arSkillLevel` doubtful 0.03 / bad 0.06 / very bad 0.12; `arLuckLevel`
0.3 / 0.6, `gnubg.c:276-287`; `Skill`, `Luck`, `analysis.c:279-308`).
After loading it runs `analyse clear match`, so analysis stored in an
`.sgf` is never reused (`AnalyzeMove` only recomputes when the new setup is
"better", `analysis.c:664`, `analysis.c:703`).

Derived per record (all float32, reproducing gnubg):
- `equityLoss` = `moves[imove].score − moves[0].score` (`analysis.c:733`).
- cube: the record's cubeinfo is rebuilt from the game info and the
  double/take records (cube value, owner, mover, score, Crawford, Jacoby from
  `match-info.rules`, beavers 3 in money), with `gnubg.calcgammonprice`.
  Then `FindCubeDecision`: ND/DT from the stored values (match: through
  `gnubg.mwc2eq`), DP = 1 (money) or `mwc2eq(getME(...))` with `getME`
  reimplemented as table lookups on `gnubg.met(n)` (`matchequity.c getME`).
  `actionError` as in `updateStatcontext` (`updateStatcontext`, `analysis.c:321-607`): no double:
  `ND − optimal`; double: `min(DT, DP) − optimal`; take: `DP − DT` if
  `DT > DP`; drop: `DT − DP` if `DP > DT` (0 = correct).
- `*Cost` = `eq2mwc(x) − eq2mwc(0)` (match) or `cube × x` (money).
- **Check:** `statistics.crossCheck` re-adds the per-record chequer errors,
  cube errors and luck per game in float32 and then across games, and
  compares with gnubg's own sums. They agree exactly for all six corpus
  matches and the sample (checked), so the derived per-record values are the
  ones gnubg's statistics are built from.
- `statistics.derived`: the values `show statistics match` prints, from the
  raw sums with `getMWCFromError` (`analysis.c:1434-1480`) and `formatGS`
  (`formatgs.c:133-560`) formulas in float32: chequer total/per unforced
  move, cube total (sum of the six, in gnubg's order)/per close decision,
  overall total/per decision, Snowie rate (overall total ÷ both players'
  total moves), luck total/per move, actual and luck-adjusted result,
  ratings as `gnubg.errorrating()` / `gnubg.luckrating()` indexes. Stored
  sign (errors positive); gnubg prints them negated.
- `statistics.showStatisticsMatchText` (+ `...Parsed`): the exact text,
  columns `"%-40s %-23s %-23s"` (`analysis.c:1480`). Precision of the text:
  totals 3 decimals (EMG) and 3 decimals of a percent (MWC); rates 1 decimal
  of mEMG; results 2 decimals of a percent; FIBS ratings 1–2 decimals.
- `luckLabelCountsFromRecords`: correct per-player luck label counts (to work
  around the `marked-rolls` bug).
- `.mat` money sessions: the `.mat` format has no Jacoby flag; `import mat`
  sets each money game's Jacoby to the **global** `fJacoby` (`import.c:962`),
  default on. So `money4.mat` is analysed with Jacoby on and `money4.sgf`
  (Jacoby off in the file) without: their analyses differ. Set `JACOBY=off`
  to analyse the .mat the way the .sgf says.

## 9. History dependence (important for the wasm comparison)

Results depend on what was evaluated before **in the same process**, and
not only in the last bit:

1. **Cube efficiency is not in the cache key.** At a cubeful leaf the cube
   efficiency is `EvalEfficiency(board, class, pec->nPlies)` (`eval.c:6145`),
   which uses one constant for a top-level search of ≥ 2 plies and another
   below (`eval.c:4047`, e.g. `rContactX = {0.68, 0.76}`, `eval.c:374`). The
   cubeful cache key uses the *remaining* plies `nPlies`, not `pec->nPlies`
   (`eval.c:6314`, `EvalKey` `eval.c:2299`). So a 0-ply cubeful value cached
   during an "expert" hint is reused inside a later "world class" search, and
   vice versa. Checked: opening 3-1 money, world-class hint top move
   `0.20106463` in a fresh process, `0.21260865` after an expert hint;
   corpus position `contact-02`, 2-ply cubeful evaluate: cubeless equity
   `0.0421411` fresh, `0.0365032` after a 1-ply cubeful evaluate. Over the
   corpus, single-process vs fresh differs by up to 0.06 in hint equities and
   reorders hint lists; match analysis of a file after another file in the
   same process differs by up to 0.005.
2. The 1-ulp effects from cache evictions and incremental NN evaluation
   (NOTES.md, beavers).

`gnubg clear cache` (`CommandClearCache` → `EvalCacheFlush`, `eval.c:3180-3189`)
removes both: with a flush before every query, one process reproduces the
fresh-process results **bit for bit for all 344 corpus queries** (checked,
strict and release). Hence three modes in `run_native.sh`:

| mode | how | use |
|---|---|---|
| `fresh` | one gnubg process per query and per match file | primary reference |
| `single-clear` | one process, `clear cache` before each query/match | identical to `fresh` (checked), fast |
| `single` | one process, fixed order, no flushing | only for a wasm runner replaying the exact same order |

The fixed order is in `dump_reference.py` and in each output as
`queryOrder`. If the wasm API flushes the evaluation cache (`EvalCacheFlush`)
at the start of each call, it should match `fresh`.

## 10. Output schema (tests/reference/native-<variant>-<mode>.json)

```
{"variant", "mode",
 "positionsReference": {
   "generator", "variant", "mode", "corpus", "clearCacheBeforeEachQuery", "settings",
   "queryOrder": [[positionId, query], ...], "positions": [corpus entries],
   "results": [{"queryIndex", "positionIndex", "positionKey", "query", "result"}]},
 "matchesReference": [per match file, below]}
```
`query` is one of `eval-{0,1,2}ply-{cubeless,cubeful}`, `hint-expert`,
`hint-worldclass` (move positions), `cube-0ply`, `cube-2ply` (cube positions).
Every `result` has `call`, `cubeinfo` (dict passed to gnubg) and `state`
(`gnubgIdIn`, `gnubgIdAfterSet`, `board`, `cubeinfo`, `posinfo`), plus:
- eval: `evalContext`, `probs` {win, winGammon, winBackgammon, loseGammon,
  loseBackgammon}, `cubelessEquity`, `cubefulEquity: null`.
- hint: `preset`, `settingsInEffect` {evalContext, moveFilter, threshold},
  `gnubgId`, `moves`: [{move, equity, diff, probs, plies, cubeful, evalContext}]
  in gnubg's order.
- cube: `evalContext`, `equities` {optimal, noDouble, doubleTake, doublePass},
  `mwc` (match only), `decision`, `recommendation`, `percent`,
  `cubeAvailable`, `noDouble: null`.

Match entry: `{"file", "format", "matchInfo", "settings", "games": [{"info",
"statistics", "records": [{"index", "action", "player", "dice"?, "board"?,
"cubeinfo"?, "move"? (text), "analysis"?: {"moves": [{move, equity, probs,
evalContext}], "playedIndex", "bestMove", "equityLoss", "equityLossCost",
"skill"?, "cube-skill"?, "luck"?, "luck-value"?, "luckCost"?, "cube"?:
{"stored": {type, probs, nd-cubeful-eq, dt-cubeful-eq, nd-match-eq,
dt-match-eq, eval-context}, "derived": {noDouble, doubleTake, doublePass,
optimal}, "actionError", "actionErrorCost"}}}]}], "statistics": {"raw",
"derived", "luckLabelCountsFromRecords", "crossCheck",
"showStatisticsMatchText", "showStatisticsMatchParsed"}}`.

All floats are float32 values written with Python `repr`, which round-trips.

## 11. Open questions

1. **Cubeful equity of `evaluate`.** The Python interface cannot return
   `GeneralEvaluationE`'s cubeful equity (`arOutput[6]`), which the wasm
   `gnubg_api_evaluate` reports as `cubefulEquity`. Comparable full-precision
   native numbers: the probabilities and cubeless equity of the same call, and
   the cube search's ND equity (`cfevaluate`, = desktop `eval`'s "Cubeful"
   column). Whether `GeneralEvaluationE` and `GeneralCubeDecisionE` give the
   same ND equity bit for bit is not established (different `cci`/`fTop`
   paths in `EvaluatePositionCubeful3`).
2. **Cube-search probabilities** (`analyse_cube` `noDouble.probs`) are not
   available from Python for an arbitrary position. They are available, raw,
   for every analysed move record of a match (`analysis.cube.stored.probs`).
3. Match analysis move-list order: the stored order (section 6) is what
   Python returns; whether the desktop GUI re-sorts it with `RefreshMoveList`
   for display was not checked (GTK code not built).
4. Beaver sequences (`DT_BEAVER`, raccoons) are not analysed by gnubg
   (`analysis.c:754`, `:805`, `:825`); the derived take/drop error assumes a plain
   double. No corpus match contains a beaver.
5. Strict vs release differences in match analysis are large in rare
   positions (corpus positions: at most ~7e-6; see below): with Jacoby on and
   a centred cube in money play every candidate's cubeful equity can be
   exactly the same (the cash value), so the 2-ply look-ahead picks moves by
   float-noise-level differences. Example `tbsHAQA5AAAAAA`, money, Jacoby,
   2-ply cubeful: winGammon `0.3158821` (strict) vs `0.2799508` (release);
   cubeless and Jacoby-off agree. I did not trace which comparison flips.
