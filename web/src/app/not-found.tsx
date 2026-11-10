// 404: a calm page in the house style (paper background in light and dark,
// from app/globals.css), with a way back to the game.
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page not found · gnubg-web",
};

export default function NotFound() {
  return (
    <main className="notfound" data-testid="not-found">
      <div className="notfound-card">
        <span className="loading-pieces" aria-hidden="true">
          <span className="piece piece-ivory" />
          <span className="piece piece-walnut" />
        </span>
        <h1 className="serif-title">Page not found</h1>
        <p className="muted">There is nothing at this address.</p>
        <Link href="/" className="flat flat-primary">
          Back to the game
        </Link>
      </div>
    </main>
  );
}
