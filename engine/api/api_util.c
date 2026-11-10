/*
 * api_util.c: helpers shared by the gnubg-web C API files. See api_util.h.
 *
 * Copyright (C) 2026 gnubg-web contributors. GPL v3 or later (see LICENSE).
 */
#include "api_util.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "positionid.h"
#include "matchid.h"

/* ---------------------------------------------------------------------- */
/* Result buffer                                                          */
/* ---------------------------------------------------------------------- */

static char *last_result = NULL;  /* the one result buffer (see api_util.h) */

/* Serialise `obj` into the result buffer, free `obj`, and return the string. */
const char *
finish(cJSON *obj)
{
    free(last_result);
    last_result = cJSON_PrintUnformatted(obj);
    cJSON_Delete(obj);
    return last_result;
}

const char *
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
void
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


/*
 * Read "position" (gnubg position ID, required) and "match" (gnubg match ID,
 * optional). Without a match ID we use a money game, cube 1 and centred,
 * player 0 on roll, with gnubg's current Jacoby setting.
 * Returns NULL on success, or an error message.
 */
const char *
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
        /* MatchFromID returns 0 on success, -1 on error (matchid.c) */
        if (MatchFromID(pos->anDice, &fTurn, &fResigned, &fDoubled, &fMove, &fCubeOwner,
                         &fCrawford, &nMatchTo, anScore, &nCube, &fJacobyLocal, &gs, jmatch->valuestring) < 0)
            return "invalid match ID";
    }

    /* Same call as gnubg's GetMatchStateCubeInfo(), using its global nBeavers. */
    if (SetCubeInfo(&pos->ci, nCube, fCubeOwner, fMove, nMatchTo, anScore,
                    fCrawford, fJacobyLocal, nBeavers, bgvDefault) < 0)
        return "invalid cube/score combination";
    return NULL;
}

/* Index into gnubg's aszSettings/aecSettings for a preset name, or -1. */
int
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
const char *
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
cJSON *
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

cJSON *
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

