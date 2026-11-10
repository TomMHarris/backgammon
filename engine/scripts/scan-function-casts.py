#!/usr/bin/env python3
"""
Find function-pointer casts that would crash in WebAssembly, and check whether
any of them can be reached in the engine we ship.

Why: C code often casts a function to a pointer type with a different number
of arguments (e.g. a 1-argument free function cast to glib's 2-argument
GFunc). Native CPUs ignore the extra argument; WebAssembly checks the
signature of every indirect call and traps ("null function or function
signature mismatch"). See NOTES.md, Phase 1. Such a bug always crashes; it
cannot silently change a number. (glib's own docs suggest linking with
-sEMULATE_FUNCTION_POINTER_CASTS instead; we fix the casts with glib patch
0004 and use this scan to check nothing was missed.)

How:
  1. Re-run every compile command of the wasm build (gnubg, gnubg/lib, every
     engine/api/*.c, cJSON, glib, libcharset, PCRE2) with clang's
     -Wcast-function-type-strict, which reports every explicit cast between
     incompatible function types.
  2. Keep only casts whose *WebAssembly-level* signature differs: number of
     parameters, or i32/i64/f32/f64/void kinds. (Casts that only change
     pointer types are harmless in wasm.)
  3. Decide whether each risky cast can be in the binary. The scan re-links
     the objects of the last engine/build.sh run (same inputs and flags, from
     build/gnubg-wasm/link-args.txt) without optimisation and with a symbol
     map, so the list of linked functions is always current. A function can
     also be compiled *into* another one (inlining: glib is built with -O3),
     in which case it has no symbol of its own. So a function counts as
     linked if it, or any function in the same source file that mentions it
     (directly, or through a chain of such mentions or a macro), is in the
     symbol map. Casts outside any function (static tables) count as linked
     if anything in their file is linked.
  4. A check on the linked binary itself (catches what step 1 can't see, such
     as a function pointer converted through void*/gpointer): every function
     that can be called through a pointer sits in the wasm function table
     with its real type. If no indirect call anywhere in the binary uses a
     type, the table functions of that type can only ever be called with a
     *wrong* type (a trap) or never called at all. Those are listed for
     review.

Limits (what this scan can NOT prove):
  - Step 1 only sees explicit casts. A function pointer stored as void* or
    gpointer and later used as another function type produces no warning.
    Step 4 catches it only when the real type is never used by any indirect
    call; if some other, correct call of that type exists, it is not seen.
  - Step 3 works on source text (which functions mention which names), not
    on a real call graph. It errs on the side of "linked" (more to review),
    but code reached only through a macro defined in a header is not traced.
  - It cannot tell whether a linked cast is ever *executed*; linked risky
    casts must be fixed or reviewed by hand (REVIEWED below).

Usage (after engine/build.sh):
  python3 -I engine/scripts/scan-function-casts.py
(It sets up the pinned Emscripten itself.)
Exit status 1 if a risky cast is in our own code (gnubg, API, cJSON), in a
third-party function that is linked, or if step 4 finds an unreviewed type;
2 if the build is missing or older than the sources.
"""
import glob
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

ENGINE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OBJ = os.path.join(ENGINE, "build/gnubg-wasm")
GLIB_BUILD = os.path.join(ENGINE, "build/glib-wasm")
THIRD_PARTY = os.path.join(ENGINE, "build/src/glib") + os.sep  # glib, libcharset, PCRE2 (subprojects/)
LINK_ARGS = os.path.join(OBJ, "link-args.txt")
REPORT = os.path.join(ENGINE, "build/function-casts-report.txt")

# Risky-looking casts in LINKED third-party functions that were checked by
# hand and are safe: (file name, function) -> why. Re-check when glib changes.
REVIEWED = {
    ("gmain.c", "g_timeout_dispatch"): (
        "Casts the callback to GSourceOnceFunc only for one-shot sources, which only "
        "g_timeout_add_once() creates (not linked); other timeouts are called as GSourceFunc. "
        "gnubg's timeout callbacks save_autosave (gnubg.c), DelayTimeout (play.c) and "
        "NextTurnNotify (gnubg.c) are all gint/gboolean f(gpointer) = GSourceFunc. "
        "Reviewed 2026-11-10 for glib 2.90.1 / gnubg 1.08.003."),
}

# Step 4: wasm function types that are in the function table but never used
# by an indirect call, checked by hand: wasm signature -> why it is safe.
REVIEWED_TABLE_TYPES = {
}


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def emsdk_environment():
    """Environment with the pinned Emscripten on PATH (via emsdk-env.sh)."""
    p = run(["bash", "-c", 'source "$1" >&2 && env -0', "_", os.path.join(ENGINE, "scripts/emsdk-env.sh")])
    if p.returncode != 0:
        sys.exit("could not set up Emscripten:\n" + p.stderr)
    return dict(x.split("=", 1) for x in p.stdout.split("\0") if "=" in x)


def check_build_is_current():
    """The scan relinks the objects of the last build; they must match the sources."""
    if not os.path.exists(LINK_ARGS):
        print("No build found (build/gnubg-wasm/link-args.txt): run engine/build.sh first.")
        sys.exit(2)
    built = os.path.getmtime(LINK_ARGS)
    inputs = glob.glob(os.path.join(ENGINE, "api/*.c")) + glob.glob(os.path.join(ENGINE, "patches/*/*.patch")) \
        + [os.path.join(ENGINE, "build.sh"), os.path.join(ENGINE, "versions.env")]
    newer = [os.path.relpath(f, ENGINE) for f in inputs if os.path.getmtime(f) > built]
    if newer:
        print("The build is older than: " + ", ".join(newer) + ". Run engine/build.sh first.")
        sys.exit(2)


def make_var(directory, expr, env):
    """Expand a make expression in an automake-generated Makefile."""
    p = subprocess.run(["make", "-s", "-f", "Makefile", "-f", "-", "print-var"], cwd=directory, env=env,
                       # $(info) prints the raw value; "echo" would let the shell strip quotes
                       input=f"print-var: ; @: $(info {expr})\n", capture_output=True, text=True, check=True)
    return p.stdout.strip()


def collect_commands(env):
    """(cwd, argv, source) for every C file compiled into the wasm build."""
    cmds = []
    # gnubg and gnubg/lib: automake's $(COMPILE) is the exact compiler command
    # (CC, defines, includes and CFLAGS) that make uses for each source file.
    top_compile = shlex.split(make_var(OBJ, "$(COMPILE)", env))
    top_src = os.path.join(OBJ, make_var(OBJ, "$(srcdir)", env))
    for o in make_var(OBJ, "$(gnubg_OBJECTS)", env).split():
        cmds.append((OBJ, top_compile + [os.path.join(top_src, o[:-2] + ".c")], o))
    lib = os.path.join(OBJ, "lib")
    lib_compile = shlex.split(make_var(lib, "$(COMPILE)", env))
    lib_src = os.path.join(lib, make_var(lib, "$(srcdir)", env))
    for f in make_var(lib, "$(libevent_la_SOURCES) $(libsimd_la_SOURCES)", env).split():
        if f.endswith(".c"):
            cmds.append((lib, lib_compile + [os.path.join(lib_src, f)], f))
    # glib, libcharset and PCRE2 (8-bit, the only one linked): meson's compilation database
    for e in json.load(open(os.path.join(GLIB_BUILD, "compile_commands.json"))):
        if any(t in e["output"] for t in ("libglib-2.0.a.p/", "libcharset.a.p/", "libpcre2-8.a.p/")):
            cmds.append((e["directory"], shlex.split(e["command"]), e["file"]))
    # Our API (every engine/api/*.c, as build.sh compiles them) and cJSON,
    # with gnubg's flags plus the cJSON include path.
    for src in sorted(glob.glob(os.path.join(ENGINE, "api/*.c"))) + [os.path.join(ENGINE, "build/src/cjson/cJSON.c")]:
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


# ---- step 3: which source functions can be in the binary --------------------

IDENT = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\b")
FUNC_START = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*\(")
_file_cache = {}


def parse_source(path):
    """Functions and macros of a C file, by glib/PCRE2/GNU layout conventions:
    a definition's name starts a line ("name (...)") and its body runs from a
    line starting with "{" to the next line starting with "}".
    Returns (functions: {name: (first_line, last_line, identifiers)},
             macros: {name: identifiers})."""
    if path in _file_cache:
        return _file_cache[path]
    lines = open(path, errors="replace").read().split("\n")
    funcs, macros = {}, {}
    name, i = None, 0
    while i < len(lines):
        line = lines[i]
        m = FUNC_START.match(line)
        if m and m.group(1) not in ("if", "for", "while", "switch", "return", "sizeof"):
            name, name_line = m.group(1), i
        if line.startswith("#define"):
            text = line
            while text.endswith("\\") and i + 1 < len(lines):
                i += 1
                text = text[:-1] + lines[i]
            mm = re.match(r"#define\s+([A-Za-z_][A-Za-z0-9_]*)", text)
            if mm:
                macros[mm.group(1)] = set(IDENT.findall(text[mm.end():]))
        elif line.startswith("{") and name is not None and i - name_line < 15:
            j = i
            while j + 1 < len(lines) and not lines[j].startswith("}"):
                j += 1
            body = "\n".join(lines[i:j + 1])
            funcs[name] = (name_line + 1, j + 1, set(IDENT.findall(body)))
            name, i = None, j
        i += 1
    _file_cache[path] = (funcs, macros)
    return funcs, macros


def enclosing_function(path, line):
    """Name of the function whose definition contains `line` (1-based), or
    None for code outside any function (e.g. a static table)."""
    funcs, _ = parse_source(path)
    for name, (first, last, _) in funcs.items():
        if first <= line <= last:
            return name
    return None


def reachable_in_file(path, linked):
    """Functions of this file whose code can be in the binary: those in the
    symbol map, plus everything they mention (transitively, also through
    macros of this file) that is defined in this file."""
    funcs, macros = parse_source(path)
    todo = [f for f in funcs if f in linked]
    seen = set(todo)
    while todo:
        cur = todo.pop()
        names = funcs[cur][2] if cur in funcs else macros.get(cur, set())
        for n in names:
            if n not in seen and (n in funcs or n in macros):
                seen.add(n)
                todo.append(n)
    return {f for f in seen if f in funcs}


# ---- step 4: table types never used by an indirect call ---------------------

def table_type_check(wasm, env):
    """Returns {signature: [function names]} for table functions whose type no
    call_indirect uses."""
    wat = run([os.path.join(env["EMSDK"], "upstream/bin/wasm-dis"), wasm], env=env).stdout

    def signature(text):
        """'(param $0 i32) (param $1 f64) (result i32)' -> 'i32 f64 -> i32'"""
        params = [t for g in re.findall(r"\(param ([^()]*)\)", text) for t in g.split() if not t.startswith("$")]
        results = [t for g in re.findall(r"\(result ([^()]*)\)", text) for t in g.split()]
        return " ".join(params or ["(none)"]) + " -> " + " ".join(results or ["(none)"])

    # wasm-dis prints: "(type $3 (func (param i32 i32) (result i32)))",
    # "(func $name (param $0 i32) (result i32)" (one line per header),
    # "(import "env" "x" (func $x (param i32)))", "(call_indirect $0 (type $3)"
    # and "(elem $0 (i32.const 1) $f1 $f2 ...)".
    types = {m.group(1): signature(m.group(2))
             for m in re.finditer(r"^\s*\(type (\$\S+) \(func(.*)$", wat, re.M)}
    func_sig = {m.group(1): signature(m.group(2))
                for m in re.finditer(r"\(func (\$[^\s()]+)(.*)$", wat, re.M)}
    used = {types[t] for t in re.findall(r"\(call_indirect(?: \$\S+)? \(type (\$[^\s()]+)\)", wat)}
    table = []
    for elem in re.findall(r"^\s*\(elem .*$", wat, re.M):
        table += [f.rstrip(")") for f in re.findall(r"\$\S+", elem)[1:]]  # [0] is the segment name
    unknown = [f for f in table if f not in func_sig]
    if unknown or not used:
        sys.exit(f"could not parse wasm-dis output (unknown table entries {unknown[:5]}, "
                 f"{len(used)} call_indirect types)")
    unused = {}
    for f in table:
        if func_sig[f] not in used:
            unused.setdefault(func_sig[f], []).append(f.lstrip("$"))
    return unused, len(table)


def scan_link(env, tmp):
    """Re-link the last build's inputs unoptimised, with a symbol map."""
    args = [a for a in open(LINK_ARGS).read().split("\n") if a]
    out = os.path.join(tmp, "scan.mjs")
    p = run(["emcc"] + args + ["-O0", "--profiling-funcs", "--emit-symbol-map", "-o", out], cwd=OBJ, env=env)
    if p.returncode != 0:
        sys.exit("scan link failed:\n" + p.stderr)
    linked = {l.split(":", 1)[1].strip() for l in open(out + ".symbols") if ":" in l}
    return linked, os.path.join(tmp, "scan.wasm")


def main():
    check_build_is_current()
    env = emsdk_environment()
    cmds = collect_commands(env)
    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(
            lambda c: (c, subprocess.run(syntax_only(c[1]), cwd=c[0], env=env, capture_output=True, text=True)),
            cmds))
    failed = [(c[2], p.stderr) for c, p in results if p.returncode != 0]

    with tempfile.TemporaryDirectory() as tmp:
        linked, wasm = scan_link(env, tmp)
        unused_types, table_size = table_type_check(wasm, env)

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
            risky.append((path, int(line), frm_aka or frm, to_aka or to))

    bad = 0
    with open(REPORT, "w") as out:
        for path, line, frm, to in sorted(risky):
            ours = not path.startswith(THIRD_PARTY)
            func = enclosing_function(path, line)
            reach = reachable_in_file(path, linked) if not ours else set()
            if ours:
                status = "OUR CODE (gnubg/API/cJSON) - must fix"
                bad += 1
            elif func is None and reach:
                status = "third-party, file-scope cast in a LINKED file - must fix or prove unreachable"
                bad += 1
            elif func is None:
                status = "third-party, file-scope cast, nothing in this file linked"
            elif func in reach and (os.path.basename(path), func) in REVIEWED:
                status = "third-party, linked, REVIEWED SAFE: " + REVIEWED[(os.path.basename(path), func)]
            elif func in reach:
                how = "in symbol map" if func in linked else "inlined into a linked function of the same file"
                status = f"third-party, LINKED ({how}) - must fix or prove unreachable"
                bad += 1
            else:
                status = "third-party, not linked (neither it nor any same-file caller is in the binary)"
            out.write(f"{status}\n  {os.path.relpath(path, ENGINE)}:{line} in {func or '(file scope)'}()\n"
                      f"  from {frm}\n  to   {to}\n")
        out.write(f"\nFunction table: {table_size} entries. Types never used by an indirect call:\n")
        for sig, fns in sorted(unused_types.items()):
            note = REVIEWED_TABLE_TYPES.get(sig, "NOT REVIEWED")
            out.write(f"  {sig}: {note}\n    {', '.join(sorted(fns))}\n")

    unreviewed_types = [s for s in unused_types if s not in REVIEWED_TABLE_TYPES]
    third = sum(1 for c in cmds if c[2].startswith(THIRD_PARTY) or c[0].startswith(GLIB_BUILD))
    print(f"Scanned {len(cmds)} source files ({len(cmds) - third} gnubg/API/cJSON, "
          f"{third} glib/libcharset/PCRE2); {len(failed)} failed to compile")
    for f, err in failed:
        first_error = next((l for l in err.split("\n") if "error" in l), err[:300])
        print("  FAILED:", f, "--", first_error)
    print(f"Function-type casts: {harmless} harmless in wasm, {len(risky)} with a different wasm signature")
    print(f"Of those, {bad} need attention.")
    print(f"Function table: {table_size} entries; {len(unused_types)} type(s) never used by an indirect call, "
          f"{len(unreviewed_types)} not reviewed.")
    print(f"Details: {os.path.relpath(REPORT, os.getcwd())}")
    sys.exit(1 if bad or failed or unreviewed_types else 0)


if __name__ == "__main__":
    main()
