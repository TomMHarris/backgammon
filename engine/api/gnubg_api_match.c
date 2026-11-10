/*
 * gnubg_api_match.c: match import, analysis and export for the gnubg-web
 * JSON C API (see api_util.h for the conventions and MATCH_API.md for the
 * JSON shapes).
 *
 * Everything here goes through gnubg's own C functions:
 *   - loading:   CommandLoadMatch (SGF) / CommandImportMat (.mat), the C
 *                functions behind "load match" and "import mat";
 *   - analysis:  CommandAnalyseMatch ("analyse match"), or ChangeGame +
 *                CommandAnalyseGame ("analyse game") for one game at a time;
 *                both run gnubg's AnalyzeGame/AnalyzeMove with the global
 *                analysis settings (esAnalysisChequer, esAnalysisCube,
 *                aamfAnalysis, ecLuck, arSkillLevel, arLuckLevel, ...);
 *   - results:   the move records gnubg filled in (move lists, cube
 *                evaluations, luck, skill marks), FindCubeDecision, eq2mwc;
 *   - statistics: updateStatisticsMatch (what "show statistics match"
 *                calls), getMWCFromError, GetRating, getLuckRating, the FIBS
 *                rating functions, and DumpStatcontext for the exact text;
 *   - export:    CommandSaveMatch ("save match", SGF with analysis) and
 *                CommandExportMatchMat ("export match mat").
 * Files are exchanged through Emscripten's in-memory filesystem (MEMFS).
 *
 * gnubg prints board diagrams and messages while it runs commands; we
 * capture stdout/stderr around each command, drop stdout, and return what
 * gnubg wrote to stderr (its errors and warnings) in a "messages" field.
 *
 * Copyright (C) 2026 gnubg-web contributors. GPL v3 or later (see LICENSE).
 */

#include "api_util.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "analysis.h"
#include "drawboard.h"
#include "format.h"
#include "matchequity.h"
#include "matchid.h"
#include "positionid.h"
#include "rollout.h"

#define TMP_DIR "/tmp"
#define TMP_IMPORT TMP_DIR "/gnubg-web-import"
#define TMP_EXPORT TMP_DIR "/gnubg-web-export"
#define TMP_OUTPUT TMP_DIR "/gnubg-web-output"

/* ---------------------------------------------------------------------- */
/* Capturing gnubg's console output                                       */
/* ---------------------------------------------------------------------- */

static int cap_saved_out = -1, cap_saved_err = -1, cap_fd_out = -1, cap_fd_err = -1;

/*
 * Redirect stdout and stderr into MEMFS files until capture_end(). gnubg
 * prints boards and progress to stdout (discarded) and its errors and
 * warnings to stderr (returned to the caller as "messages").
 */
static void
capture_begin(void)
{
    fflush(stdout);
    fflush(stderr);
    cap_fd_out = open(TMP_OUTPUT ".out", O_WRONLY | O_CREAT | O_TRUNC, 0600);
    cap_fd_err = open(TMP_OUTPUT ".err", O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (cap_fd_out < 0 || cap_fd_err < 0)
        return;
    cap_saved_out = dup(STDOUT_FILENO);
    cap_saved_err = dup(STDERR_FILENO);
    dup2(cap_fd_out, STDOUT_FILENO);
    dup2(cap_fd_err, STDERR_FILENO);
}

/* Restore stdout/stderr; return what gnubg wrote to stderr (g_free it) or NULL. */
static char *
capture_end(void)
{
    char *text = NULL;
    gsize len = 0;

    if (cap_fd_out < 0 || cap_fd_err < 0)
        return NULL;
    fflush(stdout);
    fflush(stderr);
    dup2(cap_saved_out, STDOUT_FILENO);
    dup2(cap_saved_err, STDERR_FILENO);
    close(cap_saved_out);
    close(cap_saved_err);
    close(cap_fd_out);
    close(cap_fd_err);
    cap_fd_out = cap_fd_err = cap_saved_out = cap_saved_err = -1;
    if (!g_file_get_contents(TMP_OUTPUT ".err", &text, &len, NULL))
        text = NULL;
    unlink(TMP_OUTPUT ".out");
    unlink(TMP_OUTPUT ".err");
    return text;
}

/* Add gnubg's captured messages (if any) to a result object; frees text. */
static void
add_messages(cJSON *o, char *text)
{
    if (text) {
        g_strstrip(text);
        if (*text)
            cJSON_AddStringToObject(o, "messages", text);
    }
    g_free(text);
}

/* ---------------------------------------------------------------------- */
/* Small helpers                                                          */
/* ---------------------------------------------------------------------- */

static int
match_loaded(void)
{
    return plGame != NULL && !ListEmpty(&lMatch);
}

static int
count_games(void)
{
    int n = 0;
    for (listOLD *pl = lMatch.plNext; pl != &lMatch; pl = pl->plNext)
        n++;
    return n;
}

/* The move list of game i (0-based), or NULL. */
static listOLD *
game_list(int i)
{
    int n = 0;
    for (listOLD *pl = lMatch.plNext; pl != &lMatch; pl = pl->plNext, n++)
        if (n == i)
            return pl->p;
    return NULL;
}

static moverecord *
game_info(const listOLD *plG)
{
    moverecord *pmr = plG->plNext->p;
    g_assert(pmr && pmr->mt == MOVE_GAMEINFO);
    return pmr;
}

static cJSON *
int_pair(int a, int b)
{
    cJSON *arr = cJSON_CreateArray();
    cJSON_AddItemToArray(arr, cJSON_CreateNumber(a));
    cJSON_AddItemToArray(arr, cJSON_CreateNumber(b));
    return arr;
}

/* gnubg's rating / luck-rating labels without the "rating|" context prefix. */
static const char *
rating_text(ratingtype rt)
{
    return Q_(aszRating[rt]);
}

static const char *
luck_rating_text(lucktype lt)
{
    return Q_(aszLuckRating[lt]);
}

/* Machine labels: gnubg's own command words for skill and luck marks. */
static const char *
skill_label(skilltype st)
{
    return aszSkillTypeCommand[st];     /* "verybad" "bad" "doubtful" "none" */
}

static const char *
luck_label(lucktype lt)
{
    return aszLuckTypeCommand[lt];      /* "veryunlucky" "unlucky" "none" "lucky" "verylucky" */
}

static const char *
record_type(movetype mt)
{
    switch (mt) {
    case MOVE_GAMEINFO: return "gameinfo";
    case MOVE_NORMAL: return "move";
    case MOVE_DOUBLE: return "double";
    case MOVE_TAKE: return "take";
    case MOVE_DROP: return "drop";
    case MOVE_RESIGN: return "resign";
    case MOVE_SETBOARD: return "setboard";
    case MOVE_SETDICE: return "setdice";
    case MOVE_SETCUBEVAL: return "setcubevalue";
    case MOVE_SETCUBEPOS: return "setcubeposition";
    }
    return "unknown";
}

/*
 * An error/luck value in gnubg's native units plus its "cost", exactly as
 * analysis.c's updateStatcontext computes it: in match play the change in
 * match winning chances (eq2mwc(r) - eq2mwc(0)), in money play the
 * normalised value times the cube.
 */
static float
cost_of(float r, const matchstate *pms, const cubeinfo *pci)
{
    return pms->nMatchTo ? eq2mwc(r, pci) - eq2mwc(0.0f, pci) : (float) pms->nCube * r;
}

static void
add_value_pair(cJSON *o, const char *name, float r, const matchstate *pms, const cubeinfo *pci)
{
    cJSON *v = cJSON_AddObjectToObject(o, name);
    add_num(v, "equity", r);
    add_num(v, pms->nMatchTo ? "mwc" : "points", cost_of(r, pms, pci));
}

/* ---------------------------------------------------------------------- */
/* Analysis settings                                                      */
/* ---------------------------------------------------------------------- */

/* gnubg's built-in analysis defaults, snapshotted before we first change them. */
static struct {
    int saved;
    evalsetup esChequer, esCube;
    movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES];
    evalcontext ecLuck;
    float arSkill[N_SKILLS], arLuck[N_LUCKS];
    int fCube, fDice, fMove, afPlayers[2];
} defaults;

static void
save_defaults(void)
{
    if (defaults.saved)
        return;
    defaults.esChequer = esAnalysisChequer;
    defaults.esCube = esAnalysisCube;
    memcpy(defaults.aamf, aamfAnalysis, sizeof(defaults.aamf));
    defaults.ecLuck = ecLuck;
    memcpy(defaults.arSkill, arSkillLevel, sizeof(defaults.arSkill));
    memcpy(defaults.arLuck, arLuckLevel, sizeof(defaults.arLuck));
    defaults.fCube = fAnalyseCube;
    defaults.fDice = fAnalyseDice;
    defaults.fMove = fAnalyseMove;
    defaults.afPlayers[0] = afAnalysePlayers[0];
    defaults.afPlayers[1] = afAnalysePlayers[1];
    defaults.saved = 1;
}

static int
find_move_filter(const char *name)
{
    for (int i = 0; i < NUM_MOVEFILTER_SETTINGS; i++)
        if (g_ascii_strcasecmp(aszMoveFilterSettings[i], name) == 0)
            return i;
    return -1;
}

/*
 * Apply an evaluation description to *pec:
 *   "world class"                      (a gnubg preset name), or
 *   {"preset": "...", "plies": n, "cubeful": b, "prune": b,
 *    "deterministic": b, "noise": x}   (preset first, then the overrides).
 * *piPreset gets the preset index used (or -1).
 */
static const char *
parse_evalcontext(const cJSON *j, evalcontext *pec, int *piPreset)
{
    const cJSON *jp;

    if (piPreset)
        *piPreset = -1;
    if (!j)
        return NULL;
    if (!cJSON_IsString(j) && !cJSON_IsObject(j))
        return "an evaluation setting must be a preset name or an object";
    jp = cJSON_IsString(j) ? j : cJSON_GetObjectItemCaseSensitive(j, "preset");
    if (jp) {
        int i;
        if (!cJSON_IsString(jp))
            return "\"preset\" must be a string";
        if ((i = find_preset(jp->valuestring)) < 0)
            return "unknown evaluation preset";
        *pec = aecSettings[i];
        if (piPreset)
            *piPreset = i;
    }
    if (!cJSON_IsObject(j))
        return NULL;
    /* plies 0..4, cubeful/prune/deterministic booleans, noise >= 0 */
    return apply_eval_fields(j, pec);
}

/* "moveFilter": a gnubg filter name ("tiny" ... "huge") or a 4x4 array of
 * {"accept": n, "extra": n, "threshold": x} (row = plies - 1). */
static const char *
parse_move_filter(const cJSON *j, movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES])
{
    if (cJSON_IsString(j)) {
        int i = find_move_filter(j->valuestring);
        if (i < 0)
            return "unknown move filter name";
        memcpy(aamf, aaamfMoveFilterSettings[i], sizeof(movefilter) * MAX_FILTER_PLIES * MAX_FILTER_PLIES);
        return NULL;
    }
    if (!cJSON_IsArray(j) || cJSON_GetArraySize(j) != MAX_FILTER_PLIES)
        return "moveFilter must be a name or a 4x4 array";
    for (int i = 0; i < MAX_FILTER_PLIES; i++) {
        const cJSON *row = cJSON_GetArrayItem(j, i);
        if (!cJSON_IsArray(row) || cJSON_GetArraySize(row) != MAX_FILTER_PLIES)
            return "moveFilter must be a name or a 4x4 array";
        for (int k = 0; k < MAX_FILTER_PLIES; k++) {
            const cJSON *e = cJSON_GetArrayItem(row, k), *x;
            const char *err;
            int n;
            if (!cJSON_IsObject(e))
                return "moveFilter entries must be objects";
            /* The rules of "set ... movefilter" (set.c:304-325): accept is a
             * count, or -1 to skip the level (then extra and threshold are
             * 0); extra >= 0; threshold >= 0. */
            n = aamf[i][k].Accept;
            if ((err = get_int_field(e, "accept", -1, INT_MAX, &n)))
                return err;
            aamf[i][k].Accept = n;
            n = aamf[i][k].Extra;
            if ((err = get_int_field(e, "extra", 0, INT_MAX, &n)))
                return err;
            aamf[i][k].Extra = n;
            if ((x = cJSON_GetObjectItemCaseSensitive(e, "threshold"))) {
                if (!cJSON_IsNumber(x) || !isfinite(x->valuedouble) || x->valuedouble < 0.0)
                    return "\"threshold\" must be a number >= 0";
                aamf[i][k].Threshold = (float) x->valuedouble;
            }
            if (aamf[i][k].Accept < 0) {
                aamf[i][k].Accept = -1;
                aamf[i][k].Extra = 0;
                aamf[i][k].Threshold = 0.0f;
            }
        }
    }
    return NULL;
}

static const char *
parse_threshold(const cJSON *j, const char *name, float *pr)
{
    const cJSON *x = cJSON_GetObjectItemCaseSensitive(j, name);
    if (!x)
        return NULL;
    if (!cJSON_IsNumber(x) || !isfinite(x->valuedouble) || x->valuedouble < 0.0)
        return "thresholds must be non-negative numbers";
    *pr = (float) x->valuedouble;
    return NULL;
}

/*
 * Apply a settings object to gnubg's global analysis settings (the same
 * variables the "set analysis ..." commands change). Validates everything
 * into copies first, so a bad request changes nothing.
 */
static const char *
apply_settings(const cJSON *js)
{
    evalsetup esChequer = esAnalysisChequer, esCube = esAnalysisCube;
    movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES];
    evalcontext ecL = ecLuck;
    float arSkill[N_SKILLS], arLuck[N_LUCKS];
    int fCube = fAnalyseCube, fDice = fAnalyseDice, fMove = fAnalyseMove;
    int afPlayers[2] = { afAnalysePlayers[0], afAnalysePlayers[1] };
    const cJSON *j, *x;
    const char *err;
    int iPreset, fDefaults = FALSE;

    save_defaults();
    if (!js || cJSON_IsNull(js))
        return NULL;
    if (!cJSON_IsObject(js))
        return "settings must be an object";

    if ((err = get_bool_field(js, "defaults", &fDefaults)))
        return err;
    if (fDefaults) {
        esChequer = defaults.esChequer;
        esCube = defaults.esCube;
        memcpy(aamf, defaults.aamf, sizeof(aamf));
        ecL = defaults.ecLuck;
        memcpy(arSkill, defaults.arSkill, sizeof(arSkill));
        memcpy(arLuck, defaults.arLuck, sizeof(arLuck));
        fCube = defaults.fCube;
        fDice = defaults.fDice;
        fMove = defaults.fMove;
        afPlayers[0] = defaults.afPlayers[0];
        afPlayers[1] = defaults.afPlayers[1];
    } else {
        memcpy(aamf, aamfAnalysis, sizeof(aamf));
        memcpy(arSkill, arSkillLevel, sizeof(arSkill));
        memcpy(arLuck, arLuckLevel, sizeof(arLuck));
    }

    if ((j = cJSON_GetObjectItemCaseSensitive(js, "chequer"))) {
        if ((err = parse_evalcontext(j, &esChequer.ec, &iPreset)))
            return err;
        esChequer.et = EVAL_EVAL;
        /* A preset brings its own move filter (as in gnubg's GUI), unless one is given. */
        if (iPreset >= 0 && aiSettingsMoveFilter[iPreset] >= 0)
            memcpy(aamf, aaamfMoveFilterSettings[aiSettingsMoveFilter[iPreset]], sizeof(aamf));
        if (cJSON_IsObject(j) && (x = cJSON_GetObjectItemCaseSensitive(j, "moveFilter"))
            && (err = parse_move_filter(x, aamf)))
            return err;
    }
    if ((j = cJSON_GetObjectItemCaseSensitive(js, "moveFilter")) && (err = parse_move_filter(j, aamf)))
        return err;
    if ((j = cJSON_GetObjectItemCaseSensitive(js, "cube"))) {
        if ((err = parse_evalcontext(j, &esCube.ec, NULL)))
            return err;
        esCube.et = EVAL_EVAL;
    }
    if ((j = cJSON_GetObjectItemCaseSensitive(js, "luck")) && (err = parse_evalcontext(j, &ecL, NULL)))
        return err;
    if ((j = cJSON_GetObjectItemCaseSensitive(js, "thresholds"))) {
        if (!cJSON_IsObject(j))
            return "thresholds must be an object";
        if ((err = parse_threshold(j, "doubtful", &arSkill[SKILL_DOUBTFUL]))
            || (err = parse_threshold(j, "bad", &arSkill[SKILL_BAD]))
            || (err = parse_threshold(j, "veryBad", &arSkill[SKILL_VERYBAD]))
            || (err = parse_threshold(j, "lucky", &arLuck[LUCK_GOOD]))
            || (err = parse_threshold(j, "veryLucky", &arLuck[LUCK_VERYGOOD]))
            || (err = parse_threshold(j, "unlucky", &arLuck[LUCK_BAD]))
            || (err = parse_threshold(j, "veryUnlucky", &arLuck[LUCK_VERYBAD])))
            return err;
    }
    if ((j = cJSON_GetObjectItemCaseSensitive(js, "analyse"))) {
        if (!cJSON_IsObject(j))
            return "analyse must be an object";
        if ((err = get_bool_field(j, "moves", &fMove)) || (err = get_bool_field(j, "cube", &fCube))
            || (err = get_bool_field(j, "luck", &fDice)))
            return err;
        if ((x = cJSON_GetObjectItemCaseSensitive(j, "players"))) {
            if (!cJSON_IsArray(x) || cJSON_GetArraySize(x) != 2
                || !cJSON_IsBool(cJSON_GetArrayItem(x, 0)) || !cJSON_IsBool(cJSON_GetArrayItem(x, 1)))
                return "analyse.players must be [bool, bool]";
            afPlayers[0] = cJSON_IsTrue(cJSON_GetArrayItem(x, 0));
            afPlayers[1] = cJSON_IsTrue(cJSON_GetArrayItem(x, 1));
        }
    }

    esAnalysisChequer = esChequer;
    esAnalysisCube = esCube;
    memcpy(aamfAnalysis, aamf, sizeof(aamf));
    ecLuck = ecL;
    memcpy(arSkillLevel, arSkill, sizeof(arSkill));
    memcpy(arLuckLevel, arLuck, sizeof(arLuck));
    fAnalyseCube = fCube;
    fAnalyseDice = fDice;
    fAnalyseMove = fMove;
    afAnalysePlayers[0] = afPlayers[0];
    afAnalysePlayers[1] = afPlayers[1];
    return NULL;
}

/* eval_json() plus the matching preset name, if any. */
static cJSON *
eval_with_preset_json(const evalcontext *pec)
{
    cJSON *e = eval_json(pec);
    const char *name = NULL;
    for (int i = 0; i < NUM_SETTINGS; i++)
        if (cmp_evalcontext(pec, &aecSettings[i]) == 0) {
            const char *s = strchr(aszSettings[i], '|');
            name = s ? s + 1 : aszSettings[i];
            break;
        }
    if (name)
        cJSON_AddStringToObject(e, "preset", name);
    else
        cJSON_AddNullToObject(e, "preset");
    return e;
}

static cJSON *
move_filter_json(movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES])
{
    cJSON *rows = cJSON_CreateArray();
    for (int i = 0; i < MAX_FILTER_PLIES; i++) {
        cJSON *row = cJSON_CreateArray();
        for (int k = 0; k < MAX_FILTER_PLIES; k++) {
            cJSON *e = cJSON_CreateObject();
            cJSON_AddNumberToObject(e, "accept", aamf[i][k].Accept);
            cJSON_AddNumberToObject(e, "extra", aamf[i][k].Extra);
            add_num(e, "threshold", aamf[i][k].Threshold);
            cJSON_AddItemToArray(row, e);
        }
        cJSON_AddItemToArray(rows, row);
    }
    return rows;
}

/* The analysis settings currently in effect. */
static cJSON *
settings_json(void)
{
    cJSON *s = cJSON_CreateObject(), *c, *t, *a;
    int iFilter = -1;

    c = cJSON_AddObjectToObject(s, "chequer");
    cJSON_AddItemToObject(c, "eval", eval_with_preset_json(&esAnalysisChequer.ec));
    for (int i = 0; i < NUM_MOVEFILTER_SETTINGS; i++)
        if (!memcmp(aamfAnalysis, aaamfMoveFilterSettings[i], sizeof(aamfAnalysis))) {
            iFilter = i;
            break;
        }
    if (iFilter >= 0)
        cJSON_AddStringToObject(c, "moveFilterName", aszMoveFilterSettings[iFilter]);
    else
        cJSON_AddNullToObject(c, "moveFilterName");
    cJSON_AddItemToObject(c, "moveFilter", move_filter_json(aamfAnalysis));
    c = cJSON_AddObjectToObject(s, "cube");
    cJSON_AddItemToObject(c, "eval", eval_with_preset_json(&esAnalysisCube.ec));
    c = cJSON_AddObjectToObject(s, "luck");
    cJSON_AddItemToObject(c, "eval", eval_json(&ecLuck));

    t = cJSON_AddObjectToObject(s, "thresholds");
    add_num(t, "doubtful", arSkillLevel[SKILL_DOUBTFUL]);
    add_num(t, "bad", arSkillLevel[SKILL_BAD]);
    add_num(t, "veryBad", arSkillLevel[SKILL_VERYBAD]);
    add_num(t, "lucky", arLuckLevel[LUCK_GOOD]);
    add_num(t, "veryLucky", arLuckLevel[LUCK_VERYGOOD]);
    add_num(t, "unlucky", arLuckLevel[LUCK_BAD]);
    add_num(t, "veryUnlucky", arLuckLevel[LUCK_VERYBAD]);

    a = cJSON_AddObjectToObject(s, "analyse");
    cJSON_AddBoolToObject(a, "moves", fAnalyseMove);
    cJSON_AddBoolToObject(a, "cube", fAnalyseCube);
    cJSON_AddBoolToObject(a, "luck", fAnalyseDice);
    {
        cJSON *pl = cJSON_AddArrayToObject(a, "players");
        cJSON_AddItemToArray(pl, cJSON_CreateBool(afAnalysePlayers[0]));
        cJSON_AddItemToArray(pl, cJSON_CreateBool(afAnalysePlayers[1]));
    }
    return s;
}

/* ---------------------------------------------------------------------- */
/* Match overview                                                         */
/* ---------------------------------------------------------------------- */

/* Records that gnubg's "load match" counts as moves. */
static int
count_moves(const listOLD *plG, int *pnRecords)
{
    int nMoves = 0, nRecords = 0;
    for (listOLD *pl = plG->plNext->plNext; pl != plG; pl = pl->plNext) {
        const moverecord *pmr = pl->p;
        nRecords++;
        switch (pmr->mt) {
        case MOVE_NORMAL:
        case MOVE_DOUBLE:
        case MOVE_TAKE:
        case MOVE_DROP:
            nMoves++;
            break;
        default:
            break;
        }
    }
    if (pnRecords)
        *pnRecords = nRecords;
    return nMoves;
}

static cJSON *
match_overview(void)
{
    cJSON *o = cJSON_CreateObject(), *players, *games;
    const moverecord *pmr0 = game_info(lMatch.plNext->p);
    int iGame = 0, iCrawford = -1;

    cJSON_AddBoolToObject(o, "ok", 1);
    cJSON_AddNumberToObject(o, "matchLength", pmr0->g.nMatch);
    players = cJSON_AddArrayToObject(o, "players");
    cJSON_AddItemToArray(players, cJSON_CreateString(ap[0].szName));
    cJSON_AddItemToArray(players, cJSON_CreateString(ap[1].szName));
    cJSON_AddBoolToObject(o, "crawfordRule", pmr0->g.fCrawford);
    cJSON_AddBoolToObject(o, "jacoby", pmr0->g.fJacoby);
    cJSON_AddBoolToObject(o, "cubeUse", pmr0->g.fCubeUse);
    cJSON_AddNumberToObject(o, "variation", pmr0->g.bgv);
    games = cJSON_AddArrayToObject(o, "games");
    for (listOLD *pl = lMatch.plNext; pl != &lMatch; pl = pl->plNext, iGame++) {
        const listOLD *plG = pl->p;
        const moverecord *pmr = game_info(plG);
        cJSON *g = cJSON_CreateObject();
        int nRecords;
        int nMoves = count_moves(plG, &nRecords);

        cJSON_AddNumberToObject(g, "index", iGame);
        cJSON_AddItemToObject(g, "scoreBefore", int_pair(pmr->g.anScore[0], pmr->g.anScore[1]));
        cJSON_AddNumberToObject(g, "moves", nMoves);
        cJSON_AddNumberToObject(g, "records", nRecords);
        cJSON_AddBoolToObject(g, "crawfordGame", pmr->g.fCrawfordGame);
        if (pmr->g.fWinner >= 0) {
            cJSON_AddNumberToObject(g, "winner", pmr->g.fWinner);
            cJSON_AddNumberToObject(g, "points", pmr->g.nPoints);
            cJSON_AddBoolToObject(g, "resigned", pmr->g.fResigned);
        } else {
            cJSON_AddNullToObject(g, "winner");
            cJSON_AddNullToObject(g, "points");
            cJSON_AddBoolToObject(g, "resigned", 0);
        }
        cJSON_AddItemToArray(games, g);
        if (pmr->g.fCrawfordGame && iCrawford < 0)
            iCrawford = iGame;
    }
    if (iCrawford >= 0)
        cJSON_AddNumberToObject(o, "crawfordGame", iCrawford);
    else
        cJSON_AddNullToObject(o, "crawfordGame");
    return o;
}

/* Free the current match the way gnubg does before loading another one. */
static void
clear_match(void)
{
    if (!ListEmpty(&lMatch))
        FreeMatch();
    ClearMatch();
    /* FreeMatch frees the games; plGame/plLastMove pointed into them. NULL is
     * gnubg's own "no game" state (CheckGameExists etc. test for it). */
    plGame = plLastMove = NULL;
}

/* ---------------------------------------------------------------------- */
/* Exported API: load / clear / settings                                  */
/* ---------------------------------------------------------------------- */

/*
 * Load a match from text.
 * Request:  {"format": "sgf" | "mat", "text": "<file contents>"}
 * Response: {"ok":true, "matchLength":n, "players":[a,b], "games":[...],
 *            "crawfordGame": i|null, ..., "messages": "gnubg output"}
 */
API_EXPORT const char *
gnubg_api_load_match(const char *requestJson)
{
    cJSON *req, *o;
    const cJSON *jfmt, *jtext;
    const char *err;
    char path[64], cmd[80];
    char *messages;
    int fSgf;
    FILE *pf;

    API_REQUIRE_READY();
    if (!(req = parse_request(requestJson, &err)))
        return error_result(err);
    jfmt = cJSON_GetObjectItemCaseSensitive(req, "format");
    jtext = cJSON_GetObjectItemCaseSensitive(req, "text");
    if (!cJSON_IsString(jfmt) || (strcmp(jfmt->valuestring, "sgf") && strcmp(jfmt->valuestring, "mat"))) {
        cJSON_Delete(req);
        return error_result("\"format\" must be \"sgf\" or \"mat\"");
    }
    if (!cJSON_IsString(jtext)) {
        cJSON_Delete(req);
        return error_result("missing \"text\" (the file contents)");
    }
    fSgf = !strcmp(jfmt->valuestring, "sgf");
    snprintf(path, sizeof path, "%s.%s", TMP_IMPORT, fSgf ? "sgf" : "mat");
    if (!(pf = fopen(path, "wb"))) {
        cJSON_Delete(req);
        return error_result("cannot write temporary file");
    }
    fwrite(jtext->valuestring, 1, strlen(jtext->valuestring), pf);
    fclose(pf);
    cJSON_Delete(req);

    save_defaults();
    capture_begin();
    clear_match();
    /* The C functions behind "load match" and "import mat". They take the
     * command's argument string (and tokenise it in place). */
    snprintf(cmd, sizeof cmd, "%s", path);
    api_flush_cache();          /* a new match starts from an empty cache */
    if (fSgf)
        CommandLoadMatch(cmd);
    else
        CommandImportMat(cmd);
    messages = capture_end();
    unlink(path);

    if (!match_loaded()) {
        o = cJSON_CreateObject();
        cJSON_AddBoolToObject(o, "ok", 0);
        cJSON_AddStringToObject(o, "error", "gnubg could not load the match");
        add_messages(o, messages);
        clear_match();
        return finish(o);
    }
    o = match_overview();
    add_messages(o, messages);
    return finish(o);
}

/* Discard the current match. Request: {} -> {"ok":true} */
API_EXPORT const char *
gnubg_api_clear_match(const char *UNUSED(requestJson))
{
    cJSON *o;
    API_REQUIRE_READY();
    o = cJSON_CreateObject();
    capture_begin();
    clear_match();
    g_free(capture_end());
    cJSON_AddBoolToObject(o, "ok", 1);
    return finish(o);
}

/* Current match overview (same shape as load_match's response). */
API_EXPORT const char *
gnubg_api_match_info(const char *UNUSED(requestJson))
{
    API_REQUIRE_READY();
    if (!match_loaded())
        return error_result("no match loaded");
    return finish(match_overview());
}

/* Remove all analysis from the current match ("analyse clear match"). */
API_EXPORT const char *
gnubg_api_clear_analysis(const char *UNUSED(requestJson))
{
    cJSON *o;
    API_REQUIRE_READY();
    if (!match_loaded())
        return error_result("no match loaded");
    capture_begin();
    api_flush_cache();
    CommandAnalyseClearMatch(NULL);
    g_free(capture_end());
    o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);
    return finish(o);
}

/*
 * Change gnubg's analysis settings (see MATCH_API.md). Request: a settings
 * object; {} just reports the current settings; {"defaults": true, ...}
 * starts from gnubg's built-in defaults.
 * Response: {"ok":true, "settings":{...}}
 */
API_EXPORT const char *
gnubg_api_set_analysis_settings(const char *requestJson)
{
    cJSON *req, *o;
    const char *err;
    API_REQUIRE_READY();
    if (!(req = parse_request(requestJson, &err)))
        return error_result(err);
    err = apply_settings(req);
    cJSON_Delete(req);
    if (err)
        return error_result(err);
    o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);
    cJSON_AddItemToObject(o, "settings", settings_json());
    return finish(o);
}

/* ---------------------------------------------------------------------- */
/* Exported API: analysis                                                 */
/* ---------------------------------------------------------------------- */

static const char *
check_can_analyse(void)
{
    if (!match_loaded())
        return "no match loaded";
    if (!fAnalyseCube && !fAnalyseDice && !fAnalyseMove)
        return "no analysis selected (enable at least one of moves, cube, luck)";
    return NULL;
}

/*
 * Analyse one game exactly as "analyse game" does: make it gnubg's current
 * game (ChangeGame, as the GUI's game list does), then CommandAnalyseGame,
 * which runs AnalyzeGame on it with the global analysis settings.
 * Calling this for every game in order evaluates exactly the same positions
 * in the same order as "analyse match" (see MATCH_API.md).
 * Request: {"game": i, "settings": {...optional...}}
 */
API_EXPORT const char *
gnubg_api_analyse_game(const char *requestJson)
{
    cJSON *req, *o;
    const char *err;
    listOLD *plTarget;
    int i = -1, fFlush = FALSE;

    API_REQUIRE_READY();
    if (!(req = parse_request(requestJson, &err)))
        return error_result(err);
    if ((err = get_int_field(req, "game", 0, INT_MAX, &i))
        || (err = get_bool_field(req, "flushCache", &fFlush))
        || (i < 0 && (err = "missing \"game\" (a game index)"))
        || (err = apply_settings(cJSON_GetObjectItemCaseSensitive(req, "settings")))) {
        cJSON_Delete(req);
        return error_result(err);
    }
    cJSON_Delete(req);
    /* Start from an empty cache for game 0 (or on request), so analysing
     * games 0..n-1 in order reproduces native "analyse match" in a freshly
     * started gnubg exactly; later games keep the cache, as gnubg does. */
    if (i == 0 || fFlush)
        api_flush_cache();
    if ((err = check_can_analyse()))
        return error_result(err);
    if (!(plTarget = game_list(i)))
        return error_result("\"game\" must be a valid game index");

    capture_begin();
    ChangeGame(plTarget);
    CommandAnalyseGame(NULL);
    g_free(capture_end());

    o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", !fInterrupt);
    cJSON_AddNumberToObject(o, "game", i);
    cJSON_AddNumberToObject(o, "games", count_games());
    cJSON_AddItemToObject(o, "settings", settings_json());
    return finish(o);
}

/* Analyse the whole match with gnubg's CommandAnalyseMatch ("analyse match").
 * Request: {"settings": {...optional...}} */
API_EXPORT const char *
gnubg_api_analyse_match(const char *requestJson)
{
    cJSON *req, *o;
    const char *err;

    API_REQUIRE_READY();
    if (!(req = parse_request(requestJson, &err)))
        return error_result(err);
    err = apply_settings(cJSON_GetObjectItemCaseSensitive(req, "settings"));
    cJSON_Delete(req);
    if (err || (err = check_can_analyse()))
        return error_result(err);

    capture_begin();
    api_flush_cache();
    CommandAnalyseMatch(NULL);
    g_free(capture_end());

    o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", !fInterrupt);
    cJSON_AddNumberToObject(o, "games", count_games());
    cJSON_AddItemToObject(o, "settings", settings_json());
    return finish(o);
}

/* ---------------------------------------------------------------------- */
/* Per-record results                                                     */
/* ---------------------------------------------------------------------- */

/* Position + match ID for a match state (gnubg's own encoders). */
static void
add_ids(cJSON *o, const matchstate *pms)
{
    cJSON_AddStringToObject(o, "positionId", PositionID((ConstTanBoard) pms->anBoard));
    cJSON_AddStringToObject(o, "matchId", MatchIDFromMatchState(pms));
}

static cJSON *
chequer_move_json(const move *pm, int rank, const movelist *pml, const TanBoard anBoard,
                  const matchstate *pms, const cubeinfo *pci)
{
    char sz[FORMATEDMOVESIZE];
    cJSON *jm = cJSON_CreateObject();

    cJSON_AddNumberToObject(jm, "rank", rank);
    FormatMove(sz, anBoard, pm->anMove);
    cJSON_AddStringToObject(jm, "move", sz);
    add_num(jm, "equity", pm->rScore);
    add_num(jm, "diff", pm->rScore - pml->amMoves[0].rScore);
    if (pms->nMatchTo)
        add_num(jm, "mwc", eq2mwc(pm->rScore, pci));
    cJSON_AddItemToObject(jm, "probs", probs_json(pm->arEvalMove));
    add_num(jm, "cubelessEquity", pm->arEvalMove[OUTPUT_EQUITY]);
    cJSON_AddStringToObject(jm, "evalType", pm->esMove.et == EVAL_ROLLOUT ? "rollout"
                            : pm->esMove.et == EVAL_EVAL ? "eval" : "none");
    cJSON_AddNumberToObject(jm, "plies", pm->esMove.ec.nPlies);
    cJSON_AddBoolToObject(jm, "cubeful", pm->esMove.ec.fCubeful);
    return jm;
}

/* Chequer-play analysis of a MOVE_NORMAL record. pms: state before the move. */
static cJSON *
chequer_json(const moverecord *pmr, const matchstate *pms, const cubeinfo *pci, int maxMoves)
{
    cJSON *c = cJSON_CreateObject(), *jmoves;
    const movelist *pml = &pmr->ml;
    int iPlayed = (pmr->n.iMove < pml->cMoves) ? (int) pmr->n.iMove : -1;
    TanBoard anBoard;

    memcpy(anBoard, pms->anBoard, sizeof(TanBoard));
    cJSON_AddBoolToObject(c, "analysed", pmr->esChequer.et != EVAL_NONE);
    if (pmr->esChequer.et != EVAL_NONE)
        cJSON_AddItemToObject(c, "eval", eval_json(&pmr->esChequer.ec));
    cJSON_AddNumberToObject(c, "legalMoves", pml->cMoves);
    cJSON_AddStringToObject(c, "skill", skill_label(pmr->n.stMove));
    if (pml->cMoves == 0 || !pml->amMoves) {
        cJSON_AddNullToObject(c, "playedIndex");
        return c;
    }
    jmoves = cJSON_AddArrayToObject(c, "moves");
    for (unsigned int i = 0; i < pml->cMoves; i++)
        if (maxMoves <= 0 || (int) i < maxMoves || (int) i == iPlayed)
            cJSON_AddItemToArray(jmoves, chequer_move_json(&pml->amMoves[i], (int) i, pml, anBoard, pms, pci));
    if (iPlayed >= 0) {
        float rSkill = pml->amMoves[iPlayed].rScore - pml->amMoves[0].rScore;
        cJSON_AddNumberToObject(c, "playedIndex", iPlayed);
        /* Same value AnalyzeMove/updateStatcontext use (<= 0). */
        add_value_pair(c, "error", rSkill, pms, pci);
    } else
        cJSON_AddNullToObject(c, "playedIndex");
    return c;
}

/*
 * Cube analysis stored on a record (MOVE_NORMAL, MOVE_DOUBLE, or a
 * take/drop, which shares its double's data). All values are from the point
 * of view of the player who has (or had) the cube decision, i.e. pci->fMove.
 */
static cJSON *
cube_json(const moverecord *pmr, const matchstate *pms, const cubeinfo *pci)
{
    static const char *keys[NUM_CUBEFUL_OUTPUTS] = { "optimal", "noDouble", "doubleTake", "doublePass" };
    cubedecisiondata *pcd = pmr->CubeDecPtr;
    float arDouble[NUM_CUBEFUL_OUTPUTS], rError = 0.0f, rPercent;
    cJSON *c = cJSON_CreateObject(), *eq, *raw;
    cubedecision cd;
    const char *actual = "no double";

    cJSON_AddItemToObject(c, "eval", eval_json(&pcd->esDouble.ec));
    cd = FindCubeDecision(arDouble, pcd->aarOutput, pci);
    eq = cJSON_AddObjectToObject(c, "equities");
    for (int i = 0; i < NUM_CUBEFUL_OUTPUTS; i++)
        add_num(eq, keys[i], arDouble[i]);
    if (pms->nMatchTo) {
        cJSON *mwc = cJSON_AddObjectToObject(c, "mwc");
        for (int i = 0; i < NUM_CUBEFUL_OUTPUTS; i++)
            add_num(mwc, keys[i], eq2mwc(arDouble[i], pci));
    }
    cJSON_AddNumberToObject(c, "decision", (int) cd);
    cJSON_AddStringToObject(c, "proper", GetCubeRecommendation(cd));
    rPercent = getPercent(cd, arDouble);
    if (rPercent >= 0.0f)
        add_num(c, "percent", rPercent);
    else
        cJSON_AddNullToObject(c, "percent");

    /* The error of the action actually taken, as analysis.c computes it. */
    switch (pmr->mt) {
    case MOVE_NORMAL:
        actual = "no double";
        rError = arDouble[OUTPUT_NODOUBLE] - arDouble[OUTPUT_OPTIMAL];
        break;
    case MOVE_DOUBLE:
        actual = "double";
        rError = arDouble[OUTPUT_TAKE] < arDouble[OUTPUT_DROP] ?
            arDouble[OUTPUT_TAKE] - arDouble[OUTPUT_OPTIMAL] : arDouble[OUTPUT_DROP] - arDouble[OUTPUT_OPTIMAL];
        break;
    case MOVE_TAKE:
        actual = "take";
        if (-arDouble[OUTPUT_TAKE] < -arDouble[OUTPUT_DROP])
            rError = -arDouble[OUTPUT_TAKE] - -arDouble[OUTPUT_DROP];
        break;
    case MOVE_DROP:
        actual = "drop";
        if (-arDouble[OUTPUT_DROP] < -arDouble[OUTPUT_TAKE])
            rError = -arDouble[OUTPUT_DROP] - -arDouble[OUTPUT_TAKE];
        break;
    default:
        break;
    }
    cJSON_AddStringToObject(c, "actual", actual);
    add_value_pair(c, "error", rError, pms, pci);
    cJSON_AddStringToObject(c, "skill", skill_label(pmr->stCube));
    cJSON_AddBoolToObject(c, "close", isCloseCubedecision(arDouble));

    /* Raw stored evaluation (no double / double-take), as gnubg keeps it. */
    raw = cJSON_AddObjectToObject(c, "raw");
    cJSON_AddItemToObject(raw, "noDoubleProbs", probs_json(pcd->aarOutput[0]));
    add_num(raw, "noDoubleCubeless", pcd->aarOutput[0][OUTPUT_EQUITY]);
    add_num(raw, "noDoubleCubeful", pcd->aarOutput[0][OUTPUT_CUBEFUL_EQUITY]);
    cJSON_AddItemToObject(raw, "doubleTakeProbs", probs_json(pcd->aarOutput[1]));
    add_num(raw, "doubleTakeCubeless", pcd->aarOutput[1][OUTPUT_EQUITY]);
    add_num(raw, "doubleTakeCubeful", pcd->aarOutput[1][OUTPUT_CUBEFUL_EQUITY]);
    return c;
}

static cJSON *
luck_json(const moverecord *pmr, const matchstate *pms, const cubeinfo *pci)
{
    cJSON *l;
    if (pmr->rLuck == ERR_VAL)
        return cJSON_CreateNull();
    l = cJSON_CreateObject();
    add_num(l, "equity", pmr->rLuck);
    add_num(l, pms->nMatchTo ? "mwc" : "points", cost_of(pmr->rLuck, pms, pci));
    cJSON_AddStringToObject(l, "label", luck_label(pmr->lt));
    return l;
}

static cJSON *
resign_json(const moverecord *pmr, const matchstate *pms)
{
    cJSON *r = cJSON_CreateObject();
    int n = pmr->r.nResigned;
    static const char *names[] = { "single", "gammon", "backgammon" };

    cJSON_AddNumberToObject(r, "resigned", n);
    cJSON_AddStringToObject(r, "type", names[CLAMP(n, 1, 3) - 1]);
    cJSON_AddBoolToObject(r, "analysed", pmr->r.esResign.et != EVAL_NONE);
    if (pmr->r.esResign.et != EVAL_NONE) {
        cubeinfo ci;
        float rBefore, rAfter;
        float arResign[NUM_ROLLOUT_OUTPUTS];
        GetMatchStateCubeInfo(&ci, pms);
        memcpy(arResign, pmr->r.arResign, sizeof(arResign));
        getResignEquities(arResign, &ci, n, &rBefore, &rAfter);
        cJSON_AddItemToObject(r, "eval", eval_json(&pmr->r.esResign.ec));
        cJSON_AddItemToObject(r, "probs", probs_json(pmr->r.arResign));
        add_num(r, "equityBefore", rBefore);
        add_num(r, "equityAfter", rAfter);
        cJSON_AddStringToObject(r, "resignSkill", skill_label(pmr->r.stResign));
        cJSON_AddStringToObject(r, "acceptSkill", skill_label(pmr->r.stAccept));
    }
    return r;
}

/*
 * Walk one game's records with a private match state, the same way gnubg's
 * AnalyzeGame/updateStatisticsGame do (FixMatchState, the board swap for
 * moves/resigns/set-dice, then ApplyMoveRecord), and describe every record
 * with the state *before* it.
 */
static cJSON *
game_records_json(listOLD *plG, int maxMoves)
{
    cJSON *recs = cJSON_CreateArray();
    matchstate msx;
    int iRecord = -1;

    memset(&msx, 0, sizeof msx);
    for (listOLD *pl = plG->plNext; pl != plG; pl = pl->plNext, iRecord++) {
        moverecord *pmr = pl->p;
        cJSON *r;
        cubeinfo ci;
        matchstate msShow;

        if (pmr->mt != MOVE_GAMEINFO) {
            FixMatchState(&msx, pmr);
            if (pmr->fPlayer != msx.fMove
                && (pmr->mt == MOVE_NORMAL || pmr->mt == MOVE_RESIGN || pmr->mt == MOVE_SETDICE)) {
                SwapSides(msx.anBoard);
                msx.fMove = pmr->fPlayer;
            }
        }
        if (pmr->mt == MOVE_GAMEINFO) {
            ApplyMoveRecord(&msx, plG, pmr);
            continue;
        }

        r = cJSON_CreateObject();
        cJSON_AddNumberToObject(r, "index", iRecord);
        cJSON_AddStringToObject(r, "type", record_type(pmr->mt));
        cJSON_AddNumberToObject(r, "player", pmr->fPlayer);
        GetMatchStateCubeInfo(&ci, &msx);

        /* The position to show for this record: the state before it, with
         * the roll for chequer moves (as gnubg's board shows it). */
        msShow = msx;
        if (msShow.gs == GAME_NONE)
            msShow.gs = GAME_PLAYING;
        if (pmr->mt == MOVE_NORMAL) {
            msShow.anDice[0] = pmr->anDice[0];
            msShow.anDice[1] = pmr->anDice[1];
            msShow.fTurn = msShow.fMove = pmr->fPlayer;
        }
        add_ids(r, &msShow);
        cJSON_AddNumberToObject(r, "cube", msx.nCube);
        cJSON_AddNumberToObject(r, "cubeOwner", msx.fCubeOwner);

        switch (pmr->mt) {
        case MOVE_NORMAL:{
                char sz[FORMATEDMOVESIZE];
                TanBoard anBoard;
                memcpy(anBoard, msx.anBoard, sizeof(TanBoard));
                cJSON_AddItemToObject(r, "dice", int_pair((int) pmr->anDice[0], (int) pmr->anDice[1]));
                FormatMove(sz, anBoard, pmr->n.anMove);
                cJSON_AddStringToObject(r, "move", sz);
                cJSON_AddItemToObject(r, "chequer", chequer_json(pmr, &msx, &ci, maxMoves));
                cJSON_AddItemToObject(r, "luck", luck_json(pmr, &msx, &ci));
                if (pmr->CubeDecPtr->esDouble.et != EVAL_NONE)
                    cJSON_AddItemToObject(r, "cubeDecision", cube_json(pmr, &msx, &ci));
                else
                    cJSON_AddNullToObject(r, "cubeDecision");
                break;
            }
        case MOVE_DOUBLE:
        case MOVE_TAKE:
        case MOVE_DROP:
            if (pmr->mt == MOVE_DOUBLE)
                cJSON_AddNumberToObject(r, "newCube", msx.nCube * 2);
            if (pmr->CubeDecPtr->esDouble.et != EVAL_NONE)
                cJSON_AddItemToObject(r, "cubeDecision", cube_json(pmr, &msx, &ci));
            else {
                cJSON_AddNullToObject(r, "cubeDecision");
                /* Skill mark without stored cube data (e.g. beavers). */
                cJSON_AddStringToObject(r, "skill", skill_label(pmr->stCube));
            }
            break;
        case MOVE_RESIGN:
            cJSON_AddItemToObject(r, "resign", resign_json(pmr, &msx));
            break;
        case MOVE_SETDICE:
            cJSON_AddItemToObject(r, "dice", int_pair((int) pmr->anDice[0], (int) pmr->anDice[1]));
            cJSON_AddItemToObject(r, "luck", luck_json(pmr, &msx, &ci));
            break;
        case MOVE_SETBOARD:
            cJSON_AddStringToObject(r, "board", PositionIDFromKey(&pmr->sb.key));
            break;
        case MOVE_SETCUBEVAL:
            cJSON_AddNumberToObject(r, "value", pmr->scv.nCube);
            break;
        case MOVE_SETCUBEPOS:
            cJSON_AddNumberToObject(r, "owner", pmr->scp.fCubeOwner);
            break;
        default:
            break;
        }
        if (pmr->sz)
            cJSON_AddStringToObject(r, "comment", pmr->sz);
        cJSON_AddItemToArray(recs, r);

        ApplyMoveRecord(&msx, plG, pmr);
    }
    return recs;
}

/* ---------------------------------------------------------------------- */
/* Statistics                                                             */
/* ---------------------------------------------------------------------- */

static cJSON *
err_json(float rNormalised, float rUnnormalised, int nMatchTo)
{
    cJSON *e = cJSON_CreateObject();
    add_num(e, "equity", rNormalised);
    add_num(e, nMatchTo ? "mwc" : "points", rUnnormalised);
    return e;
}

static cJSON *
cube_error_json(int n, const float ar[2], int nMatchTo)
{
    cJSON *e = err_json(ar[0], ar[1], nMatchTo);
    cJSON_AddNumberToObject(e, "count", n);
    return e;
}

/*
 * One statcontext as JSON: the raw counters/sums gnubg keeps plus every
 * value "show statistics" derives from them, computed with formatGS's
 * expressions (float arithmetic, getMWCFromError, GetRating, ...).
 * Sign convention: gnubg stores errors and luck as positive "cost" values
 * (errors) and signed luck; formatGS prints errors negated.
 */
static cJSON *
stats_json(const statcontext *psc, int nMatchTo, int fIsMatch)
{
    cJSON *s = cJSON_CreateObject(), *players;
    float aaaar[3][2][2][2];

    getMWCFromError(psc, aaaar);
    cJSON_AddNumberToObject(s, "games", psc->nGames);
    cJSON_AddBoolToObject(s, "hasChequer", psc->fMoves);
    cJSON_AddBoolToObject(s, "hasCube", psc->fCube);
    cJSON_AddBoolToObject(s, "hasLuck", psc->fDice);
    players = cJSON_AddArrayToObject(s, "players");

    for (int i = 0; i < 2; i++) {
        cJSON *p = cJSON_CreateObject(), *c, *m, *l, *cu, *ov;

        /* chequer play (formatGS FORMATGS_CHEQUER) */
        c = cJSON_AddObjectToObject(p, "chequer");
        cJSON_AddNumberToObject(c, "totalMoves", psc->anTotalMoves[i]);
        cJSON_AddNumberToObject(c, "unforcedMoves", psc->anUnforcedMoves[i]);
        m = cJSON_AddObjectToObject(c, "marked");
        cJSON_AddNumberToObject(m, "none", psc->anMoves[i][SKILL_NONE]);
        cJSON_AddNumberToObject(m, "doubtful", psc->anMoves[i][SKILL_DOUBTFUL]);
        cJSON_AddNumberToObject(m, "bad", psc->anMoves[i][SKILL_BAD]);
        cJSON_AddNumberToObject(m, "veryBad", psc->anMoves[i][SKILL_VERYBAD]);
        cJSON_AddItemToObject(c, "errorTotal",
                              err_json(aaaar[CHEQUERPLAY][TOTAL][i][NORMALISED],
                                       aaaar[CHEQUERPLAY][TOTAL][i][UNNORMALISED], nMatchTo));
        cJSON_AddItemToObject(c, "errorPerMove",
                              err_json(aaaar[CHEQUERPLAY][PERMOVE][i][NORMALISED],
                                       aaaar[CHEQUERPLAY][PERMOVE][i][UNNORMALISED], nMatchTo));
        if (psc->anUnforcedMoves[i]) {
            ratingtype rt = GetRating(aaaar[CHEQUERPLAY][PERMOVE][i][NORMALISED]);
            cJSON_AddStringToObject(c, "rating", rating_text(rt));
            cJSON_AddNumberToObject(c, "ratingIndex", rt);
        } else {
            cJSON_AddNullToObject(c, "rating");
            cJSON_AddNullToObject(c, "ratingIndex");
        }

        /* luck (FORMATGS_LUCK) */
        l = cJSON_AddObjectToObject(p, "luck");
        m = cJSON_AddObjectToObject(l, "marked");
        cJSON_AddNumberToObject(m, "veryLucky", psc->anLuck[i][LUCK_VERYGOOD]);
        cJSON_AddNumberToObject(m, "lucky", psc->anLuck[i][LUCK_GOOD]);
        cJSON_AddNumberToObject(m, "none", psc->anLuck[i][LUCK_NONE]);
        cJSON_AddNumberToObject(m, "unlucky", psc->anLuck[i][LUCK_BAD]);
        cJSON_AddNumberToObject(m, "veryUnlucky", psc->anLuck[i][LUCK_VERYBAD]);
        cJSON_AddItemToObject(l, "total", err_json(psc->arLuck[i][0], psc->arLuck[i][1], nMatchTo));
        if (psc->anTotalMoves[i]) {
            float r0 = psc->arLuck[i][0] / (float) psc->anTotalMoves[i];
            float r1 = psc->arLuck[i][1] / (float) psc->anTotalMoves[i];
            lucktype lt = getLuckRating(r0);
            cJSON_AddItemToObject(l, "perMove", err_json(r0, r1, nMatchTo));
            cJSON_AddStringToObject(l, "rating", luck_rating_text(lt));
            cJSON_AddNumberToObject(l, "ratingIndex", lt);
        } else {
            cJSON_AddNullToObject(l, "perMove");
            cJSON_AddNullToObject(l, "rating");
            cJSON_AddNullToObject(l, "ratingIndex");
        }

        /* cube (FORMATGS_CUBE) */
        cu = cJSON_AddObjectToObject(p, "cube");
        cJSON_AddNumberToObject(cu, "total", psc->anTotalCube[i]);
        cJSON_AddNumberToObject(cu, "close", psc->anCloseCube[i]);
        cJSON_AddNumberToObject(cu, "doubles", psc->anDouble[i]);
        cJSON_AddNumberToObject(cu, "takes", psc->anTake[i]);
        cJSON_AddNumberToObject(cu, "passes", psc->anPass[i]);
        cJSON_AddItemToObject(cu, "missedDoubleBelowCP",
                              cube_error_json(psc->anCubeMissedDoubleDP[i], psc->arErrorMissedDoubleDP[i], nMatchTo));
        cJSON_AddItemToObject(cu, "missedDoubleAboveCP",
                              cube_error_json(psc->anCubeMissedDoubleTG[i], psc->arErrorMissedDoubleTG[i], nMatchTo));
        cJSON_AddItemToObject(cu, "wrongDoubleBelowDP",
                              cube_error_json(psc->anCubeWrongDoubleDP[i], psc->arErrorWrongDoubleDP[i], nMatchTo));
        cJSON_AddItemToObject(cu, "wrongDoubleAboveTG",
                              cube_error_json(psc->anCubeWrongDoubleTG[i], psc->arErrorWrongDoubleTG[i], nMatchTo));
        cJSON_AddItemToObject(cu, "wrongTake",
                              cube_error_json(psc->anCubeWrongTake[i], psc->arErrorWrongTake[i], nMatchTo));
        cJSON_AddItemToObject(cu, "wrongPass",
                              cube_error_json(psc->anCubeWrongPass[i], psc->arErrorWrongPass[i], nMatchTo));
        cJSON_AddItemToObject(cu, "errorTotal",
                              err_json(aaaar[CUBEDECISION][TOTAL][i][NORMALISED],
                                       aaaar[CUBEDECISION][TOTAL][i][UNNORMALISED], nMatchTo));
        cJSON_AddItemToObject(cu, "errorPerDecision",
                              err_json(aaaar[CUBEDECISION][PERMOVE][i][NORMALISED],
                                       aaaar[CUBEDECISION][PERMOVE][i][UNNORMALISED], nMatchTo));
        if (psc->anCloseCube[i]) {
            ratingtype rt = GetRating(aaaar[CUBEDECISION][PERMOVE][i][NORMALISED]);
            cJSON_AddStringToObject(cu, "rating", rating_text(rt));
            cJSON_AddNumberToObject(cu, "ratingIndex", rt);
        } else {
            cJSON_AddNullToObject(cu, "rating");
            cJSON_AddNullToObject(cu, "ratingIndex");
        }

        /* overall (FORMATGS_OVERALL) */
        ov = cJSON_AddObjectToObject(p, "overall");
        cJSON_AddItemToObject(ov, "errorTotal",
                              err_json(aaaar[COMBINED][TOTAL][i][NORMALISED],
                                       aaaar[COMBINED][TOTAL][i][UNNORMALISED], nMatchTo));
        cJSON_AddItemToObject(ov, "errorPerDecision",
                              err_json(aaaar[COMBINED][PERMOVE][i][NORMALISED],
                                       aaaar[COMBINED][PERMOVE][i][UNNORMALISED], nMatchTo));
        {
            int n = psc->anTotalMoves[0] + psc->anTotalMoves[1];
            if (n > 0)
                add_num(ov, "snowieErrorRate", aaaar[COMBINED][TOTAL][i][NORMALISED] / (float) n);
            else
                cJSON_AddNullToObject(ov, "snowieErrorRate");
        }
        if (psc->anCloseCube[i] + psc->anUnforcedMoves[i]) {
            ratingtype rt = GetRating(aaaar[COMBINED][PERMOVE][i][NORMALISED]);
            cJSON_AddStringToObject(ov, "rating", rating_text(rt));
            cJSON_AddNumberToObject(ov, "ratingIndex", rt);
        } else {
            cJSON_AddNullToObject(ov, "rating");
            cJSON_AddNullToObject(ov, "ratingIndex");
        }
        add_num(ov, "actualResult", psc->arActualResult[i]);
        add_num(ov, "luckAdjustedResult", psc->arLuckAdj[i]);
        add_num(ov, "varianceActual", psc->arVarianceActual[i]);
        add_num(ov, "varianceLuckAdjusted", psc->arVarianceLuckAdj[i]);
        if (nMatchTo) {
            cJSON *f = cJSON_AddObjectToObject(ov, "errorBasedFibsRating");
            if (psc->anCloseCube[i] + psc->anUnforcedMoves[i])
                add_num(f, "total", absoluteFibsRating(aaaar[CHEQUERPLAY][PERMOVE][i][NORMALISED],
                                                       aaaar[CUBEDECISION][PERMOVE][i][NORMALISED],
                                                       nMatchTo, rRatingOffset));
            else
                cJSON_AddNullToObject(f, "total");
            if (psc->anUnforcedMoves[i])
                add_num(f, "chequerLoss",
                        absoluteFibsRatingChequer(aaaar[CHEQUERPLAY][PERMOVE][i][NORMALISED], nMatchTo));
            else
                cJSON_AddNullToObject(f, "chequerLoss");
            if (psc->anCloseCube[i])
                add_num(f, "cubeLoss", absoluteFibsRatingCube(aaaar[CUBEDECISION][PERMOVE][i][NORMALISED], nMatchTo));
            else
                cJSON_AddNullToObject(f, "cubeLoss");
        }
        if (psc->fDice && !nMatchTo && psc->nGames > 1) {
            /* "Advantage in ppg" rows, with formatGS's exact expressions. */
            const float *af[2][2] = { { psc->arActualResult, psc->arVarianceActual },
                                      { psc->arLuckAdj, psc->arVarianceLuckAdj } };
            static const char *names[2] = { "advantageActual", "advantageLuckAdjusted" };
            for (int k = 0; k < 2; k++) {
                cJSON *a = cJSON_AddObjectToObject(ov, names[k]);
                float ci = 1.95996f * sqrtf(af[k][1][i] / (float) psc->nGames);
                add_num(a, "ppg", af[k][0][i] / (float) psc->nGames);
                add_num(a, "ciLow", af[k][0][i] - ci);
                add_num(a, "ciHigh", af[k][0][i] + ci);
            }
        }
        cJSON_AddItemToArray(players, p);
    }

    /* "Luck based FIBS rating diff." (formatGS; uses gnubg's ms.nMatchTo) */
    if (nMatchTo && psc->fDice && (psc->arActualResult[0] > 0.0f || psc->arActualResult[1] > 0.0f)) {
        float r = 0.5f + psc->arActualResult[0] - psc->arLuck[0][1] + psc->arLuck[1][1];
        if (r > 0.0f && r < 1.0f)
            add_num(s, "luckBasedFibsRatingDiff", relativeFibsRating(r, ms.nMatchTo));
        else
            cJSON_AddNullToObject(s, "luckBasedFibsRatingDiff");
    }
    (void) fIsMatch;
    return s;
}

/* The exact text of gnubg's "show statistics match/game" (DumpStatcontext). */
static void
add_stats_text(cJSON *o, const statcontext *psc)
{
    char *sz = g_malloc0(STATCONTEXT_MAXSIZE);
    DumpStatcontext(sz, psc, ap[0].szName, ap[1].szName, ms.nMatchTo);
    cJSON_AddStringToObject(o, "statisticsText", sz);
    g_free(sz);
}

/*
 * Everything gnubg knows about the analysed match.
 * Request: {"maxMoves": 5 (alternatives per chequer move, 0 = all),
 *           "game": i (only this game; default all),
 *           "text": true (add gnubg's "show statistics" text)}
 * Statistics are recomputed with updateStatisticsMatch, exactly as
 * "show statistics match" does.
 */
API_EXPORT const char *
gnubg_api_get_analysis(const char *requestJson)
{
    cJSON *req, *o, *games;
    int maxMoves = 5, onlyGame = -1, fText = FALSE, iGame = 0;
    int nMatchTo;
    const char *err;

    API_REQUIRE_READY();
    if (!(req = parse_request(requestJson, &err)))
        return error_result(err);
    err = get_int_field(req, "maxMoves", 0, INT_MAX, &maxMoves);
    if (!err)
        err = get_int_field(req, "game", 0, INT_MAX, &onlyGame);
    if (!err)
        err = get_bool_field(req, "text", &fText);
    cJSON_Delete(req);
    if (err)
        return error_result(err);
    if (!match_loaded())
        return error_result("no match loaded");
    if (onlyGame >= count_games())
        return error_result("\"game\" must be a valid game index");

    save_defaults();
    /* What "show statistics match" does first. */
    updateStatisticsMatch(&lMatch);

    o = match_overview();
    nMatchTo = game_info(lMatch.plNext->p)->g.nMatch;
    cJSON_AddItemToObject(o, "settings", settings_json());
    add_num(o, "errorRateFactor", rErrorRateFactor);
    cJSON_DeleteItemFromObject(o, "games");
    games = cJSON_AddArrayToObject(o, "games");
    for (listOLD *pl = lMatch.plNext; pl != &lMatch; pl = pl->plNext, iGame++) {
        listOLD *plG = pl->p;
        moverecord *pmr = game_info(plG);
        cJSON *g;

        if (onlyGame >= 0 && iGame != onlyGame)
            continue;
        g = cJSON_CreateObject();
        cJSON_AddNumberToObject(g, "index", iGame);
        cJSON_AddItemToObject(g, "scoreBefore", int_pair(pmr->g.anScore[0], pmr->g.anScore[1]));
        cJSON_AddBoolToObject(g, "crawfordGame", pmr->g.fCrawfordGame);
        if (pmr->g.fWinner >= 0) {
            cJSON_AddNumberToObject(g, "winner", pmr->g.fWinner);
            cJSON_AddNumberToObject(g, "points", pmr->g.nPoints);
            cJSON_AddBoolToObject(g, "resigned", pmr->g.fResigned);
        } else {
            cJSON_AddNullToObject(g, "winner");
            cJSON_AddNullToObject(g, "points");
            cJSON_AddBoolToObject(g, "resigned", 0);
        }
        cJSON_AddItemToObject(g, "records", game_records_json(plG, maxMoves));
        cJSON_AddItemToObject(g, "statistics", stats_json(&pmr->g.sc, nMatchTo, FALSE));
        if (fText)
            add_stats_text(g, &pmr->g.sc);
        cJSON_AddItemToArray(games, g);
    }
    cJSON_AddItemToObject(o, "statistics", stats_json(&scMatch, nMatchTo, TRUE));
    if (fText)
        add_stats_text(o, &scMatch);
    return finish(o);
}

/* ---------------------------------------------------------------------- */
/* Export                                                                 */
/* ---------------------------------------------------------------------- */

/*
 * Export the current match with gnubg's own writers.
 * Request:  {"format": "sgf" | "mat"}
 * Response: {"ok":true, "format":..., "text":"..."}
 * SGF is "save match" (includes the analysis); mat is "export match mat".
 */
API_EXPORT const char *
gnubg_api_export_match(const char *requestJson)
{
    cJSON *req, *o;
    const cJSON *jfmt;
    const char *err;
    char path[64], cmd[80];
    char *text = NULL, *messages;
    gsize len = 0;
    int fSgf;

    API_REQUIRE_READY();
    if (!(req = parse_request(requestJson, &err)))
        return error_result(err);
    jfmt = cJSON_GetObjectItemCaseSensitive(req, "format");
    if (!cJSON_IsString(jfmt) || (strcmp(jfmt->valuestring, "sgf") && strcmp(jfmt->valuestring, "mat"))) {
        cJSON_Delete(req);
        return error_result("\"format\" must be \"sgf\" or \"mat\"");
    }
    fSgf = !strcmp(jfmt->valuestring, "sgf");
    cJSON_Delete(req);
    if (!match_loaded())
        return error_result("no match loaded");

    snprintf(path, sizeof path, "%s.%s", TMP_EXPORT, fSgf ? "sgf" : "mat");
    unlink(path);               /* so gnubg never asks "overwrite?" */
    snprintf(cmd, sizeof cmd, "%s", path);
    capture_begin();
    if (fSgf)
        CommandSaveMatch(cmd);
    else
        CommandExportMatchMat(cmd);
    messages = capture_end();
    if (!g_file_get_contents(path, &text, &len, NULL)) {
        o = cJSON_CreateObject();
        cJSON_AddBoolToObject(o, "ok", 0);
        cJSON_AddStringToObject(o, "error", "gnubg did not write the file");
        add_messages(o, messages);
        return finish(o);
    }
    unlink(path);
    o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);
    cJSON_AddStringToObject(o, "format", fSgf ? "sgf" : "mat");
    cJSON_AddStringToObject(o, "text", text);
    g_free(text);
    add_messages(o, messages);
    return finish(o);
}
