/*
 * api_util.h: helpers shared by the gnubg-web C API files (gnubg_api*.c).
 *
 * Conventions for every exported API function:
 *   - input: one JSON string; output: one JSON string with "ok": true/false
 *     (and "error": "..." when false);
 *   - the returned string lives in a single result buffer that is freed on
 *     the next call (finish()), so the caller must copy it out immediately;
 *   - floats are written with 17 significant digits (add_num) so values
 *     round-trip exactly.
 *
 * Copyright (C) 2026 gnubg-web contributors. GPL v3 or later (see LICENSE).
 */
#ifndef GNUBG_WEB_API_UTIL_H
#define GNUBG_WEB_API_UTIL_H

#include "config.h"
#include <glib.h>
#include "backgammon.h"
#include "eval.h"
#include "cJSON.h"

#if defined(__EMSCRIPTEN__)
#include <emscripten.h>
#define API_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define API_EXPORT
#endif

/* A parsed position: board + cube/score context, all from gnubg IDs. */
typedef struct {
    TanBoard anBoard;           /* anBoard[1] is the player on roll */
    unsigned int anDice[2];
    cubeinfo ci;
} api_position;

/* Serialise obj into the result buffer, free obj, return the string. */
const char *finish(cJSON *obj);
/*
 * Empty gnubg's evaluation cache (gnubg's "clear cache" command).
 * gnubg's results depend on what is in its cache: cubeful cache entries do
 * not record the top-level ply, so values computed under one setting can be
 * reused under another (differences up to ~0.06 equity were measured), and
 * cache hits change the order of float operations (last-bit differences).
 * Every API call that evaluates flushes first, so its result equals what a
 * freshly started gnubg gives for the same request. See NOTES.md (Phase 2).
 */
void api_flush_cache(void);

/* {"ok": false, "error": message} */
const char *error_result(const char *message);
/* Add a float exactly (17 significant digits); null if not finite. */
void add_num(cJSON *obj, const char *name, double v);
/* Read "position" (+ optional "match") from a request; NULL or error text. */
const char *parse_position(const cJSON *req, api_position *pos);
/* Index of a gnubg preset name ("expert", "world class", ...), or -1. */
int find_preset(const char *name);
/* Read "preset" or "eval" from a request; NULL or error text. */
const char *parse_eval(const cJSON *req, evalcontext *pec, movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES]);
/* {"win":..,"winGammon":..,...} from gnubg's 5 network outputs. */
cJSON *probs_json(const float ar[]);
/* The evaluation settings actually used, for echoing back to the caller. */
cJSON *eval_json(const evalcontext *pec);

#endif
