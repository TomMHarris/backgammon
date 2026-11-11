// Talking to the room server (POST /api/room, web/api/_rooms.js) and
// remembering this browser's seat tokens.
//
// A token proves which seat you hold; it is kept in this browser
// (localStorage), so reopening the link, or reloading, puts you back in
// your seat. Another browser opening the same link after both seats are
// taken cannot play.

import type { RoomAction, RoomEntry, RoomSettings, Seat } from "@/game/online";

export class RoomError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly length?: number // for "out of date": the log length on the server
  ) {
    super(message);
  }
}

/** A room as the server shows it. */
export interface RoomView {
  room: string;
  settings: RoomSettings;
  names: [string, string]; // by seat
  joined: boolean; // the friend has taken seat 0
  length: number; // entries in the log
  since: number; // `log` starts at this entry
  log: RoomEntry[];
  next: string | null; // the rematch room, once one was asked for
}

async function call<T>(op: string, body: object): Promise<T> {
  let r: Response;
  try {
    r = await fetch("/api/room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, ...body }),
    });
  } catch {
    throw new RoomError("No connection to the game server.", 0);
  }
  const j = await r.json().catch(() => ({ ok: false, error: `server error ${r.status}` }));
  if (!j.ok) throw new RoomError(j.error ?? `server error ${r.status}`, r.status, j.length);
  return j as T;
}

export const createRoom = (settings: RoomSettings, name: string) =>
  call<RoomView & { token: string; seat: Seat }>("create", { settings, name });
export const joinRoom = (room: string, name: string, token?: string) =>
  call<RoomView & { token: string; seat: Seat }>("join", { room, name, token });
export const pollRoom = (room: string, since: number) => call<RoomView>("poll", { room, since });
export const sendAction = (room: string, token: string, expect: number, action: RoomAction) =>
  call<{ entry: RoomEntry; length: number }>("act", { room, token, expect, action });
export const askRematch = (room: string, token: string) => call<{ next: string }>("rematch", { room, token });

// ---- this browser's seats -------------------------------------------------------
const TOKENS_KEY = "gnubg-web.rooms";

export function savedSeat(room: string): { token: string; seat: Seat } | null {
  try {
    return JSON.parse(localStorage.getItem(TOKENS_KEY) ?? "{}")[room] ?? null;
  } catch {
    return null;
  }
}
export function saveSeat(room: string, token: string, seat: Seat) {
  try {
    const all = JSON.parse(localStorage.getItem(TOKENS_KEY) ?? "{}");
    all[room] = { token, seat, at: Date.now() };
    // keep the 30 most recent rooms
    const keep = Object.entries(all)
      .sort((a, b) => ((b[1] as { at?: number }).at ?? 0) - ((a[1] as { at?: number }).at ?? 0))
      .slice(0, 30);
    localStorage.setItem(TOKENS_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {
    // storage unavailable: a reload will not find the seat again
  }
}

/** The room id in the page's address (?room=...), or null. */
export function roomInUrl(): string | null {
  const id = new URLSearchParams(window.location.search).get("room");
  return id && /^[a-z0-9]{6}$/.test(id) ? id : null;
}
/** Put the room id in the address bar (or remove it), without reloading. */
export function setRoomInUrl(room: string | null) {
  const u = new URL(window.location.href);
  if (room) u.searchParams.set("room", room);
  else u.searchParams.delete("room");
  window.history.replaceState(null, "", u.toString());
}
export const inviteLink = (room: string) => `${window.location.origin}/?room=${room}`;
