// Pulsing placeholder for loading states. w/h accept any CSS length (e.g.
// "100%", 16, "12rem"); rounded defaults to md, "full" for avatars/pills.
import type { CSSProperties } from "react";
import clsx from "clsx";

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  rounded?: "sm" | "md" | "lg" | "full";
  className?: string;
  style?: CSSProperties;
}

const ROUNDED = {
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  full: "rounded-full",
} as const;

export function Skeleton({ width, height = 16, rounded = "md", className, style }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={clsx("animate-pulse bg-drive-hover", ROUNDED[rounded], className)}
      style={{ width, height, ...style }}
    />
  );
}
