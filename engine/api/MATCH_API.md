# Match API (engine/api/gnubg_api_match.c)

Import, analyse and export matches with gnubg's own C functions. Same conventions as the
rest of the API (`api_util.h`): one JSON string in, one JSON string out with `"ok"`; floats
are printed with 17 significant digits (exact); the result buffer is reused by the next call.

There is one current match (gnubg's global `lMatch`). The usual sequence is:

```
set_analysis_settings → load_match → analyse_game(0..n-1) (or analyse_match) → get_analysis → export_match
```

## Functions and the gnubg code behind them

| Function | Request | gnubg functions |
|---|---|---|
| `gnubg_api_load_match` | `{"format":"sgf"\|"mat","text":"..."}` | text → MEMFS temp file → `CommandLoadMatch` ("load match") or `CommandImportMat` ("import mat") |
| `gnubg_api_match_info` | `{}` | same overview as `load_match` returns |
| `gnubg_api_clear_match` | `{}` | `FreeMatch`, `ClearMatch` (no match loaded afterwards) |
| `gnubg_api_set_analysis_settings` | settings object (below) | sets `esAnalysisChequer`, `esAnalysisCube`, `aamfAnalysis`, `ecLuck`, `arSkillLevel`, `arLuckLevel`, `fAnalyseMove/Cube/Dice`, `afAnalysePlayers` (what the `set analysis …` commands change) |
| `gnubg_api_analyse_game` | `{"game":i, "settings":{…}?}` | `ChangeGame(game i)` + `CommandAnalyseGame` ("analyse game") → `AnalyzeGame`/`AnalyzeMove` |
| `gnubg_api_analyse_match` | `{"settings":{…}?}` | `CommandAnalyseMatch` ("analyse match") |
| `gnubg_api_clear_analysis` | `{}` | `CommandAnalyseClearMatch` ("analyse clear match") |
| `gnubg_api_get_analysis` | `{"maxMoves":5, "game":i?, "text":false}` | `updateStatisticsMatch` (what "show statistics match" runs first), the move records, `FindCubeDecision`, `GetCubeRecommendation`, `getPercent`, `eq2mwc`, `getResignEquities`, `FormatMove`, `PositionID`, `MatchIDFromMatchState`, `getMWCFromError`, `GetRating`, `getLuckRating`, `relativeFibsRating`, `absoluteFibsRating*`, `DumpStatcontext` |
| `gnubg_api_export_match` | `{"format":"sgf"\|"mat"}` | `CommandSaveMatch` ("save match", SGF incl. analysis) / `CommandExportMatchMat` ("export match mat") → MEMFS temp file → text |

Notes:
- gnubg prints boards and messages while these commands run. The API captures stdout
  (discarded) and stderr; whatever gnubg wrote to stderr (parse errors, warnings) is returned
  as `"messages"`. No command can block on a prompt: the engine runs non-interactively, so
  gnubg's `GetInputYN` answers yes, and export deletes the temp file first so "overwrite?"
  never comes up.
- `analyse_game` for every game in order evaluates exactly the same positions in the same
  order as `analyse_match` (that only queues all games, then runs them in order). Results are
  bit-identical (checked by `tests/match_smoke.mjs`). The worker can report progress and
  cancel between games.
- Like gnubg, analysis does not overwrite a move that already has analysis at an equal or
  better setting (`cmp_evalsetup`). SGF files can contain analysis. Call `clear_analysis`
  first to force a fresh analysis.
- **Call history matters in the last float bits.** gnubg's evaluations depend slightly on what
  the engine evaluated earlier in the same process. Native gnubg does this too: analysing the
  same match twice in one native process changes ~3% of the stored values by about 1e-7. To
  reproduce desktop results bit for bit, use a fresh engine instance and the same sequence
  of calls as desktop.

## Settings object

All fields are optional. Anything left out keeps its current value. `{"defaults": true}`
starts from gnubg's built-in analysis defaults: chequer and cube at "supremo"
(2-ply, cubeful, prune), the "Large" move filter, 0-ply cubeful luck analysis, thresholds
doubtful 0.03 / bad 0.06 / very bad 0.12, lucky 0.3 / very lucky 0.6.

```
{
  "defaults": true,
  "chequer": "world class"                       // a gnubg preset name, or:
  "chequer": {"preset": "expert", "plies": 0, "cubeful": true, "prune": true,
              "deterministic": true, "noise": 0, "moveFilter": "large"},
  "moveFilter": "tiny|narrow|normal|large|huge"  // or a 4x4 array of {"accept","extra","threshold"}
  "cube":  {"preset": "...", "plies": 2, ...},
  "luck":  {"plies": 0, "cubeful": true, ...},   // ecLuck
  "thresholds": {"doubtful": 0.03, "bad": 0.06, "veryBad": 0.12,
                 "lucky": 0.3, "veryLucky": 0.6, "unlucky": 0.3, "veryUnlucky": 0.6},
  "analyse": {"moves": true, "cube": true, "luck": true, "players": [true, true]}
}
```

A chequer preset brings its own move filter (as in gnubg's settings dialog), unless
`moveFilter` is also given. Setting only `plies` keeps the current filter, like
`set analysis chequerplay evaluation plies N`. The response echoes the settings in effect:
`{"ok":true,"settings":{"chequer":{"eval":{plies,cubeful,prune,deterministic,noise,preset},
"moveFilterName","moveFilter"},"cube":{"eval"},"luck":{"eval"},"thresholds":{…},"analyse":{…}}}`.
`analyse_game` and `analyse_match` echo them too.

## load_match / match_info response

```
{"ok": true, "matchLength": 7,            // 0 = money session
 "players": ["Alice", "Bob"],             // player 0, player 1
 "crawfordRule": true, "jacoby": false, "cubeUse": true, "variation": 0,
 "games": [{"index": 0, "scoreBefore": [0, 0], "moves": 41, "records": 43,
            "crawfordGame": false, "winner": 0, "points": 1, "resigned": false}],
 "crawfordGame": 4,                        // index of the Crawford game, or null
 "messages": "..."}                        // only if gnubg printed errors/warnings
```
`moves` counts moves, doubles, takes and drops, as gnubg's loader does. `records` counts every
move record except the game header, so it is the right unit for progress.

## get_analysis response

```
{ok, matchLength, players, crawfordRule, jacoby, cubeUse, variation, crawfordGame,
 settings, errorRateFactor,               // 1000: gnubg shows rates in mEMG
 games: [{index, scoreBefore, crawfordGame, winner, points, resigned,
          records: [...], statistics: {...}, statisticsText?}],
 statistics: {...},                       // whole match
 statisticsText?}                         // exact "show statistics match" text (with "text": true)
```

### Records

Every record after the game header, in order. `index` counts from 0 within the game.

```
{index, type, player,                     // type: move|double|take|drop|resign|setboard|setdice|setcubevalue|setcubeposition
 positionId, matchId,                     // gnubg IDs of the position BEFORE this record
 cube, cubeOwner,                         // cube value / owner (-1 centred) before the record
 ...type-specific fields...,
 comment?}
```

The IDs describe the state gnubg's analysis uses for the record. The position is from the
point of view of the player to act. For chequer moves the match ID includes the dice. For a
take/drop it is the state after the double (the doubler is still "on roll" and the match ID
has the doubled flag set).

**move**: `dice`, `move` (gnubg's text, e.g. `"8/5 6/5"`), and
```
chequer: {analysed, eval, legalMoves, skill,      // skill: none|doubtful|bad|verybad (gnubg's marks)
          moves: [{rank, move, equity, diff, mwc?, probs:{win,winGammon,winBackgammon,loseGammon,loseBackgammon},
                   cubelessEquity, evalType, plies, cubeful}],
          playedIndex,                             // rank of the played move in gnubg's list
          error: {equity, mwc|points}}             // played − best (≤ 0)
luck: {equity, mwc|points, label} | null          // label: veryunlucky|unlucky|none|lucky|verylucky
cubeDecision: {...} | null                        // the cube decision before rolling, if gnubg analysed one
```
`moves` holds the top `maxMoves` alternatives (0 = all) plus the played move if it ranks
lower. `equity` is gnubg's `rScore`: cubeful when the evaluation is cubeful, normalised
(money equity; in match play the "EMG" equivalent). `mwc` (match play only) is `eq2mwc(equity)`.
`error` and luck use analysis.c's own formulas: `equity` in gnubg's native units, plus in match
play `mwc` = eq2mwc(x) − eq2mwc(0), and in money play `points` = x × cube value. These are the
numbers the statistics add up.

**double / take / drop**: `newCube` (double only), and `cubeDecision` (take and drop share
their double's evaluation, as in gnubg). If there is no cube analysis: `cubeDecision: null`
and `skill`.
```
cubeDecision: {eval,
  equities: {optimal, noDouble, doubleTake, doublePass},  // FindCubeDecision, normalised money equity (EMG)
  mwc: {...same keys...},                                 // match play only
  decision, proper,                                       // gnubg's cubedecision enum + text, e.g. "Double, take"
  percent,                                                // getPercent (or null)
  actual,                                                 // "no double" | "double" | "take" | "drop"
  error: {equity, mwc|points},                            // error of the actual action, as analysis.c computes it
  skill, close,                                           // gnubg's mark; isCloseCubedecision
  raw: {noDoubleProbs, noDoubleCubeless, noDoubleCubeful,
        doubleTakeProbs, doubleTakeCubeless, doubleTakeCubeful}}  // gnubg's stored evaluation
```
All cube values are from the point of view of the player with the cube decision (the doubler).
That also applies on take/drop records, as in gnubg.

**resign**: `resign: {resigned (1-3), type, analysed, eval?, probs?, equityBefore?, equityAfter?, resignSkill?, acceptSkill?}`.
**setdice**: `dice`, `luck`. **setboard**: `board`. **setcubevalue**: `value`. **setcubeposition**: `owner`.

### Statistics (per game and for the match)

These are the values gnubg's `show statistics` reports, computed with formatGS's own
expressions in single-precision floats. Each player entry looks like this:

```
{games, hasChequer, hasCube, hasLuck,
 players: [{
   chequer: {totalMoves, unforcedMoves, marked: {none, doubtful, bad, veryBad},
             errorTotal: {equity, mwc|points}, errorPerMove: {...}, rating, ratingIndex},
   luck:    {marked: {veryLucky, lucky, none, unlucky, veryUnlucky},
             total: {equity, mwc|points}, perMove: {...}, rating, ratingIndex},
   cube:    {total, close, doubles, takes, passes,
             missedDoubleBelowCP, missedDoubleAboveCP, wrongDoubleBelowDP, wrongDoubleAboveTG,
             wrongTake, wrongPass,               // each {count, equity, mwc|points}
             errorTotal, errorPerDecision, rating, ratingIndex},
   overall: {errorTotal, errorPerDecision, snowieErrorRate, rating, ratingIndex,
             actualResult, luckAdjustedResult, varianceActual, varianceLuckAdjusted,
             errorBasedFibsRating: {total, chequerLoss, cubeLoss},   // match play
             advantageActual/advantageLuckAdjusted: {ppg, ciLow, ciHigh}}  // money, >1 game
 }, {...}],
 luckBasedFibsRatingDiff}                 // match play, when gnubg shows it
```

- **Signs:** errors are stored as positive costs, as gnubg stores them. `show statistics`
  prints them negated. Luck is signed (positive means lucky).
- **Units:** `equity` is normalised (EMG) and `mwc` is a fraction (0.01 = 1%). gnubg shows per-move rates ×
  `errorRateFactor` (mEMG).
- `rating` is gnubg's text label ("World class", "Awful!", …). `ratingIndex` is gnubg's
  `ratingtype` (luck: `lucktype`). A label is null where gnubg prints "n/a".
- `ciLow`/`ciHigh` reproduce formatGS exactly, including its quirk of centring the interval
  on the total rather than on the per-game value.
- `statisticsText` is `DumpStatcontext`'s output, i.e. exactly what `show statistics match`
  (or `show statistics game` for a game) prints.

## export_match response

`{"ok":true, "format":"sgf"|"mat", "text":"..."}`. The SGF includes all analysis and the
statistics, as "save match" writes them.

## Comparison with native gnubg (Phase 2)

Native gnubg 1.08.003 (strict build, `-t -r -q`, fresh process per run) running `load match`
/ `import mat` → `analyse match` → `show statistics match` / `show statistics game` →
`gnubg.match(analysis=True, statistics=True)` → `save match` / `export match mat`, compared
with this API in a fresh Node process:

- Identical: every move-list equity and probability, luck value and label, chequer and cube
  skill mark, cube evaluation (ND/DT cubeful equities and probabilities), position ID, every
  statistics counter and sum, the text of `show statistics match` and of every `show
  statistics game`, and the `.mat` export.
- Expected differences:
  1. **Order of exactly tied moves.** gnubg sorts move lists with C `qsort`, and its
     comparator (`CompareMoves`) has no tie-break once equity and secondary score are equal.
     Different C libraries (macOS, glibc, Windows, Emscripten's musl) order such ties
     differently. This changes the rank shown and `playedIndex` for those moves, and their
     order in the SGF `A[...]` list. It never changes an equity, error, mark or statistic.
     Seen 0–2 times per match, in positions with no contact left.
  2. **`luckBasedFibsRatingDiff`** uses `log10f`. That function is not correctly rounded and
     can differ by one float step between C libraries. Seen once (‑150.63211 vs ‑150.63209).
     The 2-decimal text is identical.
