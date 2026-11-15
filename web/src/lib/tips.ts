// The tip jar (Android app only): three consumable in-app products sold with
// Google Play Billing, through cordova-plugin-purchase (window.CdvPurchase,
// injected by Capacitor into the app's pages). A tip unlocks nothing; the
// purchase is consumed at once so the same tip can be given again.
//
// The products must exist in the Play Console (Monetize > Products > In-app
// products) with exactly these IDs, and be active. Their prices and names
// come from Google Play, in the buyer's currency.

import { isAndroidApp } from "./platform";

/** Whether the tip jar is offered at all (switch off to ship without purchases). */
export const TIPS_ENABLED = true;

export const TIP_IDS = ["tip_small", "tip_medium", "tip_large"] as const;
export type TipId = (typeof TIP_IDS)[number];

export interface TipProduct {
  id: TipId;
  title: string;
  price: string; // formatted by Google Play, e.g. "£1.99"
  canPurchase: boolean;
}

// The small part of cordova-plugin-purchase's API used here (www/store.d.ts).
interface CdvOffer {
  order(): Promise<{ code: number; message: string } | undefined>;
}
interface CdvProduct {
  id: string;
  title: string;
  canPurchase: boolean;
  pricing?: { price: string };
  getOffer(): CdvOffer | undefined;
}
interface CdvTransaction {
  products: { id: string }[];
  finish(): Promise<void>;
}
interface CdvWhen {
  approved(cb: (t: CdvTransaction) => void): CdvWhen;
  finished(cb: (t: CdvTransaction) => void): CdvWhen;
  productUpdated(cb: (p: CdvProduct) => void): CdvWhen;
}
interface CdvStore {
  verbosity: number;
  register(p: { id: string; type: string; platform: string }[]): void;
  initialize(platforms: string[]): Promise<{ code: number; message: string }[]>;
  get(id: string, platform?: string): CdvProduct | undefined;
  when(): CdvWhen;
  error(cb: (e: { code: number; message: string }) => void): void;
}
interface CdvPurchaseGlobal {
  store: CdvStore;
  ProductType: { CONSUMABLE: string };
  Platform: { GOOGLE_PLAY: string };
  LogLevel: { WARNING: number };
  ErrorCode: { PAYMENT_CANCELLED: number };
}

/** Whether to show the tip jar here. */
export const tipsAvailable = () => TIPS_ENABLED && isAndroidApp();

function cdv(): CdvPurchaseGlobal | undefined {
  return (window as unknown as { CdvPurchase?: CdvPurchaseGlobal }).CdvPurchase;
}

/** Wait for Cordova's plugins (deviceready), at most `ms`. */
function pluginReady(ms = 8000): Promise<CdvPurchaseGlobal | undefined> {
  const now = cdv();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(cdv());
    document.addEventListener("deviceready", done, { once: true });
    setTimeout(done, ms);
  });
}

type Listener = (e: { kind: "thanks"; id: string } | { kind: "products" }) => void;
const listeners = new Set<Listener>();
let ready: Promise<CdvPurchaseGlobal | undefined> | null = null;

/** Set up the store once (registers the products and the purchase handlers). */
function init(): Promise<CdvPurchaseGlobal | undefined> {
  if (ready) return ready;
  ready = (async () => {
    const C = await pluginReady();
    if (!C) return undefined;
    const { store, ProductType, Platform, LogLevel } = C;
    store.verbosity = LogLevel.WARNING;
    store.register(TIP_IDS.map((id) => ({ id, type: ProductType.CONSUMABLE, platform: Platform.GOOGLE_PLAY })));
    store
      .when()
      .productUpdated(() => listeners.forEach((l) => l({ kind: "products" })))
      // Nothing to deliver: finishing a consumable consumes it at Google Play.
      .approved((t) => void t.finish())
      .finished((t) => listeners.forEach((l) => l({ kind: "thanks", id: t.products[0]?.id ?? "" })));
    store.error(() => {
      /* shown where it matters: order() returns the error */
    });
    await store.initialize([Platform.GOOGLE_PLAY]);
    return C;
  })();
  return ready;
}

/** Listen for product updates and completed tips; returns the unsubscribe function. */
export function onTipEvent(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The tip products with Google Play's prices (empty when the store is unavailable). */
export async function loadTips(): Promise<TipProduct[]> {
  const C = await init();
  if (!C) return [];
  const out: TipProduct[] = [];
  for (const id of TIP_IDS) {
    const p = C.store.get(id, C.Platform.GOOGLE_PLAY);
    if (p?.pricing?.price) out.push({ id, title: p.title, price: p.pricing.price, canPurchase: p.canPurchase });
  }
  return out;
}

/** Start Google Play's purchase sheet. Resolves with an error message, "cancelled", or null once the sheet is done. */
export async function giveTip(id: TipId): Promise<string | null> {
  const C = await init();
  const offer = C?.store.get(id, C.Platform.GOOGLE_PLAY)?.getOffer();
  if (!C || !offer) return "The tip jar is not available right now.";
  const err = await offer.order();
  if (!err) return null;
  return err.code === C.ErrorCode.PAYMENT_CANCELLED ? "cancelled" : err.message || "The purchase did not go through.";
}
