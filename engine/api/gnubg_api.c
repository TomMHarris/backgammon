/*
 * gnubg_api.c: a small JSON-in / JSON-out C API over GNU Backgammon's engine.
 *
 * Each exported function takes a JSON request string and returns a JSON
 * response string. The returned pointer stays valid until the next API call
 * (we keep one result buffer and free the previous one), so callers must copy
 * it out straight away. The engine is single-threaded, so this is safe.
 *
 * We call gnubg's own C functions directly (the same ones its "hint" and
 * "eval" commands use). We never drive gnubg by sending text commands.
 *
 * Phase 1 scope: init, evaluate, rankMoves. More arrives in Phase 3.
 *
 * Copyright (C) 2026 gnubg-web contributors. GPL v3 or later (see LICENSE).
 */

#include "config.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <glib.h>

#if defined(__EMSCRIPTEN__)
#include <emscripten.h>
#define API_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define API_EXPORT
#endif

#include "backgammon.h"
#include "eval.h"
#include "positionid.h"
#include "matchid.h"
#include "drawboard.h"
#include "cJSON.h"

/* Defined in gnubg.c by our patch engine/patches/gnubg/0001-web-init-instead-of-main.patch */
extern int gnubg_web_init(const char *szDataDir, const char *szPrefsDir);

/* ---------------------------------------------------------------------- */
/* Result buffer                                                          */
/* ---------------------------------------------------------------------- */

static char *last_result = NULL;

/* Serialise `obj` into the result buffer, free `obj`, and return the string. */
static const char *
finish(cJSON *obj)
{
    free(last_result);
    last_result = cJSON_PrintUnformatted(obj);
    cJSON_Delete(obj);
    return last_result;
}

static const char *
error_result(const char *message)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 0);
    cJSON_AddStringToObject(o, "error", message);
    return finish(o);
}

/*
 * Add a floating-point number to a JSON object *exactly*. cJSON's own
 * printer uses 15 significant digits when they are "close enough", which can
 * change the last bit; that would hide or invent differences when we compare
 * with native gnubg. 17 significant digits always round-trip a double (and
 * every float gnubg produces is exactly representable as a double).
 */
static void
add_num(cJSON *obj, const char *name, double v)
{
    char buf[32];
    if (!isfinite(v)) {
        cJSON_AddNullToObject(obj, name);
        return;
    }
    snprintf(buf, sizeof buf, "%.17g", v);
    cJSON_AddRawToObject(obj, name, buf);
}

/* ---------------------------------------------------------------------- */
/* Request parsing helpers                                                */
/* ---------------------------------------------------------------------- */

/* A parsed position: board + cube/score context, all from gnubg IDs. */
typedef struct {
    TanBoard anBoard;           /* anBoard[1] is the player on roll */
    unsigned int anDice[2];
    cubeinfo ci;
} api_position;

/*
 * Read "position" (gnubg position ID, required) and "match" (gnubg match ID,
 * optional). Without a match ID we use a money game, cube 1 and centred,
 * player 0 on roll, with gnubg's current Jacoby setting.
 * Returns NULL on success, or an error message.
 */
static const char *
parse_position(const cJSON *req, api_position *pos)
{
    const cJSON *jpos = cJSON_GetObjectItemCaseSensitive(req, "position");
    const cJSON *jmatch = cJSON_GetObjectItemCaseSensitive(req, "match");
    int fTurn = 0, fResigned = 0, fDoubled = 0, fMove = 0, fCubeOwner = -1;
    int fCrawford = 0, nMatchTo = 0, anScore[2] = { 0, 0 }, nCube = 1, fJacobyLocal = fJacoby;
    gamestate gs = GAME_PLAYING;

    if (!cJSON_IsString(jpos))
        return "missing \"position\" (a gnubg position ID)";
    if (!PositionFromID(pos->anBoard, jpos->valuestring))
        return "invalid position ID";

    pos->anDice[0] = pos->anDice[1] = 0;
    if (cJSON_IsString(jmatch)) {
        if (!MatchFromID(pos->anDice, &fTurn, &fResigned, &fDoubled, &fMove, &fCubeOwner,
                         &fCrawford, &nMatchTo, anScore, &nCube, &fJacobyLocal, &gs, jmatch->valuestring))
            return "invalid match ID";
    }

    /* Same call as gnubg's GetMatchStateCubeInfo(), using its global nBeavers. */
    if (SetCubeInfo(&pos->ci, nCube, fCubeOwner, fMove, nMatchTo, anScore,
                    fCrawford, fJacobyLocal, nBeavers, bgvDefault) < 0)
        return "invalid cube/score combination";
    return NULL;
}

/* Index into gnubg's aszSettings/aecSettings for a preset name, or -1. */
static int
find_preset(const char *name)
{
    for (int i = 0; i < NUM_SETTINGS; i++) {
        /* aszSettings entries look like "setting|world class": compare the
         * part after the '|' context marker. */
        const char *s = strchr(aszSettings[i], '|');
        s = s ? s + 1 : aszSettings[i];
        if (g_ascii_strcasecmp(s, name) == 0)
            return i;
    }
    return -1;
}

/*
 * Fill evaluation context + move filter from the request.
 *   "preset": "expert" | "world class" | ...   (gnubg's predefined settings)
 * or
 *   "eval": {"plies": 2, "cubeful": true, "prune": true, "noise": 0.0, "deterministic": true}
 * Default: gnubg's current chequer-play settings (esEvalChequer) and filter.
 */
static const char *
parse_eval(const cJSON *req, evalcontext *pec, movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES])
{
    const cJSON *jpreset = cJSON_GetObjectItemCaseSensitive(req, "preset");
    const cJSON *jeval = cJSON_GetObjectItemCaseSensitive(req, "eval");

    *pec = GetEvalChequer()->ec;
    memcpy(aamf, *GetEvalMoveFilter(), sizeof(movefilter) * MAX_FILTER_PLIES * MAX_FILTER_PLIES);

    if (cJSON_IsString(jpreset)) {
        int i = find_preset(jpreset->valuestring);
        if (i < 0)
            return "unknown preset";
        *pec = aecSettings[i];
        if (aiSettingsMoveFilter[i] >= 0)
            memcpy(aamf, aaamfMoveFilterSettings[aiSettingsMoveFilter[i]],
                   sizeof(movefilter) * MAX_FILTER_PLIES * MAX_FILTER_PLIES);
    } else if (cJSON_IsObject(jeval)) {
        const cJSON *j;
        if ((j = cJSON_GetObjectItemCaseSensitive(jeval, "plies")) && cJSON_IsNumber(j)) {
            if (j->valueint < 0 || j->valueint > 4)
                return "plies must be 0..4";
            pec->nPlies = (unsigned int) j->valueint;
        }
        if ((j = cJSON_GetObjectItemCaseSensitive(jeval, "cubeful")) && cJSON_IsBool(j))
            pec->fCubeful = cJSON_IsTrue(j);
        if ((j = cJSON_GetObjectItemCaseSensitive(jeval, "prune")) && cJSON_IsBool(j))
            pec->fUsePrune = cJSON_IsTrue(j);
        if ((j = cJSON_GetObjectItemCaseSensitive(jeval, "deterministic")) && cJSON_IsBool(j))
            pec->fDeterministic = cJSON_IsTrue(j);
        if ((j = cJSON_GetObjectItemCaseSensitive(jeval, "noise")) && cJSON_IsNumber(j))
            pec->rNoise = (float) j->valuedouble;
    }
    return NULL;
}

/* {"win":..,"winGammon":..,...} from gnubg's 5 network outputs. */
static cJSON *
probs_json(const float ar[])
{
    cJSON *p = cJSON_CreateObject();
    add_num(p, "win", ar[OUTPUT_WIN]);
    add_num(p, "winGammon", ar[OUTPUT_WINGAMMON]);
    add_num(p, "winBackgammon", ar[OUTPUT_WINBACKGAMMON]);
    add_num(p, "loseGammon", ar[OUTPUT_LOSEGAMMON]);
    add_num(p, "loseBackgammon", ar[OUTPUT_LOSEBACKGAMMON]);
    return p;
}

static cJSON *
eval_json(const evalcontext *pec)
{
    cJSON *e = cJSON_CreateObject();
    cJSON_AddNumberToObject(e, "plies", pec->nPlies);
    cJSON_AddBoolToObject(e, "cubeful", pec->fCubeful);
    cJSON_AddBoolToObject(e, "prune", pec->fUsePrune);
    cJSON_AddBoolToObject(e, "deterministic", pec->fDeterministic);
    add_num(e, "noise", pec->rNoise);
    return e;
}

/* ---------------------------------------------------------------------- */
/* Exported API                                                           */
/* ---------------------------------------------------------------------- */

/* Initialise gnubg. dataDir holds gnubg.wd, gnubg_os0.bd, gnubg_ts0.bd, met/. */
API_EXPORT const char *
gnubg_api_init(const char *dataDir)
{
    cJSON *o;
    if (gnubg_web_init(dataDir, "/tmp/gnubg-home") != 0)
        return error_result("gnubg initialisation failed");
    o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);
    cJSON_AddStringToObject(o, "version", VERSION);
    return finish(o);
}

/*
 * Evaluate a position for the player on roll (before rolling).
 * Request:  {"position": "...", "match": "...", "preset"|"eval": ...}
 * Response: {"ok":true, "probs":{...}, "cubelessEquity":x, "cubefulEquity":y|null, "eval":{...}}
 * Equities are gnubg's normalised equities (per unit cube; in match play
 * gnubg's "EMG" equivalent-to-money equity), as GeneralEvaluationE returns.
 */
API_EXPORT const char *
gnubg_api_evaluate(const char *requestJson)
{
    cJSON *req = cJSON_Parse(requestJson), *o;
    api_position pos;
    evalcontext ec;
    movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES];
    float ar[NUM_ROLLOUT_OUTPUTS];
    const char *err;

    if (!req)
        return error_result("request is not valid JSON");
    if ((err = parse_position(req, &pos)) || (err = parse_eval(req, &ec, aamf))) {
        cJSON_Delete(req);
        return error_result(err);
    }
    cJSON_Delete(req);

    if (GeneralEvaluationE(ar, (ConstTanBoard) pos.anBoard, &pos.ci, &ec) < 0)
        return error_result("evaluation failed");

    o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);
    cJSON_AddItemToObject(o, "probs", probs_json(ar));
    add_num(o, "cubelessEquity", ar[OUTPUT_EQUITY]);
    if (ec.fCubeful)
        add_num(o, "cubefulEquity", ar[OUTPUT_CUBEFUL_EQUITY]);
    else
        cJSON_AddNullToObject(o, "cubefulEquity");
    cJSON_AddItemToObject(o, "eval", eval_json(&ec));
    return finish(o);
}

/*
 * Rank every legal play for the given dice, the way gnubg's "hint" does:
 * FindnSaveBestMoves with threshold arSkillLevel[SKILL_DOUBTFUL] and the move
 * filter, then RefreshMoveList to apply gnubg's tie-breaking order.
 * Moves cut by the move filter keep their lower-ply evaluation, exactly as in
 * gnubg; each move reports the plies it was evaluated at.
 *
 * Request:  {"position":"...", "match":"...", "dice":[3,1], "preset"|"eval": ...}
 * Response: {"ok":true, "moves":[{"move":"8/5 6/5", "equity":x, "diff":d,
 *            "probs":{...}, "plies":n, "cubeful":bool}, ...]}
 */
API_EXPORT const char *
gnubg_api_rank_moves(const char *requestJson)
{
    cJSON *req = cJSON_Parse(requestJson), *o, *jmoves, *jdice;
    api_position pos;
    evalcontext ec;
    movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES];
    movelist ml;
    const char *err;
    int d0, d1;

    if (!req)
        return error_result("request is not valid JSON");
    if ((err = parse_position(req, &pos)) || (err = parse_eval(req, &ec, aamf))) {
        cJSON_Delete(req);
        return error_result(err);
    }
    jdice = cJSON_GetObjectItemCaseSensitive(req, "dice");
    if (!cJSON_IsArray(jdice) || cJSON_GetArraySize(jdice) != 2) {
        cJSON_Delete(req);
        return error_result("missing \"dice\": [d1, d2]");
    }
    d0 = cJSON_GetArrayItem(jdice, 0)->valueint;
    d1 = cJSON_GetArrayItem(jdice, 1)->valueint;
    cJSON_Delete(req);
    if (d0 < 1 || d0 > 6 || d1 < 1 || d1 > 6)
        return error_result("dice must be 1..6");

    memset(&ml, 0, sizeof(ml));
    if (FindnSaveBestMoves(&ml, d0, d1, (ConstTanBoard) pos.anBoard, NULL,
                           arSkillLevel[SKILL_DOUBTFUL], &pos.ci, &ec, aamf) < 0)
        return error_result("move evaluation failed");

    if (ml.cMoves > 0) {
        int *ai = (int *) malloc(ml.cMoves * sizeof(int));
        RefreshMoveList(&ml, ai);
        free(ai);
    }

    o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);
    jmoves = cJSON_AddArrayToObject(o, "moves");
    for (unsigned int i = 0; i < ml.cMoves; i++) {
        const move *m = &ml.amMoves[i];
        char sz[FORMATEDMOVESIZE];
        cJSON *jm = cJSON_CreateObject();
        FormatMove(sz, (ConstTanBoard) pos.anBoard, m->anMove);
        cJSON_AddStringToObject(jm, "move", sz);
        add_num(jm, "equity", m->rScore);
        add_num(jm, "diff", m->rScore - ml.amMoves[0].rScore);
        cJSON_AddItemToObject(jm, "probs", probs_json(m->arEvalMove));
        cJSON_AddNumberToObject(jm, "plies", m->esMove.ec.nPlies);
        cJSON_AddBoolToObject(jm, "cubeful", m->esMove.ec.fCubeful);
        cJSON_AddItemToArray(jmoves, jm);
    }
    free(ml.amMoves);
    return finish(o);
}
