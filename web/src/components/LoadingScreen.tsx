"use client";
// Shown while the engine downloads its data files and starts.

import type { LoadProgress } from "@/engine/types";

const mb = (bytes: number) => (bytes / 1e6).toFixed(1);

export default function LoadingScreen({ progress, error }: { progress: LoadProgress | null; error: string | null }) {
  const pct = progress ? Math.min(100, Math.round((100 * progress.loaded) / Math.max(1, progress.total))) : 0;
  return (
    <main className="loading" data-testid="loading">
      <div className="loading-card">
        <span className="loading-pieces" aria-hidden="true">
          <span className="piece piece-ivory" />
          <span className="piece piece-walnut" />
        </span>
        <h1 className="serif-title">GNU Backgammon</h1>
        {error ? (
          <p className="loading-error" role="alert">
            {error}
          </p>
        ) : (
          <>
            <div className="progress" role="progressbar" aria-label="download progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="progress-bar" style={{ width: `${pct}%` }} />
            </div>
            <p className="loading-meta tnum">
              <span>{progress ? `${mb(progress.loaded)} / ${mb(progress.total)} mb` : "starting"}</span>
              <span>{pct}%</span>
            </p>
            <p className="loading-note">first visit downloads about 9 mb · cached afterwards</p>
          </>
        )}
      </div>
    </main>
  );
}
