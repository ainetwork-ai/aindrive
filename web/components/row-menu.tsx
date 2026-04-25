"use client";

import { useEffect, useRef, useState } from "react";
import { MoreVertical, DollarSign, Share2, Pencil, Trash2 } from "lucide-react";

type Action = "sell" | "share" | "rename" | "delete";

export function RowMenu({
  hasPaidShare,
  onAction,
}: {
  hasPaidShare: boolean;
  onAction: (a: Action) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(a: Action) {
    setOpen(false);
    onAction(a);
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="p-1.5 rounded hover:bg-drive-hover"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-30 min-w-[180px] rounded-lg border border-drive-border bg-white shadow-drive py-1 text-sm"
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem
            icon={<DollarSign className="w-4 h-4" />}
            label={hasPaidShare ? "Already selling" : "Sell…"}
            disabled={hasPaidShare}
            onClick={() => pick("sell")}
          />
          <MenuItem
            icon={<Share2 className="w-4 h-4" />}
            label="Share…"
            onClick={() => pick("share")}
          />
          <div className="my-1 border-t border-drive-border" />
          <MenuItem
            icon={<Pencil className="w-4 h-4" />}
            label="Rename"
            onClick={() => pick("rename")}
          />
          <MenuItem
            icon={<Trash2 className="w-4 h-4" />}
            label="Delete"
            danger
            onClick={() => pick("delete")}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon, label, onClick, disabled, danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-drive-hover disabled:opacity-50 disabled:hover:bg-transparent ${
        danger ? "text-red-600 hover:bg-red-50" : ""
      }`}
    >
      <span className="text-drive-muted">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
