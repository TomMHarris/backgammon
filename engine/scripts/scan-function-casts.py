#!/usr/bin/env python3
"""
Find function-pointer casts that would crash in WebAssembly, and check whether
any of them is actually linked into the engine.

Why: C code often casts a function to a pointer type with a different number
of arguments (e.g. a 1-argument free function cast to glib's 2-argument
GFunc). Native CPUs ignore the extra argument; WebAssembly checks the
signature of every indirect call and traps ("null function or function
signature mismatch"). See NOTES.md, Phase 1.

How:
  1. Re-run every compile command of the wasm build (gnubg, gnubg/lib, glib,
     our API, cJSON) with clang's -Wcast-function-type-strict, which reports
     every cast between incompatible function types.
  2. Keep only casts whose *WebAssembly-level* signature differs: number of
     parameters, or i32/i64/f32/f64/void kinds. (Casts that only change
     pointer types are harmless in wasm.)
  3. If a debug build exists (GNUBG_DEBUG=1 engine/build.sh writes
     engine/build/dist-debug/gnubg.mjs.symbols), report for each risky cast
     whether the function containing it is linked into the binary.

Usage (after engine/build.sh and GNUBG_DEBUG=1 engine/build.sh):
  source engine/scripts/emsdk-env.sh
  python3 -I engine/scripts/scan-function-casts.py
Exit status 1 if a risky cast is in our own code (gnubg, API) or in a glib
function that is linked into the binary.
"""
import json
import os
import re
import shlex
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

ENGINE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OBJ = os.path.join(ENGINE, "build/gnubg-wasm")
GLIB_BUILD = os.path.join(ENGINE, "build/glib-wasm")
SYMBOLS = os.path.join(ENGINE, "build/dist-debug/gnubg.mjs.symbols")
REPORT = os.path.join(ENGINE, "build/function-casts-report.txt")


def make_var(directory, expr):
    """Expand a make expression in an automake-generated Makefile."""
    p = subprocess.run(["make", "-s", "-f", "Makefile", "-f", "-", "print-var"], cwd=directory,
                       # $(info) prints the raw value; "echo" would let the shell strip quotes
                       input=f"print-var: ; @: $(info {expr})\n", capture_output=True, text=True, check=True)
    return p.stdout.strip()


def collect_commands():
    """(cwd, argv, source) for every C file compiled into the wasm build."""
    cmds = []
    # gnubg and gnubg/lib: automake's $(COMPILE) is the exact compiler command
    # (CC, defines, includes and CFLAGS) that make uses for each source file.
    top_compile = shlex.split(make_var(OBJ, "$(COMPILE)"))
    top_src = os.path.join(OBJ, make_var(OBJ, "$(srcdir)"))
    for o in make_var(OBJ, "$(gnubg_OBJECTS)").split():
        cmds.append((OBJ, top_compile + [os.path.join(top_src, o[:-2] + ".c")], o))
    lib = os.path.join(OBJ, "lib")
    lib_compile = shlex.split(make_var(lib, "$(COMPILE)"))
    lib_src = os.path.join(lib, make_var(lib, "$(srcdir)"))
    for f in make_var(lib, "$(libevent_la_SOURCES) $(libsimd_la_SOURCES)").split():
        if f.endswith(".c"):
            cmds.append((lib, lib_compile + [os.path.join(lib_src, f)], f))
    # glib: meson's compilation database
    for e in json.load(open(os.path.join(GLIB_BUILD, "compile_commands.json"))):
        if "libglib-2.0.a.p/" in e["output"] or "libcharset.a.p/" in e["output"]:
            cmds.append((e["directory"], shlex.split(e["command"]), e["file"]))
    # Our API and cJSON, with gnubg's flags plus the cJSON include path.
    for src in (os.path.join(ENGINE, "api/gnubg_api.c"), os.path.join(ENGINE, "build/src/cjson/cJSON.c")):
        cmds.append((OBJ, top_compile + ["-I" + os.path.join(ENGINE, "build/src/cjson"), src], src))
    return cmds


def syntax_only(argv):
    """Turn a compile command into a warnings-only run."""
    res, skip = [], False
    for a in argv:
        if skip:
            skip = False
            continue
        if a in ("-o", "-MF", "-MQ", "-MT"):
            skip = True
            continue
        if a in ("-c", "-MD", "-MP") or a.startswith("-W"):
            continue
        res.append(a)
    return res + ["-fsyntax-only", "-Wno-everything", "-Wcast-function-type-strict",
                  "-fdiagnostics-color=never"]


WARNING = re.compile(
    r"^(.*?):(\d+):\d+: warning: cast from '([^']*)'(?: \(aka '([^']*)'\))? "
    r"to '([^']*)'(?: \(aka '([^']*)'\))? converts to incompatible function type", re.M)


def split_signature(t):
    """'ret (*)(a, b)' -> ('ret', ['a', 'b'])"""
    m = re.match(r"^(.*?)\s*\(\*\)\((.*)\)$", t.strip())
    if not m:
        return None
    ret, args = m.group(1).strip(), m.group(2).strip()
    parts, depth, cur = [], 0, ""
    for ch in args:
        depth += ch == "("
        depth -= ch == ")"
        if ch == "," and depth == 0:
            parts.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        parts.append(cur.strip())
    return ret, ([] if parts == ["void"] else parts)


def wasm_kind(t):
    """The WebAssembly value type a C type lowers to (wasm32)."""
    t = t.replace("const", "").replace("volatile", "").strip()
    if "*" in t or "[" in t:
        return "i32"
    if t == "void":
        return "void"
    if t == "float":
        return "f32"
    if t == "double":
        return "f64"
    if re.search(r"\b(long long|int64_t|uint64_t|gint64|guint64|goffset|off_t|time_t)\b", t):
        return "i64"
    return "i32"


def enclosing_function(path, line):
    src = open(path).read().split("\n")
    for j in range(int(line) - 1, 0, -1):
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*\(", src[j])
        if m and m.group(1) not in ("if", "for", "while", "switch", "return"):
            return m.group(1)
    return "?"


def main():
    cmds = collect_commands()
    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(
            lambda c: (c, subprocess.run(syntax_only(c[1]), cwd=c[0], capture_output=True, text=True)), cmds))
    failed = [(c[2], p.stderr) for c, p in results if p.returncode != 0]

    linked = None
    if os.path.exists(SYMBOLS):
        linked = {l.split(":", 1)[1].strip() for l in open(SYMBOLS) if ":" in l}

    seen, risky, harmless = set(), [], 0
    for (cwd, _, src), p in results:
        for m in WARNING.finditer(p.stderr):
            f, line, frm, frm_aka, to, to_aka = m.groups()
            path = os.path.normpath(f if os.path.isabs(f) else os.path.join(cwd, f))
            if (path, line) in seen:
                continue
            seen.add((path, line))
            a, b = split_signature(frm_aka or frm), split_signature(to_aka or to)
            if a and b and (wasm_kind(a[0]), [wasm_kind(x) for x in a[1]]) == \
                           (wasm_kind(b[0]), [wasm_kind(x) for x in b[1]]):
                harmless += 1
                continue
            func = enclosing_function(path, line)
            risky.append((path, line, func, frm_aka or frm, to_aka or to))

    bad = 0
    with open(REPORT, "w") as out:
        for path, line, func, frm, to in sorted(risky):
            ours = "/build/src/glib/" not in path
            if ours:
                status = "OUR CODE (gnubg/API) - must fix"
                bad += 1
            elif linked is None:
                status = "glib, linkage unknown (no debug build)"
                bad += 1
            elif func in linked:
                status = "glib, LINKED INTO BINARY - must fix or prove unreachable"
                bad += 1
            else:
                status = "glib, not linked"
            out.write(f"{status}\n  {os.path.relpath(path, ENGINE)}:{line} in {func}()\n"
                      f"  from {frm}\n  to   {to}\n")

    n_ours = sum(1 for c in cmds if "/build/src/glib/" not in c[1][-1] and "glib-wasm" not in c[0])
    print(f"Scanned {len(cmds)} source files ({n_ours} gnubg/API/cJSON, {len(cmds) - n_ours} glib); "
          f"{len(failed)} failed to compile")
    for f, err in failed:
        first_error = next((l for l in err.split("\n") if "error" in l), err[:300])
        print("  FAILED:", f, "--", first_error)
    print(f"Function-type casts: {harmless} harmless in wasm, {len(risky)} with a different wasm signature")
    print(f"Of those, {bad} need attention. Details: {os.path.relpath(REPORT, os.getcwd())}")
    sys.exit(1 if bad or failed else 0)


if __name__ == "__main__":
    main()
