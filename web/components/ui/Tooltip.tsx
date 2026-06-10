"use client";

// Lightweight tooltip. Shows on hover or keyboard focus after a short delay,
// hides on leave/blur/Esc. CSS-positioned relative to the wrapper (no portal) —
// fine for short labels on toolbar icons. content="" renders the child bare.
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import clsx from "clsx";

export type TooltipSide = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: TooltipSide;
  delay?: number;
  className?: string;
}

const SIDE: Record<TooltipSide, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
  left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
  right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
};

export function Tooltip({ content, children, side = "top", delay = 300, className }: TooltipProps) {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!content) return <>{children}</>;

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(true), delay);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setShown(false);
  };

  return (
    <span
      className={clsx("relative inline-flex", className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
      onKeyDown={(e) => e.key === "Escape" && hide()}
    >
      {children}
      {shown && (
        <span
          role="tooltip"
          className={clsx(
            "pointer-events-none absolute z-50 whitespace-nowrap",
            "rounded-md bg-drive-text px-2 py-1 text-caption text-white shadow-e2",
            SIDE[side],
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
