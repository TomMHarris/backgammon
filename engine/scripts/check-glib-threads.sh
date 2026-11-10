#!/usr/bin/env bash
# Guard: fail if gnubg or our API starts using a glib threading function that
# does not work in our WebAssembly build.
#
#   engine/scripts/check-glib-threads.sh OBJECT_OR_ARCHIVE...
#   (build.sh runs it on every gnubg/API object it links; emnm must be on PATH)
#
# Background. We build glib without -pthread (glib patch 0003), so there is
# exactly one thread and Emscripten's libc supplies single-threaded pthread
# "stubs". With those stubs (checked for glib 2.90.1 + Emscripten 7.0.0,
# NOTES.md Phase 1 / review finding GLIB-2):
#
#   Work correctly (single thread):  GMutex lock/unlock, GRecMutex, GRWLock
#     lock/unlock, GOnce / g_once_init_enter/leave, GPrivate, g_thread_self.
#
#   Do NOT work:
#     g_thread_new, g_thread_try_new, g_thread_create*, GThreadPool
#       -> link error (pthread_getname_np missing from Emscripten's libc), and
#          even with a stub pthread_create returns ENOTSUP and glib aborts.
#     g_get_num_processors
#       -> link error (pthread_getaffinity_np / __sched_cpucount missing).
#     g_mutex_trylock, g_rec_mutex_trylock, g_rw_lock_*_trylock
#       -> always return TRUE, even when the lock is already held.
#     g_cond_wait, g_cond_wait_until, g_cond_timed_wait
#       -> return immediately (as if signalled); timed waits never time out.
#     g_async_queue_pop, g_async_queue_timeout_pop, g_async_queue_timed_pop
#       (and their _unlocked forms) -> on an empty queue: spin forever or
#       return at once, instead of waiting for another thread.
#
# gnubg uses none of them today (it is configured with --disable-threads,
# so its USE_MULTITHREAD code is compiled out). If that ever changes, this
# check stops the build with an explanation instead of shipping an engine that
# misbehaves at run time. It looks at the symbols each object file *refers
# to* (nm -u), so it also catches calls in code that is never executed.
set -euo pipefail

[ $# -gt 0 ] || { echo "usage: $0 OBJECT..." >&2; exit 2; }

UNSUPPORTED='^(g_thread_new|g_thread_try_new|g_thread_create|g_thread_create_full|g_thread_pool_.*|g_get_num_processors|g_mutex_trylock|g_rec_mutex_trylock|g_rw_lock_writer_trylock|g_rw_lock_reader_trylock|g_cond_wait|g_cond_wait_until|g_cond_timed_wait|g_async_queue_pop|g_async_queue_pop_unlocked|g_async_queue_timeout_pop|g_async_queue_timeout_pop_unlocked|g_async_queue_timed_pop|g_async_queue_timed_pop_unlocked)$'

# "nm -u -A" prints one "file: U symbol" line per undefined symbol.
# (stderr is dropped because nm warns "no symbols" for objects that gnubg's
# configure compiled empty, e.g. the Python module.)
symbols="$(emnm -u -A "$@" 2>/dev/null)" || { echo "ERROR: emnm failed on $*" >&2; exit 1; }
found="$(printf '%s\n' "$symbols" | awk -v re="$UNSUPPORTED" '$NF ~ re { sub(/:$/, "", $1); print "  " $1 " uses " $NF }')"

if [ -n "$found" ]; then
    echo "ERROR: glib threading functions that don't work in the single-threaded wasm build:" >&2
    echo "$found" >&2
    echo "See engine/scripts/check-glib-threads.sh for why and what does work." >&2
    exit 1
fi
