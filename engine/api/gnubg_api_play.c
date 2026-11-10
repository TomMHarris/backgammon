/*
 * gnubg_api_play.c: what play mode needs from the engine.
 *
 *   gnubg_api_position_info  decode position + match IDs into plain data
 *   gnubg_api_make_ids       build position + match IDs from plain data
 *   gnubg_api_legal_moves    every legal play for a roll (the UI's move rules)
 *   gnubg_api_bot_move       the move gnubg's computer player would make
 *   gnubg_api_bot_double     whether gnubg's computer player would double
 *   gnubg_api_bot_take       gnubg's computer player's answer to a double
 *
 * The engine is stateless here: every request carries the position (gnubg
 * position ID) and the match state (gnubg match ID). The web app runs the
 * game flow itself (dice, turns, score) and asks the engine for rules and
 * decisions.
 *
 * Board convention (gnubg's TanBoard): board[1] is the player on roll and
 * board[0] the opponent. Each is 25 numbers: index i (0..23) is that player's
 * own point i+1 counted from their home board (index 0 = their ace point),
 * index 24 is their bar. Checkers borne off are 15 minus the sum.
 *
 * The bot functions follow gnubg's ComputerTurn() in play.c step by step;
 * line references below are to gnubg 1.08.003.
 *
 * Copyright (C) 2026 gnubg-web contributors. GPL v3 or later (see LICENSE).
 */
#include "api_util.h"

#include <stdlib.h>
#include <string.h>

#include "positionid.h"
#include "matchid.h"
#include "drawboard.h"
#include "matchequity.h"

/* --------------------------------------------------------------------- */
/* Small helpers                                                         */
/* --------------------------------------------------------------------- */

static cJSON *
board_json(const TanBoard anBoard)
{
    cJSON *b = cJSON_CreateArray();
    for (int side = 0; side < 2; side++) {
        cJSON *s = cJSON_CreateArray();
        for (int i = 0; i < 25; i++)
            cJSON_AddItemToArray(s, cJSON_CreateNumber(anBoard[side][i]));
        cJSON_AddItemToArray(b, s);
    }
    return b;
}

/* Read "board": [[25 numbers],[25 numbers]] into anBoard. */
static const char *
parse_board(const cJSON *jb, TanBoard anBoard)
{
    if (!cJSON_IsArray(jb) || cJSON_GetArraySize(jb) != 2)
        return "\"board\" must be [[25 numbers], [25 numbers]]";
    for (int side = 0; side < 2; side++) {
        const cJSON *s = cJSON_GetArrayItem(jb, side);
        unsigned int total = 0;
        if (!cJSON_IsArray(s) || cJSON_GetArraySize(s) != 25)
            return "\"board\" must be [[25 numbers], [25 numbers]]";
        for (int i = 0; i < 25; i++) {
            const cJSON *n = cJSON_GetArrayItem(s, i);
            if (!cJSON_IsNumber(n) || n->valueint < 0 || n->valueint > 15)
                return "board entries must be 0..15";
            anBoard[side][i] = (unsigned int) n->valueint;
            total += anBoard[side][i];
        }
        if (total > 15)
            return "a side has more than 15 checkers";
    }
    return NULL;
}

/* {"from": [..], "to": [..]} pairs from gnubg's anMove (-1 terminated) */
static cJSON *
move_pairs_json(const int anMove[8])
{
    cJSON *a = cJSON_CreateArray();
    for (int i = 0; i < 8 && anMove[i] >= 0; i += 2) {
        cJSON *p = cJSON_CreateArray();
        cJSON_AddItemToArray(p, cJSON_CreateNumber(anMove[i]));
        cJSON_AddItemToArray(p, cJSON_CreateNumber(anMove[i + 1]));
        cJSON_AddItemToArray(a, p);
    }
    return a;
}

/* Position IDs after playing anMove: from the mover's perspective, and
 * swapped (the next player's perspective, i.e. what the next turn uses). */
static void
add_after_positions(cJSON *o, const TanBoard anBoard, const int anMove[8])
{
    TanBoard b;
    memcpy(b, anBoard, sizeof(TanBoard));
    ApplyMove(b, anMove, FALSE);
    cJSON_AddStringToObject(o, "positionAfter", PositionID((ConstTanBoard) b));
    SwapSides(b);
    cJSON_AddStringToObject(o, "positionAfterSwapped", PositionID((ConstTanBoard) b));
}

static int
dice_from(const cJSON *req, const api_position *pos, int *d0, int *d1)
{
    const cJSON *jd = cJSON_GetObjectItemCaseSensitive(req, "dice");
    if (cJSON_IsArray(jd) && cJSON_GetArraySize(jd) == 2) {
        *d0 = cJSON_GetArrayItem(jd, 0)->valueint;
        *d1 = cJSON_GetArrayItem(jd, 1)->valueint;
    } else {
        *d0 = (int) pos->anDice[0];
        *d1 = (int) pos->anDice[1];
    }
    return *d0 >= 1 && *d0 <= 6 && *d1 >= 1 && *d1 <= 6;
}

/* --------------------------------------------------------------------- */
/* Position and match IDs                                                */
/* --------------------------------------------------------------------- */

/*
 * Request:  {"position": "...", "match": "..."}   (match optional)
 * Response: {"ok", "positionId", "board": [[25],[25]], "pips": [opp, onRoll],
 *            "borneOff": [opp, onRoll], "positionClass": n, "match": {...}}
 */
API_EXPORT const char *
gnubg_api_position_info(const char *requestJson)
{
    cJSON *req = cJSON_Parse(requestJson), *o, *jm;
    const cJSON *jmatch;
    TanBoard anBoard;
    unsigned int anPips[2];
    const char *posid;

    if (!req)
        return error_result("request is not valid JSON");
    posid = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(req, "position"));
    if (!posid || !PositionFromID(anBoard, posid)) {
        cJSON_Delete(req);
        return error_result("missing or invalid \"position\"");
    }
    PipCount((ConstTanBoard) anBoard, anPips);

    o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);
    cJSON_AddStringToObject(o, "positionId", PositionID((ConstTanBoard) anBoard));
    cJSON_AddItemToObject(o, "board", board_json((ConstTanBoard) anBoard));
    {
        cJSON *p = cJSON_AddArrayToObject(o, "pips"), *bo = cJSON_AddArrayToObject(o, "borneOff");
        for (int side = 0; side < 2; side++) {
            unsigned int n = 0;
            for (int i = 0; i < 25; i++)
                n += anBoard[side][i];
            cJSON_AddItemToArray(p, cJSON_CreateNumber(anPips[side]));
            cJSON_AddItemToArray(bo, cJSON_CreateNumber(15 - n));
        }
    }
    cJSON_AddNumberToObject(o, "positionClass", ClassifyPosition((ConstTanBoard) anBoard, VARIATION_STANDARD));

    jmatch = cJSON_GetObjectItemCaseSensitive(req, "match");
    if (cJSON_IsString(jmatch)) {
        unsigned int anDice[2];
        int fTurn, fResigned, fDoubled, fMove, fCubeOwner, fCrawford, nMatchTo, anScore[2], nCube, fJac;
        gamestate gs;
        /* returns 0 on success, -1 on error */
        if (MatchFromID(anDice, &fTurn, &fResigned, &fDoubled, &fMove, &fCubeOwner, &fCrawford,
                         &nMatchTo, anScore, &nCube, &fJac, &gs, jmatch->valuestring) < 0) {
            cJSON_Delete(o);
            cJSON_Delete(req);
            return error_result("invalid \"match\" ID");
        }
        jm = cJSON_AddObjectToObject(o, "match");
        cJSON_AddStringToObject(jm, "matchId", jmatch->valuestring);
        {
            cJSON *d = cJSON_AddArrayToObject(jm, "dice");
            cJSON_AddItemToArray(d, cJSON_CreateNumber(anDice[0]));
            cJSON_AddItemToArray(d, cJSON_CreateNumber(anDice[1]));
        }
        cJSON_AddNumberToObject(jm, "turn", fTurn);
        cJSON_AddNumberToObject(jm, "move", fMove);
        cJSON_AddNumberToObject(jm, "resigned", fResigned);
        cJSON_AddBoolToObject(jm, "doubled", fDoubled);
        cJSON_AddNumberToObject(jm, "cube", nCube);
        cJSON_AddNumberToObject(jm, "cubeOwner", fCubeOwner);
        cJSON_AddBoolToObject(jm, "crawford", fCrawford);
        cJSON_AddNumberToObject(jm, "matchLength", nMatchTo);
        {
            cJSON *s = cJSON_AddArrayToObject(jm, "score");
            cJSON_AddItemToArray(s, cJSON_CreateNumber(anScore[0]));
            cJSON_AddItemToArray(s, cJSON_CreateNumber(anScore[1]));
        }
        cJSON_AddBoolToObject(jm, "jacoby", fJac);
        cJSON_AddNumberToObject(jm, "gameState", (int) gs);
    }
    cJSON_Delete(req);
    return finish(o);
}

/*
 * Build IDs. Request (all fields optional except board or position):
 *   {"board": [[25],[25]] | "position": "...",
 *    "dice": [d1,d2], "turn": 0|1, "move": 0|1, "resigned": 0|1|2|3,
 *    "doubled": bool, "cube": n, "cubeOwner": -1|0|1, "crawford": bool,
 *    "matchLength": n (0 = money), "score": [a,b], "jacoby": bool,
 *    "gameState": n (gnubg gamestate; default 1 = playing)}
 * Response: {"ok", "positionId", "matchId"}
 */
API_EXPORT const char *
gnubg_api_make_ids(const char *requestJson)
{
    cJSON *req = cJSON_Parse(requestJson), *o;
    const cJSON *j;
    TanBoard anBoard;
    unsigned int anDice[2] = { 0, 0 };
    int anScore[2] = { 0, 0 };
    int fTurn = 0, fMove = 0, fResigned = 0, fDoubled = 0, nCube = 1, fCubeOwner = -1;
    int fCrawford = 0, nMatchTo = 0, fJac = fJacoby;
    gamestate gs = GAME_PLAYING;
    const char *err = NULL;

    if (!req)
        return error_result("request is not valid JSON");
    if ((j = cJSON_GetObjectItemCaseSensitive(req, "board")))
        err = parse_board(j, anBoard);
    else if (!cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(req, "position")) ||
             !PositionFromID(anBoard, cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(req, "position"))))
        err = "need \"board\" or a valid \"position\"";
    if (err) {
        cJSON_Delete(req);
        return error_result(err);
    }
#define GET_INT(name, var) if ((j = cJSON_GetObjectItemCaseSensitive(req, name)) && cJSON_IsNumber(j)) var = j->valueint
#define GET_BOOL(name, var) if ((j = cJSON_GetObjectItemCaseSensitive(req, name)) && cJSON_IsBool(j)) var = cJSON_IsTrue(j)
    GET_INT("turn", fTurn);
    GET_INT("move", fMove);
    GET_INT("resigned", fResigned);
    GET_BOOL("doubled", fDoubled);
    GET_INT("cube", nCube);
    GET_INT("cubeOwner", fCubeOwner);
    GET_BOOL("crawford", fCrawford);
    GET_INT("matchLength", nMatchTo);
    GET_BOOL("jacoby", fJac);
    if ((j = cJSON_GetObjectItemCaseSensitive(req, "gameState")) && cJSON_IsNumber(j))
        gs = (gamestate) j->valueint;
#undef GET_INT
#undef GET_BOOL
    if ((j = cJSON_GetObjectItemCaseSensitive(req, "dice")) && cJSON_IsArray(j) && cJSON_GetArraySize(j) == 2) {
        anDice[0] = (unsigned int) cJSON_GetArrayItem(j, 0)->valueint;
        anDice[1] = (unsigned int) cJSON_GetArrayItem(j, 1)->valueint;
    }
    if ((j = cJSON_GetObjectItemCaseSensitive(req, "score")) && cJSON_IsArray(j) && cJSON_GetArraySize(j) == 2) {
        anScore[0] = cJSON_GetArrayItem(j, 0)->valueint;
        anScore[1] = cJSON_GetArrayItem(j, 1)->valueint;
    }
    cJSON_Delete(req);

    o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);
    cJSON_AddStringToObject(o, "positionId", PositionID((ConstTanBoard) anBoard));
    cJSON_AddStringToObject(o, "matchId", MatchID(anDice, fTurn, fResigned, fDoubled, fMove, fCubeOwner,
                                                  fCrawford, nMatchTo, anScore, nCube, fJac, gs));
    return finish(o);
}

/* --------------------------------------------------------------------- */
/* Legal moves                                                           */
/* --------------------------------------------------------------------- */

/*
 * Every legal play for a roll, as gnubg's move generator produces them
 * (GenerateMoves; plays that use fewer dice than possible are excluded,
 * and plays leading to the same position are listed once).
 * Request:  {"position": "...", "dice": [d1, d2]}  (or dice from "match")
 * Response: {"ok", "moves": [{"move": "24/21 13/12", "pairs": [[from,to],...],
 *            "positionAfter": id (mover's view), "positionAfterSwapped": id
 *            (next player's view)}], "count": n}
 * Points in "pairs" are 0-based from the mover's side: 24 = bar, -1 = off.
 */
API_EXPORT const char *
gnubg_api_legal_moves(const char *requestJson)
{
    cJSON *req = cJSON_Parse(requestJson), *o, *jmoves;
    api_position pos;
    movelist ml;
    const char *err;
    int d0, d1;
    move *amCopy;
    unsigned int cMoves;

    if (!req)
        return error_result("request is not valid JSON");
    if ((err = parse_position(req, &pos))) {
        cJSON_Delete(req);
        return error_result(err);
    }
    if (!dice_from(req, &pos, &d0, &d1)) {
        cJSON_Delete(req);
        return error_result("need \"dice\": [d1, d2] (1..6), or a match ID with dice");
    }
    cJSON_Delete(req);

    /* GenerateMoves fills ml with pointers into static storage; copy the
     * moves out before calling anything else that generates moves. */
    GenerateMoves(&ml, (ConstTanBoard) pos.anBoard, d0, d1, FALSE);
    cMoves = ml.cMoves;
    amCopy = cMoves ? (move *) g_memdup2(ml.amMoves, cMoves * sizeof(move)) : NULL;

    o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);
    cJSON_AddNumberToObject(o, "count", cMoves);
    jmoves = cJSON_AddArrayToObject(o, "moves");
    for (unsigned int i = 0; i < cMoves; i++) {
        char sz[FORMATEDMOVESIZE];
        cJSON *jm = cJSON_CreateObject();
        FormatMove(sz, (ConstTanBoard) pos.anBoard, amCopy[i].anMove);
        cJSON_AddStringToObject(jm, "move", sz);
        cJSON_AddItemToObject(jm, "pairs", move_pairs_json(amCopy[i].anMove));
        add_after_positions(jm, (ConstTanBoard) pos.anBoard, amCopy[i].anMove);
        cJSON_AddItemToArray(jmoves, jm);
    }
    g_free(amCopy);
    return finish(o);
}

/* --------------------------------------------------------------------- */
/* gnubg's computer player                                               */
/* --------------------------------------------------------------------- */

/*
 * The move gnubg would play: play.c ComputerTurn() lines ~1416-1436:
 * FindnSaveBestMoves with threshold 0 and the player's chequer settings and
 * move filter, RefreshMoveList, then the first move. Weaker presets include
 * gnubg's evaluation noise (deterministic per position, as in gnubg).
 * Request:  {"position", "match" (with dice) | "dice", "preset"|"eval"}
 * Response: {"ok", "move": text | null (no legal move), "pairs", "positionAfter",
 *            "positionAfterSwapped", "equity", "eval"}
 */
API_EXPORT const char *
gnubg_api_bot_move(const char *requestJson)
{
    cJSON *req = cJSON_Parse(requestJson), *o;
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
    if (!dice_from(req, &pos, &d0, &d1)) {
        cJSON_Delete(req);
        return error_result("need \"dice\" or a match ID with dice");
    }
    cJSON_Delete(req);

    memset(&ml, 0, sizeof(ml));
    if (FindnSaveBestMoves(&ml, d0, d1, (ConstTanBoard) pos.anBoard, NULL, 0.0f, &pos.ci, &ec, aamf) < 0)
        return error_result("move evaluation failed");
    RefreshMoveList(&ml, NULL);

    o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);
    if (ml.cMoves) {
        char sz[FORMATEDMOVESIZE];
        FormatMove(sz, (ConstTanBoard) pos.anBoard, ml.amMoves[0].anMove);
        cJSON_AddStringToObject(o, "move", sz);
        cJSON_AddItemToObject(o, "pairs", move_pairs_json(ml.amMoves[0].anMove));
        add_after_positions(o, (ConstTanBoard) pos.anBoard, ml.amMoves[0].anMove);
        add_num(o, "equity", ml.amMoves[0].rScore);
    } else {
        TanBoard b;
        cJSON_AddNullToObject(o, "move");
        cJSON_AddItemToObject(o, "pairs", cJSON_CreateArray());
        memcpy(b, pos.anBoard, sizeof(TanBoard));
        cJSON_AddStringToObject(o, "positionAfter", PositionID((ConstTanBoard) b));
        SwapSides(b);
        cJSON_AddStringToObject(o, "positionAfterSwapped", PositionID((ConstTanBoard) b));
    }
    cJSON_AddItemToObject(o, "eval", eval_json(&ec));
    g_free(ml.amMoves);
    return finish(o);
}

/*
 * Would gnubg double now (player on roll, before rolling)? play.c lines
 * ~1290-1375: if the cube is available, first a cheap "market window" check
 * (cubeless evaluation one ply shallower than the cube setting, compared with
 * GetDoublePointDeadCube); only if inside the window, the full cube decision,
 * then gnubg's mapping from verdict to action.
 * Request:  {"position", "match" (no dice), "preset"|"eval"}
 * Response: {"ok", "double": bool, "reason": "...", "recommendation": text|null}
 */
API_EXPORT const char *
gnubg_api_bot_double(const char *requestJson)
{
    cJSON *req = cJSON_Parse(requestJson), *o;
    api_position pos;
    evalcontext ec, ecDH;
    movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES];
    float arOutput[NUM_ROLLOUT_OUTPUTS];
    float aarOutput[2][NUM_ROLLOUT_OUTPUTS], arDouble[4];
    const char *err;
    int fDouble = FALSE;
    cubedecision cd;

    if (!req)
        return error_result("request is not valid JSON");
    if ((err = parse_position(req, &pos)) || (err = parse_eval(req, &ec, aamf))) {
        cJSON_Delete(req);
        return error_result(err);
    }
    cJSON_Delete(req);
    ec.fCubeful = TRUE;         /* the computer's cube setting (esCube) */

    o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);

    if (pos.ci.nCube >= MAX_CUBE || !GetDPEq(NULL, NULL, &pos.ci)) {
        cJSON_AddBoolToObject(o, "double", 0);
        cJSON_AddStringToObject(o, "reason", "cube not available");
        cJSON_AddNullToObject(o, "recommendation");
        return finish(o);
    }

    ecDH = ec;
    ecDH.fCubeful = FALSE;
    if (ecDH.nPlies)
        ecDH.nPlies--;
    if (EvaluatePosition(NULL, (ConstTanBoard) pos.anBoard, arOutput, &pos.ci, &ecDH)) {
        cJSON_Delete(o);
        return error_result("evaluation failed");
    }
    if (arOutput[0] < GetDoublePointDeadCube(arOutput, &pos.ci)) {
        cJSON_AddBoolToObject(o, "double", 0);
        cJSON_AddStringToObject(o, "reason", "outside market window");
        cJSON_AddNullToObject(o, "recommendation");
        return finish(o);
    }

    if (GeneralCubeDecisionE(aarOutput, (ConstTanBoard) pos.anBoard, &pos.ci, &ec, NULL) < 0) {
        cJSON_Delete(o);
        return error_result("cube evaluation failed");
    }
    cd = FindCubeDecision(arDouble, aarOutput, &pos.ci);
    switch (cd) {
    case DOUBLE_TAKE:
    case REDOUBLE_TAKE:
    case DOUBLE_PASS:
    case REDOUBLE_PASS:
    case DOUBLE_BEAVER:
        fDouble = TRUE;
        break;
    case OPTIONAL_DOUBLE_BEAVER:
    case OPTIONAL_DOUBLE_TAKE:
    case OPTIONAL_REDOUBLE_TAKE:
    case OPTIONAL_DOUBLE_PASS:
    case OPTIONAL_REDOUBLE_PASS:
        /* gnubg doubles optional doubles only at 0-ply, unless about to lose */
        fDouble = (ec.nPlies == 0 && arOutput[0] > 0.001f);
        break;
    default:
        fDouble = FALSE;
        break;
    }
    cJSON_AddBoolToObject(o, "double", fDouble);
    cJSON_AddStringToObject(o, "reason", "cube decision");
    cJSON_AddStringToObject(o, "recommendation", GetCubeRecommendation(cd));
    return finish(o);
}

/*
 * gnubg's answer to a double: play.c lines ~1199-1245 ("normal double by
 * opponent"). The position and match ID are those of the DOUBLER, on roll,
 * with the cube as it was before doubling (the cube decision is evaluated
 * from the doubler's side, as gnubg does).
 * Request:  {"position", "match", "preset"|"eval", "beaversSoFar": n (default 0)}
 * Response: {"ok", "action": "take"|"drop"|"beaver", "recommendation": text}
 */
API_EXPORT const char *
gnubg_api_bot_take(const char *requestJson)
{
    cJSON *req = cJSON_Parse(requestJson), *o;
    const cJSON *j;
    api_position pos;
    evalcontext ec;
    movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES];
    float aarOutput[2][NUM_ROLLOUT_OUTPUTS], arDouble[4];
    const char *err, *action;
    int cBeavers = 0;
    cubedecision cd;

    if (!req)
        return error_result("request is not valid JSON");
    if ((err = parse_position(req, &pos)) || (err = parse_eval(req, &ec, aamf))) {
        cJSON_Delete(req);
        return error_result(err);
    }
    if ((j = cJSON_GetObjectItemCaseSensitive(req, "beaversSoFar")) && cJSON_IsNumber(j))
        cBeavers = j->valueint;
    cJSON_Delete(req);
    ec.fCubeful = TRUE;

    if (GeneralCubeDecisionE(aarOutput, (ConstTanBoard) pos.anBoard, &pos.ci, &ec, NULL) < 0)
        return error_result("cube evaluation failed");
    cd = FindCubeDecision(arDouble, aarOutput, &pos.ci);

    switch (cd) {
    case DOUBLE_PASS:
    case TOOGOOD_PASS:
    case REDOUBLE_PASS:
    case TOOGOODRE_PASS:
    case OPTIONAL_DOUBLE_PASS:
    case OPTIONAL_REDOUBLE_PASS:
        action = "drop";
        break;
    case DOUBLE_BEAVER:
    case NODOUBLE_BEAVER:
    case NO_REDOUBLE_BEAVER:
    case OPTIONAL_DOUBLE_BEAVER:
        action = (cBeavers < (int) nBeavers && !pos.ci.nMatchTo && pos.ci.nCube < (MAX_CUBE >> 1))
            ? "beaver" : "take";
        break;
    default:
        action = "take";
        break;
    }
    o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);
    cJSON_AddStringToObject(o, "action", action);
    cJSON_AddStringToObject(o, "recommendation", GetCubeRecommendation(cd));
    return finish(o);
}
