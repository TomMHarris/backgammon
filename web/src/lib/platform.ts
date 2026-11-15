// Where the app is running: the website, or the Android app (the same static
// export packaged with Capacitor, served inside the app from https://localhost).
//
// In the app, relative URLs still reach the bundled files (engine, data,
// pages), but the online-play server and the links friends open live on the
// website, so those use SITE.

/** The public website: the online-play server and the target of invite links. */
export const SITE = "https://backgammon-blond.vercel.app";

type CapacitorGlobal = { isNativePlatform?: () => boolean; getPlatform?: () => string };

/** True inside the Capacitor app (Android); false on the website. */
export function isNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

/** True inside the Android app. */
export function isAndroidApp(): boolean {
  if (!isNativeApp()) return false;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor?.getPlatform?.() === "android";
}

/** The origin for links other people open: the website, also from inside the app. */
export function publicOrigin(): string {
  return isNativeApp() ? SITE : window.location.origin;
}

/** Base URL of the room server ("" = same origin, as on the website). */
export function apiBase(): string {
  return isNativeApp() ? SITE : "";
}
