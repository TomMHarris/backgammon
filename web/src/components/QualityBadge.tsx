// A decision's quality (lib/quality.ts) as a small coloured badge: ★ best,
// ✓ strong, ?! doubtful, ? bad, ?? very bad, – forced. With `label`, the
// badge is followed by the word. The colours are tokens in globals.css (--q-*).

import { QUALITY, type Quality } from "@/lib/quality";

export default function QualityBadge({ q, label = false, className = "" }: { q: Quality; label?: boolean; className?: string }) {
  const info = QUALITY[q];
  return (
    <span className={`qtag q-${q} ${label ? "qtag-label" : ""} ${className}`} title={`${info.label}: ${info.gnubg}`} data-quality={q}>
      <span className="qbadge" aria-hidden="true">
        {info.symbol}
      </span>
      {label ? <span className="qtag-text">{info.label}</span> : <span className="sr-only">{info.label}</span>}
    </span>
  );
}
