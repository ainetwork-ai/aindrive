// Shared label/helper/error scaffold for form controls (Input, Select). Keeps
// the slot markup + a11y wiring (label htmlFor, aria-describedby/invalid) in one
// place so every field looks and announces identically.
import type { ReactNode } from "react";
import clsx from "clsx";

export interface FieldProps {
  id: string;
  label?: ReactNode;
  error?: ReactNode;
  helper?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** describedById: pass to the control's aria-describedby so SR reads helper/error. */
export function describedById(id: string, hasError: boolean, hasHelper: boolean): string | undefined {
  if (hasError) return `${id}-error`;
  if (hasHelper) return `${id}-helper`;
  return undefined;
}

export function Field({ id, label, error, helper, className, children }: FieldProps) {
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={id} className="text-caption font-medium text-drive-text">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-caption text-red-600">
          {error}
        </p>
      ) : helper ? (
        <p id={`${id}-helper`} className="text-caption text-drive-muted">
          {helper}
        </p>
      ) : null}
    </div>
  );
}

// Shared control chrome — rounded-md, h-9, border, accent focus ring. Inputs and
// the Select trigger compose this so sizing/states stay in lockstep.
export function controlClass(error?: boolean): string {
  return clsx(
    "w-full h-9 rounded-md border bg-drive-panel px-3 text-body text-drive-text",
    "transition-colors duration-150 outline-none",
    "placeholder:text-drive-muted",
    "focus-visible:ring-2 focus-visible:ring-drive-accent/40 focus-visible:border-drive-accent",
    "disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-drive-bg",
    error ? "border-red-400 focus-visible:ring-red-400/40 focus-visible:border-red-400" : "border-drive-border",
  );
}
