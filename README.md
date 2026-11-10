# gnubg-web

Play backgammon against GNU Backgammon (gnubg), one of the strongest backgammon programs, in a
web browser, and have your games analysed by it. This is not a reimplementation: it is gnubg
1.08.003 itself, compiled from the official GNU source code to WebAssembly, so its moves, hints,
cube decisions and match analysis come from the same code as the desktop program. Everything
runs on the player's own device; the website is a set of static files with no server-side code.

Source: <https://github.com/TomMHarris/backgammon> · Licence: GPL v3 or later (see [Licence](#licence)).

## Screenshots

(To be added.)

- The game at desktop width, light theme
- The game on a phone, dark theme
- A hint (gnubg's ranked moves with equities)
- The end-of-game analysis (error rates, luck, biggest mistakes)
- The About page

## How it works

```
gnubg 1.08.003 + GLib 2.90.1 (C)          official release tarballs, checked by SHA-256
        │  engine/build.sh: Emscripten 7.0.0, our small patches (engine/patches)
        ▼  and a JSON interface (engine/api)
engine/dist/gnubg.wasm + gnubg.mjs        committed, so the website never needs Emscripten
        │  plus gnubg's data files (engine/data: neural net, bearoff databases, match equity tables)
        ▼
Web Worker (web/public/engine/engine.worker.mjs)   loads and checks the files, runs the engine
        │  off the main thread so the page never freezes while gnubg thinks
        ▼
Next.js app (web/), exported as static HTML/JS     the board, play, hints, analysis
```

- The engine is single-threaded, so the site needs no special browser features or headers and
  works in every current browser, including iOS Safari.
- Engine and data files have content-hashed names (`web/scripts/copy-engine.mjs`), so browsers
  cache them for good and download them again only when they change.

**Verified against native gnubg.** The WebAssembly engine was compared with native gnubg built
from the same source on 43 test positions and 8 match files: 193,851 of 193,883 numbers are
bit-identical, with no differences in cube decisions, skill or luck marks, or match statistics.
The 32 remaining numbers differ in the last digits for two documented C-library reasons (how ties
are sorted, and one `log10f` rounding). Details and how to reproduce: [tests/reference/RESULTS.md](tests/reference/RESULTS.md).

## Download size

Measured for a first visit to the game, until the engine is ready (the static export served
locally with this repository's `vercel.json` headers and brotli compression, as Vercel does):

| | files | on disk | transferred |
|---|---|---|---|
| Web app (HTML, JavaScript, CSS, fonts) | 16 | 0.7 MB | 0.25 MB |
| Engine (`gnubg.wasm`, loader, worker, manifest) | 4 | 1.1 MB | 0.4 MB |
| gnubg data files (mostly the 6.8 MB two-sided bearoff database) | 19 | 8.7 MB | 8.7 MB |
| **Total** | 39 | **10.7 MB** | **about 9.4 MB** (9.5 MB with gzip) |

Vercel compresses HTML, JavaScript, CSS, JSON and WebAssembly, but not gnubg's binary data
files (their file type is not on its list of compressible types; they would only shrink to
about 7 MB anyway). On later visits everything except the HTML, the worker and its manifest
comes from the browser cache, so a returning visitor downloads a few kilobytes.

## Building and running

### Prerequisites

- **Node.js 24** (the tests run TypeScript files directly; the web app needs Node 20.9 or newer).
- Only for rebuilding the engine: the tools listed in [engine/README.md](engine/README.md)
  (on macOS: Xcode command line tools and `brew install meson ninja pkgconf node`). Emscripten
  is downloaded into the repository automatically. The built engine is committed, so you can
  skip this unless you change something in `engine/`.
- Only for the comparison with native gnubg: `brew install glib pkgconf python3`.

### Build the engine (optional)

```sh
engine/build.sh          # about 4 minutes the first time, seconds afterwards
```

Then commit `engine/dist/` with your change. `engine/scripts/check-reproducible.sh` confirms
that a fresh clone rebuilds byte-identical files.

### Run the tests

Quick tests of the WebAssembly engine and the app's game logic (from the repository root, each
a few seconds to a minute):

```sh
node tests/smoke.mjs              # engine loads, evaluates, hints
node tests/play_smoke.mjs         # legal moves, bot moves, doubles and takes
node tests/match_smoke.mjs        # match analysis, game by game
node tests/api_validation.mjs     # the engine refuses bad input
node tests/ui_mat_roundtrip.mjs   # the web app's game logic and .mat export, against the engine
```

The full comparison with native gnubg (Phase 2, a few minutes) is described step by step in
[tests/README.md](tests/README.md): build native gnubg, produce reference results, replay them
through the WebAssembly engine, and compare.

### Run the web app locally

```sh
cd web
npm ci
npm run dev                                  # development server: http://localhost:3000/
# or the production build, exactly the files that get deployed:
npm run build && node scripts/serve-out.mjs  # http://localhost:8080/
```

`npm run dev` and `npm run build` first copy the engine and data files into `web/public/engine/`
(and the licence to `web/public/LICENSE.txt`). The production build is a static export in
`web/out/`. The build downloads the two web fonts from Google Fonts once, so it needs network
access; the finished site makes no requests to Google.

## Deploying to Vercel

1. Push the repository to GitHub.
2. In the Vercel dashboard choose **Add New → Project**, import the GitHub repository and keep
   the **root directory** as the repository root. Leave the framework, build and output settings
   alone: `vercel.json` sets them (install `cd web && npm ci`, build `cd web && npm run build`,
   output `web/out`, framework "Other"). No environment variables are needed.
3. Deploy. Every push to the main branch then deploys automatically, and other branches get
   preview deployments.

Alternatively, from a terminal: `npx vercel` (log in when asked), then `npx vercel --prod`.

`vercel.json` also sets:

- **Clean URLs**: `/about` serves `about.html`; `/about.html` and `/about/` redirect to `/about`.
  Unknown paths get the app's 404 page.
- **Caching**: the content-hashed engine and data files (`/engine/v/…`) and Next.js's hashed
  files (`/_next/static/…`) are cached for a year; the worker and `manifest.json` are
  re-checked on every visit, so a new deployment takes effect immediately.
- **Security headers**: a Content-Security-Policy that allows only the site's own files
  (plus `'wasm-unsafe-eval'` for WebAssembly and `'unsafe-inline'` for the small inline scripts
  that a static Next.js export needs), `X-Content-Type-Options: nosniff`, a referrer policy and
  no framing by other sites. If you add anything loaded from another domain (analytics, a CDN),
  the policy must be extended. On preview deployments it may block Vercel's
  feedback toolbar; that does not affect the site.

## Updating gnubg, GLib or Emscripten

All versions and checksums are pinned in `engine/versions.env`. How to change them, rebuild and
re-verify (re-run the Phase 2 comparison after any engine change) is in
[engine/README.md](engine/README.md). Next.js and React are pinned in `web/package.json`. The
About page reads the engine versions from `engine/versions.env` when the site is built.

## Licence

gnubg-web is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of
the License, or (at your option) any later version. It comes with no warranty. See
[LICENSE](LICENSE).

Anyone who distributes the site (including the WebAssembly engine) must also offer its
corresponding source code. The site's About page does this, linking to this repository, the
exact upstream tarballs and `engine/patches/`.

## Credits

- [GNU Backgammon](https://www.gnu.org/software/gnubg/), written by Joseph Heled, Oystein
  Johansen, Joern Thyssen, Gary Wong, David Montgomery, Christian Anthon, Jim Segrave, Jonathan
  Kinsey, Michael Petch and Philippe Michel, with many other contributors (GPL v3 or later).
- Theodore Hwa's [gnubg-web](https://github.com/hwatheod/gnubg-web), the first port of gnubg to
  the browser; this project follows its method with gnubg 1.08.
- [GLib](https://docs.gtk.org/glib/) (LGPL 2.1 or later) with PCRE2 (BSD),
  [Emscripten](https://emscripten.org/) (MIT / University of Illinois),
  [cJSON](https://github.com/DaveGamble/cJSON) (MIT), [Next.js](https://nextjs.org/) and
  [React](https://react.dev/) (MIT), and the fonts DM Mono and Cormorant Garamond (SIL Open Font
  Licence).
