// Native <select> styled to match Input, plus a chevron. Native (not a custom
// popover) keeps mobile/keyboard/scroll behavior free and accessible.
import { forwardRef, useId } from "react";
import type { SelectHTMLAttributes, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import clsx from "clsx";
import { Field, controlClass, describedById } from "./Field";

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  label?: ReactNode;
  error?: ReactNode;
  helper?: ReactNode;
  wrapClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, helper, className, wrapClassName, children, ...rest },
  ref,
) {
  const id = useId();
  const hasError = !!error;
  return (
    <Field id={id} label={label} error={error} helper={helper} className={wrapClassName}>
      <div className="relative">
        <select
          ref={ref}
          id={id}
          aria-invalid={hasError || undefined}
          aria-describedby={describedById(id, hasError, !!helper)}
          className={clsx(controlClass(hasError), "appearance-none pr-9 cursor-pointer", className)}
          {...rest}
        >
          {children}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-drive-muted"
          aria-hidden="true"
        />
      </div>
    </Field>
  );
});
