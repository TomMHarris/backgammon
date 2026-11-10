"use client";
// Shown while the engine downloads its data files and starts.

import type { LoadProgress } from "@/engine/types";
import { Logo } from "./AppHeader";

const mb = (bytes: number) => (bytes / 1e6).toFixed(1);

export default function LoadingScreen({ progress, error }: { progress: LoadProgress | null; error: string | null }) {
  const pct = progress ? Math.min(100, Math.round((100 * progress.loaded) / Math.max(1, progress.total))) : 0;
  return (
    <main className="loading" data-testid="loading">
      <div className="loading-card">
        <Logo size={48} />
        <h1>GNU Backgammon</h1>
        {error ? (
          <p className="loading-error" role="alert">
            {error}
          </p>
        ) : (
          <>
            <p className="loading-sub">Loading the engine…</p>
            <div className="progress" role="progressbar" aria-label="Download progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="progress-bar" style={{ width: `${pct}%` }} />
            </div>
            <p className="loading-meta tnum">
              <span>{progress ? `${mb(progress.loaded)} of ${mb(progress.total)} MB` : "Starting…"}</span>
              <span>{pct}%</span>
            </p>
            <p className="loading-note">The first visit downloads about 9 MB; it is cached afterwards.</p>
          </>
        )}
      </div>
    </main>
  );
}
