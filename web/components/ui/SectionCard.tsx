// Labelled section card: a quiet inline icon + title (+ optional one-line
// description) header over a body, with an optional top-right `action` slot
// (toggle / total / button). For WIDE surfaces (manage page, create-agent
// modal) — the narrow Share drawer uses flat sections instead of cards.
// `highlight` rings the card to draw focus to a deep-linked section.
import type { ReactNode } from "react";
import clsx from "clsx";

export interface SectionCardProps {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Top-right slot, vertically centered with the title row. */
  action?: ReactNode;
  highlight?: boolean;
  className?: string;
  children?: ReactNode;
}

export function SectionCard({
  icon, title, description, action, highlight, className, children,
}: SectionCardProps) {
  return (
    <section
      className={clsx(
        "rounded-xl border border-drive-border bg-drive-panel p-4",
        highlight && "ring-2 ring-drive-accent/50",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-subtitle text-drive-text leading-tight">
            <span className="shrink-0 text-drive-muted">{icon}</span>
            <span className="truncate">{title}</span>
          </h3>
          {description && <p className="mt-0.5 text-caption text-drive-muted">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}
