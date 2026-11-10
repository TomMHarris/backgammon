/*
 * api_util.h: helpers shared by the gnubg-web C API files (gnubg_api*.c).
 *
 * Conventions for every exported API function:
 *   - input: one JSON string; output: one JSON string with "ok": true/false
 *     (and "error": "..." when false);
 *   - the returned string lives in a single result buffer that is freed on
 *     the next call (finish()), so the caller must copy it out immediately;
 *   - floats are written with 17 significant digits (add_num) so values
 *     round-trip exactly;
 *   - every function except gnubg_api_init refuses to run until
 *     gnubg_api_init has succeeded (API_REQUIRE_READY);
 *   - requests are validated strictly: a field that is present must have the
 *     right JSON type and range, otherwise the call fails with an error that
 *     names the field. Nothing is silently ignored, rounded or replaced by a
 *     default. Results for valid requests are what gnubg computes.
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

/* ---------------------------------------------------------------------- */
/* Engine state                                                           */
/* ---------------------------------------------------------------------- */

/*
 * Before gnubg_api_init succeeds, gnubg has no neural nets, no evaluation
 * cache and no move buffer (td.tld is NULL, multithread.h:194), so calling
 * the engine would return meaningless numbers or write through a NULL
 * pointer into wasm memory. After a failed initialisation gnubg's state is
 * half set up and cannot be reset (eval.c keeps it in statics), so the
 * module instance must be thrown away.
 */
typedef enum {
    ENGINE_NOT_STARTED,         /* gnubg_api_init not called, or refused before touching gnubg */
    ENGINE_READY,               /* gnubg_api_init succeeded */
    ENGINE_FAILED               /* gnubg_api_init failed or aborted: unusable */
} engine_state;

void api_set_engine_state(engine_state state);
engine_state api_get_engine_state(void);
/* NULL when the engine is ready; otherwise the {"ok":false,...} result to return. */
const char *api_not_ready(void);
/* First statement of every exported function except gnubg_api_init. */
#define API_REQUIRE_READY() \
    do { const char *not_ready_ = api_not_ready(); if (not_ready_) return not_ready_; } while (0)

/* ---------------------------------------------------------------------- */
/* Results                                                                */
/* ---------------------------------------------------------------------- */

/* A parsed position: board + cube/score context, all from gnubg IDs. */
typedef struct {
    TanBoard anBoard;           /* anBoard[1] is the player on roll */
    unsigned int anDice[2];     /* dice from the match ID (0, 0 = not rolled) */
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

/* ---------------------------------------------------------------------- */
/* Request parsing and validation                                         */
/* ---------------------------------------------------------------------- */

/*
 * Parse a request: exactly one JSON object, nothing after it (a NULL
 * request counts as {}). Returns the object (cJSON_Delete it), or NULL with
 * *err set.
 */
cJSON *parse_request(const char *json, const char **err);

/*
 * Typed field readers. Each returns NULL when the field is absent (leaving
 * *out unchanged) or present and valid (setting *out), and an error message
 * naming the field otherwise. JSON null counts as present and wrong.
 */
const char *get_int_field(const cJSON *obj, const char *name, int lo, int hi, int *out);
const char *get_bool_field(const cJSON *obj, const char *name, int *out);
const char *get_string_field(const cJSON *obj, const char *name, const char **out);
/* "name": [d1, d2], two integers 1..6. *present says whether it was given. */
const char *get_dice_field(const cJSON *obj, const char *name, int *present, int anDice[2]);

/*
 * Decode a gnubg position ID strictly: exactly 14 characters of the base64
 * alphabet, a legal position by gnubg's CheckPosition, and canonical (it is
 * the ID gnubg writes for the board it decodes to). fInPlay additionally
 * requires both sides to have at least one chequer left (a game in progress).
 */
const char *decode_position_id(const char *sz, int fInPlay, TanBoard anBoard);

/* A decoded and normalised match ID (see decode_match_id). */
typedef struct {
    unsigned int anDice[2];
    int fTurn, fResigned, fDoubled, fMove, fCubeOwner, fCrawford;
    int nMatchTo, anScore[2], nCube, fJacoby;
    gamestate gs;
} api_match;

/*
 * Decode a gnubg match ID strictly (12 base64 characters, accepted by
 * gnubg's MatchFromID, cube within gnubg's tables), then normalise it the
 * way desktop gnubg's "set matchid" does (play.c SetMatchID).
 */
const char *decode_match_id(const char *sz, api_match *pm);
/* The match state for a money game without a match ID (see parse_position). */
void default_match(api_match *pm);

/*
 * Read "position" (gnubg position ID, required) and "match" (gnubg match ID,
 * optional) from a request; NULL or error text. The position must be a game
 * in progress (both sides have chequers left).
 */
const char *parse_position(const cJSON *req, api_position *pos);
/* Index of a gnubg preset name ("expert", "world class", ...), or -1. */
int find_preset(const char *name);
/*
 * Apply the evaluation fields "plies", "cubeful", "prune", "deterministic",
 * "noise" found in obj (all optional) to *pec, with type/range checks.
 */
const char *apply_eval_fields(const cJSON *obj, evalcontext *pec);
/* Read "preset" or "eval" from a request; NULL or error text. */
const char *parse_eval(const cJSON *req, evalcontext *pec, movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES]);
/* {"win":..,"winGammon":..,...} from gnubg's 5 network outputs. */
cJSON *probs_json(const float ar[]);
/* The evaluation settings actually used, for echoing back to the caller. */
cJSON *eval_json(const evalcontext *pec);

#endif
