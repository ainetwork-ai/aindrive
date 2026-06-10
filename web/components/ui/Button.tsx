// Drive-style pill buttons. One control-sizing system shared across primitives:
// md = h-9, sm = h-8. Variants map to the Drive palette (accent #0b57d0).
import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import clsx from "clsx";

export type ButtonVariant = "filled" | "tonal" | "text" | "outline" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  filled:
    "bg-drive-accent text-white hover:bg-drive-accentHover active:bg-drive-accentHover shadow-e1",
  tonal:
    "bg-drive-selected text-drive-accent hover:brightness-95 active:brightness-90",
  text: "text-drive-accent hover:bg-drive-selected/60 active:bg-drive-selected",
  outline:
    "border border-drive-border bg-drive-panel text-drive-text hover:bg-drive-hover/60 active:bg-drive-hover",
  danger: "bg-red-600 text-white hover:bg-red-700 active:bg-red-800 shadow-e1",
};

const SIZE: Record<ButtonSize, string> = {
  md: "h-9 px-4 text-body gap-2",
  sm: "h-8 px-3 text-caption gap-1.5",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Optional leading icon (lucide). Hidden while loading (spinner replaces it). */
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "filled", size = "md", loading = false, icon, className, children, disabled, type, ...rest },
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
        "inline-flex items-center justify-center rounded-full font-medium whitespace-nowrap",
        "transition-colors duration-150 outline-none select-none",
        "focus-visible:ring-2 focus-visible:ring-drive-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-drive-panel",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 className={clsx("animate-spin", size === "sm" ? "w-3.5 h-3.5" : "w-4 h-4")} aria-hidden="true" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
});
