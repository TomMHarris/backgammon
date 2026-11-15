"use client";
// The tip jar (Android app only, lib/tips.ts): three optional tips through
// Google Play. Prices and names are Google Play's, in the player's currency.

import { useEffect, useState } from "react";
import Dialog from "./ui/Dialog";
import { giveTip, loadTips, onTipEvent, type TipId, type TipProduct } from "@/lib/tips";

const LABEL: Record<TipId, string> = { tip_small: "Small tip", tip_medium: "Medium tip", tip_large: "Large tip" };

export default function TipJarDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tips, setTips] = useState<TipProduct[] | null>(null); // null: loading
  const [busy, setBusy] = useState<TipId | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [thanks, setThanks] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setMessage(null);
    setThanks(false);
    const refresh = () => void loadTips().then((t) => live && setTips(t));
    refresh();
    const off = onTipEvent((e) => {
      if (e.kind === "thanks") {
        setBusy(null);
        setThanks(true);
      } else refresh();
    });
    return () => {
      live = false;
      off();
    };
  }, [open]);

  const tip = async (id: TipId) => {
    setBusy(id);
    setMessage(null);
    const err = await giveTip(id);
    // success arrives as a "thanks" event once Google Play confirms the payment
    if (err) {
      setBusy(null);
      if (err !== "cancelled") setMessage(err);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Tip jar" subtitle="Free, open source, no ads." testId="tip-jar" className="dialog-sm">
      {thanks ? (
        <p data-testid="tip-thanks">Thank you! Your tip really helps.</p>
      ) : (
        <>
          <p className="small">
            This app is free and always will be. If you enjoy it, you can leave a tip to support its development. Tips are optional and
            don&apos;t unlock anything.
          </p>
          {tips === null ? (
            <p className="small muted">
              <span className="spinner" aria-hidden="true" /> Loading prices from Google Play…
            </p>
          ) : tips.length === 0 ? (
            <p className="small muted" data-testid="tip-unavailable">
              The tip jar isn&apos;t available right now. Please try again later, and thank you for thinking of it!
            </p>
          ) : (
            <div className="choice-list">
              {tips.map((t) => (
                <button key={t.id} className="choice" onClick={() => tip(t.id)} disabled={!!busy || !t.canPurchase} data-testid={`tip-${t.id}`}>
                  <span>{busy === t.id ? "Waiting for Google Play…" : LABEL[t.id]}</span>
                  <span className="choice-meta tnum">{t.price}</span>
                </button>
              ))}
            </div>
          )}
          {message && (
            <p className="small error-text" role="alert">
              {message}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
