"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Lock, Users, ArrowRight } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Modal, Button } from "@/components/ui";
import { atLeast } from "@/lib/access-core.js";
// Pure presets/parsers — safe in a client component.
import { DEFAULT_TOKENS, resolveDriveTokens, type PaymentToken } from "@/lib/payment-tokens";
import { resolvePayoutWallet, type PayoutRow } from "@/lib/payout";
import {
  SellSection, PeopleSection, FreeLinkSection,
  type Share, type Member,
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
  const [inviteRole, setInviteRole] = useState<"viewer" | "editor">("viewer");
  // Separate from inviteRole on purpose — a new link's role must not silently
  // follow whatever the invite form was last set to.
  const [linkRole, setLinkRole] = useState<"viewer" | "editor">("viewer");
  const [busy, setBusy] = useState(false);
  const [editingSell, setEditingSell] = useState(focusSection === "sell");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState(DEFAULT_TOKENS[0].symbol);
  const [listed, setListed] = useState(false);
  // Drive token policy (currency select options). Non-owners can't read the
  // drive GET (403) and keep the default — the server re-validates anyway.
  const [driveTokens, setDriveTokens] = useState<PaymentToken[]>(DEFAULT_TOKENS);
  // Path-scoped payout wallets for the whole drive; `payoutInput` edits the
  // wallet set on THIS folder (defaultPath), while the effective/inherited
  // wallet is resolved from the full list (nearest ancestor wins).
  const [payoutRows, setPayoutRows] = useState<PayoutRow[]>([]);
  const [payoutInput, setPayoutInput] = useState<string>("");
  const [members, setMembers] = useState<Member[]>([]);
  const [me, setMe] = useState<{ email: string; role: "viewer" | "editor" | "owner" | "none" }>({
    email: "",
    role: "none",
  });

  async function load() {
    // Earnings/receipts moved to the Manage page (Sales) — this contextual
    // panel no longer fetches them.
    const [s, d, mem, who] = await Promise.all([
      apiFetch<{ shares: Share[] }>(`/api/drives/${driveId}/shares`),
      apiFetch<{ payout_wallets?: PayoutRow[]; allowed_tokens: string | null }>(`/api/drives/${driveId}`),
      apiFetch<{ members: Member[]; myRole: "viewer" | "editor" | "owner" }>(`/api/drives/${driveId}/members`),
      apiFetch<{ user: { email: string } | null }>(`/api/auth/me`),
    ]);
    if (s.ok) setShares(s.data.shares);
    if (d.ok) {
      const rows = d.data.payout_wallets ?? [];
      setPayoutRows(rows);
      // The input edits the wallet set ON this exact folder (empty if none).
      const here = rows.find((r) => r.path === defaultPath)?.wallet ?? "";
      setPayoutInput(here);
      // Drive token policy feeds the read-only "Accepted in this drive" chips +
      // the per-sale Currency select. EDITING the policy lives in Settings →
      // Payments (audit in settings), not in this contextual drawer.
      const tokens = resolveDriveTokens(d.data.allowed_tokens ?? null);
      setDriveTokens(tokens);
      // Keep the user's pick if still allowed; otherwise snap to the policy's first token
      setCurrency((cur) => (tokens.some((t) => t.symbol === cur) ? cur : tokens[0].symbol));
    }
    if (mem.ok) setMembers(mem.data.members);
    if (who.ok && who.data.user) {
      setMe({ email: who.data.user.email, role: mem.ok ? mem.data.myRole : "none" });
    }
  }
  useEffect(() => { load(); }, [driveId]);

  // Set/clear the wallet on THIS folder (defaultPath) via the path-scoped
  // endpoint. Clearing falls back to the inherited ancestor wallet, not to any
  // operator default — empty input deletes this folder's override.
  async function savePayoutWallet() {
    const v = payoutInput.trim();
    if (v && !/^0x[a-fA-F0-9]{40}$/.test(v)) {
      toast.error("Payout wallet must be 0x + 40 hex chars");
      return;
    }
    setBusy(true);
    const res = v
      ? await apiFetch(`/api/drives/${driveId}/payout`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: defaultPath, wallet: v }),
        })
      : await apiFetch(`/api/drives/${driveId}/payout`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: defaultPath }),
        });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Failed to save payout wallet");
      return;
    }
    // Reflect the change locally: replace/remove this folder's row.
    const wallet = v.toLowerCase();
    setPayoutRows((prev) => {
      const rest = prev.filter((r) => r.path !== defaultPath);
      return wallet ? [...rest, { path: defaultPath, wallet }] : rest;
    });
    toast.success(wallet ? "Payout wallet saved for this folder" : "Folder payout wallet cleared");
  }

  // Same owner test MembersSection uses; gates the List checkbox and the
  // token-policy editor (mirrors the API: listed=403, PATCH=403 for non-owners).
  const isOwner = atLeast(me.role, "owner");

  // Owner saves the drive's payment-token policy: selected fixed presets (USDC)
  // ∪ custom tokens added by contract-address lookup. Dedupe by symbol so a
  // custom token can't collide with a preset.
  // Existing paid share for this exact path (most recent first)
  const paidShare = shares.find(s => s.path === defaultPath && s.price_usdc !== null);

  // Toggle is derived: ON when an active paid share exists, OR user opened the form
  const sellOn = !!paidShare || editingSell;

  // Seed the editable sell form from the existing paid share so its CURRENT
  // terms are what you edit (not the blank create-defaults set above). Keyed on
  // the share id so it re-seeds if the share changes; the create flow (no
  // paidShare) keeps the blank defaults.
  useEffect(() => {
    if (!paidShare) return;
    setPrice(paidShare.price_usdc != null ? String(paidShare.price_usdc) : "");
    setCurrency(paidShare.currency ?? DEFAULT_TOKENS[0].symbol);
    setListed(paidShare.listed === 1);
  }, [paidShare?.id]);

  async function saveSell() {
    const num = Number(price);
    if (!num || num < 0.01 || num > 9999.99) {
      toast.error(`Price must be between 0.01 and 9999.99 ${currency}`);
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
        currency,
        // Checkbox renders for owners only; the API 403s listed:true otherwise
        listed: isOwner && listed,
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
    setListed(false);
    load();
  }

  // Edit an existing paid share's terms IN PLACE (same /s link). The owner-only
  // `listed` field is sent only when owner — the API 403s listed:true otherwise
  // (mirrors saveSell). Changing price/currency only affects NEW buyers.
  async function saveShareEdit() {
    if (!paidShare) return;
    const num = Number(price);
    if (!num || num < 0.01 || num > 9999.99) {
      toast.error(`Price must be between 0.01 and 9999.99 ${currency}`);
      return;
    }
    setBusy(true);
    const res = await apiFetch(`/api/drives/${driveId}/shares/${paidShare.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        price_usdc: Math.round(num * 100) / 100,
        currency,
        ...(isOwner ? { listed } : {}),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Failed to update sale");
      return;
    }
    toast.success("Sale updated");
    load();
  }

  async function createFreeLink() {
    setBusy(true);
    const res = await apiFetch<{ url: string }>(`/api/drives/${driveId}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: defaultPath, role: linkRole }),
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
      body: JSON.stringify({ email, role: inviteRole, path: defaultPath }),
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
    <Modal
      open
      variant="drawer"
      onClose={onClose}
      title={<>Share &ldquo;{defaultPath || "/"}&rdquo;</>}
      footer={
        <div className="flex items-center justify-between gap-2 w-full">
          <div className="text-[11px] text-drive-muted flex items-center gap-1">
            <Lock className="w-3 h-3" /> Payments are final · no refunds
          </div>
          <Button onClick={onClose}>Done</Button>
        </div>
      }
    >
      {/* Contextual share panel for THIS path, as ONE flat sheet (divide-y
          sections, no card chrome): people → link sharing → selling, then a
          quiet pointer to the drive-wide ledger (Manage page) at the end. */}
      <div className="divide-y divide-drive-border">
        <PeopleSection
          members={members}
          isOwner={isOwner}
          currentUserEmail={me.email}
          currentPath={defaultPath}
          changeMemberRole={changeMemberRole}
          removeMember={removeMember}
          email={email}
          setEmail={setEmail}
          inviteRole={inviteRole}
          setInviteRole={setInviteRole}
          invite={invite}
          busy={busy}
        />

        <FreeLinkSection
          shares={shares}
          currentPath={defaultPath}
          linkRole={linkRole}
          setLinkRole={setLinkRole}
          createFreeLink={createFreeLink}
          busy={busy}
          copyLink={copyLink}
        />

        <SellSection
          defaultPath={defaultPath}
          focusSection={focusSection}
          sellOn={sellOn}
          paidShare={paidShare}
          payoutOwnWallet={payoutRows.find((r) => r.path === defaultPath)?.wallet ?? ""}
          payoutEffective={resolvePayoutWallet(payoutRows, defaultPath)}
          payoutInherited={
            !payoutRows.some((r) => r.path === defaultPath) &&
            resolvePayoutWallet(payoutRows, defaultPath) !== null
          }
          payoutInput={payoutInput}
          setPayoutInput={setPayoutInput}
          savePayoutWallet={savePayoutWallet}
          price={price}
          setPrice={setPrice}
          currency={currency}
          setCurrency={setCurrency}
          currencyOptions={driveTokens.map((t) => t.symbol)}
          listed={listed}
          setListed={setListed}
          isOwner={isOwner}
          driveId={driveId}
          saveSell={saveSell}
          saveShareEdit={saveShareEdit}
          busy={busy}
          setEditingSell={setEditingSell}
          copyLink={copyLink}
        />

        {/* Audit lives in Settings — the drawer only points there ("create in
            context, audit in settings"). */}
        {isOwner && (
          <a
            href={`/d/${driveId}/manage`}
            className="flex items-center justify-between gap-2 py-3 text-body text-drive-muted hover:text-drive-accent"
          >
            <span className="flex items-center gap-2">
              <Users className="w-4 h-4" /> All members, links &amp; sales
            </span>
            <ArrowRight className="w-4 h-4" />
          </a>
        )}
      </div>
    </Modal>
  );
}
