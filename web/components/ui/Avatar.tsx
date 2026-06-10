// Initials avatar with a deterministic background color derived from the name
// (or an explicit `color`). For account menus + collaboration presence.
// Color reuses colorForId (the same hash that tints peer cursors), so a person
// reads as the same color across the app.
import clsx from "clsx";
import { colorForId } from "../viewer-utils";

export type AvatarSize = "xs" | "sm" | "md" | "lg";

const SIZE: Record<AvatarSize, string> = {
  xs: "h-6 w-6 text-[10px]",
  sm: "h-8 w-8 text-caption",
  md: "h-9 w-9 text-body",
  lg: "h-12 w-12 text-subtitle",
};

/** First letters of up to two name parts, uppercased. "Ada Lovelace" -> "AL". */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export interface AvatarProps {
  name: string;
  /** Override the deterministic color (e.g. presence color from awareness). */
  color?: string;
  size?: AvatarSize;
  className?: string;
  title?: string;
}

export function Avatar({ name, color, size = "md", className, title }: AvatarProps) {
  return (
    <span
      title={title ?? name}
      aria-label={name}
      className={clsx(
        "inline-flex items-center justify-center rounded-full font-medium text-white select-none shrink-0",
        SIZE[size],
        className,
      )}
      style={{ backgroundColor: color ?? colorForId(name) }}
    >
      {initials(name)}
    </span>
  );
}
