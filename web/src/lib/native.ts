// What the Android app does differently from the website. Android's WebView
// has no Web Share API and ignores <a download>, has a hardware/gesture back
// button, and is opened by invite links (App Links); the Capacitor plugins
// for these are loaded only inside the app, so the website never fetches them.

import { isNativeApp } from "./platform";

/** Whether a share sheet is available (the app's, or the browser's Web Share). */
export function canShare(): boolean {
  return isNativeApp() || (typeof navigator !== "undefined" && "share" in navigator);
}

/** Open the share sheet for a link. Resolves when done or dismissed. */
export async function shareLink(p: { title: string; text: string; url: string }): Promise<void> {
  try {
    if (isNativeApp()) {
      const { Share } = await import("@capacitor/share");
      await Share.share({ title: p.title, text: p.text, url: p.url, dialogTitle: p.title });
    } else await navigator.share(p);
  } catch {
    /* dismissed */
  }
}

/**
 * Save text as a file: a download on the website; in the app, the file is
 * written to the app's cache and handed to the share sheet (save to Files or
 * Drive, send by email, ...).
 */
export async function saveTextFile(text: string, fileName: string, type = "text/plain"): Promise<void> {
  if (isNativeApp()) {
    const { Filesystem, Directory, Encoding } = await import("@capacitor/filesystem");
    const { Share } = await import("@capacitor/share");
    const w = await Filesystem.writeFile({ path: fileName, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
    try {
      await Share.share({ title: fileName, files: [w.uri], dialogTitle: `Save ${fileName}` });
    } catch {
      /* dismissed */
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The in-app address for an invite link (https://<site>/?room=abc123 -> /?room=abc123), or null. */
function inAppPath(url: string): string | null {
  try {
    const u = new URL(url);
    const room = u.searchParams.get("room");
    return room && /^[a-z0-9]{6}$/.test(room) ? `/?room=${room}` : u.pathname === "/" ? "/" : null;
  } catch {
    return null;
  }
}

let started = false;

/**
 * Once per app start: the back button (closes the open dialog, else goes
 * back a page, else leaves the app in the background as Android apps do) and
 * invite links that open the app (App Links), both when the app is started
 * by the link and when it is already running.
 */
export async function startNative(): Promise<void> {
  if (started || !isNativeApp()) return;
  started = true;
  const { App } = await import("@capacitor/app");

  App.addListener("backButton", ({ canGoBack }) => {
    const dialogs = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]"));
    const top = dialogs[dialogs.length - 1];
    if (top) {
      // the same as Esc: Dialog.tsx closes it through onCancel (if it may be closed)
      top.dispatchEvent(new Event("cancel", { cancelable: true }));
      return;
    }
    const menu = document.querySelector<HTMLElement>("[role=menu]");
    if (menu) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return;
    }
    // the hint / moves sheet over the board (phones; components/SidePanel.tsx)
    const sheetClose = document.querySelector<HTMLButtonElement>(".bottom-sheet [data-testid=close-panel], .side-sheet [data-testid=close-panel]");
    if (sheetClose) {
      sheetClose.click();
      return;
    }
    if (canGoBack && window.location.pathname !== "/") window.history.back();
    else void App.minimizeApp();
  });

  const open = (url: string | undefined) => {
    const path = url ? inAppPath(url) : null;
    if (path && path !== "/" && window.location.pathname + window.location.search !== path) window.location.href = path;
  };
  App.addListener("appUrlOpen", ({ url }) => open(url));
  const launch = await App.getLaunchUrl();
  open(launch?.url);
}
