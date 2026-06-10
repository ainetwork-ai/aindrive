// Labelled section card: an icon badge + title (+ optional one-line
// description) header over a body, with an optional top-right `action` slot
// (toggle / total / button). Used to break long modal forms into a scannable
// stack of cards (share dialog, create-agent modal). `highlight` rings the card
// to draw focus to a deep-linked section.
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
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-drive-selected text-drive-accent">
            {icon}
          </span>
          <div className="min-w-0">
            <h3 className="text-subtitle text-drive-text leading-tight">{title}</h3>
            {description && <p className="text-caption text-drive-muted">{description}</p>}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}
