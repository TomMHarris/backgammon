# gnubg-web: Build Plan

Status: **Phase 1 done** (engine builds and runs). Plan approved 2026-11-10.
Decisions taken since: glib Plan A (current glib 2.90.1) worked; Emscripten 7.0.0 pinned.
See NOTES.md for what was learned in each phase.
Everything below comes from reading the sources listed in "What I read". Items
marked **(to verify)** are things I expect but haven't confirmed yet.

---

## 1. What I read

| Source | What it is | Key facts |
|---|---|---|
| `ftp.gnu.org/gnu/gnubg/` | Official GNU release area | Latest source release is **gnubg 1.08.003** (`gnubg-release-1.08.003-sources.tar.gz`, April 2024). I checked its GPG signature against the GNU keyring: good signature from Philippe Michel (gnubg maintainer). SHA-256 `6f7d969b…c445979`. |
| `git.savannah.gnu.org/git/gnubg.git` | Official git repository | Newest release tag is `release-1_08_003`, the same version as the tarball. |
| `github.com/hwatheod/gnubg-web` | Theodore Hwa's Emscripten port | Updated **1 Sep 2026** to build with **Emscripten 6.0.8** (its README no longer says 2.0.23). Still based on **gnubg 1.05.000** and **glib 2.62.0**. |
| emsdk tags | Emscripten SDK releases | Latest is **7.0.0**, released 6 Nov 2026 (four days ago). The 6.0.x line ends at 6.0.13. |
| GNOME release index | glib releases | Latest stable glib is 2.90.x. gnubg 1.08.003 only requires glib ≥ 2.22. |

### What Hwa's port does, and what we take from it
- **Builds with a single `emcc` command.** It compiles every `.c` file in `gnubg/`, `gnubg/lib/`
  and a trimmed glib 2.62 tree (unneeded glib files renamed to `*.c_do_not_compile`),
  with `-DWEB` and one hand-written `config.h` that merges gnubg's and glib's configuration.
- **Excludes** (moved to `removed_files/`): all `gtk*.c`, `gnubgstock.c`, `gnubgmodule.c`
  (Python), `external*.c` (socket play), `openurl.c`, `glib-ext.c`, and the standalone
  tools `makebearoff.c`, `makehyper.c`, `makeweights.c`, `bearoffdump.c`.
- **Source changes** are small `#ifdef WEB` blocks in `gnubg.c`, `play.c`, `set.c`,
  `show.c` and `matchequity.c`. Most of them wire up his text console UI. We won't need those.
- **Workarounds he needed.** These are the warning signs for us:
  1. glib's GSlice allocator forced to plain `malloc` (an alignment assertion failed under Emscripten 6.0.8).
  2. `g_markup_parse_context_free` skipped in `matchequity.c` because it crashed. That is the XML parser used to load match equity tables.
  3. A `sed` edit of the generated JavaScript, because Emscripten's `getpwuid` stub throws.
- **Data files**: ships `gnubg.wd`, `gnubg_os0.bd` and `met/`. It **does not ship
  `gnubg_ts0.bd`** (the two-sided bearoff database, 6.8 MB). This matters: desktop gnubg loads
  that file when it is present (`eval.c:654`), so without it bearoff positions would be
  evaluated differently from desktop.
- **Interface**: drives gnubg through its text command line (`run_command`). We are not doing that.

### Why we use gnubg 1.08.003 rather than Hwa's 1.05 tree
The engine and analysis code changed a lot between 1.05 and 1.08. Comparing his files with
1.08.003, ignoring whitespace, about 285 lines differ in `analysis.c`, 230 in `sgf.c`, 216 in
`export.c`, 187 in `rollout.c` and 125 in `bearoff.c`. 1.08 also switched the RNG to SFMT
(`lib/SFMT.c`). Desktop gnubg today is 1.08.x, so matching it means building 1.08.003. We take
Hwa's *method* (which files to drop, how glib was handled) but not his source tree.

---

## 2. Repository layout

```
backgammon/
├── PLAN.md, NOTES.md, README.md, LICENSE (GPL v3)
├── engine/
│   ├── build.sh             # one reproducible build: fetch → verify → patch → compile
│   ├── versions.env         # pinned versions + SHA-256 of every downloaded tarball
│   ├── patches/             # our (small, reviewable) changes to gnubg, as .patch files
│   ├── config/              # hand-written config.h for the wasm build
│   ├── api/                 # our C API layer (gnubg_api.c) + cJSON
│   ├── data/                # generated gnubg.wd, gnubg_os0.bd, gnubg_ts0.bd, met/ (committed)
│   ├── native/              # script to build the native reference gnubg
│   └── dist/                # build output: gnubg.mjs + gnubg.wasm (committed)
├── tests/                   # Node smoke test, Python comparison suite, test positions
└── web/                     # Next.js + TypeScript app (Phases 3–6)
```

`build.sh` downloads the pinned gnubg and glib tarballs, checks their SHA-256 and unpacks them
into `engine/build/` (gitignored). It then applies `patches/` and compiles. The upstream source is
not committed. Only our patches are, so every change we make to gnubg can be seen in one place.

The built `.wasm` and data files **are** committed. Vercel then only has to run `next build` and
never needs Emscripten installed.

---

## 3. Toolchain and Emscripten version

- emsdk is installed **inside the repo** (`engine/.emsdk/`, gitignored) by `build.sh`, at the
  version pinned in `versions.env`. Nothing is installed globally.
- **Order of attempts:** 7.0.0 (current) → 6.0.13 (last 6.x) → 6.0.8 (Hwa's tested version) →
  2.0.23 (last resort). The first one that builds *and* passes the Phase 2 comparison gets pinned.
  7.0.0 is only four days old, so if it breaks for reasons that have nothing to do with us, I'll
  move to 6.0.13 rather than work around it.
- Build output: `MODULARIZE=1`, `EXPORT_ES6=1`, `ENVIRONMENT=web,worker,node`. The same
  `gnubg.mjs`/`gnubg.wasm` pair then runs in Node (tests) and in the browser's Web Worker.
  `ALLOW_MEMORY_GROWTH=1`, because the bearoff DBs and evaluation cache need tens of MB.
- Native tools (from Homebrew, for the native reference build): `glib`, `pkg-config`, and a
  Python 3 with headers. The tarball ships a pre-generated `configure`, `sgf_l.c` and `sgf_y.c`,
  so autotools, flex and bison are **not** needed.

---

## 4. Which gnubg files we compile

The starting list follows Hwa's choices, mapped onto 1.08.003. The final list will be recorded
in NOTES.md during Phase 1.

**Compile** (with GTK, Python, sqlite, curl, cairo, libpng, GMP and sound all *disabled* in `config.h`):
- Engine core: `eval.c`, `evallock.c`, `bearoff.c`, `bearoffgammon.c`, `positionid.c`,
  `matchid.c`, `matchequity.c`, `mec.c`, `osr.c`, `rollout.c`, `dice.c`, `lib/*.c`
  (neural net, inputs, SFMT, isaac, md5, cache).
- Game model, analysis and files: `gnubg.c`, `play.c`, `analysis.c`, `set.c`, `show.c`,
  `format.c`, `formatgs.c`, `drawboard.c`, `text.c`, `sgf.c`, `sgf_l.c`, `sgf_y.c`, `import.c`,
  `export.c`, `file.c`, `progress.c`, `util.c`, `output.c`, `timer.c`, `boardpos.c`,
  `simpleboard.c`, `credits.c`, `copying.c`, `dbprovider.c`, `multithread.c`, `mtsupport.c`.
- Files that compile to near-empty stubs once optional libraries are off. I checked that each one
  guards its library use with `#if`: `gnubgmodule.c`, `relational.c`, `randomorg.c`, `sound.c`,
  `render.c`, `renderprefs.c`, `html.c`, `htmlimages.c`, `latex.c`, `speed.c`. If a stub is not
  referenced, I'll leave it out.

**Exclude:** every `gtk*.c` (including 1.08's new `gtkscoremap.c`), `gnubgstock.c`,
`board3d/`, `external*.c` (network play), `openurl.c`, and the standalone tools
`makebearoff.c`, `makehyper.c`, `makeweights.c`, `bearoffdump.c`. We do build those tools
*natively* to generate the data files.

**Why compile `gnubg.c`/`play.c` at all?** Match analysis (`AnalyzeGame` in `analysis.c`),
`.mat`/`.sgf` import and SGF export all work on gnubg's global match state (the match list and
`matchstate ms`), which those files define. Rewriting that would risk changing the results.
Instead, our API calls these internal C functions directly and reads the resulting C structs.
`main()` is replaced by our own `gnubg_init()`, which performs the same initialisation steps
apart from the GUI and console ones.

**Patches to gnubg** are kept minimal, each in its own file in `engine/patches/` with a comment
explaining it. The ones I expect:
- Replace `main()`/console startup with a callable init (similar to Hwa's `start()`).
- Point the home and data directories at fixed paths in Emscripten's virtual filesystem.
- Anything Emscripten-specific that Phase 1 turns up (for example `getpwuid`), fixed in C rather than by `sed` on generated JS.

No patch is allowed to touch evaluation, analysis or file-format logic.

---

## 5. glib

gnubg uses glib throughout: lists, strings, `g_build_filename`, the `GMarkup` XML parser
(match equity tables), option parsing, and threads when they are enabled. Writing a stand-in
for glib would be a lot of new code, so we compile the real thing.

- **Plan A:** current stable glib (2.90.x), cross-compiled as a static library with **meson** and
  an Emscripten cross file. This is glib's own supported build system. Newer glib also replaced
  GSlice with plain `malloc` (it was dropped around 2.76 **(to verify)**), which should remove
  workaround 1 above. Only `libglib-2.0` is needed: no gio, no gobject. Whether current glib
  cross-compiles to Emscripten without patches is **unknown**, and I'll find out early in Phase 1.
- **Plan B:** if Plan A needs more than a few small, well-understood patches, use Hwa's
  configured glib 2.62.0 tree, which is known to build with Emscripten 6.0.8, together with his
  workarounds. Each one gets documented in NOTES.md.

Both are LGPL, which is compatible with GPL v3.

---

## 6. Threads

- **Single-threaded** build: `USE_MULTITHREAD` is left undefined. gnubg has a complete
  single-thread code path (`multithread.c:502`, `mtsupport.c:388`), so this is a supported
  configuration and not a hack.
- Threads in gnubg only speed things up by parallelising evaluations. They don't change any
  evaluation or analysis result, so a single-threaded build gives the same numbers. Rollouts with
  random dice are the one place to double-check **(to verify, only if rollouts are added)**.
- This means **no COOP/COEP headers and no SharedArrayBuffer**, so the site works anywhere, iOS
  Safari included.
- If analysis turns out too slow later, the simpler option is several Web Workers, each with its
  own engine instance, analysing different games or moves in parallel. That also needs no special
  headers. Real pthreads with COOP/COEP would remain a separate optional build.

---

## 7. SIMD and floating point (key to the Phase 2 comparison)

Two facts from gnubg's build system:
1. `configure.ac` compiles with **`-O3 -ffast-math`** by default. Fast-math lets the compiler
   reorder floating-point arithmetic, so desktop builds already differ in the last digits
   depending on compiler and CPU.
2. SIMD code paths exist for SSE2, AVX and NEON (`lib/neuralnetsse.c`). They also sum in a
   different order from the plain-C path. On Apple Silicon, configure's NEON auto-detection is
   commented out (`configure.ac:457`), so a native Mac build uses the plain-C path.

Plan for the comparison:
- **Strict pair.** Native and wasm are both built with *no SIMD*, `-O2 -fno-fast-math
  -ffp-contract=off`, from the same source. Wasm floats are IEEE-754 single precision like
  native, so I expect identical or near-identical results (differences of a few units in the
  last place at most, from `libm` `exp`). This pair shows that the port itself is correct.
- **Release-flags pair.** Both built with gnubg's default `-O3 -ffast-math`. This measures the
  "floating-point noise" that real desktop builds already carry, which gives a principled
  tolerance and avoids an arbitrary one.
- **Optional wasm SIMD.** Emscripten can translate SSE2 intrinsics to WebAssembly SIMD
  (`-msimd128 -msse2`), which would let us reuse gnubg's SSE2 path unchanged. We'll only adopt it
  if it is measurably faster *and* passes the same tests.
- The production build uses whichever flags pass Phase 2 and run fast enough. My expectation is
  the strict flags, since the speed cost is probably small for 0–2 ply.

What counts as a failure: **any** difference in move ranking order (apart from exact ties), any
difference in cube verdict, or any equity difference bigger than the release-flags noise.
Each one gets investigated. None of them gets absorbed by loosening the tolerance.

---

## 8. Data files

| File | Source | Size | Notes |
|---|---|---|---|
| `gnubg.wd` | `makeweights < gnubg.weights` | ~0.4 MB | binary neural-net weights |
| `gnubg_os0.bd` | `makebearoff -o 6 -s 7999999` | ~1.5 MB | one-sided bearoff DB |
| `gnubg_ts0.bd` | `makebearoff -t 6x6` | ~6.8 MB | two-sided bearoff DB. **Needed for parity with desktop.** |
| `met/*.xml` | in tarball | ~0.2 MB | match equity tables. Default is `Kazaross-XG2.xml` (`gnubg.c:4750`). |

- These commands are the exact ones in gnubg's `Makefile.am`. They are generated **once** with
  the natively built tools from the same 1.08.003 tarball and committed. The native reference
  build uses the *same* files, so both sides of every comparison read identical data. (x86,
  arm64 and wasm are all little-endian IEEE, so the binary files are portable.)
- In the browser, the worker `fetch`es each file (which lets us show a per-file progress bar)
  and writes it into Emscripten's in-memory filesystem before calling `gnubg_init()`. We don't
  use `--preload-file`, which would bundle everything into one opaque blob.
- Files get content-hashed names and long-lived cache headers, so they download once per
  browser.

---

## 9. Engine API (refined from your draft)

A thin C layer, `engine/api/gnubg_api.c`. Each function is `EMSCRIPTEN_KEEPALIVE`, takes a
JSON string and returns a JSON string. **cJSON** (MIT, a single C file, widely used, pinned)
handles parsing and writing. Internally the layer calls gnubg's C functions; it never sends text
commands.

| API function | gnubg internals it calls |
|---|---|
| `init(dataDir)` | `EvalInitialise`, MET load, default settings (same steps as `main()`) |
| `evaluatePosition(pos, settings)` | `PositionFromID`, `MatchFromID`, `SetCubeInfo`, `GeneralEvaluationE` (cubeless + cubeful) |
| `rankMoves(pos, dice, settings)` | `FindnSaveBestMoves` (with gnubg's move filters) |
| `legalMoves(pos, dice)` | `GenerateMoves` (UI move enforcement, no separate rules code) |
| `analyseCube(pos, settings)` | `GeneralCubeDecisionE`, `FindCubeDecision`, `GetDPEq` → ND / D-T / D-P equities, verdict string, proper action |
| `analyseMatch(text, format, settings)` | import via `ImportMat` / gnubg's SGF loader → `AnalyzeGame` per game (what `CommandAnalyseMatch` does) → walk move records → per-move JSON + stats from `statcontext` (`updateStatisticsMatch`, `getMWCFromError`, `Skill`, `Luck`) |
| `exportMatch(format)` | gnubg's own SGF / `.mat` writers |
| `botMove(pos, dice, level)` / `botCube(...)` | `FindBestMove` with preset `aecSettings[level]` (beginner … grandmaster, including gnubg's deterministic noise for weaker levels) |

- **Positions** go in as a gnubg ID (`PositionID:MatchID`), which round-trips with desktop
  gnubg. A plain 2×25 board array is also accepted and returned.
- **Settings**: a preset name (`"expert"`, `"world class"`, …, taken from gnubg's
  `aszSettings`) or explicit ply, cubeful flag, noise and move filter. Money vs match play, match
  length, score, Crawford and Jacoby all come from the match ID or explicit fields.
- **Match analysis is split into steps** (load → analyse game *n* → collect results), so the
  worker can report progress and be cancelled between steps.
- **Match summary stats**: I'll compute these with the same functions `formatgs.c` uses and
  check them against native gnubg's `show statistics match` output, so the numbers aren't
  re-derived by me.
- **Dice for play mode** come from the browser's crypto RNG. Luck analysis doesn't depend on how
  the dice were generated.

TypeScript side: `web/src/engine/client.ts` wraps the worker with typed methods that return
promises (`engine.rankMoves(pos, [3,1])`). The worker (`engine.worker.ts`) loads `gnubg.mjs`,
fetches the data files, calls `init`, and then handles one request at a time.

---

## 10. Verification (Phase 2)

- **Reference**: native gnubg 1.08.003, built from the same tarball as a command-line-only build
  (`--without-gtk --without-board3d --disable-simd`) **with Python scripting enabled**. gnubg's
  embedded Python module (`gnubgmodule.c`) exposes `evaluate`, `findbestmove`, `hint`,
  `cfevaluate`, `cubeinfo`, `evalcontext` and `match(analysis=True)`, which return
  **full-precision floats**. That's far better than parsing the 3-decimal console text. The
  reference is unmodified gnubg; only our wasm side goes through our API.
- **Harness**: a Python script runs native gnubg (`gnubg -t -p dump_reference.py`) to write
  reference JSON. A Node script runs the wasm build through our API to write candidate JSON. A
  Python comparer (`pytest`) checks the two and prints the results table.
- **Test set (≥ 24 positions)**: openings, middle-game contact, back games/primes, races, bearoffs
  inside the two-sided DB, bearoffs outside it (one-sided DB / race net), gammonish and
  backgammonish positions, and cube decisions (no double / double-take / double-pass / too
  good). Each is run in money play (with and without Jacoby) and at several match scores,
  including Crawford and post-Crawford. Plies 0, 1 and 2.
- **Match analysis**: one or two real `.mat` matches and one `.sgf`, analysed at the same
  settings. We compare every per-move error, luck value, skill/luck label and the summary stats.

---

## 11. Web app (Phases 4–6), brief

- Next.js (pinned) with `output: 'export'`, so the site is pure static files. TypeScript, plain
  CSS modules with light and dark themes through CSS variables, and no UI framework beyond React.
- SVG board, built by us. Click-to-move first, then drag-and-drop. Legal moves always come from
  `legalMoves`.
- Charts (equity graph): a small, established library (probably uPlot or plain SVG). To be
  decided in Phase 5.
- Deploy: `vercel.json` with immutable caching for hashed `.wasm`/data files. No COOP/COEP needed
  (see §6). GPL v3 `LICENSE`, plus an "About" page crediting GNU Backgammon's authors and
  Theodore Hwa's port, and linking to this source repository.

---

## 12. Risks and open questions

1. **Current glib under Emscripten** (Plan A vs B above). Biggest unknown in Phase 1.
2. **Emscripten 7.0.0 is brand new.** Fallbacks are listed in §3.
3. **gnubg's global state.** The API has to set gnubg's globals (current match, analysis
   settings) carefully before each call, and reset them afterwards, so that requests don't leak
   into each other. Tests will run positions in random order to catch this.
4. **Download size**: roughly 9 MB of data (mostly `gnubg_ts0.bd`) plus the wasm, which I
   haven't measured yet. It's cached after the first visit. If size becomes a problem, gzip
   should shrink the bearoff DBs a lot **(to verify)**, and Vercel only compresses some content
   types automatically **(to verify in Phase 6)**.
5. **Your reference desktop gnubg.** If you compare against a Windows/Intel desktop build, it
   uses AVX/SSE and `-ffast-math`, so expect last-digit differences of the size measured by the
   release-flags pair in §7. That would be normal noise, not a bug.
