/*
 * gnubg_api.c: a small JSON-in / JSON-out C API over GNU Backgammon's engine.
 *
 * Each exported function takes a JSON request string and returns a JSON
 * response string. The returned pointer stays valid until the next API call
 * (we keep one result buffer and free the previous one), so callers must copy
 * it out straight away. The engine is single-threaded, so this is safe.
 *
 * We call gnubg's own C functions directly (rank_moves uses the same ones as
 * its "hint" command, analyse_cube the same as its cube "hint"). We never
 * drive gnubg by sending text commands. See the comment on each function for
 * how its numbers relate to what desktop gnubg shows.
 *
 * Line references are to gnubg 1.08.003 (engine/build/src/gnubg).
 *
 * Copyright (C) 2026 gnubg-web contributors. GPL v3 or later (see LICENSE).
 */

#include "api_util.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "bearoff.h"
#include "drawboard.h"
#include "matchequity.h"
#include "matchid.h"
#include "positionid.h"

/* Defined in gnubg.c by our patch engine/patches/gnubg/0001-web-init-instead-of-main.patch.
 * It returns -1 only if gnubg's home directory cannot be created. Other
 * problems either abort the program with exit() (e.g. unreadable neural net
 * weights, eval.c:737-740) or make gnubg quietly use a fallback (see
 * check_data_loaded below). */
extern int gnubg_web_init(const char *szDataDir, const char *szPrefsDir);

/* The data directory the engine was initialised from (for repeated init calls). */
static char *init_data_dir = NULL;

/* ---------------------------------------------------------------------- */
/* Initialisation                                                         */
/* ---------------------------------------------------------------------- */

/*
 * The data files gnubg-web requires. Desktop gnubg quietly falls back to
 * something else when one of them is missing, and the results change:
 *   gnubg.wd             neural net weights (missing: exit(), eval.c:737-740)
 *   gnubg_os0.bd         one-sided bearoff database (missing: a heuristic
 *                        approximation, eval.c:646-651)
 *   gnubg_ts0.bd         two-sided bearoff database (missing: not used,
 *                        only a warning, eval.c:653-665)
 *   met/Kazaross-XG2.xml match equity table (missing: a built-in table,
 *                        matchequity.c:1511-1513)
 */
static const char *const required_files[] = {
    "gnubg.wd", "gnubg_os0.bd", "gnubg_ts0.bd", "met/Kazaross-XG2.xml"
};

/* NULL if dataDir holds every required file (non-empty), else an error. */
static const char *
check_data_files(const char *dataDir)
{
    static char msg[512];
    for (size_t i = 0; i < G_N_ELEMENTS(required_files); i++) {
        char *path = g_build_filename(dataDir, required_files[i], NULL);
        struct stat st;
        int ok = stat(path, &st) == 0 && S_ISREG(st.st_mode) && st.st_size > 0;
        g_free(path);
        if (!ok) {
            snprintf(msg, sizeof msg, "missing data file %s in %s", required_files[i], dataDir);
            return msg;
        }
    }
    return NULL;
}

/* After gnubg_web_init: did gnubg really load the files, or fall back? */
static const char *
check_data_loaded(void)
{
    /* BearoffInit with BO_HEURISTIC sets fHeuristic (bearoff.c:801-805). */
    if (!pbc1 || pbc1->bt != BEAROFF_ONESIDED || pbc1->fHeuristic)
        return "gnubg could not read gnubg_os0.bd (it would have used a heuristic instead)";
    if (!pbc2 || pbc2->bt != BEAROFF_TWOSIDED)
        return "gnubg could not read gnubg_ts0.bd";
    /* readMET records the file it read (matchequity.c:1070); the built-in
     * fallback getDefaultMET names "met/zadeh.xml" (matchequity.c:826). */
    if (!miCurrent.szFileName || !g_str_has_suffix(miCurrent.szFileName, "Kazaross-XG2.xml"))
        return "gnubg could not read met/Kazaross-XG2.xml (it would have used a built-in table)";
    return NULL;
}

static const char *
init_ok(int fAlready)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);
    cJSON_AddStringToObject(o, "version", VERSION);
    if (fAlready)
        cJSON_AddBoolToObject(o, "alreadyInitialised", 1);
    return finish(o);
}

/* ---------------------------------------------------------------------- */
/* Exported API                                                           */
/* ---------------------------------------------------------------------- */

/*
 * Initialise gnubg. dataDir holds gnubg.wd, gnubg_os0.bd, gnubg_ts0.bd and
 * met/Kazaross-XG2.xml. Response: {"ok":true, "version":"1.08.003"}.
 *
 * - A missing or empty data file: {"ok":false} before gnubg is touched; the
 *   instance stays usable, so init can be retried once the file is there.
 * - Any later failure (gnubg cannot read a file, or aborts with exit(),
 *   which reaches JavaScript as an exception): this module instance is
 *   unusable and every call returns an error. Create a new instance.
 * - Calling init again after success does not re-initialise (that would
 *   reload every data file and leak ~11 MB each time): with the same
 *   dataDir it returns {"ok":true, "version", "alreadyInitialised":true};
 *   with another dataDir it is an error.
 */
API_EXPORT const char *
gnubg_api_init(const char *dataDir)
{
    const char *err;
    char msg[512];

    switch (api_get_engine_state()) {
    case ENGINE_READY:
        if (dataDir && strcmp(dataDir, init_data_dir) == 0)
            return init_ok(TRUE);
        snprintf(msg, sizeof msg, "already initialised from %s; create a new engine instance "
                 "to use other data files", init_data_dir);
        return error_result(msg);
    case ENGINE_FAILED:
        return api_not_ready();
    case ENGINE_NOT_STARTED:
        break;
    }
    if (!dataDir || !*dataDir)
        return error_result("missing data directory");
    if ((err = check_data_files(dataDir)))
        return error_result(err);

    /* From here on gnubg's global state changes and cannot be undone. Mark
     * the engine failed until init has fully succeeded, so that an exit()
     * inside gnubg also leaves it marked failed. */
    api_set_engine_state(ENGINE_FAILED);
    if (gnubg_web_init(dataDir, "/tmp/gnubg-home") != 0)
        return error_result("gnubg initialisation failed (could not create its home directory)");
    if ((err = check_data_loaded()))
        return error_result(err);
    init_data_dir = g_strdup(dataDir);
    api_set_engine_state(ENGINE_READY);
    return init_ok(FALSE);
}

/*
 * Evaluate a position for the player on roll (before rolling), with gnubg's
 * GeneralEvaluationE (eval.c), the function behind Python's gnubg.evaluate.
 * Request:  {"position": "...", "match": "...", "preset"|"eval": ...}
 * Response: {"ok":true, "probs":{...}, "cubelessEquity":x,
 *            "cubefulOptimal":y|null, "cubefulEquity":z|null, "eval":{...}}
 *
 * - cubelessEquity: gnubg's UtilityME: cubeless equity from the outcome
 *   probabilities, per unit cube (in match play the money-equivalent "EMG"
 *   value). Desktop "eval" shows this in its "Equity" column for money play.
 * - cubefulOptimal (cubeful evaluations only): normalised cubeful equity
 *   after the on-roll player's BEST cube action now: GeneralEvaluationE
 *   evaluates with fTop = FALSE (eval.c:5938), so the player on roll may
 *   double at the root, giving max(no double, min(double/take, double/pass)).
 *   Per unit cube; in match play converted from MWC with mwc2eq (as
 *   ScoreMove does for rank_moves), so it is on the same scale as rank_moves
 *   "equity" and analyse_cube "equities".
 *   This is NOT desktop "eval"'s "Cubeful" column whenever doubling is right:
 *   desktop shows the no-double value (format.c:1195-1224 uses
 *   GeneralCubeDecisionE). Use analyse_cube for that: its equities.noDouble
 *   is desktop eval's "Cubeful" number and equities.optimal is the best
 *   action (same quantity as cubefulOptimal, from gnubg's cube-decision
 *   routine; the two were bit-identical on all 215 corpus requests tried).
 *   Checked against native gnubg 2-ply: analyse_cube noDouble equals desktop
 *   cube "hint"'s No double on 14/14 positions, and desktop "eval"'s
 *   Cubeful on 13/14. The exception is desktop's own call history: "eval"
 *   computes 0, 1 and 2 ply in turn with one cache, which moved its 2-ply
 *   value by 0.005 there (see api_flush_cache in api_util.h).
 * - cubefulEquity: GeneralEvaluationE's raw cubeful output, kept for
 *   compatibility: equal to cubefulOptimal in money play, but in match play
 *   a match winning chance (0..1), not an equity.
 * Both cubeful fields are null for a cubeless evaluation.
 */
API_EXPORT const char *
gnubg_api_evaluate(const char *requestJson)
{
    cJSON *req, *o;
    api_position pos;
    evalcontext ec;
    movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES];
    float ar[NUM_ROLLOUT_OUTPUTS];
    const char *err;

    API_REQUIRE_READY();
    if (!(req = parse_request(requestJson, &err)))
        return error_result(err);
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
    if (ec.fCubeful) {
        float r = ar[OUTPUT_CUBEFUL_EQUITY];
        add_num(o, "cubefulOptimal", pos.ci.nMatchTo ? mwc2eq(r, &pos.ci) : r);
        add_num(o, "cubefulEquity", r);
    } else {
        cJSON_AddNullToObject(o, "cubefulOptimal");
        cJSON_AddNullToObject(o, "cubefulEquity");
    }
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
 * Dice order: the dice are passed to gnubg in the order given, as desktop
 * "hint" passes the dice in the order they were rolled (gnubg.c:5563).
 * gnubg generates the plays for (d1, d2) first and then (d2, d1), and 0-ply
 * scores them incrementally in that order, so [6, 2] and [2, 6] give the same
 * plays and ranking but can differ in the last float bits (and so in the
 * order of exactly tied plays). Match IDs, saved matches and analysis store
 * the larger die first (matchid.c:159-165, play.c:1410-1411); use that order
 * to reproduce them.
 *
 * Request:  {"position":"...", "match":"...", "dice":[3,1], "preset"|"eval": ...}
 * Response: {"ok":true, "moves":[{"move":"8/5 6/5", "equity":x, "diff":d,
 *            "probs":{...}, "plies":n, "cubeful":bool}, ...], "eval":{...}}
 * "equity" is gnubg's move score: cubeful equity when the evaluation is
 * cubeful (normalised; in match play the EMG value), else cubeless.
 */
API_EXPORT const char *
gnubg_api_rank_moves(const char *requestJson)
{
    cJSON *req, *o, *jmoves;
    api_position pos;
    evalcontext ec;
    movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES];
    movelist ml;
    const char *err;
    int anDice[2], fDice;

    API_REQUIRE_READY();
    if (!(req = parse_request(requestJson, &err)))
        return error_result(err);
    if ((err = parse_position(req, &pos)) || (err = parse_eval(req, &ec, aamf))
        || (err = get_dice_field(req, "dice", &fDice, anDice))) {
        cJSON_Delete(req);
        return error_result(err);
    }
    cJSON_Delete(req);
    if (!fDice)
        return error_result("missing \"dice\": [d1, d2]");

    api_flush_cache();   /* results independent of earlier calls; see api_util.h */
    memset(&ml, 0, sizeof(ml));
    if (FindnSaveBestMoves(&ml, anDice[0], anDice[1], (ConstTanBoard) pos.anBoard, NULL,
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
    cJSON_AddItemToObject(o, "eval", eval_json(&ec));
    return finish(o);
}

/*
 * Cube decision for the player on roll (before rolling), the way gnubg's
 * cube "hint" and Python's gnubg.cfevaluate() compute it:
 * GeneralCubeDecisionE -> FindCubeDecision (which converts match-play MWCs
 * to normalised money equity, then calls FindBestCubeDecision).
 * equities.noDouble is the "Cubeful" number desktop "eval" shows (format.c:
 * 1195-1224 evaluates with the same GeneralCubeDecisionE).
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
    cJSON *req, *o, *eq, *nd;
    api_position pos;
    evalcontext ec;
    movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES];
    float aarOutput[2][NUM_ROLLOUT_OUTPUTS];
    float arDouble[NUM_CUBEFUL_OUTPUTS];
    cubedecision cd;
    float rPercent;
    const char *err;
    static const char *keys[NUM_CUBEFUL_OUTPUTS] = { "optimal", "noDouble", "doubleTake", "doublePass" };

    API_REQUIRE_READY();
    if (!(req = parse_request(requestJson, &err)))
        return error_result(err);
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
