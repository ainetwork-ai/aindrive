"use client";
// Full-page drive management (owner-only) — the audit/ledger surface for the
// whole drive: who has access where, all share links, sales & storefront, and
// payment settings. Creating a link or selling a file happens in CONTEXT (the
// Share panel on a file/folder), not here; each section points there.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowLeft, Users, Link2, Wallet, TrendingUp, Search, UserPlus, Clock,
  TrashIcon, ShieldCheck, ExternalLink, Copy, Ban, Store,
} from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Avatar, Badge, Button, IconButton, Input, Select, SectionCard, EmptyState } from "@/components/ui";
import { TOKEN_PRESETS, resolveDriveTokens, type PaymentToken } from "@/lib/payment-tokens";
import { type PayoutRow } from "@/lib/payout";
import { PaymentTokensEditor, type Member, type Share, type Receipt, type PendingInvite } from "./share-dialog-sections";

type Section = "members" | "links" | "sales" | "payments";
type Role = "viewer" | "editor" | "owner";

const ROLE_HELP: Record<Role, string> = {
  viewer: "Read & download files",
  editor: "Upload, edit & delete files",
  owner: "Manage members, links & sales",
};

function prettyPath(p: string) { return p ? `/${p}` : "Whole drive"; }

export function DriveManage({ driveId, driveName }: { driveId: string; driveName: string }) {
  const [section, setSection] = useState<Section>("members");
  const [members, setMembers] = useState<Member[]>([]);
  const [pending, setPending] = useState<PendingInvite[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [payoutWallets, setPayoutWallets] = useState<PayoutRow[]>([]);
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
      apiFetch<{ payout_wallets?: PayoutRow[]; allowed_tokens: string | null }>(`/api/drives/${driveId}`),
    ]);
    if (mem.ok) { setMembers(mem.data.members); setPending(mem.data.pending ?? []); }
    if (sh.ok) setShares(sh.data.shares);
    if (rc.ok) setReceipts(rc.data.receipts ?? []);
    setSettingsReadable(d.ok);
    if (d.ok) { setPayoutWallets(d.data.payout_wallets ?? []); setAllowedTokens(d.data.allowed_tokens ?? null); }
  }, [driveId]);
  useEffect(() => { load(); }, [load]);

  const nav: { id: Section; label: string; Icon: typeof Users; hint: string }[] = [
    { id: "members", label: "Members", Icon: Users, hint: "Who has access" },
    { id: "links", label: "Links", Icon: Link2, hint: "Share links" },
    { id: "sales", label: "Sales", Icon: TrendingUp, hint: "Earnings & storefront" },
    { id: "payments", label: "Payments", Icon: Wallet, hint: "Payout & tokens" },
  ];

  return (
    <main className="min-h-screen bg-drive-bg">
      <header className="border-b border-drive-border bg-white">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 py-4 flex items-center gap-3">
          <Link href={`/d/${driveId}`} aria-label="Back to drive" className="rounded p-1.5 hover:bg-drive-hover">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="min-w-0">
            <div className="text-caption text-drive-muted">Manage</div>
            <h1 className="text-title text-drive-text truncate">{driveName}</h1>
          </div>
        </div>
        {/* Mobile: horizontal section tabs (the left rail collapses away). */}
        <nav className="md:hidden mx-auto max-w-5xl px-4 flex gap-1 overflow-x-auto">
          {nav.map(({ id, label, Icon }) => (
            <button key={id} onClick={() => setSection(id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-body whitespace-nowrap border-b-2 -mb-px ${
                section === id ? "border-drive-accent text-drive-accent font-medium" : "border-transparent text-drive-muted"
              }`}>
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </nav>
      </header>

      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6 flex gap-6">
        {/* Desktop left rail. */}
        <nav className="hidden md:flex flex-col gap-0.5 w-48 shrink-0">
          {nav.map(({ id, label, Icon, hint }) => (
            <button key={id} onClick={() => setSection(id)}
              className={`flex items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ${
                section === id ? "bg-drive-selected/60 text-drive-accent" : "text-drive-text hover:bg-drive-hover"
              }`}>
              <Icon className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="block text-body font-medium leading-tight">{label}</span>
                <span className="block text-caption text-drive-muted">{hint}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1 space-y-5">
          {section === "members" && (
            <MembersSection driveId={driveId} members={members} pending={pending} busy={busy} setBusy={setBusy} reload={load} />
          )}
          {section === "links" && (
            <LinksSection driveId={driveId} shares={shares} busy={busy} setBusy={setBusy} reload={load} />
          )}
          {section === "sales" && (
            <SalesSection shares={shares} receipts={receipts} />
          )}
          {section === "payments" && (
            settingsReadable
              ? <PaymentsSection driveId={driveId} payoutWallets={payoutWallets} allowedTokens={allowedTokens} busy={busy} setBusy={setBusy} reload={load} />
              : <EmptyState icon={<Wallet />} title="Creator-only" description="Payout wallet and payment tokens can only be changed by the drive’s creator." />
          )}
        </div>
      </div>
    </main>
  );
}

// ── Members ──────────────────────────────────────────────────────────────────

function MembersSection({ driveId, members, pending, busy, setBusy, reload }: {
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
                        {g.isCreator ? (
                          // The creator can't be demoted or removed — show a
                          // fixed label instead of dead controls that only 400.
                          <span className="inline-flex items-center gap-1 font-medium text-drive-text">
                            owner
                            <Badge tone="neutral" className="ml-0.5">creator</Badge>
                          </span>
                        ) : (
                          <>
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
                          </>
                        )}
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

// ── Links (the doors) ─────────────────────────────────────────────────────────
// "What doors exist into this drive." Creation lives on the file/folder Share
// panel — this section audits & revokes. Filterable by kind.

type LinkFilter = "all" | "free" | "paid" | "listed";

function LinksSection({ driveId, shares, busy, setBusy, reload }: {
  driveId: string; shares: Share[]; busy: boolean; setBusy: (b: boolean) => void; reload: () => void;
}) {
  const [filter, setFilter] = useState<LinkFilter>("all");
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const shown = useMemo(() => shares.filter((s) =>
    filter === "all" ? true :
    filter === "free" ? s.price_usdc == null :
    filter === "paid" ? s.price_usdc != null :
    /* listed */ !!s.listed,
  ), [shares, filter]);

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

  const filters: { id: LinkFilter; label: string }[] = [
    { id: "all", label: "All" }, { id: "free", label: "Free" }, { id: "paid", label: "Paid" }, { id: "listed", label: "Listed" },
  ];

  return (
    <SectionCard
      icon={<Link2 className="w-4 h-4" />}
      title="Share links"
      description="Every link into this drive. Create new ones from a file or folder’s Share panel."
      action={
        <div className="flex gap-0.5 rounded-full border border-drive-border p-0.5">
          {filters.map((f) => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              className={`rounded-full px-2.5 py-0.5 text-caption ${filter === f.id ? "bg-drive-selected/70 text-drive-accent font-medium" : "text-drive-muted hover:text-drive-text"}`}>
              {f.label}
            </button>
          ))}
        </div>
      }
    >
      {shown.length === 0 ? (
        <EmptyState
          icon={<Link2 />}
          title={shares.length === 0 ? "No links yet" : "Nothing matches this filter"}
          description={shares.length === 0
            ? "Right-click a file or folder → Share to create a free or paid link."
            : "Try a different filter."}
        />
      ) : (
        <ul className="space-y-1.5">
          {shown.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-lg bg-drive-sidebar px-2.5 py-1.5 text-body">
              <Link href={`/d/${driveId}?path=${encodeURIComponent(s.path)}`} className="text-caption text-drive-muted hover:text-drive-accent hover:underline truncate w-24 sm:w-36">{prettyPath(s.path)}</Link>
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
  );
}

// ── Sales (the money) ─────────────────────────────────────────────────────────
// "What you're selling, and what you've earned." Distinct from Links: Links is
// the door inventory; Sales is the storefront + ledger.

function SalesSection({ shares, receipts }: { shares: Share[]; receipts: Receipt[] }) {
  const totalEarned = receipts.reduce((s, r) => s + (r.amount_usdc ?? 0), 0);
  const listed = useMemo(() => shares.filter((s) => s.price_usdc != null && !!s.listed), [shares]);

  return (
    <>
      <SectionCard
        icon={<Store className="w-4 h-4" />}
        title="On the storefront"
        description="Paid items you’ve listed for members to discover and buy."
      >
        {listed.length === 0 ? (
          <EmptyState icon={<Store />} title="Nothing listed" description="When you create a paid link, tick “List on storefront” to show it here." />
        ) : (
          <ul className="space-y-1.5">
            {listed.map((s) => (
              <li key={s.id} className="flex items-center gap-2 rounded-lg bg-drive-sidebar px-2.5 py-1.5 text-body">
                <span className="truncate font-medium text-drive-text">{prettyPath(s.path)}</span>
                <Badge tone="sale" className="ml-auto shrink-0">{s.price_usdc!.toFixed(2)} {s.currency ?? "USDC"}</Badge>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        icon={<TrendingUp className="w-4 h-4" />}
        title="Earnings"
        description="Settled on-chain payments."
        action={<span className="text-body font-semibold text-green-600 tabular-nums">${totalEarned.toFixed(2)}</span>}
      >
        {receipts.length === 0 ? (
          <EmptyState icon={<ShieldCheck />} title="No sales yet" description="Paid shares appear here once a buyer settles." />
        ) : (
          <ul className="space-y-1.5 max-h-80 overflow-auto">
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

// ── Payments ──────────────────────────────────────────────────────────────────

function PaymentsSection({ driveId, payoutWallets, allowedTokens, busy, setBusy, reload }: {
  driveId: string; payoutWallets: PayoutRow[]; allowedTokens: string | null;
  busy: boolean; setBusy: (b: boolean) => void; reload: () => void;
}) {
  // Token policy state mirrors share-dialog: preset checkboxes ∪ custom tokens.
  const tokens = useMemo(() => resolveDriveTokens(allowedTokens), [allowedTokens]);
  const isFixedPreset = (t: PaymentToken) => {
    const p = TOKEN_PRESETS[t.symbol];
    return !!(p && p.asset && p.asset.toLowerCase() === t.asset.toLowerCase());
  };
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [customTokens, setCustomTokens] = useState<PaymentToken[]>([]);
  useEffect(() => {
    const customs = tokens.filter((t) => !isFixedPreset(t));
    setSel({
      // Presets: on if present as a fixed preset in the saved policy.
      ...Object.fromEntries(
        Object.entries(TOKEN_PRESETS).filter(([, p]) => !!p.asset).map(([k]) => [k, tokens.some((t) => t.symbol === k && isFixedPreset(t))]),
      ),
      // Customs: anything in the saved policy is, by definition, accepted (on).
      ...Object.fromEntries(customs.map((t) => [t.symbol, true])),
    });
    setCustomTokens(customs);
  }, [tokens]);

  async function saveTokens() {
    // Saved policy = every token toggled ON (presets + customs). OFF customs
    // simply aren't persisted (matches "accepted = in the menu").
    const presetTokens = Object.entries(TOKEN_PRESETS).filter(([k, p]) => sel[k] && p.asset).map(([, p]) => p);
    const activeCustoms = customTokens.filter((t) => sel[t.symbol]);
    const bySymbol = new Map<string, PaymentToken>();
    for (const t of [...presetTokens, ...activeCustoms]) bySymbol.set(t.symbol, t);
    const policy = [...bySymbol.values()];
    if (policy.length === 0) { toast.error("Turn on at least one token"); return; }
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
      <SectionCard
        icon={<Wallet className="w-4 h-4" />}
        title="Payout wallets"
        description="Where buyers’ payments land. A folder inherits the nearest parent’s wallet (down to the drive default); add per-folder overrides from a folder’s Share panel."
      >
        <div className="space-y-3">
          {/* Drive default ("" path) is always editable here; per-folder rows are
              created in the Share drawer and audited/removed from this list. */}
          <PayoutWalletRow
            driveId={driveId} path="" label="Drive default"
            wallet={payoutWallets.find((w) => w.path === "")?.wallet ?? ""}
            busy={busy} setBusy={setBusy} reload={reload}
          />
          {payoutWallets
            .filter((w) => w.path !== "")
            .sort((a, b) => a.path.localeCompare(b.path))
            .map((w) => (
              <PayoutWalletRow
                key={w.path} driveId={driveId} path={w.path} label={`/${w.path}`}
                wallet={w.wallet} removable
                busy={busy} setBusy={setBusy} reload={reload}
              />
            ))}
        </div>
      </SectionCard>

      <SectionCard icon={<ShieldCheck className="w-4 h-4" />} title="Payment tokens" description="Which tokens buyers can pay with across this drive.">
        <PaymentTokensEditor
          busy={busy}
          editor={{
            sel,
            toggle: (symbol) => setSel((s) => ({ ...s, [symbol]: !s[symbol] })),
            customTokens,
            addCustom: (t) => { setCustomTokens((c) => [...c, t]); setSel((s) => ({ ...s, [t.symbol]: true })); },
            removeCustom: (symbol) => setCustomTokens((c) => c.filter((t) => t.symbol !== symbol)),
            save: saveTokens,
          }}
        />
      </SectionCard>
    </>
  );
}

// One row of the payout-wallets audit list. `path === ""` is the drive default
// (not removable — clear it to fall back to nothing); folder rows are removable.
// Both Save (PUT) and Remove (DELETE) hit the path-scoped /payout endpoint.
function PayoutWalletRow({ driveId, path, label, wallet, removable, busy, setBusy, reload }: {
  driveId: string; path: string; label: string; wallet: string;
  removable?: boolean; busy: boolean; setBusy: (b: boolean) => void; reload: () => void;
}) {
  const [v, setV] = useState(wallet);
  useEffect(() => { setV(wallet); }, [wallet]);

  async function save() {
    const t = v.trim();
    if (t && !/^0x[a-fA-F0-9]{40}$/.test(t)) { toast.error("Must be 0x + 40 hex chars"); return; }
    setBusy(true);
    const res = t
      ? await apiFetch(`/api/drives/${driveId}/payout`, {
          method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, wallet: t }),
        })
      : await apiFetch(`/api/drives/${driveId}/payout`, {
          method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }),
        });
    setBusy(false);
    if (!res.ok) { toast.error(res.error || "Failed to save"); return; }
    toast.success(t ? "Payout wallet saved" : "Payout wallet cleared"); reload();
  }

  async function remove() {
    setBusy(true);
    const res = await apiFetch(`/api/drives/${driveId}/payout`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }),
    });
    setBusy(false);
    if (!res.ok) { toast.error(res.error || "Failed to remove"); return; }
    toast.success("Folder override removed"); reload();
  }

  return (
    <div>
      <div className="text-caption text-drive-muted mb-1 font-mono truncate">{label}</div>
      <div className="flex gap-2">
        <Input wrapClassName="flex-1" className="font-mono" placeholder="0x…" value={v} onChange={(e) => setV(e.target.value)} />
        <Button variant="tonal" disabled={busy || v.trim() === wallet} onClick={save}>Save</Button>
        {removable && (
          <IconButton variant="text" aria-label="Remove folder override" disabled={busy} onClick={remove}>
            <TrashIcon className="w-4 h-4" />
          </IconButton>
        )}
      </div>
    </div>
  );
}
