"use client";

// Switch toggle. Generalizes the inline Toggle in share-dialog-sections.tsx
// (same on/onChange/disabled contract + accent track) so feature code can drop
// its copy. Adds a focus ring for keyboard users.
import { forwardRef } from "react";
import clsx from "clsx";

export interface ToggleProps {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
}

export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { on, onChange, disabled, className, ...aria },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={clsx(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full",
        "transition-colors duration-150 outline-none",
        "focus-visible:ring-2 focus-visible:ring-drive-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-drive-panel",
        "disabled:cursor-not-allowed disabled:opacity-60",
        on ? "bg-drive-accent" : "bg-drive-border",
        className,
      )}
      {...aria}
    >
      <span
        className={clsx(
          "inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-150",
          on ? "translate-x-6" : "translate-x-1",
        )}
      />
    </button>
  );
});
