// Centered empty / zero-data state: icon chip + title + optional description and
// action (e.g. a Button). Used for empty folders, no search results, etc.
import type { ReactNode } from "react";
import clsx from "clsx";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={clsx("flex flex-col items-center justify-center text-center px-6 py-12", className)}>
      {icon && (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-drive-sidebar text-drive-muted [&_svg]:w-7 [&_svg]:h-7">
          {icon}
        </div>
      )}
      <h3 className="text-subtitle text-drive-text">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-body text-drive-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
