"use client";

// Dropdown / context menu. Click-toggles, closes on outside-click or Esc,
// arrow-key navigation (Up/Down wrap, Home/End, Enter/Space activate), and
// aligns the popover under the trigger (start = left edges, end = right edges).
// Intended to absorb the ad-hoc row ⋮ menu and right-click menus.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import clsx from "clsx";

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface MenuProps {
  /** Render-prop trigger; receives open state + a toggle handler to spread onto a control. */
  trigger: (args: { open: boolean; onClick: () => void; "aria-expanded": boolean; "aria-haspopup": "menu" }) => ReactNode;
  items: MenuItem[];
  /** Horizontal edge to align the popover to the trigger. */
  align?: "start" | "end";
  className?: string;
}

export function Menu({ trigger, items, align = "start", className }: MenuProps) {
  const [open, setOpen] = useState(false);
  // -1 = no item highlighted (e.g. opened by mouse).
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);

  const firstEnabled = useCallback(
    (dir: 1 | -1, from: number) => {
      const n = items.length;
      for (let step = 1; step <= n; step++) {
        const i = (from + dir * step + n * step) % n;
        if (!items[i]?.disabled) return i;
      }
      return -1;
    },
    [items],
  );

  // Outside-click closes (capture so it beats item handlers re-opening).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    }
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, close]);

  // Move DOM focus to the highlighted item so SR + visuals track keyboard nav.
  useEffect(() => {
    if (open && active >= 0) itemRefs.current[active]?.focus();
  }, [open, active]);

  function onTriggerClick() {
    setOpen((v) => {
      const next = !v;
      if (next) setActive(firstEnabled(1, -1));
      return next;
    });
  }

  function onMenuKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => firstEnabled(1, i));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => firstEnabled(-1, i));
        break;
      case "Home":
        e.preventDefault();
        setActive(firstEnabled(1, -1));
        break;
      case "End":
        e.preventDefault();
        setActive(firstEnabled(-1, 0));
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (active >= 0 && !items[active]?.disabled) {
          items[active].onClick();
          close();
        }
        break;
    }
  }

  return (
    <div ref={rootRef} className={clsx("relative inline-block", className)}>
      {trigger({ open, onClick: onTriggerClick, "aria-expanded": open, "aria-haspopup": "menu" })}
      {open && (
        <div
          id={menuId}
          role="menu"
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          // Not portaled — the popover is a DOM child of whatever clickable
          // row/card hosts the trigger, so item clicks must not bubble into the
          // host's navigate handler (folder row onClick would also fire).
          onClick={(e) => e.stopPropagation()}
          className={clsx(
            "absolute z-50 mt-1 min-w-[12rem] py-1",
            "bg-drive-panel rounded-md shadow-e2 border border-drive-border",
            "origin-top animate-[menu-in_120ms_ease-out]",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {items.map((item, i) => (
            <button
              key={i}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                item.onClick();
                close();
              }}
              onMouseEnter={() => !item.disabled && setActive(i)}
              className={clsx(
                "flex w-full items-center gap-2.5 px-3 h-9 text-body text-left",
                "outline-none transition-colors",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                item.danger ? "text-red-600" : "text-drive-text",
                active === i && !item.disabled && (item.danger ? "bg-red-50" : "bg-drive-hover"),
              )}
            >
              {item.icon && <span className="shrink-0 w-4 h-4 flex items-center justify-center">{item.icon}</span>}
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
