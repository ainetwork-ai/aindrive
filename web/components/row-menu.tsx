"use client";

// Row / card actions, built on the Menu primitive so the ⋮ dropdown and the
// right-click context menu (drive-shell-parts) render the exact same items with
// the exact same permission gates. `rowMenuItems` is the single source of those
// items; RowMenu wires them to the ⋮ IconButton trigger.
import { DollarSign, Share2, Pencil, Trash2, MoreVertical } from "lucide-react";
import { Menu, IconButton, type MenuItem } from "@/components/ui";

export type Action = "sell" | "share" | "rename" | "delete";

/**
 * Build the action items for an entry. sell/share are owner-only (O2);
 * rename/delete follow canManage (editor or owner). A sale is ongoing — one
 * link, any number of buyers — never "consumed" by a purchase, so an existing
 * paid share relabels the item to "Manage sale…" (same drawer) instead of
 * disabling it.
 */
export function rowMenuItems({
  hasPaidShare, onAction, canSell, canManage,
}: {
  hasPaidShare: boolean;
  onAction: (a: Action) => void;
  canSell: boolean;
  canManage: boolean;
}): MenuItem[] {
  const items: MenuItem[] = [];
  if (canSell) {
    items.push({
      label: hasPaidShare ? "Manage sale…" : "Sell…",
      icon: <DollarSign className="w-4 h-4" />,
      onClick: () => onAction("sell"),
    });
    items.push({
      label: "Share…",
      icon: <Share2 className="w-4 h-4" />,
      onClick: () => onAction("share"),
    });
  }
  if (canManage) {
    items.push({
      label: "Rename",
      icon: <Pencil className="w-4 h-4" />,
      onClick: () => onAction("rename"),
    });
    items.push({
      label: "Delete",
      icon: <Trash2 className="w-4 h-4" />,
      danger: true,
      onClick: () => onAction("delete"),
    });
  }
  return items;
}

export function RowMenu(props: {
  hasPaidShare: boolean;
  onAction: (a: Action) => void;
  canSell: boolean;
  canManage: boolean;
}) {
  const items = rowMenuItems(props);
  if (items.length === 0) return null;
  return (
    <Menu
      align="end"
      items={items}
      trigger={({ onClick, ...aria }) => (
        // stopPropagation so opening the menu from inside a clickable row/card
        // doesn't also fire the row's navigate handler.
        <IconButton
          aria-label="More actions"
          size="sm"
          onClick={(e) => { e.stopPropagation(); onClick(); }}
          {...aria}
        >
          <MoreVertical className="w-4 h-4" />
        </IconButton>
      )}
    />
  );
}
