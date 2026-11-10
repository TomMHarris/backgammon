# Small helpers shared by the build scripts. Sourced, not run:
#   source "$ENGINE_DIR/scripts/common.sh"
# Works with macOS's bash 3.2 and with Linux.

# Print the SHA-256 of a file. macOS (and most Linux desktops) have the
# Perl "shasum"; minimal Linux images often only have coreutils' sha256sum.
sha256_of() {
    if command -v shasum > /dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        sha256sum "$1" | awk '{print $1}'
    fi
}

# "Signatures" decide when a build directory must be thrown away and set up
# again. A signature is a plain-text description of *everything* a directory
# was configured from (tool versions, the exact configure/meson command, the
# source tree it was built from). It is stored inside the directory; if the
# text we would write now differs from the stored text, something changed and
# the directory is deleted and rebuilt from scratch. Deleting (rather than
# "make clean") is deliberate: it is the only way to be sure no stale object,
# cached configure result or old timestamp survives.
#
#   signature_matches DIR TEXT   -> true if DIR/.gnubg-web-signature == TEXT
#   write_signature   DIR TEXT
signature_matches() {
    [ -f "$1/.gnubg-web-signature" ] && [ "$(cat "$1/.gnubg-web-signature")" = "$2" ]
}
write_signature() {
    printf '%s\n' "$2" > "$1/.gnubg-web-signature"
}

# The text describing an unpacked source tree (written by unpack.sh). Build
# signatures include it, so any change to a tarball or patch forces a rebuild.
source_stamp() {
    cat "$1/.gnubg-web-source" 2>/dev/null || echo "missing"
}

# Show the last lines of a log after a failed step. A grep for "error:" alone
# can print nothing (e.g. make's "No rule to make target ... Stop."), so we
# always show the tail, plus the error lines that may have scrolled past it.
show_failure() {
    local log="$1"
    echo "---- failed; last 40 lines of $log ----" >&2
    tail -40 "$log" >&2
    if grep -qE 'error:|Error [0-9]|\*\*\*' "$log"; then
        echo "---- error lines in $log ----" >&2
        grep -E 'error:|Error [0-9]|\*\*\*' "$log" | head -20 >&2
    fi
}
