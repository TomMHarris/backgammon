"use client";
// Online games with a friend: the Invite dialog (the link to send, while
// waiting for the friend) and the Join dialog (what the friend sees on
// opening the link). The logic is in lib/useOnlineGame.ts.

import { useEffect, useState } from "react";
import Dialog from "./ui/Dialog";
import type { RoomSettings } from "@/game/online";

const describe = (s: RoomSettings) =>
  `${s.matchLength ? `${s.matchLength}-point match` : "Money game"} · hints ${s.hints ? "allowed" : "off"}`;

export function InviteDialog({
  open,
  link,
  settings,
  joined,
  onClose,
}: {
  open: boolean;
  link: string;
  settings: RoomSettings;
  joined: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [link]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      (document.getElementById("invite-link") as HTMLInputElement | null)?.select();
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: "Backgammon", text: "Play backgammon with me", url: link });
    } catch {
      /* dismissed */
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Invite a friend"
      subtitle={describe(settings)}
      testId="invite-dialog"
      footer={
        <button className="flat flat-primary" onClick={onClose} data-autofocus>
          {joined ? "Play" : "Close"}
        </button>
      }
    >
      <p>Send this link to your friend. The game starts as soon as they open it.</p>
      <div className="invite-row">
        <input id="invite-link" className="text-input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} data-testid="invite-link" />
        <button className="flat" onClick={copy} data-testid="copy-link">
          {copied ? "Copied" : "Copy"}
        </button>
        {typeof navigator !== "undefined" && "share" in navigator && (
          <button className="flat touch-only" onClick={share}>
            Share
          </button>
        )}
      </div>
      <p className="invite-wait" role="status">
        {joined ? (
          "Your friend has joined."
        ) : (
          <>
            <span className="spinner" aria-hidden="true" /> Waiting for your friend to join…
          </>
        )}
      </p>
    </Dialog>
  );
}

export function JoinDialog({
  open,
  info,
  name,
  setName,
  error,
  joining,
  onJoin,
  onClose,
}: {
  open: boolean;
  info: { host: string; settings: RoomSettings } | null; // null while loading
  name: string;
  setName: (s: string) => void;
  error: string | null;
  joining: boolean;
  onJoin: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={info?.host ? `Play ${info.host}` : "Join a game"}
      subtitle={info ? describe(info.settings) : "Looking up the game…"}
      testId="join-dialog"
      footer={
        <>
          <button className="flat flat-quiet" onClick={onClose}>
            Not now
          </button>
          <button className="flat flat-primary" onClick={onJoin} disabled={!info || joining || !!error} data-testid="join" data-autofocus>
            {joining ? "Joining…" : "Join game"}
          </button>
        </>
      }
    >
      {error ? (
        <p className="error-text" role="alert" data-testid="join-error">
          {error}
        </p>
      ) : (
        <>
          <p>You have been invited to an online game of backgammon.</p>
          <label className="setting-row online-name">
            <span className="setting-label">Your name</span>
            <input
              className="text-input"
              value={name}
              maxLength={16}
              placeholder="Shown to your friend"
              onChange={(e) => setName(e.target.value.replace(/\s+/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && onJoin()}
              data-testid="join-name"
            />
          </label>
        </>
      )}
    </Dialog>
  );
}
