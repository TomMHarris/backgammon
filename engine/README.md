# engine/: GNU Backgammon compiled to WebAssembly

`engine/build.sh` turns the pinned GNU Backgammon 1.08.003 + glib 2.90.1 sources into
`engine/dist/gnubg.mjs` + `engine/dist/gnubg.wasm` with Emscripten 7.0.0. The results are
committed, so the web app never needs Emscripten. Rebuild only after changing something
in `engine/` (and commit `engine/dist/` with the change).

```sh
engine/build.sh              # ~4 min the first time, seconds afterwards
node tests/smoke.mjs         # quick check of the result
```

## Host prerequisites

Everything that ends up in `gnubg.wasm` is pinned and checksummed (see "What is pinned"
below). The build also needs some ordinary tools on the host. Their exact versions don't
change the output, but some have minimum versions.

| Tool | Needed for | Minimum |
|---|---|---|
| bash, git, curl, tar, make, patch | scripts, downloads, gnubg's Makefile | curl 7.71 recommended (older works, with fewer retries) |
| `shasum` or `sha256sum` | checksums | |
| `xz` | unpacking glib's `.tar.xz` with GNU tar (Linux) | |
| python3 | meson, Emscripten (on Linux emsdk uses the system python), scan script | 3.10 |
| meson | building glib | **1.4.0** (glib 2.90 refuses older) |
| ninja | building glib | |
| pkg-config (or pkgconf) | gnubg's configure finding our wasm glib | |
| node | running the tests | 18.3 (Emscripten 7.0.0's minimum) |

Emscripten itself is **not** a prerequisite: `scripts/emsdk-env.sh` downloads it into
`engine/.emsdk/` (about 1 GB on disk) on first use. Nothing is installed outside the repository.

**macOS** (tested: macOS 26, Apple Silicon, Homebrew). git, curl, make, patch and tar come
with the Xcode command line tools (`xcode-select --install`). Then:

```sh
brew install meson ninja pkgconf node
```

**Linux** (Debian/Ubuntu names; not yet tested end to end, please report problems):

```sh
sudo apt install build-essential git curl xz-utils pkg-config python3 python3-venv ninja-build patch nodejs
python3 -m pip install --user 'meson>=1.4'     # or: pipx install meson
```

Distribution meson packages are often too old for glib 2.90 (check `meson --version`;
the build stops with a clear message if it is below 1.4.0). The scripts avoid macOS-only
commands and use `sha256sum` when `shasum` is missing.

**Checkout path.** gnubg's `configure` refuses source paths containing a space or any of
`\ " # $ & ' `` ` ``; `build.sh` checks this first. Clone the repository somewhere without them.

**Network access** during the first build: ftp.gnu.org (or a GNU mirror),
download.gnome.org, github.com, wrapdb.mesonbuild.com and zlib.net for sources (all
checked against SHA-256 in `versions.env`), plus github.com and Google's storage for
emsdk and the Emscripten SDK.

**Native gnubg** (`native/build-native.sh`, only for the comparison tests and for
regenerating `engine/data/`): additionally a C compiler, glib 2 development files and
Python 3 headers. macOS: `brew install glib pkgconf python3`. Debian/Ubuntu:
`sudo apt install libglib2.0-dev python3-dev`.

## What the scripts do

| Script | Job |
|---|---|
| `build.sh` | Runs everything below in order, then configures, compiles and links gnubg + our API. |
| `versions.env` | Every pinned version, URL and SHA-256 (and the emsdk git commit). |
| `scripts/fetch.sh` | Downloads to `build/downloads/` and checks SHA-256. A wrong download is deleted and the next URL tried. |
| `scripts/unpack.sh` | Unpacks into `build/src/<name>/` and applies `patches/<name>/*.patch`. |
| `scripts/emsdk-env.sh` | `source` it (bash or zsh) to get the pinned `emcc` on PATH; installs it if needed and refuses any other version. |
| `scripts/build-glib.sh` | Cross-compiles glib's core library with meson. |
| `scripts/check-glib-threads.sh` | Build guard: gnubg must not use glib threading functions that don't work without threads. |
| `scripts/check-reproducible.sh` | Rebuilds the current commit from a fresh clone and compares with the committed `dist/`. |
| `scripts/scan-function-casts.py` | Looks for function-pointer casts that would trap in WebAssembly. |
| `native/build-native.sh`, `native/make-data.sh` | Native gnubg (reference engine) and the data files in `engine/data/`. |

**Re-runs are safe.** Each source tree records the SHA-256 of its tarball and of every
patch; each build directory records everything it was configured from (exact configure
or meson command, compiler version, source tree). When anything differs, the tree or
directory is deleted and rebuilt from scratch. So after editing a patch, bumping a
version or changing a flag, just run `engine/build.sh` again; there is never a need to
delete `engine/build/` by hand (doing so is harmless, only slower).

## What is pinned

- gnubg, glib and cJSON tarballs: URL + SHA-256 in `versions.env`.
- glib's meson subprojects (PCRE2, which is compiled into `gnubg.wasm`, plus libffi and
  zlib, which glib's build files require but we never compile): downloaded by `fetch.sh`
  with the SHA-256 from glib's own `subprojects/*.wrap` files, and meson runs with
  `--wrap-mode=nodownload`. `unpack.sh` stops if glib's `.wrap` files and `versions.env`
  disagree.
- Emscripten: emsdk repository at a fixed git commit (its manifest fixes the LLVM, node and
  python builds it installs) and SDK release 7.0.0; `emsdk-env.sh` checks `emcc -dumpversion`.
  Meson's test programs run with emsdk's node, not the host's.
- glib's install prefix is fixed (`--prefix=/usr/local`): glib compiles two install paths
  into the library as strings, and meson's default prefix differs between machines.

`scripts/check-reproducible.sh` confirms that a fresh clone rebuilds byte-identical files
and that no path of the build machine appears in `gnubg.wasm`. It runs on one machine;
building on a second machine (another OS) is the remaining test of host independence.

## Safety nets in the binary

- **Stack overflow traps.** The release link uses `-Wl,--stack-first`, so the 8 MB stack
  sits below gnubg's static data and an overflow traps ("memory access out of bounds")
  instead of silently overwriting global variables. No measurable speed cost.
- **No threads.** glib is built without `-pthread`. Mutexes, once-initialisation and
  thread-private data work; creating threads, `GThreadPool`, `g_get_num_processors`,
  `trylock` and timed waits do not. `scripts/check-glib-threads.sh` (run by `build.sh`)
  fails the build if gnubg or the API starts using any of those.
- **Function-pointer casts.** WebAssembly traps when a function is called through a
  pointer of a different type. glib patch 0004 fixes the cases glib's linked code
  contains; `scripts/scan-function-casts.py` checks for new ones (see its header for what
  it can and cannot detect).
