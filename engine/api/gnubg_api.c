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

#include "api_util.h"

#include <stdlib.h>
#include <string.h>

#include "positionid.h"
#include "matchid.h"
#include "drawboard.h"

/* Defined in gnubg.c by our patch engine/patches/gnubg/0001-web-init-instead-of-main.patch */
extern int gnubg_web_init(const char *szDataDir, const char *szPrefsDir);

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

    api_flush_cache();   /* results independent of earlier calls; see api_util.h */
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

    api_flush_cache();   /* results independent of earlier calls; see api_util.h */
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

/*
 * Cube decision for the player on roll (before rolling), the way gnubg's
 * cube "hint" and Python's gnubg.cfevaluate() compute it:
 * GeneralCubeDecisionE -> FindCubeDecision (which converts match-play MWCs
 * to normalised money equity, then calls FindBestCubeDecision).
 *
 * Request:  {"position":"...", "match":"...", "preset"|"eval": ...}
 *           (the evaluation is always cubeful, as in gnubg)
 * Response: {"ok":true,
 *   "equities": {"optimal":x, "noDouble":x, "doubleTake":x, "doublePass":x},
 *       normalised money equity (in match play, gnubg's "EMG" equity);
 *   "mwc": {...same keys...} in match play only (match winning chances);
 *   "decision": gnubg's cubedecision enum value (int),
 *   "recommendation": gnubg's text, e.g. "Double, take", "Too good to double, pass",
 *   "percent": gnubg's percentage shown next to the proper action, or null,
 *   "cubeAvailable": bool,
 *   "noDouble": {"probs":{...}, "cubelessEquity": x}  (cubeless evaluation),
 *   "eval": {...settings used...}}
 */
API_EXPORT const char *
gnubg_api_analyse_cube(const char *requestJson)
{
    cJSON *req = cJSON_Parse(requestJson), *o, *eq, *nd;
    api_position pos;
    evalcontext ec;
    movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES];
    float aarOutput[2][NUM_ROLLOUT_OUTPUTS];
    float arDouble[NUM_CUBEFUL_OUTPUTS];
    cubedecision cd;
    float rPercent;
    const char *err;
    static const char *keys[NUM_CUBEFUL_OUTPUTS] = { "optimal", "noDouble", "doubleTake", "doublePass" };

    if (!req)
        return error_result("request is not valid JSON");
    if ((err = parse_position(req, &pos)) || (err = parse_eval(req, &ec, aamf))) {
        cJSON_Delete(req);
        return error_result(err);
    }
    cJSON_Delete(req);
    ec.fCubeful = TRUE;         /* cube decisions are always cubeful in gnubg */

    api_flush_cache();   /* results independent of earlier calls; see api_util.h */
    if (GeneralCubeDecisionE(aarOutput, (ConstTanBoard) pos.anBoard, &pos.ci, &ec, NULL) < 0)
        return error_result("cube evaluation failed");

    cd = FindCubeDecision(arDouble, aarOutput, &pos.ci);
    rPercent = getPercent(cd, arDouble);

    o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);
    eq = cJSON_AddObjectToObject(o, "equities");
    for (int i = 0; i < NUM_CUBEFUL_OUTPUTS; i++)
        add_num(eq, keys[i], arDouble[i]);
    if (pos.ci.nMatchTo) {
        cJSON *mwc = cJSON_AddObjectToObject(o, "mwc");
        for (int i = 0; i < NUM_CUBEFUL_OUTPUTS; i++)
            add_num(mwc, keys[i], eq2mwc(arDouble[i], &pos.ci));
    }
    cJSON_AddNumberToObject(o, "decision", (int) cd);
    cJSON_AddStringToObject(o, "recommendation", GetCubeRecommendation(cd));
    if (rPercent >= 0.0f)
        add_num(o, "percent", rPercent);
    else
        cJSON_AddNullToObject(o, "percent");
    cJSON_AddBoolToObject(o, "cubeAvailable", GetDPEq(NULL, NULL, &pos.ci) != 0);
    nd = cJSON_AddObjectToObject(o, "noDouble");
    cJSON_AddItemToObject(nd, "probs", probs_json(aarOutput[0]));
    add_num(nd, "cubelessEquity", aarOutput[0][OUTPUT_EQUITY]);
    cJSON_AddItemToObject(o, "eval", eval_json(&ec));
    return finish(o);
}
