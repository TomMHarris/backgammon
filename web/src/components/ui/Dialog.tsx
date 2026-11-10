"use client";
// A modal dialog built on the native <dialog> element: the browser provides
// the focus trap, Esc to close and the backdrop. `open` is controlled by the
// parent; closing by Esc or the close button calls onClose.

import { useEffect, useRef } from "react";
import Icon from "./Icon";

export default function Dialog({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  className = "",
  dismissable = true,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  dismissable?: boolean; // false: no close button, Esc does nothing
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute("open", "");
      }
      // Focus the dialog's main button (marked data-autofocus), not the close button.
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      aria-labelledby={testId ? `${testId}-title` : undefined}
      data-testid={testId}
      onCancel={(e) => {
        e.preventDefault(); // keep React in charge of `open`
        if (dismissable) onClose();
      }}
      onClick={(e) => {
        // a click on the backdrop (the dialog element itself, outside the card)
        if (dismissable && e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="dialog-card">
          <header className="dialog-head">
            <div>
              <h2 id={testId ? `${testId}-title` : undefined}>{title}</h2>
              {subtitle && <p className="dialog-sub">{subtitle}</p>}
            </div>
            {dismissable && (
              <button className="btn btn-icon btn-ghost" onClick={onClose} aria-label="Close">
                <Icon name="close" />
              </button>
            )}
          </header>
          <div className="dialog-body">{children}</div>
          {footer && <footer className="dialog-foot">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
