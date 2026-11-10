"use client";
// Form controls of the design system: a switch, a segmented control and a
// setting row. They are plain HTML inputs underneath (checkbox / radio), so
// keyboard and screen-reader behaviour comes from the browser.

import { useId } from "react";

export function Switch({
  checked,
  onChange,
  label,
  detail,
  testId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  detail?: string;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="setting">
      <label className="setting-text" htmlFor={id}>
        <span className="setting-label">{label}</span>
        {detail && <span className="setting-detail">{detail}</span>}
      </label>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
      />
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  label,
  testId,
  size,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; title?: string }[];
  label: string; // accessible name of the group
  testId?: string;
  size?: "sm";
}) {
  const name = useId();
  return (
    <div className={`segmented ${size === "sm" ? "segmented-sm" : ""}`} role="radiogroup" aria-label={label} data-testid={testId}>
      {options.map((o) => (
        <label key={String(o.value)} className={o.value === value ? "on" : ""} title={o.title}>
          <input
            type="radio"
            name={name}
            checked={o.value === value}
            onChange={() => onChange(o.value)}
            data-testid={testId ? `${testId}-${String(o.value).replace(/\s+/g, "-")}` : undefined}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/** A labelled row holding any control on the right. */
export function SettingRow({ label, detail, children }: { label: string; detail?: string; children: React.ReactNode }) {
  return (
    <div className="setting setting-stack">
      <div className="setting-text">
        <span className="setting-label">{label}</span>
        {detail && <span className="setting-detail">{detail}</span>}
      </div>
      {children}
    </div>
  );
}
