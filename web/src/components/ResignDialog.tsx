"use client";
// Resign: offer gnubg a single game, a gammon or a backgammon.

import Dialog from "./ui/Dialog";
import { points } from "@/lib/format";

export default function ResignDialog({
  open,
  cube,
  onResign,
  onClose,
}: {
  open: boolean;
  cube: number;
  onResign: (value: 1 | 2 | 3) => void;
  onClose: () => void;
}) {
  const options: [1 | 2 | 3, string][] = [
    [1, "Single game"],
    [2, "Gammon"],
    [3, "Backgammon"],
  ];
  return (
    <Dialog open={open} onClose={onClose} title="Resign" subtitle="gnubg decides whether to accept." testId="resign-dialog" className="dialog-sm">
      <div className="choice-list">
        {options.map(([v, label]) => (
          <button key={v} className="choice" onClick={() => onResign(v)} data-testid={`resign-${v}`}>
            <span>{label}</span>
            <span className="choice-meta tnum">{points(v * cube)}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
