// The ainize mark + brand colour, for the one place aindrive hands work to ainize: ▶ Run.
// Colours are ainize's own tokens (primary #8b3eeb, hover #5b1ca8) so the button reads as
// "this runs on ainize", not as a generic drive action.
import type { ComponentProps } from "react";

export const AINIZE_PURPLE = "#8b3eeb";
export const AINIZE_PURPLE_HOVER = "#5b1ca8";

/** ainize logomark: a rounded tile with the "A" of the wordmark. */
export function AinizeMark({ className = "w-3.5 h-3.5", ...rest }: ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true" {...rest}>
      <rect x="1" y="1" width="18" height="18" rx="4" fill="currentColor" opacity="0.18" />
      <path d="M10 3.5 L16 16.5 H13.4 L12.1 13.6 H7.9 L6.6 16.5 H4 Z M8.7 11.6 H11.3 L10 8.6 Z" fill="currentColor" />
    </svg>
  );
}

/** Class list for a solid ainize-branded button (purple, white text). */
export const ainizeButtonClass =
  "inline-flex items-center gap-1.5 rounded px-3 py-1 text-sm font-medium text-white bg-[#8b3eeb] hover:bg-[#5b1ca8] disabled:opacity-50 transition-colors";

/** Class list for the compact ainize-branded text action (purple text, no fill). */
export const ainizeLinkClass =
  "inline-flex items-center gap-1 text-caption font-semibold text-[#8b3eeb] hover:text-[#5b1ca8] transition-colors";
