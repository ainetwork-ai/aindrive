// Surface container — rounded-lg panel with a hairline border. `interactive`
// adds hover elevation + focus ring and renders a <button> (use for clickable
// file/showcase cards). Drive uses 12px radius for cards.
import { forwardRef } from "react";
import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import clsx from "clsx";

const BASE = "rounded-lg border border-drive-border bg-drive-panel";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: false;
  padded?: boolean;
}
export interface InteractiveCardProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  interactive: true;
  padded?: boolean;
}

export const Card = forwardRef<HTMLDivElement | HTMLButtonElement, CardProps | InteractiveCardProps>(
  function Card({ interactive, padded = true, className, children, ...rest }, ref) {
    if (interactive) {
      const { ...btn } = rest as ButtonHTMLAttributes<HTMLButtonElement>;
      return (
        <button
          ref={ref as React.Ref<HTMLButtonElement>}
          type="button"
          className={clsx(
            BASE,
            "text-left w-full transition-shadow duration-150 outline-none",
            "hover:shadow-e2 active:shadow-e1",
            "focus-visible:ring-2 focus-visible:ring-drive-accent/40",
            padded && "p-4",
            className,
          )}
          {...btn}
        >
          {children}
        </button>
      );
    }
    const { ...div } = rest as HTMLAttributes<HTMLDivElement>;
    return (
      <div ref={ref as React.Ref<HTMLDivElement>} className={clsx(BASE, padded && "p-4", className)} {...div}>
        {children}
      </div>
    );
  },
);
