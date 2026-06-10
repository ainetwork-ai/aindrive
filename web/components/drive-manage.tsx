"use client";
// Full-page drive management (owner-only): People / Links & sales / Settings.
// The cramped share modal stays for quick per-folder sharing; this is the home
// for "who has access where", pending invites, link revocation, earnings, and
// drive-wide settings (payout wallet + token policy).
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowLeft, Users, LinkIcon, Settings as SettingsIcon, UserPlus, Search,
  TrashIcon, ShieldCheck, Clock, ExternalLink, Copy, Ban,
} from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Avatar, Badge, Button, IconButton, Input, Select, SectionCard, EmptyState } from "@/components/ui";
import { TOKEN_PRESETS, DEFAULT_TOKENS, resolveDriveTokens, type PaymentToken } from "@/lib/payment-tokens";
import { PaymentTokensEditor, type Member, type Share, type Receipt, type PendingInvite } from "./share-dialog-sections";

type Tab = "people" | "links" | "settings";
type Role = "viewer" | "editor" | "owner";

const ROLE_HELP: Record<Role, string> = {
  viewer: "Read & download files",
  editor: "Upload, edit & delete files",
  owner: "Manage members, links & sales",
};

function prettyPath(p: string) { return p ? `/${p}` : "Whole drive"; }

export function DriveManage({ driveId, driveName }: { driveId: string; driveName: string }) {
  const [tab, setTab] = useState<Tab>("people");
  const [members, setMembers] = useState<Member[]>([]);
  const [pending, setPending] = useState<PendingInvite[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [payoutWallet, setPayoutWallet] = useState("");
  const [allowedTokens, setAllowedTokens] = useState<string | null>(null);
  // Drive financial settings are creator-only (the GET 403s co-owners), so a
  // co-owner managing people/links still can't read/write payout + tokens.
  const [settingsReadable, setSettingsReadable] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [mem, sh, rc, d] = await Promise.all([
      apiFetch<{ members: Member[]; pending: PendingInvite[]; myRole: Role }>(`/api/drives/${driveId}/members`),
      apiFetch<{ shares: Share[] }>(`/api/drives/${driveId}/shares`),
      apiFetch<{ receipts: Receipt[] }>(`/api/drives/${driveId}/receipts`),
      apiFetch<{ payout_wallet: string | null; allowed_tokens: string | null }>(`/api/drives/${driveId}`),
    ]);
    if (mem.ok) { setMembers(mem.data.members); setPending(mem.data.pending ?? []); }
    if (sh.ok) setShares(sh.data.shares);
    if (rc.ok) setReceipts(rc.data.receipts ?? []);
    setSettingsReadable(d.ok);
    if (d.ok) { setPayoutWallet(d.data.payout_wallet ?? ""); setAllowedTokens(d.data.allowed_tokens ?? null); }
  }, [driveId]);
  useEffect(() => { load(); }, [load]);

  const tabs: { id: Tab; label: string; Icon: typeof Users }[] = [
    { id: "people", label: "People", Icon: Users },
    { id: "links", label: "Links & sales", Icon: LinkIcon },
    { id: "settings", label: "Settings", Icon: SettingsIcon },
  ];

  return (
    <main className="min-h-screen bg-drive-bg">
      <header className="border-b border-drive-border bg-white">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 py-4 flex items-center gap-3">
          <Link href={`/d/${driveId}`} aria-label="Back to drive" className="rounded p-1.5 hover:bg-drive-hover">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="min-w-0">
            <div className="text-caption text-drive-muted">Manage</div>
            <h1 className="text-title text-drive-text truncate">{driveName}</h1>
          </div>
        </div>
        <div className="mx-auto max-w-3xl px-4 sm:px-6 flex gap-1">
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-body border-b-2 -mb-px transition-colors ${
                tab === id ? "border-drive-accent text-drive-accent font-medium" : "border-transparent text-drive-muted hover:text-drive-text"
              }`}
            >
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 space-y-5">
        {tab === "people" && (
          <PeopleTab driveId={driveId} members={members} pending={pending} busy={busy} setBusy={setBusy} reload={load} />
        )}
        {tab === "links" && (
          <LinksTab driveId={driveId} shares={shares} receipts={receipts} busy={busy} setBusy={setBusy} reload={load} />
        )}
        {tab === "settings" && (
          settingsReadable
            ? <SettingsTab driveId={driveId} payoutWallet={payoutWallet} allowedTokens={allowedTokens} busy={busy} setBusy={setBusy} reload={load} />
            : <EmptyState icon={<SettingsIcon />} title="Creator-only settings" description="Payout wallet and payment tokens can only be changed by the drive’s creator." />
        )}
      </div>
    </main>
  );
}

// ── People ──────────────────────────────────────────────────────────────────

function PeopleTab({ driveId, members, pending, busy, setBusy, reload }: {
  driveId: string; members: Member[]; pending: PendingInvite[];
  busy: boolean; setBusy: (b: boolean) => void; reload: () => void;
}) {
  const [q, setQ] = useState("");
  // Group grants by person so the owner sees "who has access, and where".
  const people = useMemo(() => {
    const by = new Map<string, { email: string; name: string; grants: Member[] }>();
    for (const m of members) {
      const k = m.email.toLowerCase();
      if (!by.has(k)) by.set(k, { email: m.email, name: m.name, grants: [] });
      by.get(k)!.grants.push(m);
    }
    const list = [...by.values()];
    const needle = q.trim().toLowerCase();
    return needle ? list.filter((p) => p.email.toLowerCase().includes(needle) || (p.name ?? "").toLowerCase().includes(needle)) : list;
  }, [members, q]);

  async function changeRole(memberId: string, role: Role) {
    setBusy(true);
    const res = await apiFetch(`/api/drives/${driveId}/members/${memberId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role }),
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error || "Failed to change role"); return; }
    toast.success("Role updated"); reload();
  }
  async function removeGrant(memberId: string) {
    if (!confirm("Remove this access?")) return;
    setBusy(true);
    const res = await apiFetch(`/api/drives/${driveId}/members/${memberId}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) { toast.error(res.error || "Failed to remove"); return; }
    toast.success("Access removed"); reload();
  }
  async function cancelInvite(inviteId: string) {
    setBusy(true);
    const res = await apiFetch(`/api/drives/${driveId}/members/invites/${inviteId}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) { toast.error(res.error || "Failed to cancel"); return; }
    toast.success("Invite cancelled"); reload();
  }

  return (
    <>
      <InviteCard driveId={driveId} busy={busy} setBusy={setBusy} reload={reload} />

      {pending.length > 0 && (
        <SectionCard icon={<Clock className="w-4 h-4" />} title="Pending invites" description="They’ll get access automatically when they sign up with this email.">
          <ul className="space-y-1.5">
            {pending.map((p) => (
              <li key={p.id} className="flex items-center gap-2 rounded-lg bg-drive-sidebar px-2.5 py-1.5 text-body">
                <span className="truncate font-medium text-drive-text">{p.email}</span>
                <Badge tone="neutral" className="shrink-0">{p.role}</Badge>
                <span className="text-caption text-drive-muted truncate">{prettyPath(p.path)}</span>
                <IconButton size="sm" variant="text" aria-label="Cancel invite" className="ml-auto" disabled={busy} onClick={() => cancelInvite(p.id)}>
                  <Ban className="w-3.5 h-3.5" />
                </IconButton>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <SectionCard
        icon={<Users className="w-4 h-4" />}
        title="People with access"
        description={`${members.length} grant${members.length === 1 ? "" : "s"}`}
        action={
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-drive-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search"
              className="w-32 rounded-full border border-drive-border bg-white pl-7 pr-2 py-1 text-caption focus:outline-none focus:ring-2 focus:ring-drive-accent/40" />
          </div>
        }
      >
        {people.length === 0 ? (
          <EmptyState icon={<Users />} title={q ? "No matches" : "No members yet"} description={q ? "Try a different name or email." : "Invite someone above to get started."} />
        ) : (
          <ul className="space-y-3">
            {people.map((p) => (
              <li key={p.email} className="flex gap-3">
                <Avatar name={p.name || p.email} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-drive-text truncate">{p.name || p.email}</div>
                  {p.name && <div className="text-caption text-drive-muted truncate">{p.email}</div>}
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {p.grants.map((g) => (
                      <span key={g.id} className="inline-flex items-center gap-1 rounded-full border border-drive-border bg-drive-sidebar pl-2 pr-1 py-0.5 text-caption">
                        <Link href={`/d/${driveId}?path=${encodeURIComponent(g.path)}`} className="text-drive-muted hover:text-drive-accent hover:underline">
                          {prettyPath(g.path)}
                        </Link>
                        <select
                          value={g.role}
                          disabled={busy}
                          onChange={(e) => changeRole(g.id, e.target.value as Role)}
                          className="bg-transparent text-drive-text font-medium focus:outline-none"
                          aria-label={`Role at ${prettyPath(g.path)}`}
                        >
                          <option value="viewer">viewer</option>
                          <option value="editor">editor</option>
                          <option value="owner">owner</option>
                        </select>
                        <IconButton size="sm" variant="text" aria-label={`Remove access at ${prettyPath(g.path)}`} disabled={busy} onClick={() => removeGrant(g.id)}>
                          <TrashIcon className="w-3 h-3" />
                        </IconButton>
                      </span>
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </>
  );
}

function InviteCard({ driveId, busy, setBusy, reload }: { driveId: string; busy: boolean; setBusy: (b: boolean) => void; reload: () => void }) {
  const [email, setEmail] = useState("");
  const [path, setPath] = useState("");
  const [role, setRole] = useState<Role>("viewer");

  async function invite() {
    if (!email.trim()) { toast.error("Enter an email"); return; }
    setBusy(true);
    const res = await apiFetch<{ pending?: boolean }>(`/api/drives/${driveId}/members`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.trim(), path: path.trim(), role }),
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error || "Invite failed"); return; }
    toast.success(res.data?.pending ? "Invite sent — pending until they sign up" : "Member added");
    setEmail(""); reload();
  }

  return (
    <SectionCard icon={<UserPlus className="w-4 h-4" />} title="Invite people" description="Invite by email. No account yet? The invite waits for them to sign up.">
      <div className="flex flex-col sm:flex-row gap-2">
        <Input wrapClassName="flex-1" placeholder="name@email.com" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input wrapClassName="sm:w-40" placeholder="folder (blank = all)" value={path} onChange={(e) => setPath(e.target.value)} />
        <Select wrapClassName="sm:w-32" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
          <option value="owner">Owner</option>
        </Select>
        <Button variant="filled" disabled={busy} onClick={invite}>Invite</Button>
      </div>
      <p className="mt-2 text-caption text-drive-muted">
        <span className="font-medium text-drive-text">{role[0].toUpperCase() + role.slice(1)}:</span> {ROLE_HELP[role]}
        {!path.trim() && role !== "viewer" && " · applies to the whole drive"}
      </p>
    </SectionCard>
  );
}

// ── Links & sales ─────────────────────────────────────────────────────────────

function LinksTab({ driveId, shares, receipts, busy, setBusy, reload }: {
  driveId: string; shares: Share[]; receipts: Receipt[];
  busy: boolean; setBusy: (b: boolean) => void; reload: () => void;
}) {
  const totalEarned = receipts.reduce((s, r) => s + (r.amount_usdc ?? 0), 0);
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  async function revoke(shareId: string) {
    if (!confirm("Revoke this link? People who already accepted keep their access.")) return;
    setBusy(true);
    const res = await apiFetch(`/api/drives/${driveId}/shares/${shareId}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) { toast.error(res.error || "Failed to revoke"); return; }
    toast.success("Link revoked"); reload();
  }
  async function copy(token: string) {
    const ok = await navigator.clipboard.writeText(`${origin}/s/${token}`).then(() => true).catch(() => false);
    toast[ok ? "success" : "error"](ok ? "Link copied" : "Couldn’t copy");
  }

  return (
    <>
      <SectionCard icon={<LinkIcon className="w-4 h-4" />} title="Share links" description="Free and paid links into this drive.">
        {shares.length === 0 ? (
          <EmptyState icon={<LinkIcon />} title="No links yet" description="Create share links from a folder’s Share dialog." />
        ) : (
          <ul className="space-y-1.5">
            {shares.map((s) => (
              <li key={s.id} className="flex items-center gap-2 rounded-lg bg-drive-sidebar px-2.5 py-1.5 text-body">
                <span className="text-caption text-drive-muted truncate w-24 sm:w-32">{prettyPath(s.path)}</span>
                <Badge tone="neutral" className="shrink-0">{s.role}</Badge>
                {s.price_usdc != null
                  ? <Badge tone="sale" className="shrink-0">{s.price_usdc.toFixed(2)} {s.currency ?? "USDC"}</Badge>
                  : <span className="text-caption text-drive-muted">Free</span>}
                {!!s.listed && <Badge tone="warning" className="shrink-0">Listed</Badge>}
                <div className="ml-auto flex items-center gap-0.5">
                  <IconButton size="sm" variant="text" aria-label="Copy link" onClick={() => copy(s.token)}><Copy className="w-3.5 h-3.5" /></IconButton>
                  <IconButton size="sm" variant="text" aria-label="Revoke link" disabled={busy} onClick={() => revoke(s.id)}><Ban className="w-3.5 h-3.5" /></IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        icon={<ShieldCheck className="w-4 h-4" />}
        title="Earnings"
        description="Settled on-chain payments."
        action={<span className="text-body font-semibold text-green-600 tabular-nums">${totalEarned.toFixed(2)}</span>}
      >
        {receipts.length === 0 ? (
          <EmptyState icon={<ShieldCheck />} title="No sales yet" description="Paid shares appear here once a buyer settles." />
        ) : (
          <ul className="space-y-1.5 max-h-72 overflow-auto">
            {receipts.map((r) => (
              <li key={r.id} className="flex items-center gap-2 rounded-lg bg-drive-sidebar px-2.5 py-1.5 text-caption">
                <span className="font-mono text-drive-muted truncate w-28">{r.wallet.slice(0, 6)}…{r.wallet.slice(-4)}</span>
                <span className="text-drive-muted truncate">{prettyPath(r.path)}</span>
                <span className="ml-auto font-medium text-drive-text tabular-nums">${(r.amount_usdc ?? 0).toFixed(2)}</span>
                {!r.tx_hash.startsWith("0xdev_bypass") && (
                  <a href={`https://basescan.org/tx/${r.tx_hash}`} target="_blank" rel="noreferrer" className="text-drive-muted hover:text-drive-accent" aria-label="View transaction">
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────────

function SettingsTab({ driveId, payoutWallet, allowedTokens, busy, setBusy, reload }: {
  driveId: string; payoutWallet: string; allowedTokens: string | null;
  busy: boolean; setBusy: (b: boolean) => void; reload: () => void;
}) {
  const [wallet, setWallet] = useState(payoutWallet);
  useEffect(() => { setWallet(payoutWallet); }, [payoutWallet]);

  // Token policy state mirrors share-dialog: preset checkboxes ∪ custom tokens.
  const tokens = useMemo(() => resolveDriveTokens(allowedTokens), [allowedTokens]);
  const isFixedPreset = (t: PaymentToken) => {
    const p = TOKEN_PRESETS[t.symbol];
    return !!(p && p.asset && p.asset.toLowerCase() === t.asset.toLowerCase());
  };
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [customTokens, setCustomTokens] = useState<PaymentToken[]>([]);
  useEffect(() => {
    setSel(Object.fromEntries(
      Object.entries(TOKEN_PRESETS).filter(([, p]) => !!p.asset).map(([k]) => [k, tokens.some((t) => t.symbol === k && isFixedPreset(t))]),
    ));
    setCustomTokens(tokens.filter((t) => !isFixedPreset(t)));
  }, [tokens]);

  async function saveWallet() {
    const v = wallet.trim();
    if (v && !/^0x[a-fA-F0-9]{40}$/.test(v)) { toast.error("Must be 0x + 40 hex chars"); return; }
    setBusy(true);
    const res = await apiFetch<{ payout_wallet: string | null }>(`/api/drives/${driveId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ payout_wallet: v || null }),
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error || "Failed to save"); return; }
    toast.success(v ? "Payout wallet saved" : "Payout wallet cleared"); reload();
  }
  async function saveTokens() {
    const presetTokens = Object.entries(TOKEN_PRESETS).filter(([k, p]) => sel[k] && p.asset).map(([, p]) => p);
    const bySymbol = new Map<string, PaymentToken>();
    for (const t of [...presetTokens, ...customTokens]) bySymbol.set(t.symbol, t);
    const policy = [...bySymbol.values()];
    if (policy.length === 0) { toast.error("Select or add at least one token"); return; }
    setBusy(true);
    const res = await apiFetch(`/api/drives/${driveId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ allowed_tokens: JSON.stringify(policy) }),
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error || "Failed to save tokens"); return; }
    toast.success("Payment tokens saved"); reload();
  }

  return (
    <>
      <SectionCard icon={<SettingsIcon className="w-4 h-4" />} title="Payout wallet" description="Where buyers’ payments are sent. Required before selling.">
        <div className="flex gap-2">
          <Input wrapClassName="flex-1" className="font-mono" placeholder="0x…" value={wallet} onChange={(e) => setWallet(e.target.value)} />
          <Button variant="tonal" disabled={busy} onClick={saveWallet}>Save</Button>
        </div>
      </SectionCard>

      <SectionCard icon={<ShieldCheck className="w-4 h-4" />} title="Payment tokens" description="Which tokens buyers can pay with across this drive.">
        <PaymentTokensEditor
          busy={busy}
          editor={{
            sel,
            toggle: (symbol) => setSel((s) => ({ ...s, [symbol]: !s[symbol] })),
            customTokens,
            addCustom: (t) => setCustomTokens((c) => [...c, t]),
            removeCustom: (symbol) => setCustomTokens((c) => c.filter((t) => t.symbol !== symbol)),
            save: saveTokens,
          }}
        />
      </SectionCard>
    </>
  );
}
