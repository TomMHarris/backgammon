# Minimal reproductions of the two WebAssembly-vs-native differences

Both come from the C library, not from gnubg or from the port. See
`tests/reference/RESULTS.md`.

```sh
cd tests/compare/repro
T=$(mktemp -d)
cc -O0 -o "$T"/q qsort_ties.c && "$T"/q          # macOS libc:  7 1 2 3 0 5 6 4
cc -O0 -o "$T"/l log10f.c && "$T"/l              # macOS libm:  0.19808195531368256 (correctly rounded)
source ../../../engine/.emsdk/emsdk_env.sh
emcc -O0 -o "$T"/q.js qsort_ties.c && node "$T"/q.js   # Emscripten: 0 2 1 4 3 5 7 6
emcc -O0 -o "$T"/l.js log10f.c && node "$T"/l.js       # Emscripten: 0.19808194041252136 (one float step lower)
```

1. `qsort_ties.c`: gnubg's move comparator `CompareMoves` (`eval.c:2811-2816`)
   never returns 0, so moves with exactly equal scores end up in whatever order
   the library's `qsort` algorithm leaves them. Different libraries, different
   order. Equities are not affected.
2. `log10f.c`: the exact log10 of the argument is 0.198081951294994…; the
   nearest float is 0.19808195531368256 (macOS). Emscripten's libc returns the
   float just below it.
