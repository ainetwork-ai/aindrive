"use client";
// Hover affordance on a home-page drive card: leave a drive I was added to
// (invite, share link, or purchase). Owners never see this — the creator
// can't leave their own drive (API enforces it too).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { toast } from "sonner";

export function LeaveDriveButton({ driveId, driveName }: { driveId: string; driveName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function leave() {
    if (!confirm(
      `Leave "${driveName}"?\n\nYou lose access — including anything you paid for — and rejoining needs a new invite or link.`,
    )) return;
    setBusy(true);
    const res = await fetch(`/api/drives/${driveId}/leave`, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.error || "failed to leave drive");
      return;
    }
    toast.success(`Left "${driveName}"`);
    router.refresh();
  }

  return (
    <button
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); leave(); }}
      disabled={busy}
      title="Leave this drive"
      className="absolute top-3 right-3 hidden group-hover:flex items-center gap-1 rounded-full border border-drive-border bg-white px-2.5 py-1 text-caption text-drive-muted hover:text-red-600 hover:border-red-200 transition disabled:opacity-50"
    >
      <LogOut className="w-3 h-3" /> Leave
    </button>
  );
}
