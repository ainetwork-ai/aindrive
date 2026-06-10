// Text input with label/error/helper slots. Shares control chrome (h-9,
// rounded-md, accent focus ring) with Select via Field.
import { forwardRef, useId } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";
import { Field, controlClass, describedById } from "./Field";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label?: ReactNode;
  error?: ReactNode;
  helper?: ReactNode;
  /** className applies to the <input>; wrapClassName to the Field wrapper. */
  wrapClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, helper, className, wrapClassName, ...rest },
  ref,
) {
  const id = useId();
  const hasError = !!error;
  return (
    <Field id={id} label={label} error={error} helper={helper} className={wrapClassName}>
      <input
        ref={ref}
        id={id}
        aria-invalid={hasError || undefined}
        aria-describedby={describedById(id, hasError, !!helper)}
        className={clsx(controlClass(hasError), className)}
        {...rest}
      />
    </Field>
  );
});
