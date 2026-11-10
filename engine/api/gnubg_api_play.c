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

#include <limits.h>
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

/* Read "board": [[25 numbers],[25 numbers]] into anBoard and check it with
 * gnubg's CheckPosition (positionid.c:286), as "set board" does. */
static const char *
parse_board(const cJSON *jb, TanBoard anBoard)
{
    unsigned int total[2] = { 0, 0 };

    if (!cJSON_IsArray(jb) || cJSON_GetArraySize(jb) != 2)
        return "\"board\" must be [[25 numbers], [25 numbers]]";
    for (int side = 0; side < 2; side++) {
        const cJSON *s = cJSON_GetArrayItem(jb, side);
        if (!cJSON_IsArray(s) || cJSON_GetArraySize(s) != 25)
            return "\"board\" must be [[25 numbers], [25 numbers]]";
        for (int i = 0; i < 25; i++) {
            const cJSON *n = cJSON_GetArrayItem(s, i);
            if (!cJSON_IsNumber(n) || n->valuedouble < 0 || n->valuedouble > 15
                || n->valuedouble != (double) (int) n->valuedouble)
                return "board entries must be integers from 0 to 15";
            anBoard[side][i] = (unsigned int) n->valuedouble;
            total[side] += anBoard[side][i];
        }
        if (total[side] > 15)
            return "a side has more than 15 checkers";
    }
    if (total[0] == 0 && total[1] == 0)
        return "there are no checkers on the board";
    if (!CheckPosition((ConstTanBoard) anBoard))
        return "not a legal position (both sides on one point, or both on the bar against closed boards)";
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

/* "dice": [d1, d2] if given (used in that order; see rank_moves in
 * gnubg_api.c on dice order), else the dice in the match ID (larger die
 * first). */
static const char *
dice_from(const cJSON *req, const api_position *pos, int anDice[2])
{
    int fDice;
    const char *err = get_dice_field(req, "dice", &fDice, anDice);
    if (err || fDice)
        return err;
    if (!pos->anDice[0])
        return "need \"dice\": [d1, d2] (1..6), or a match ID with dice";
    anDice[0] = (int) pos->anDice[0];
    anDice[1] = (int) pos->anDice[1];
    return NULL;
}

/* Parse the request, "position"/"match", and optionally the evaluation
 * settings (pec != NULL) and the dice (anDice != NULL). Returns the request
 * (cJSON_Delete it) or NULL with *err set. */
static cJSON *
parse_common(const char *requestJson, api_position *pos, evalcontext *pec,
             movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES], int *anDice, const char **err)
{
    cJSON *req = parse_request(requestJson, err);
    if (!req)
        return NULL;
    if ((*err = parse_position(req, pos))
        || (pec && (*err = parse_eval(req, pec, aamf)))
        || (anDice && (*err = dice_from(req, pos, anDice)))) {
        cJSON_Delete(req);
        return NULL;
    }
    return req;
}

/* --------------------------------------------------------------------- */
/* Position and match IDs                                                */
/* --------------------------------------------------------------------- */

/*
 * Request:  {"position": "...", "match": "..."}   (match optional)
 * Response: {"ok", "positionId", "board": [[25],[25]], "pips": [opp, onRoll],
 *            "borneOff": [opp, onRoll], "positionClass": n, "match": {...}}
 * IDs are validated as everywhere else (see api_util.h), except that a
 * finished game (one side has borne off everything) is accepted here. The
 * match state is reported as desktop "set matchid" would set it (see
 * decode_match_id: a pending double is stepped back, a Crawford flag only
 * counts at 1-away), and "matchId" is gnubg's ID for that state (the input
 * itself whenever it was already normalised).
 */
API_EXPORT const char *
gnubg_api_position_info(const char *requestJson)
{
    cJSON *req, *o, *jm;
    TanBoard anBoard;
    unsigned int anPips[2];
    const char *szPos = NULL, *szMatch = NULL, *err;
    api_match m;

    API_REQUIRE_READY();
    if (!(req = parse_request(requestJson, &err)))
        return error_result(err);
    if ((err = get_string_field(req, "position", &szPos)) || (err = get_string_field(req, "match", &szMatch))
        || (!szPos && (err = "missing \"position\" (a gnubg position ID)"))
        || (err = decode_position_id(szPos, FALSE, anBoard))
        || (szMatch && (err = decode_match_id(szMatch, &m)))) {
        cJSON_Delete(req);
        return error_result(err);
    }
    cJSON_Delete(req);
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

    if (szMatch) {
        jm = cJSON_AddObjectToObject(o, "match");
        cJSON_AddStringToObject(jm, "matchId", MatchID(m.anDice, m.fTurn, m.fResigned, m.fDoubled, m.fMove,
                                                       m.fCubeOwner, m.fCrawford, m.nMatchTo, m.anScore,
                                                       m.nCube, m.fJacoby, m.gs));
        {
            cJSON *d = cJSON_AddArrayToObject(jm, "dice");
            cJSON_AddItemToArray(d, cJSON_CreateNumber(m.anDice[0]));
            cJSON_AddItemToArray(d, cJSON_CreateNumber(m.anDice[1]));
        }
        cJSON_AddNumberToObject(jm, "turn", m.fTurn);
        cJSON_AddNumberToObject(jm, "move", m.fMove);
        cJSON_AddNumberToObject(jm, "resigned", m.fResigned);
        cJSON_AddBoolToObject(jm, "doubled", m.fDoubled);
        cJSON_AddNumberToObject(jm, "cube", m.nCube);
        cJSON_AddNumberToObject(jm, "cubeOwner", m.fCubeOwner);
        cJSON_AddBoolToObject(jm, "crawford", m.fCrawford);
        cJSON_AddNumberToObject(jm, "matchLength", m.nMatchTo);
        {
            cJSON *s = cJSON_AddArrayToObject(jm, "score");
            cJSON_AddItemToArray(s, cJSON_CreateNumber(m.anScore[0]));
            cJSON_AddItemToArray(s, cJSON_CreateNumber(m.anScore[1]));
        }
        cJSON_AddBoolToObject(jm, "jacoby", m.fJacoby);
        cJSON_AddNumberToObject(jm, "gameState", (int) m.gs);
    }
    return finish(o);
}

/*
 * Build IDs. Request (all fields optional except board or position):
 *   {"board": [[25],[25]] | "position": "...",
 *    "dice": [d1,d2] ([0,0] = not rolled), "turn": 0|1, "move": 0|1,
 *    "resigned": 0|1|2|3, "doubled": bool, "cube": 1|2|4|...,
 *    "cubeOwner": -1|0|1, "crawford": bool, "matchLength": n (0 = money),
 *    "score": [a,b], "jacoby": bool,
 *    "gameState": n (gnubg gamestate 0..4; default 1 = playing)}
 * Other fields are ignored (so a position_info "match" object can be passed
 * back in). Values gnubg could not read back are rejected.
 * Response: {"ok", "positionId", "matchId"}
 */
API_EXPORT const char *
gnubg_api_make_ids(const char *requestJson)
{
    cJSON *req, *o;
    const cJSON *j;
    TanBoard anBoard;
    unsigned int anDice[2] = { 0, 0 };
    int anScore[2] = { 0, 0 };
    int fTurn = 0, fMove = 0, fResigned = 0, fDoubled = 0, nCube = 1, fCubeOwner = -1;
    int fCrawford = 0, nMatchTo = 0, fJac = fJacoby, gs = GAME_PLAYING;
    const char *szPos = NULL, *err = NULL;

    API_REQUIRE_READY();
    if (!(req = parse_request(requestJson, &err)))
        return error_result(err);

    if ((j = cJSON_GetObjectItemCaseSensitive(req, "board")))
        err = cJSON_GetObjectItemCaseSensitive(req, "position") ? "give \"board\" or \"position\", not both"
            : parse_board(j, anBoard);
    else if (!(err = get_string_field(req, "position", &szPos)))
        err = szPos ? decode_position_id(szPos, FALSE, anBoard) : "need \"board\" or \"position\"";

    if (!err && !(err = get_int_field(req, "turn", 0, 1, &fTurn))
        && !(err = get_int_field(req, "move", 0, 1, &fMove))
        && !(err = get_int_field(req, "resigned", 0, 3, &fResigned))
        && !(err = get_bool_field(req, "doubled", &fDoubled))
        && !(err = get_int_field(req, "cube", 1, MAX_CUBE, &nCube))
        && !(err = get_int_field(req, "cubeOwner", -1, 1, &fCubeOwner))
        && !(err = get_bool_field(req, "crawford", &fCrawford))
        && !(err = get_int_field(req, "matchLength", 0, MAXSCORE, &nMatchTo))   /* matchid.c:212 */
        && !(err = get_bool_field(req, "jacoby", &fJac))
        && !(err = get_int_field(req, "gameState", GAME_NONE, GAME_DROP, &gs))) {
        /* dice: [0, 0] (not rolled yet) or two dice 1..6 */
        if ((j = cJSON_GetObjectItemCaseSensitive(req, "dice"))) {
            int fDice, an[2];
            const cJSON *d0 = cJSON_IsArray(j) ? cJSON_GetArrayItem(j, 0) : NULL;
            const cJSON *d1 = cJSON_IsArray(j) ? cJSON_GetArrayItem(j, 1) : NULL;
            if (cJSON_IsArray(j) && cJSON_GetArraySize(j) == 2 && cJSON_IsNumber(d0) && cJSON_IsNumber(d1)
                && d0->valuedouble == 0 && d1->valuedouble == 0) {
                anDice[0] = anDice[1] = 0;
            } else if ((err = get_dice_field(req, "dice", &fDice, an))) {
                err = "\"dice\" must be [0, 0] (not rolled) or two integers from 1 to 6";
            } else {
                anDice[0] = (unsigned int) an[0];
                anDice[1] = (unsigned int) an[1];
            }
        }
        /* score: match play 0..matchLength (MatchFromKey, matchid.c:215-220);
         * money: anything the ID's 15 bits hold (the session score). */
        if (!err && (j = cJSON_GetObjectItemCaseSensitive(req, "score"))) {
            int hi = nMatchTo ? nMatchTo : 0x7FFF;
            for (int i = 0; i < 2 && !err; i++) {
                const cJSON *s = cJSON_IsArray(j) && cJSON_GetArraySize(j) == 2 ? cJSON_GetArrayItem(j, i) : NULL;
                if (!s || !cJSON_IsNumber(s) || s->valuedouble != (double) (int) s->valuedouble
                    || s->valuedouble < 0 || s->valuedouble > hi)
                    err = nMatchTo ? "\"score\" must be two integers from 0 to the match length"
                        : "\"score\" must be two integers from 0 to 32767";
                else
                    anScore[i] = (int) s->valuedouble;
            }
        }
    }
    cJSON_Delete(req);
    if (err)
        return error_result(err);

    /* The cube must be a power of 2 (set.c:924) and, in match play, within
     * gnubg's gammon-price tables (matchequity.h:27, see decode_match_id). */
    if (nCube & (nCube - 1))
        return error_result("\"cube\" must be a power of 2");
    if (nMatchTo && LogCube(nCube) >= MAXCUBELEVEL)
        return error_result("\"cube\" must be at most 64 in match play");
    /* What desktop's "set matchid" would keep (play.c:4166-4185): no
     * Crawford game in money play or a 1-point match, and only at 1-away. */
    if (fCrawford && (nMatchTo <= 1 || (anScore[0] != nMatchTo - 1 && anScore[1] != nMatchTo - 1)))
        return error_result("\"crawford\" can only be true in a match when a player is 1 point away");

    o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);
    cJSON_AddStringToObject(o, "positionId", PositionID((ConstTanBoard) anBoard));
    cJSON_AddStringToObject(o, "matchId", MatchID(anDice, fTurn, fResigned, fDoubled, fMove, fCubeOwner,
                                                  fCrawford, nMatchTo, anScore, nCube, fJac, (gamestate) gs));
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
    cJSON *req, *o, *jmoves;
    api_position pos;
    movelist ml;
    const char *err;
    int anDice[2];
    move *amCopy;
    unsigned int cMoves;

    API_REQUIRE_READY();
    if (!(req = parse_common(requestJson, &pos, NULL, NULL, anDice, &err)))
        return error_result(err);
    cJSON_Delete(req);

    /* GenerateMoves fills ml with pointers into static storage; copy the
     * moves out before calling anything else that generates moves. */
    GenerateMoves(&ml, (ConstTanBoard) pos.anBoard, anDice[0], anDice[1], FALSE);
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
 * The bot evaluates the dice in the order rolled (asyncFindMove uses
 * ms.anDice, gnubg.c:5563); pass them in that order to reproduce it.
 * Request:  {"position", "match" (with dice) | "dice", "preset"|"eval"}
 * Response: {"ok", "move": text | null (no legal move), "pairs", "positionAfter",
 *            "positionAfterSwapped", "equity", "eval"}
 */
API_EXPORT const char *
gnubg_api_bot_move(const char *requestJson)
{
    cJSON *req, *o;
    api_position pos;
    evalcontext ec;
    movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES];
    movelist ml;
    const char *err;
    int anDice[2];

    API_REQUIRE_READY();
    if (!(req = parse_common(requestJson, &pos, &ec, aamf, anDice, &err)))
        return error_result(err);
    cJSON_Delete(req);

    api_flush_cache();   /* results independent of earlier calls; see api_util.h */
    memset(&ml, 0, sizeof(ml));
    if (FindnSaveBestMoves(&ml, anDice[0], anDice[1], (ConstTanBoard) pos.anBoard, NULL, 0.0f,
                           &pos.ci, &ec, aamf) < 0)
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
    cJSON *req, *o;
    api_position pos;
    evalcontext ec, ecDH;
    movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES];
    float arOutput[NUM_ROLLOUT_OUTPUTS];
    float aarOutput[2][NUM_ROLLOUT_OUTPUTS], arDouble[4];
    const char *err;
    int fDouble = FALSE;
    cubedecision cd;

    API_REQUIRE_READY();
    if (!(req = parse_common(requestJson, &pos, &ec, aamf, NULL, &err)))
        return error_result(err);
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

    api_flush_cache();   /* results independent of earlier calls; see api_util.h */
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
    cJSON *req, *o;
    api_position pos;
    evalcontext ec;
    movefilter aamf[MAX_FILTER_PLIES][MAX_FILTER_PLIES];
    float aarOutput[2][NUM_ROLLOUT_OUTPUTS], arDouble[4];
    const char *err, *action;
    int cBeavers = 0;
    cubedecision cd;

    API_REQUIRE_READY();
    if (!(req = parse_common(requestJson, &pos, &ec, aamf, NULL, &err)))
        return error_result(err);
    err = get_int_field(req, "beaversSoFar", 0, INT_MAX, &cBeavers);
    cJSON_Delete(req);
    if (err)
        return error_result(err);
    ec.fCubeful = TRUE;

    api_flush_cache();   /* results independent of earlier calls; see api_util.h */
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
