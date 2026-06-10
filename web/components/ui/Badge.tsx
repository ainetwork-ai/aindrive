// Small status pill. `sale` tone generalizes the X402Badge accent gradient so
// for-sale / paid surfaces share one tone vocabulary.
import type { ReactNode } from "react";
import clsx from "clsx";

export type BadgeTone = "neutral" | "accent" | "warning" | "sale";

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-drive-hover text-drive-muted",
  accent: "bg-drive-selected text-drive-accent",
  warning: "bg-amber-100 text-amber-800",
  sale: "bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-sm shadow-blue-500/30",
};

export interface BadgeProps {
  tone?: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Badge({ tone = "neutral", icon, children, className }: BadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-medium leading-none",
        "whitespace-nowrap",
        TONE[tone],
        className,
      )}
    >
      {icon && <span className="shrink-0 [&_svg]:w-3 [&_svg]:h-3">{icon}</span>}
      {children}
    </span>
  );
}
