// Square icon-only button — Drive's circular hover affordance for toolbar / close
// actions. Shares the Button sizing rhythm (md = h-9, sm = h-8) but is square.
import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import clsx from "clsx";
import type { ButtonSize, ButtonVariant } from "./Button";

const VARIANT: Record<ButtonVariant, string> = {
  filled: "bg-drive-accent text-white hover:bg-drive-accentHover shadow-e1",
  tonal: "bg-drive-selected text-drive-accent hover:brightness-95",
  text: "text-drive-muted hover:bg-drive-hover hover:text-drive-text active:bg-drive-hover",
  outline: "border border-drive-border bg-drive-panel text-drive-text hover:bg-drive-hover/60",
  danger: "text-red-600 hover:bg-red-50 active:bg-red-100",
};

const SIZE: Record<ButtonSize, string> = {
  md: "h-9 w-9",
  sm: "h-8 w-8",
};

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required for a11y — icon-only controls have no text label. */
  "aria-label": string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = "text", size = "md", loading = false, className, children, disabled, type, ...rest },
  ref,
) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={clsx(
        "inline-flex items-center justify-center rounded-full shrink-0",
        "transition-colors duration-150 outline-none",
        "focus-visible:ring-2 focus-visible:ring-drive-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-drive-panel",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 className={clsx("animate-spin", size === "sm" ? "w-4 h-4" : "w-5 h-5")} aria-hidden="true" />
      ) : (
        children
      )}
    </button>
  );
});
