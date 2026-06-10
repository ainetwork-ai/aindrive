"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Lock } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Modal, Button } from "@/components/ui";
import { atLeast } from "@/lib/access-core.js";
// Pure presets/parsers — safe in a client component.
import { TOKEN_PRESETS, DEFAULT_TOKENS, resolveDriveTokens, type PaymentToken } from "@/lib/payment-tokens";
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
  const [currency, setCurrency] = useState(DEFAULT_TOKENS[0].symbol);
  const [listed, setListed] = useState(false);
  // Drive token policy (currency select options). Non-owners can't read the
  // drive GET (403) and keep the default — the server re-validates anyway.
  const [driveTokens, setDriveTokens] = useState<PaymentToken[]>(DEFAULT_TOKENS);
  // Token-policy editor (owner-only UI): preset checkboxes + FANCO asset input
  const [tokenSel, setTokenSel] = useState<Record<string, boolean>>(
    () => Object.fromEntries(Object.keys(TOKEN_PRESETS).map((k) => [k, k === "USDC"])),
  );
  const [fancoAsset, setFancoAsset] = useState("");
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
      apiFetch<{ payout_wallet: string | null; allowed_tokens: string | null }>(`/api/drives/${driveId}`),
      apiFetch<{ members: Member[]; myRole: "viewer" | "editor" | "owner" }>(`/api/drives/${driveId}/members`),
      apiFetch<{ user: { email: string } | null }>(`/api/auth/me`),
    ]);
    if (s.ok) setShares(s.data.shares);
    if (r.ok) setReceipts(r.data.receipts ?? []);
    if (d.ok) {
      setPayoutWallet(d.data.payout_wallet ?? "");
      setPayoutInput(d.data.payout_wallet ?? "");
      const tokens = resolveDriveTokens(d.data.allowed_tokens ?? null);
      setDriveTokens(tokens);
      // Keep the user's pick if still allowed; otherwise snap to the policy's first token
      setCurrency((cur) => (tokens.some((t) => t.symbol === cur) ? cur : tokens[0].symbol));
      setTokenSel(Object.fromEntries(
        Object.keys(TOKEN_PRESETS).map((k) => [k, tokens.some((t) => t.symbol === k)]),
      ));
      const fanco = tokens.find((t) => t.symbol === "FANCO");
      if (fanco?.asset) setFancoAsset(fanco.asset);
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

  // Same owner test MembersSection uses; gates the List checkbox and the
  // token-policy editor (mirrors the API: listed=403, PATCH=403 for non-owners).
  const isOwner = atLeast(me.role, "owner");

  // Owner saves the drive's payment-token policy (preset checkboxes → PaymentToken[]).
  async function saveTokenPolicy() {
    const selected = Object.keys(TOKEN_PRESETS).filter((k) => tokenSel[k]);
    if (selected.length === 0) {
      toast.error("Select at least one payment token");
      return;
    }
    const fanco = fancoAsset.trim();
    if (tokenSel.FANCO && !/^0x[a-fA-F0-9]{40}$/.test(fanco)) {
      toast.error("FANCO needs an asset address (0x + 40 hex chars)");
      return;
    }
    const policy = selected.map((k) =>
      k === "FANCO" ? { ...TOKEN_PRESETS.FANCO, asset: fanco } : TOKEN_PRESETS[k],
    );
    setBusy(true);
    const res = await apiFetch(`/api/drives/${driveId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowed_tokens: JSON.stringify(policy) }),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Failed to save payment tokens");
      return;
    }
    toast.success("Payment tokens saved");
    load();
  }

  const totalEarned = receipts.reduce((sum, r) => sum + (r.amount_usdc ?? 0), 0);

  // Existing paid share for this exact path (most recent first)
  const paidShare = shares.find(s => s.path === defaultPath && s.price_usdc !== null);

  // Toggle is derived: ON when an active paid share exists, OR user opened the form
  const sellOn = !!paidShare || editingSell;

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
    <Modal
      open
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
      <div className="space-y-3">
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
          currency={currency}
          setCurrency={setCurrency}
          currencyOptions={driveTokens.map((t) => t.symbol)}
          listed={listed}
          setListed={setListed}
          isOwner={isOwner}
          tokenEditor={{
            sel: tokenSel,
            toggle: (sym) => setTokenSel((s) => ({ ...s, [sym]: !s[sym] })),
            fancoAsset,
            setFancoAsset,
            save: saveTokenPolicy,
          }}
          saveSell={saveSell}
          busy={busy}
          setEditingSell={setEditingSell}
          copyLink={copyLink}
        />

        <MembersSection
          members={members}
          isOwner={isOwner}
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
    </Modal>
  );
}
