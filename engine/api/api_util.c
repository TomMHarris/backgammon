/*
 * api_util.c: helpers shared by the gnubg-web C API files. See api_util.h.
 *
 * Line references are to gnubg 1.08.003 (engine/build/src/gnubg).
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
#include "matchequity.h"

void
api_flush_cache(void)
{
    EvalCacheFlush();
}

/* ---------------------------------------------------------------------- */
/* Engine state                                                           */
/* ---------------------------------------------------------------------- */

static engine_state state = ENGINE_NOT_STARTED;

void
api_set_engine_state(engine_state s)
{
    state = s;
}

engine_state
api_get_engine_state(void)
{
    return state;
}

const char *
api_not_ready(void)
{
    switch (state) {
    case ENGINE_READY:
        return NULL;
    case ENGINE_FAILED:
        return error_result("engine initialisation failed; this engine instance cannot be used, "
                            "create a new one");
    default:
        return error_result("engine not initialised: call gnubg_api_init first");
    }
}

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
/* Request parsing: JSON and typed fields                                 */
/* ---------------------------------------------------------------------- */

/* Error messages that include a field name are built here. The text is
 * copied into the result by error_result() before anything else runs. */
static char err_buf[256];

static const char *
field_error(const char *name, const char *requirement)
{
    snprintf(err_buf, sizeof err_buf, "\"%s\" must be %s", name, requirement);
    return err_buf;
}

cJSON *
parse_request(const char *json, const char **err)
{
    /* require_null_terminated = 1: reject anything after the JSON value
     * (cJSON_Parse would accept '{...} xyz'). */
    cJSON *req = cJSON_ParseWithOpts(json ? json : "{}", NULL, 1);
    if (!req) {
        *err = "request is not valid JSON";
        return NULL;
    }
    if (!cJSON_IsObject(req)) {
        cJSON_Delete(req);
        *err = "request must be a JSON object";
        return NULL;
    }
    return req;
}

/* A JSON number that is a whole number (2 and 2.0 are; 2.5, 1e400 are not). */
static int
is_integer(const cJSON *j)
{
    return cJSON_IsNumber(j) && isfinite(j->valuedouble) && j->valuedouble == floor(j->valuedouble);
}

const char *
get_int_field(const cJSON *obj, const char *name, int lo, int hi, int *out)
{
    const cJSON *j = cJSON_GetObjectItemCaseSensitive(obj, name);
    char requirement[64];
    if (!j)
        return NULL;
    if (!is_integer(j) || j->valuedouble < lo || j->valuedouble > hi) {
        snprintf(requirement, sizeof requirement, "an integer from %d to %d", lo, hi);
        return field_error(name, requirement);
    }
    *out = (int) j->valuedouble;
    return NULL;
}

const char *
get_bool_field(const cJSON *obj, const char *name, int *out)
{
    const cJSON *j = cJSON_GetObjectItemCaseSensitive(obj, name);
    if (!j)
        return NULL;
    if (!cJSON_IsBool(j))
        return field_error(name, "true or false");
    *out = cJSON_IsTrue(j);
    return NULL;
}

const char *
get_string_field(const cJSON *obj, const char *name, const char **out)
{
    const cJSON *j = cJSON_GetObjectItemCaseSensitive(obj, name);
    if (!j)
        return NULL;
    if (!cJSON_IsString(j))
        return field_error(name, "a string");
    *out = j->valuestring;
    return NULL;
}

const char *
get_dice_field(const cJSON *obj, const char *name, int *present, int anDice[2])
{
    const cJSON *j = cJSON_GetObjectItemCaseSensitive(obj, name);
    *present = 0;
    if (!j)
        return NULL;
    if (!cJSON_IsArray(j) || cJSON_GetArraySize(j) != 2)
        return field_error(name, "two dice, e.g. [3, 1]");
    for (int i = 0; i < 2; i++) {
        const cJSON *d = cJSON_GetArrayItem(j, i);
        if (!is_integer(d) || d->valuedouble < 1 || d->valuedouble > 6)
            return field_error(name, "two integers from 1 to 6, e.g. [3, 1]");
        anDice[i] = (int) d->valuedouble;
    }
    *present = 1;
    return NULL;
}

/* ---------------------------------------------------------------------- */
/* gnubg position and match IDs                                           */
/* ---------------------------------------------------------------------- */

/* Every character is in gnubg's base64 alphabet (positionid.c:351 Base64(),
 * which maps anything else to 255 instead of rejecting it). */
static int
is_base64(const char *sz)
{
    for (; *sz; sz++)
        if (Base64((unsigned char) *sz) == 255)
            return 0;
    return 1;
}

const char *
decode_position_id(const char *sz, int fInPlay, TanBoard anBoard)
{
    unsigned int an[2] = { 0, 0 };

    /* PositionFromID (positionid.c:372) reads at most 14 characters,
     * zero-fills shorter strings and ignores the rest, so check the length
     * and alphabet ourselves. */
    if (strlen(sz) != L_POSITIONID)
        return "invalid position ID: it must be exactly 14 characters";
    if (!is_base64(sz))
        return "invalid position ID: only A-Z, a-z, 0-9, + and / are allowed";
    /* gnubg's own check (CheckPosition, positionid.c:286): at most 15
     * chequers a side, no point held by both sides, not both sides on the
     * bar against closed boards. This is what "set board <id>" checks. */
    if (!PositionFromID(anBoard, sz))
        return "invalid position ID: not a legal position (over 15 chequers on a side, "
            "both sides on one point, or both on the bar against closed boards)";
    /* Stricter than desktop: the ID must be the one gnubg writes for this
     * board. Otherwise it has stray bits that the decoder silently drops
     * (positionid.c:182 stops at the first excess chequer). */
    if (strcmp(PositionID((ConstTanBoard) anBoard), sz) != 0)
        return "invalid position ID: not in gnubg's canonical form (unused bits are set)";
    for (int i = 0; i < 25; i++) {
        an[0] += anBoard[0][i];
        an[1] += anBoard[1][i];
    }
    if (an[0] == 0 && an[1] == 0)
        return "invalid position ID: there are no chequers on the board";
    if (fInPlay && (an[0] == 0 || an[1] == 0))
        return "invalid position ID: a side has borne off all its chequers (the game is over)";
    return NULL;
}

void
default_match(api_match *pm)
{
    memset(pm, 0, sizeof *pm);
    pm->fCubeOwner = -1;        /* centred */
    pm->nCube = 1;
    pm->fJacoby = fJacoby;      /* gnubg's current Jacoby setting */
    pm->gs = GAME_PLAYING;
}

const char *
decode_match_id(const char *sz, api_match *pm)
{
    int anDice[2];

    /* MatchFromID (matchid.c:233) zero-fills short strings and decodes
     * unknown characters as 255 without complaint; an all-zero key is a
     * valid money game. So "" would silently mean "cube owned by player 0". */
    if (strlen(sz) != L_MATCHID)
        return "invalid match ID: it must be exactly 12 characters";
    if (!is_base64(sz))
        return "invalid match ID: only A-Z, a-z, 0-9, + and / are allowed";

    default_match(pm);
    /* gnubg's checks (MatchFromKey, matchid.c:176-230): dice 0..6, match
     * length <= 64, scores <= match length, no Crawford flag in money play.
     * MatchFromID returns 0 on success, -1 on error. */
    if (MatchFromID(pm->anDice, &pm->fTurn, &pm->fResigned, &pm->fDoubled, &pm->fMove,
                    &pm->fCubeOwner, &pm->fCrawford, &pm->nMatchTo, pm->anScore, &pm->nCube,
                    &pm->fJacoby, &pm->gs, sz) < 0)
        return "invalid match ID: gnubg rejects it (dice, match length or score out of range, "
            "or a Crawford game in money play)";
    anDice[0] = (int) pm->anDice[0];
    anDice[1] = (int) pm->anDice[1];
    if ((anDice[0] == 0) != (anDice[1] == 0))
        return "invalid match ID: only one die is set";
    /* 3 bits are stored, but gnubg's gamestate has 5 values (gnubg-types.h). */
    if (pm->gs > GAME_DROP)
        return "invalid match ID: unknown game state";

    /* The cube. A match ID can hold cubes up to 2^15.
     * - Money: desktop only accepts powers of 2 up to MAX_CUBE = 4096
     *   (set.c:924 SetCubeValue; a bigger cube in "set matchid" is ignored).
     * - Match play: gnubg's gammon-price tables have MAXCUBELEVEL = 7 levels
     *   (cube 1..64, matchequity.h:27); a bigger cube would be read past the
     *   end of the table (eval.c:3303-3310), which SetCubeInfo does not check. */
    if (pm->nMatchTo == 0 && pm->nCube > MAX_CUBE)
        return "invalid match ID: the cube is above 4096, gnubg's maximum";
    if (pm->nMatchTo > 0 && LogCube(pm->nCube) >= MAXCUBELEVEL)
        return "invalid match ID: the cube is above 64, gnubg's maximum in match play";

    /* Normalise exactly as desktop "set matchid" does (play.c SetMatchID): */
    if (pm->fDoubled) {
        /* play.c:4159-4163: a pending double is stepped back to the doubler
         * on roll, before doubling. */
        pm->fMove = pm->fTurn = !pm->fTurn;
        pm->fDoubled = 0;
    }
    /* play.c:4166-4167 and 4184-4185: no Crawford game in a 1-point match,
     * and the Crawford flag only counts when a player is 1-away. */
    if (pm->nMatchTo == 1)
        pm->fCrawford = 0;
    pm->fCrawford = pm->fCrawford
        && (pm->anScore[0] == pm->nMatchTo - 1 || pm->anScore[1] == pm->nMatchTo - 1);
    return NULL;
}

/*
 * Read "position" (gnubg position ID, required) and "match" (gnubg match ID,
 * optional). Without a match ID we use a money game, cube 1 and centred,
 * player 0 on roll, with gnubg's current Jacoby setting.
 * Returns NULL on success, or an error message.
 */
const char *
parse_position(const cJSON *req, api_position *pos)
{
    const char *szPos = NULL, *szMatch = NULL, *err;
    api_match m;

    if ((err = get_string_field(req, "position", &szPos)))
        return err;
    if (!szPos)
        return "missing \"position\" (a gnubg position ID)";
    if ((err = decode_position_id(szPos, TRUE, pos->anBoard)))
        return err;

    if ((err = get_string_field(req, "match", &szMatch)))
        return "\"match\" must be a string (a gnubg match ID; leave it out for a money game)";
    if (szMatch) {
        if ((err = decode_match_id(szMatch, &m)))
            return err;
    } else
        default_match(&m);

    pos->anDice[0] = m.anDice[0];
    pos->anDice[1] = m.anDice[1];
    /* Same call as gnubg's GetMatchStateCubeInfo() (gnubg.c:1329), using its
     * global nBeavers. */
    if (SetCubeInfo(&pos->ci, m.nCube, m.fCubeOwner, m.fMove, m.nMatchTo, m.anScore,
                    m.fCrawford, m.fJacoby, nBeavers, bgvDefault) < 0)
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

const char *
apply_eval_fields(const cJSON *obj, evalcontext *pec)
{
    const cJSON *j;
    const char *err;
    int n, f;

    n = (int) pec->nPlies;
    if ((err = get_int_field(obj, "plies", 0, 4, &n)))
        return err;
    pec->nPlies = (unsigned int) n;

    f = pec->fCubeful;
    if ((err = get_bool_field(obj, "cubeful", &f)))
        return err;
    pec->fCubeful = f;

    f = pec->fUsePrune;
    if ((err = get_bool_field(obj, "prune", &f)))
        return err;
    pec->fUsePrune = f;

    f = pec->fDeterministic;
    if ((err = get_bool_field(obj, "deterministic", &f)))
        return err;
    pec->fDeterministic = f;

    /* Noise: desktop "set ... noise" refuses negative values (set.c
     * CommandSetEvalNoise). Negative noise would add no noise but would turn
     * off pruning and the cache (eval.c tests rNoise != 0), changing results. */
    if ((j = cJSON_GetObjectItemCaseSensitive(obj, "noise"))) {
        if (!cJSON_IsNumber(j) || !isfinite(j->valuedouble) || j->valuedouble < 0.0)
            return field_error("noise", "a number >= 0");
        pec->rNoise = (float) j->valuedouble;
    }
    return NULL;
}

/*
 * Fill evaluation context + move filter from the request.
 *   "preset": "expert" | "world class" | ...   (gnubg's predefined settings)
 * or
 *   "eval": {"plies": 2, "cubeful": true, "prune": true, "noise": 0.0, "deterministic": true}
 *           (fields left out keep gnubg's default chequer-play value)
 * not both. Default: gnubg's current chequer-play settings (esEvalChequer)
 * and move filter.
 */
const char *
parse_eval(const cJSON *req, evalcontext *pec, movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES])
{
    static const char *eval_keys[] = { "plies", "cubeful", "prune", "deterministic", "noise" };
    const cJSON *jpreset = cJSON_GetObjectItemCaseSensitive(req, "preset");
    const cJSON *jeval = cJSON_GetObjectItemCaseSensitive(req, "eval");
    const cJSON *j;

    *pec = GetEvalChequer()->ec;
    memcpy(aamf, *GetEvalMoveFilter(), sizeof(movefilter) * MAX_FILTER_PLIES * MAX_FILTER_PLIES);

    if (jpreset && jeval)
        return "give either \"preset\" or \"eval\", not both";
    if (jpreset) {
        int i;
        if (!cJSON_IsString(jpreset))
            return field_error("preset", "a string, e.g. \"world class\"");
        if ((i = find_preset(jpreset->valuestring)) < 0)
            return "unknown preset";
        *pec = aecSettings[i];
        if (aiSettingsMoveFilter[i] >= 0)
            memcpy(aamf, aaamfMoveFilterSettings[aiSettingsMoveFilter[i]],
                   sizeof(movefilter) * MAX_FILTER_PLIES * MAX_FILTER_PLIES);
    } else if (jeval) {
        if (!cJSON_IsObject(jeval))
            return field_error("eval", "an object, e.g. {\"plies\": 2, \"cubeful\": true}");
        /* A misspelt field (e.g. "ply") would otherwise be ignored silently. */
        cJSON_ArrayForEach(j, jeval) {
            size_t k;
            for (k = 0; k < G_N_ELEMENTS(eval_keys); k++)
                if (!strcmp(j->string, eval_keys[k]))
                    break;
            if (k == G_N_ELEMENTS(eval_keys)) {
                snprintf(err_buf, sizeof err_buf, "unknown field \"%s\" in \"eval\" "
                         "(allowed: plies, cubeful, prune, deterministic, noise)", j->string);
                return err_buf;
            }
        }
        return apply_eval_fields(jeval, pec);
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


/* ---------------------------------------------------------------------- */
/* Stand-ins for gnubg objects we do not link                             */
/* ---------------------------------------------------------------------- */

/*
 * build.sh leaves out external*.o (play against an external bot over a
 * socket) and openurl.o (start a web browser). Nothing in the API calls
 * them, but gnubg's command table (gnubg.c) refers to them, and that table
 * becomes reachable once we call command functions such as CommandLoadMatch
 * (e.g. via SmartSit -> CommandSwapPlayers -> UserCommand). wasm-ld only
 * reports undefined symbols that are reachable, so these minimal versions
 * keep the link working. They fail cleanly if ever reached.
 */
#include <errno.h>
#include <sys/socket.h>

static gchar *web_browser = NULL;

extern void
CommandExternal(char *UNUSED(sz))
{
    outputl("External players are not available in gnubg-web.");
}

extern int
ExternalSocket(struct sockaddr **UNUSED(ppsa), socklen_t * UNUSED(pcb), char *UNUSED(sz))
{
    errno = ENOSYS;
    return -1;
}

extern int
ExternalRead(int UNUSED(h), char *UNUSED(pch), size_t UNUSED(cch))
{
    errno = ENOSYS;
    return -1;
}

extern int
ExternalWrite(int UNUSED(h), char *UNUSED(pch), size_t UNUSED(cch))
{
    errno = ENOSYS;
    return -1;
}

extern void
OpenURL(const char *UNUSED(szURL))
{
}

/* Same behaviour as openurl.c (just stores the setting). */
extern char *
set_web_browser(const char *sz)
{
    g_free(web_browser);
    web_browser = g_strdup(sz ? sz : "");
    return web_browser;
}

extern const gchar *
get_web_browser(void)
{
    return web_browser ? web_browser : "";
}
