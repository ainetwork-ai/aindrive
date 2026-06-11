"use client";

// Accessible modal shell. Owns the hard a11y/UX parts so feature modals only
// supply content: role=dialog/aria-modal/aria-labelledby, Esc + outside-click
// close, body scroll-lock (restored on close), focus-trap (focus moves in on
// open, Tab/Shift-Tab cycle within the panel, focus returns to the opener on
// close), and a fade+slide enter.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import clsx from "clsx";
import { IconButton } from "./IconButton";

export type ModalSize = "sm" | "md" | "lg";
/** center = classic dialog; drawer = right-docked side panel (share/details). */
export type ModalVariant = "center" | "drawer";

const SIZE: Record<ModalSize, string> = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-3xl",
};

// Tab order = visible, focusable, in-DOM-order elements inside the panel.
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: ModalSize;
  variant?: ModalVariant;
  /** Hide the header close button (e.g. forced-choice flows). Esc/backdrop still close. */
  hideClose?: boolean;
}

export function Modal({ open, onClose, title, children, footer, size = "md", variant = "center", hideClose }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Element focused before the modal opened — restored on close so keyboard
  // users land back where they were.
  const openerRef = useRef<Element | null>(null);
  // Delay-mounted "entered" flag drives the fade+slide transition.
  const [entered, setEntered] = useState(false);

  const focusables = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return [] as HTMLElement[];
    return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
  }, []);

  // Body scroll-lock + remember opener. Cleanup restores both.
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      // Return focus to whatever opened the modal.
      if (openerRef.current instanceof HTMLElement) openerRef.current.focus();
    };
  }, [open]);

  // Enter transition + initial focus (first focusable, else the panel).
  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const raf = requestAnimationFrame(() => {
      setEntered(true);
      const f = focusables();
      (f[0] ?? panelRef.current)?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, focusables]);

  // Esc closes; Tab/Shift-Tab cycle within the panel (focus-trap).
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) {
        // Nothing focusable — keep focus on the panel.
        e.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const first = f[0];
      const last = f[f.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose, focusables]);

  if (!open) return null;

  const isDrawer = variant === "drawer";

  return (
    <div
      className={clsx(
        "fixed inset-0 z-50 flex bg-black/40 transition-opacity duration-150",
        isDrawer ? "items-stretch justify-end" : "items-center justify-center p-4",
        entered ? "opacity-100" : "opacity-0",
      )}
      onMouseDown={(e) => {
        // Backdrop click closes; clicks that start inside the panel don't.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={clsx(
          "flex flex-col outline-none bg-drive-panel transition-all duration-150 ease-out",
          isDrawer
            ? clsx(
                "h-full w-full sm:max-w-md border-l border-drive-border shadow-e3 sm:rounded-l-2xl",
                entered ? "opacity-100 translate-x-0" : "opacity-0 translate-x-4",
              )
            : clsx(
                "w-full max-h-[90vh] rounded-xl shadow-e3",
                entered ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-2 scale-[0.98]",
                SIZE[size],
              ),
        )}
      >
        {(title || !hideClose) && (
          <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-drive-border">
            {title ? (
              <h2 id={titleId} className="text-title text-drive-text truncate">
                {title}
              </h2>
            ) : (
              <span />
            )}
            {!hideClose && (
              <IconButton aria-label="Close" size="sm" onClick={onClose}>
                <X className="w-5 h-5" />
              </IconButton>
            )}
          </header>
        )}

        <div className="px-5 py-4 overflow-y-auto scrollbar-thin text-body text-drive-text">
          {children}
        </div>

        {footer && (
          <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-drive-border">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
