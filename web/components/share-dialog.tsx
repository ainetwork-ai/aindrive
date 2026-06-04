"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { X, Lock } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { atLeast } from "@/lib/access-core.js";
import {
  EarningsSection, SellSection, EmailInviteSection, FreeLinkSection,
  MembersSection,
  type Share, type Receipt, type Member,
} from "./share-dialog-sections";

type FocusSection = "sell" | "share" | undefined;

export function ShareDialog({
  driveId, defaultPath, onClose, focusSection,
}: {
  driveId: string;
  defaultPath: string;
  onClose: () => void;
  focusSection?: FocusSection;
}) {
  const [shares, setShares] = useState<Share[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [busy, setBusy] = useState(false);
  const [editingSell, setEditingSell] = useState(focusSection === "sell");
  const [price, setPrice] = useState("");
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [payoutWallet, setPayoutWallet] = useState<string>("");
  const [payoutInput, setPayoutInput] = useState<string>("");
  const [members, setMembers] = useState<Member[]>([]);
  const [me, setMe] = useState<{ email: string; role: "viewer" | "editor" | "owner" | "none" }>({
    email: "",
    role: "none",
  });

  async function load() {
    const [s, r, d, mem, who] = await Promise.all([
      apiFetch<{ shares: Share[] }>(`/api/drives/${driveId}/shares`),
      apiFetch<{ receipts: Receipt[] }>(`/api/drives/${driveId}/receipts`),
      apiFetch<{ payout_wallet: string | null }>(`/api/drives/${driveId}`),
      apiFetch<{ members: Member[]; myRole: "viewer" | "editor" | "owner" }>(`/api/drives/${driveId}/members`),
      apiFetch<{ user: { email: string } | null }>(`/api/auth/me`),
    ]);
    if (s.ok) setShares(s.data.shares);
    if (r.ok) setReceipts(r.data.receipts ?? []);
    if (d.ok) {
      setPayoutWallet(d.data.payout_wallet ?? "");
      setPayoutInput(d.data.payout_wallet ?? "");
    }
    if (mem.ok) setMembers(mem.data.members);
    if (who.ok && who.data.user) {
      setMe({ email: who.data.user.email, role: mem.ok ? mem.data.myRole : "none" });
    }
  }
  useEffect(() => { load(); }, [driveId]);

  async function savePayoutWallet() {
    const v = payoutInput.trim();
    if (v && !/^0x[a-fA-F0-9]{40}$/.test(v)) {
      toast.error("Payout wallet must be 0x + 40 hex chars");
      return;
    }
    setBusy(true);
    const res = await apiFetch<{ payout_wallet: string | null }>(`/api/drives/${driveId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payout_wallet: v || null }),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Failed to save payout wallet");
      return;
    }
    setPayoutWallet(res.data.payout_wallet ?? "");
    toast.success(res.data.payout_wallet ? "Payout wallet saved" : "Payout wallet cleared");
  }

  const totalEarned = receipts.reduce((sum, r) => sum + (r.amount_usdc ?? 0), 0);

  // Existing paid share for this exact path (most recent first)
  const paidShare = shares.find(s => s.path === defaultPath && s.price_usdc !== null);

  // Toggle is derived: ON when an active paid share exists, OR user opened the form
  const sellOn = !!paidShare || editingSell;

  async function saveSell() {
    const num = Number(price);
    if (!num || num < 0.01 || num > 9999.99) {
      toast.error("Price must be between 0.01 and 9999.99 USDC");
      return;
    }
    setBusy(true);
    const res = await apiFetch<{ url: string }>(`/api/drives/${driveId}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: defaultPath,
        role: "viewer",
        price_usdc: Math.round(num * 100) / 100,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Failed to save");
      return;
    }
    const { url } = res.data;
    const copied = await navigator.clipboard.writeText(url).then(() => true).catch(() => false);
    if (copied) toast.success("Paid share link copied to clipboard");
    else toast.success(`Paid share link created: ${url}`, { duration: 8000 });
    setPrice("");
    load();
  }

  async function createFreeLink() {
    setBusy(true);
    const res = await apiFetch<{ url: string }>(`/api/drives/${driveId}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: defaultPath, role }),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Failed to create link");
      return;
    }
    const { url } = res.data;
    const copied = await navigator.clipboard.writeText(url).then(() => true).catch(() => false);
    if (copied) toast.success("Free share link copied");
    else toast.success(`Free share link created: ${url}`, { duration: 8000 });
    load();
  }

  async function invite() {
    if (!email) return;
    setBusy(true);
    const res = await apiFetch(`/api/drives/${driveId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, role, path: defaultPath }),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
    } else {
      setEmail("");
      toast.success("Collaborator added");
    }
  }

  async function changeMemberRole(id: string, newRole: "viewer" | "editor" | "owner") {
    setBusy(true);
    const res = await apiFetch(`/api/drives/${driveId}/members/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    setBusy(false);
    if (!res.ok) toast.error(res.error || "Failed to change role");
    else { toast.success("Role updated"); load(); }
  }

  async function removeMember(id: string) {
    if (!confirm("Remove this member?")) return;
    setBusy(true);
    const res = await apiFetch(`/api/drives/${driveId}/members/${id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) toast.error(res.error || "Failed to remove member");
    else { toast.success("Member removed"); load(); }
  }

  function copyLink(token: string) {
    const url = `${window.location.origin}/s/${token}`;
    navigator.clipboard.writeText(url);
    toast.success("Link copied");
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-drive max-h-[90vh] flex flex-col">
        <header className="flex items-center justify-between p-4 border-b border-drive-border shrink-0">
          <h2 className="font-semibold truncate">Share &ldquo;{defaultPath || "/"}&rdquo;</h2>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-drive-hover" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="p-4 space-y-5 overflow-y-auto scrollbar-thin">
          {receipts.length > 0 && (
            <EarningsSection receipts={receipts} totalEarned={totalEarned} />
          )}

          <SellSection
            defaultPath={defaultPath}
            focusSection={focusSection}
            sellOn={sellOn}
            paidShare={paidShare}
            payoutWallet={payoutWallet}
            payoutInput={payoutInput}
            setPayoutInput={setPayoutInput}
            savePayoutWallet={savePayoutWallet}
            price={price}
            setPrice={setPrice}
            saveSell={saveSell}
            busy={busy}
            setEditingSell={setEditingSell}
            copyLink={copyLink}
          />

          <MembersSection
            members={members}
            isOwner={atLeast(me.role, "owner")}
            currentUserEmail={me.email}
            changeMemberRole={changeMemberRole}
            removeMember={removeMember}
            busy={busy}
          />

          <EmailInviteSection
            email={email}
            setEmail={setEmail}
            role={role}
            setRole={setRole}
            invite={invite}
            busy={busy}
          />

          <FreeLinkSection
            shares={shares}
            createFreeLink={createFreeLink}
            busy={busy}
            copyLink={copyLink}
          />
        </div>

        <footer className="flex items-center justify-between gap-2 p-3 border-t border-drive-border shrink-0">
          <div className="text-[11px] text-drive-muted flex items-center gap-1">
            <Lock className="w-3 h-3" /> Payments are final · no refunds
          </div>
          <button
            onClick={onClose}
            className="rounded-lg bg-drive-accent text-white px-4 py-1.5 text-sm hover:bg-drive-accentHover"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
