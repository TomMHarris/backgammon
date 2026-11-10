# Source this (from bash or zsh) to put the pinned Emscripten (emcc etc.) on PATH:
#
#   source engine/scripts/emsdk-env.sh
#
# On first use it clones the emsdk repository into engine/.emsdk at the commit
# pinned in versions.env and installs the pinned SDK release with it.
# Afterwards it always checks that the emcc now on PATH is the one inside
# engine/.emsdk *and* reports the pinned version; if not (another SDK was
# activated by hand, an install was interrupted, ...) it re-runs
# "emsdk install/activate", and if that doesn't fix it, it fails. It never
# silently builds with another compiler.
#
# On failure it prints why and returns 1 (inside build.sh, "set -e" then stops
# the build; in an interactive shell your terminal stays open).

# Find this file's own location. bash and zsh do this differently; the same
# method as emsdk's own emsdk_env.sh. (Not "${BASH_SOURCE[0]}" alone: zsh, the
# default macOS shell, leaves it empty, and the script would then look for
# versions.env and .emsdk in the wrong directory.)
if [ -n "${BASH_SOURCE[0]:-}" ]; then
    _gw_self="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION:-}" ]; then
    _gw_self="${(%):-%x}"
else
    echo "emsdk-env.sh: please source this from bash or zsh" >&2
    return 1
fi

_gw_emsdk_setup() {
    local engine_dir emsdk head log
    engine_dir="$(cd "$(dirname "$1")/.." && pwd)" || return 1
    if [ ! -f "$engine_dir/versions.env" ]; then
        echo "emsdk-env.sh: $engine_dir/versions.env not found" >&2
        return 1
    fi
    # Sets EMSDK_VERSION, EMSDK_GIT_URL, EMSDK_GIT_COMMIT (and the other pins).
    . "$engine_dir/versions.env"
    if [ -z "${EMSDK_VERSION:-}" ] || [ -z "${EMSDK_GIT_COMMIT:-}" ]; then
        echo "emsdk-env.sh: EMSDK_VERSION / EMSDK_GIT_COMMIT missing from versions.env" >&2
        return 1
    fi
    emsdk="$engine_dir/.emsdk"

    # 1. The emsdk checkout, at the pinned commit. (Its manifest decides which
    #    node, python and LLVM builds "emsdk install" downloads.)
    if [ ! -d "$emsdk" ]; then
        echo "Cloning emsdk $EMSDK_VERSION into $emsdk"
        git clone --quiet --depth 1 --branch "$EMSDK_VERSION" "$EMSDK_GIT_URL" "$emsdk" || return 1
    fi
    head="$(git -C "$emsdk" rev-parse HEAD 2>/dev/null)"
    if [ "$head" != "$EMSDK_GIT_COMMIT" ]; then
        echo "engine/.emsdk is at commit '$head', pinned is $EMSDK_GIT_COMMIT: checking out the pinned commit"
        git -C "$emsdk" fetch --quiet --depth 1 origin "refs/tags/$EMSDK_VERSION:refs/tags/$EMSDK_VERSION" \
            && git -C "$emsdk" checkout --quiet --detach "$EMSDK_GIT_COMMIT" \
            || { echo "emsdk-env.sh: could not check out emsdk $EMSDK_GIT_COMMIT in $emsdk" >&2; return 1; }
    fi

    # 2. Put the SDK on PATH and check it is the right one. emsdk_env.sh is
    #    chatty, so its output is kept in a temporary file and shown only if
    #    something goes wrong.
    log="$(mktemp)"
    if ! _gw_emsdk_check "$emsdk" "$log"; then
        echo "Installing Emscripten $EMSDK_VERSION into $emsdk"
        if ! ( cd "$emsdk" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION" ); then
            echo "emsdk-env.sh: 'emsdk install/activate $EMSDK_VERSION' failed" >&2
            rm -f "$log"
            return 1
        fi
        if ! _gw_emsdk_check "$emsdk" "$log"; then
            cat "$log" >&2
            rm -f "$log"
            return 1
        fi
    fi
    rm -f "$log"
}

# Source emsdk_env.sh and verify: emcc must live inside our .emsdk and report
# exactly EMSDK_VERSION (an exact string comparison, so 6.0.1 != 6.0.13).
_gw_emsdk_check() {
    local emsdk="$1" log="$2" emcc_dir want_dir version
    [ -f "$emsdk/emsdk_env.sh" ] || { echo "no $emsdk/emsdk_env.sh" > "$log"; return 1; }
    . "$emsdk/emsdk_env.sh" > "$log" 2>&1 || return 1
    command -v emcc > /dev/null 2>&1 || { echo "emsdk-env.sh: emcc not on PATH" >> "$log"; return 1; }
    # pwd -P resolves symbolic links, so the comparison works even if .emsdk is a link.
    emcc_dir="$(cd "$(dirname "$(command -v emcc)")" && pwd -P)"
    want_dir="$(cd "$emsdk/upstream/emscripten" 2>/dev/null && pwd -P)"
    if [ "$emcc_dir" != "$want_dir" ]; then
        echo "emsdk-env.sh: emcc on PATH is $emcc_dir, expected $emsdk/upstream/emscripten" >> "$log"
        return 1
    fi
    version="$(emcc -dumpversion 2>/dev/null)"
    if [ "$version" != "$EMSDK_VERSION" ]; then
        echo "emsdk-env.sh: emcc is version '$version', expected $EMSDK_VERSION" >> "$log"
        return 1
    fi
}

if _gw_emsdk_setup "$_gw_self"; then
    unset -f _gw_emsdk_setup _gw_emsdk_check
    unset _gw_self
else
    unset -f _gw_emsdk_setup _gw_emsdk_check
    unset _gw_self
    return 1
fi
