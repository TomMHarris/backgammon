"use client";
// An online game with a friend, as a React hook (used by Game.tsx).
//
// The room's log (on the server, web/api/_rooms.js) is the truth; the match
// on screen is that log replayed through match.ts (game/online.ts), with
// this browser as side 1 ("You"). So:
//   - your actions are SENT, not applied: the server appends them (adding
//     the dice to a roll) and returns the entry, which is then applied like
//     any other entry;
//   - your friend's actions arrive by polling, are checked (a move must be
//     one of gnubg's legal moves for that roll) and are shown checker by
//     checker, like gnubg's moves;
//   - polling runs only while you are waiting (for your friend to join, to
//     act, or to start the next game), every 1 s backing off to 4 s, and
//     pauses while the tab is hidden, to keep the server's free quota.
//
// Reloading the page (the room id is in the address) or reopening the link
// puts you back in your seat: the seat's token is kept in this browser.

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { EngineClient } from "@/engine/client";
import { applyPairs, positionId, swapSides, type Board, type Dice } from "@/game/board";
import { boardFor, idsFor, responder, type MatchState } from "@/game/match";
import { applyEntry, localSettings, type RoomAction, type RoomEntry, type RoomSettings, type Seat } from "@/game/online";
import { askRematch, createRoom, joinRoom, pollRoom, RoomError, saveSeat, sendAction, setRoomInUrl, type RoomView } from "@/lib/online";
import { playSound } from "@/sound/sounds";
import { stepSound } from "@/lib/useGnubgTurn";

export interface OnlineState {
  room: string;
  seat: Seat;
  token: string;
  settings: RoomSettings;
  friend: string; // the friend's name ("Friend" until they give one)
  joined: boolean; // the friend has joined
  applied: number; // log entries applied to the match
  error: string | null; // the game cannot go on (e.g. an illegal move arrived)
}

const POLL_MIN = 1000;
const POLL_MAX = 4000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Is it this browser's turn to act (so nothing can arrive from the friend)? */
function myTurn(m: MatchState | null): boolean {
  if (!m) return false;
  if (m.phase === "rolling" || m.phase === "moving") return m.turn === 1;
  if (m.phase === "doubled") return responder(m) === 1;
  return false; // game over: either player may start the next game
}

export function useOnlineGame(p: {
  engineRef: MutableRefObject<EngineClient | null>;
  match: MatchState | null;
  setMatch: (m: MatchState | null) => void;
  setNotice: (s: string | null) => void;
  setAnim: (a: { board: Board; dice: Dice } | null) => void;
  setBusy: (s: string | null) => void;
  animate: MutableRefObject<boolean>;
  /** A new match started from the room (resets analysis, take-back, ...). */
  onNewMatch: () => void;
  /** A new game started (opening roll): `m` is the match after it. */
  onGameStart: (m: MatchState) => void;
}) {
  const { engineRef, setMatch, setNotice, setAnim, setBusy, animate } = p;
  const [state, setState] = useState<OnlineState | null>(null);
  const stateRef = useRef<OnlineState | null>(null);
  stateRef.current = state;
  const matchRef = useRef<MatchState | null>(p.match);
  matchRef.current = p.match;
  const cb = useRef(p);
  cb.current = p;

  const pending = useRef<RoomEntry[]>([]);
  const processing = useRef(false);

  const update = (f: (s: OnlineState) => OnlineState) => {
    const s = stateRef.current;
    if (!s) return;
    const n = f(s);
    stateRef.current = n;
    setState(n);
  };

  /** Apply queued entries in order (async: friend's moves are checked and animated). */
  const processQueue = useCallback(async () => {
    if (processing.current) return;
    processing.current = true;
    try {
      while (pending.current.length) {
        const s = stateRef.current;
        if (!s || s.error) break;
        const e = pending.current[0];
        if (e.n < s.applied) {
          pending.current.shift();
          continue;
        }
        if (e.n > s.applied) break; // a gap: the next poll fills it
        const m = matchRef.current;
        const fromFriend = e.seat !== null && e.seat !== s.seat;
        if (fromFriend && e.t === "move" && m && m.dice) {
          // the friend's move must be one of gnubg's legal moves for the roll
          const pairs = e.pairs ?? [];
          const engine = engineRef.current;
          if (engine) {
            const r = await engine.legalMoves({ ...idsFor(m, 0, m.dice), dice: m.dice });
            const after = positionId(applyPairs(boardFor(m, 0), pairs));
            const legal = r.moves.length === 0 ? pairs.length === 0 : r.moves.some((x) => x.positionAfter === after);
            if (!legal) {
              update((x) => ({ ...x, error: `Your friend's move (${e.text || "no move"}) is not legal for ${m.dice![0]}-${m.dice![1]}. The game cannot go on.` }));
              break;
            }
          }
          if (animate.current && pairs.length) {
            const start = swapSides(m.board); // the friend's view: board[1] = the friend
            for (let k = 0; k < pairs.length; k++) {
              const to = pairs[k][1];
              const hit = to >= 0 && applyPairs(start, pairs.slice(0, k))[0][23 - to] === 1;
              playSound(stepSound(hit, to));
              setAnim({ board: swapSides(applyPairs(start, pairs.slice(0, k + 1))), dice: m.dice });
              await sleep(420);
            }
            setAnim(null);
          }
        }
        let next: MatchState;
        try {
          next = applyEntry(m, e, s.seat, localSettings(s.settings, s.friend));
        } catch (err) {
          update((x) => ({ ...x, error: `The game's record could not be followed (${err instanceof Error ? err.message : err}).` }));
          break;
        }
        pending.current.shift();
        matchRef.current = next;
        setMatch(next);
        update((x) => ({ ...x, applied: x.applied + 1 }));
        // what happened, in words (your own actions need no notice)
        const f = s.friend;
        if (e.t === "open" || e.t === "next") cb.current.onGameStart(next);
        else if (fromFriend && e.t === "move" && m?.dice) setNotice(e.text ? `${f} plays ${m.dice[0]}-${m.dice[1]}: ${e.text}` : `${f} rolls ${m.dice[0]}-${m.dice[1]} and cannot move`);
        else if (fromFriend && e.t === "take") setNotice(`${f} takes · the cube is at ${next.cube}`);
        else if (fromFriend && e.t === "beaver") setNotice(`${f} beavers · the cube would be at ${next.cube * 2}`);
        else if (!fromFriend && e.t === "take") setNotice(`You take. The cube is at ${next.cube}.`);
        else if (fromFriend && e.t === "roll") setNotice(null);
      }
    } finally {
      processing.current = false;
    }
  }, [engineRef, setMatch, setNotice, setAnim, animate]);

  /** Start showing a room: replay its whole log at once (no checks or animation for the past). */
  const enter = useCallback(
    (v: RoomView, token: string, seat: Seat) => {
      const friend = v.names[1 - seat] || "Friend";
      let m: MatchState | null = null;
      let applied = 0;
      let error: string | null = null;
      for (const e of v.log) {
        try {
          m = applyEntry(m, e, seat, localSettings(v.settings, friend));
          applied++;
        } catch (err) {
          error = `The game's record could not be followed (${err instanceof Error ? err.message : err}).`;
          break;
        }
      }
      saveSeat(v.room, token, seat);
      setRoomInUrl(v.room);
      pending.current = [];
      const s: OnlineState = { room: v.room, seat, token, settings: v.settings, friend, joined: v.joined, applied, error };
      stateRef.current = s;
      setState(s);
      cb.current.onNewMatch();
      matchRef.current = m;
      setMatch(m);
      // a game that has just started gets its opening notice; one in progress a welcome back
      if (m && m.record.games[m.record.games.length - 1].actions.length === 0 && m.phase === "moving") cb.current.onGameStart(m);
      else if (m) setNotice("You are back in the game.");
    },
    [setMatch]
  );

  const host = useCallback(
    async (settings: RoomSettings, name: string) => {
      const r = await createRoom(settings, name);
      enter(r, r.token, r.seat);
    },
    [enter]
  );

  const join = useCallback(
    async (room: string, name: string, token?: string) => {
      const r = await joinRoom(room, name, token);
      enter(r, r.token, r.seat);
    },
    [enter]
  );

  /** Leave online play (a local match is starting). */
  const leave = useCallback(() => {
    stateRef.current = null;
    setState(null);
    pending.current = [];
    setRoomInUrl(null);
  }, []);

  /** Fetch new entries now and apply them. Returns the room view (or null on error). */
  const pollNow = useCallback(async (): Promise<RoomView | null> => {
    const s = stateRef.current;
    if (!s) return null;
    const v = await pollRoom(s.room, s.applied);
    if (stateRef.current?.room !== s.room) return null; // left meanwhile
    if (v.joined !== s.joined || (v.names[1 - s.seat] || "Friend") !== s.friend)
      update((x) => ({ ...x, joined: v.joined, friend: v.names[1 - x.seat] || "Friend" }));
    if (v.log.length) {
      pending.current.push(...v.log);
      await processQueue();
    }
    // a rematch was started (by either player): both go to the new room
    if (v.next && matchRef.current?.phase === "matchOver") await join(v.next, "", s.token);
    return v;
  }, [processQueue, join]);

  /** Send one of your actions. Resolves when it has been applied (or refused). */
  const sending = useRef(false);
  const send = useCallback(
    async (action: RoomAction) => {
      const s = stateRef.current;
      if (!s || s.error || sending.current) return;
      sending.current = true;
      const slow = setTimeout(() => setBusy("Sending"), 400);
      try {
        const r = await sendAction(s.room, s.token, s.applied, action);
        pending.current.push(r.entry);
        await processQueue();
      } catch (e) {
        if (e instanceof RoomError && e.status === 409 && e.length !== undefined) {
          // your friend acted first (or this page was behind): catch up
          await pollNow();
          setNotice("The board was out of date and has been updated. Please try again.");
        } else setNotice(e instanceof Error ? e.message : String(e));
      } finally {
        clearTimeout(slow);
        setBusy(null);
        sending.current = false;
      }
    },
    [processQueue, pollNow, setBusy, setNotice]
  );

  const rematch = useCallback(async () => {
    const s = stateRef.current;
    if (!s) return;
    try {
      const r = await askRematch(s.room, s.token);
      await join(r.next, "", s.token);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, [join, setNotice]);

  // ---- polling while waiting ----------------------------------------------------------------
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const f = () => setVisible(document.visibilityState === "visible");
    f();
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, []);
  const waiting = !!state && !state.error && (!state.joined || !myTurn(p.match));
  const delay = useRef(POLL_MIN);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    delay.current = POLL_MIN; // something changed: look again soon
  }, [state?.applied, state?.room, waiting]);
  useEffect(() => {
    if (!waiting || !visible) return;
    let stop = false;
    const t = setTimeout(async () => {
      try {
        const before = stateRef.current?.applied;
        await pollNow();
        if (stateRef.current?.applied === before) delay.current = Math.min(POLL_MAX, delay.current * 1.3);
      } catch {
        delay.current = POLL_MAX; // the server is unreachable: keep trying, slowly
      }
      if (!stop) setTick((n) => n + 1);
    }, delay.current);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [waiting, visible, tick, state?.applied, state?.room, pollNow]);

  return { state, host, join, leave, send, rematch, waiting };
}
