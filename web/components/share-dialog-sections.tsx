"use client";
// Presentational sections for ShareDialog. State + actions stay in the shell
// (share-dialog.tsx); these are pure render functions that receive data and
// handlers as props. Extracting markup only — behavior is unchanged because
// state ownership is unchanged.
//
// Each section is a SectionCard: an icon-badged header (title + optional
// description) over the section body, so the dialog reads as a stack of
// labelled cards instead of one long form. Controls use the design-system
// primitives (Input/Select/Toggle/Button/Badge).
import {
  Copy, LinkIcon, UserPlus, Trash2, DollarSign, TrendingUp, ExternalLink, Users,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Plus, Trash2 as TrashIcon, Loader2, CheckCircle2, Clock } from "lucide-react";
import { Input, Select, Toggle, Button, Badge, IconButton, SectionCard } from "@/components/ui";
import { normalizePath, isAncestorOrSelf } from "@/lib/access-core.js";
import { TOKEN_PRESETS, isX402Settleable, paymentNetwork, type PaymentToken } from "@/lib/payment-tokens";

export type Share = {
  id: string;
  token: string;
  path: string;
  role: string;
  expires_at: string | null;
  price_usdc: number | null;
  currency: string | null; // token symbol within the drive policy; null = legacy USDC
  listed: number; // SQLite 0/1 — shown on the drive's showcase
};
export type Receipt = {
  id: string;
  path: string;
  wallet: string;
  tx_hash: string;
  amount_usdc: number | null;
  network: string;
  share_id: string | null;
  settled_at: string;
};

export type Member = {
  id: string;
  path: string;
  role: "viewer" | "editor" | "owner";
  email: string;
  name: string;
};

/** A pending (pre-account) invite — converts to a Member on signup. */
export type PendingInvite = {
  id: string;
  email: string;
  path: string;
  role: "viewer" | "editor" | "owner";
};

/** Compact list row used by Earnings / Members / Free-links. */
function ListRow({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-center gap-2 rounded-lg bg-drive-sidebar px-2.5 py-1.5 text-caption">
      {children}
    </li>
  );
}

export function EarningsSection({ receipts, totalEarned }: { receipts: Receipt[]; totalEarned: number }) {
  return (
    <SectionCard
      icon={<TrendingUp className="w-4 h-4" />}
      title="Earnings"
      description="Settled payments into this drive"
      action={<span className="text-subtitle font-semibold text-emerald-600 tabular-nums">${totalEarned.toFixed(2)}</span>}
    >
      <ul className="space-y-1.5 max-h-40 overflow-auto scrollbar-thin">
        {receipts.map((r) => (
          <ListRow key={r.id}>
            <span className="font-mono w-20 shrink-0 truncate">
              {r.wallet.slice(0, 6)}…{r.wallet.slice(-4)}
            </span>
            <span className="text-drive-muted truncate flex-1">{r.path || "/"}</span>
            <span className="shrink-0 tabular-nums">
              {r.amount_usdc != null ? `$${r.amount_usdc.toFixed(2)}` : "—"}
            </span>
            {r.tx_hash.startsWith("0x") && !r.tx_hash.startsWith("0xdev_bypass") ? (
              <a
                href={`https://${r.network === "base" ? "" : "sepolia."}basescan.org/tx/${r.tx_hash}`}
                target="_blank"
                rel="noreferrer"
                className="p-0.5 rounded hover:bg-drive-hover shrink-0"
                title="View transaction"
              >
                <ExternalLink className="w-3 h-3" />
              </a>
            ) : (
              <span className="w-4 shrink-0" />
            )}
          </ListRow>
        ))}
      </ul>
    </SectionCard>
  );
}

// Token-policy mini-editor state + handlers, grouped to keep SellSection's
// prop list readable. `sel` is keyed by fixed-preset symbol; custom tokens are
// added by contract-address lookup.
export type TokenEditorProps = {
  sel: Record<string, boolean>;
  toggle: (symbol: string) => void;
  customTokens: PaymentToken[];
  addCustom: (t: PaymentToken) => void;
  removeCustom: (symbol: string) => void;
  save: () => void;
};

export function SellSection({
  defaultPath, focusSection, sellOn, paidShare,
  payoutOwnWallet, payoutEffective, payoutInherited, payoutInput,
  setPayoutInput, savePayoutWallet, price, setPrice, currency, setCurrency,
  currencyOptions, listed, setListed, isOwner, tokenEditor, saveSell, busy,
  setEditingSell, copyLink,
}: {
  defaultPath: string;
  focusSection?: "sell" | "share";
  sellOn: boolean;
  paidShare: Share | undefined;
  // Payout wallet is path-scoped (see lib/payout.ts). `payoutOwnWallet` is the
  // wallet set on THIS folder ("" if none — what the input edits); `payoutEffective`
  // is the resolved wallet including inheritance; `payoutInherited` is true when
  // the effective wallet comes from a parent folder rather than this one.
  payoutOwnWallet: string;
  payoutEffective: string | null;
  payoutInherited: boolean;
  payoutInput: string;
  setPayoutInput: (v: string) => void;
  savePayoutWallet: () => void;
  price: string;
  setPrice: (v: string) => void;
  currency: string;
  setCurrency: (v: string) => void;
  currencyOptions: string[];
  listed: boolean;
  setListed: (v: boolean) => void;
  isOwner: boolean;
  tokenEditor: TokenEditorProps;
  saveSell: () => void;
  busy: boolean;
  setEditingSell: (v: boolean) => void;
  copyLink: (token: string) => void;
}) {
  const itemWord = defaultPath ? "item" : "drive";
  return (
    <SectionCard
      icon={<DollarSign className="w-4 h-4" />}
      title={`Sell this ${itemWord}`}
      description="One payment grants a buyer permanent access"
      highlight={focusSection === "sell"}
      action={<Toggle on={sellOn} disabled={!!paidShare} onChange={setEditingSell} aria-label={`Sell this ${itemWord}`} />}
    >
      {!sellOn ? null : (
        <div className="space-y-3">
          {/* Active state: existing paid share (read-only). */}
          {paidShare && (
            <div className="rounded-lg border border-drive-border bg-drive-sidebar/50 p-3 space-y-2">
              <Row label="Price" value={priceLabel(paidShare.price_usdc, paidShare.currency)} />
              <div className="flex items-center gap-2">
                <span className="text-caption text-drive-muted w-16 shrink-0">Link</span>
                <code className="flex-1 text-caption truncate font-mono text-drive-text">/s/{paidShare.token}</code>
                <IconButton size="sm" variant="text" aria-label="Copy link" onClick={() => copyLink(paidShare.token)}>
                  <Copy className="w-3.5 h-3.5" />
                </IconButton>
              </div>
              <p className="text-caption text-drive-muted">
                Buyers pay once for permanent access. Send them this link.
              </p>
            </div>
          )}

          {/* Payout wallet — where x402 payments for THIS folder land. Scoped to
              defaultPath; if left empty it inherits the nearest parent folder's
              wallet (down to the drive root). No operator fallback exists. */}
          <div>
            <div className="flex gap-2 items-end">
              <Input
                wrapClassName="flex-1"
                label={defaultPath ? "Payout wallet for this folder" : "Payout wallet (drive default)"}
                value={payoutInput}
                onChange={(e) => setPayoutInput(e.target.value.trim())}
                placeholder={payoutInherited && payoutEffective ? `${payoutEffective} (inherited)` : "0x… (where you receive funds)"}
                className="font-mono"
              />
              <Button
                variant="tonal"
                disabled={busy || payoutInput.trim() === payoutOwnWallet}
                onClick={savePayoutWallet}
              >
                Save
              </Button>
            </div>
            {!payoutEffective ? (
              <p className="mt-1.5 text-caption text-amber-700">
                Set a payout wallet for this folder (or a parent) before selling — there is no operator fallback.
              </p>
            ) : payoutInherited ? (
              <p className="mt-1.5 text-caption text-drive-muted">
                Inherited from a parent folder: <code className="font-mono">{payoutEffective}</code>. Set one here to override for this folder.
              </p>
            ) : null}
          </div>

          {/* Editing state: no paid share yet — price + currency + list option. */}
          {!paidShare && (
            <div className="rounded-lg border border-drive-border p-3 space-y-3">
              <div className="flex gap-2 items-start">
                <Input
                  wrapClassName="flex-1"
                  label="Price"
                  type="number"
                  step="0.01"
                  min="0.01"
                  max="9999.99"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.50"
                  helper="Buyers pay once for permanent access."
                  autoFocus
                />
                <Select
                  wrapClassName="w-28"
                  label="Currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                >
                  {currencyOptions.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </Select>
              </div>
              {/* [rev2-D] Listing is owner-only (API 403s listed:true otherwise) */}
              {isOwner && (
                <label className="flex items-start gap-2.5 rounded-lg bg-drive-sidebar/60 p-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={listed}
                    onChange={(e) => setListed(e.target.checked)}
                    className="mt-0.5 accent-drive-accent"
                  />
                  <span className="text-caption text-drive-text">
                    List on the drive
                    <span className="block text-drive-muted">Members without access see it for sale.</span>
                  </span>
                </label>
              )}
              <Button
                variant="filled"
                className="w-full justify-center"
                disabled={busy || !price}
                loading={busy}
                onClick={saveSell}
              >
                Save as paid
              </Button>
            </div>
          )}

          {/* Drive-wide payment-token policy (spec D3): which currencies shares
              may be priced in. Owner-only, like the PATCH behind it. */}
          {isOwner && <PaymentTokensEditor editor={tokenEditor} busy={busy} />}
        </div>
      )}
    </SectionCard>
  );
}

/** Badge: how this token settles x402 payments on-chain. Every token with a
 *  known address settles now — eip3009 directly, permit2 after the buyer's
 *  one-time approval. The warning state survives only for malformed rows
 *  (e.g. an explicit eip3009 token missing its EIP-712 domain). */
function SettleBadge({ token }: { token: Pick<PaymentToken, "name" | "version" | "asset" | "transferMethod"> }) {
  if (!isX402Settleable(token)) {
    return <Badge tone="warning" icon={<Clock className="w-3 h-3" />}>Needs setup</Badge>;
  }
  return token.transferMethod === "permit2" ? (
    <Badge tone="sale" icon={<CheckCircle2 className="w-3 h-3" />}>Settles now · one-time approval</Badge>
  ) : (
    <Badge tone="sale" icon={<CheckCircle2 className="w-3 h-3" />}>Settles now</Badge>
  );
}

/** One row in the token policy: a uniform on/off Toggle ("accepted as a pricing
 *  option"), the token identity, and a quiet settle-type line. Custom tokens
 *  additionally show their address + a delete button — kept OFF the on/off axis
 *  so "accepted?" and "remove identity" never look like the same control. */
function TokenPolicyRow({
  token, on, onToggle, onRemove, busy,
}: {
  token: PaymentToken;
  on: boolean;
  onToggle: () => void;
  onRemove?: () => void;
  busy: boolean;
}) {
  const settleLabel = token.transferMethod === "permit2"
    ? "Instant settle · one-time approval"
    : "Instant settle";
  return (
    <div className={`flex items-center gap-3 py-2 ${on ? "" : "opacity-55"}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-drive-text">{token.symbol}</span>
          {!on && <span className="text-caption text-drive-muted">off</span>}
        </div>
        <div className="text-caption text-drive-muted truncate">
          {token.chain}
          {onRemove
            ? <> · <span title={token.asset}>{token.asset.slice(0, 6)}…{token.asset.slice(-4)}</span> · custom</>
            : <> · built-in</>}
        </div>
        <div className="text-caption text-drive-muted">⚡ {settleLabel}</div>
      </div>
      {onRemove && (
        <IconButton size="sm" variant="text" aria-label={`Remove ${token.symbol}`} disabled={busy} onClick={onRemove}>
          <TrashIcon className="w-3.5 h-3.5" />
        </IconButton>
      )}
      <Toggle on={on} onChange={onToggle} disabled={busy} aria-label={`Accept ${token.symbol}`} />
    </div>
  );
}

export function PaymentTokensEditor({ editor, busy }: { editor: TokenEditorProps; busy: boolean }) {
  // Presets with a built-in address are always listable (toggle to accept).
  const presets = Object.entries(TOKEN_PRESETS).filter(([, p]) => !!p.asset).map(([, p]) => p);
  const presetSymbols = presets.map((p) => p.symbol);
  const activeCount =
    presets.filter((p) => editor.sel[p.symbol]).length +
    editor.customTokens.filter((t) => editor.sel[t.symbol]).length;

  return (
    <div className="space-y-3">
      {/* The de-confusing frame: this is a MENU of pricing options, not
          simultaneous charging. A buyer pays ONE token per sale. */}
      <p className="text-caption text-drive-muted">
        Pick the currencies you can price sales in. You set one currency on each sale —
        buyers pay only that one. Turning on more here just gives you more options at pricing time.
      </p>

      <div className="rounded-lg border border-drive-border divide-y divide-drive-border px-3">
        {presets.map((p) => (
          <TokenPolicyRow key={p.symbol} token={p} on={!!editor.sel[p.symbol]} onToggle={() => editor.toggle(p.symbol)} busy={busy} />
        ))}
        {editor.customTokens.map((t) => (
          <TokenPolicyRow
            key={t.symbol}
            token={t}
            on={!!editor.sel[t.symbol]}
            onToggle={() => editor.toggle(t.symbol)}
            onRemove={() => editor.removeCustom(t.symbol)}
            busy={busy}
          />
        ))}
      </div>

      <AddCustomToken
        existingSymbols={[...presetSymbols, ...editor.customTokens.map((t) => t.symbol)]}
        onAdd={editor.addCustom}
      />

      <div className="flex items-center justify-between border-t border-drive-border pt-3">
        <span className="text-caption text-drive-muted">
          {activeCount === 0
            ? "No currencies accepted — turn on at least one to sell."
            : `${activeCount} ${activeCount === 1 ? "currency" : "currencies"} accepted · you choose one per sale`}
        </span>
        <Button variant="tonal" size="sm" disabled={busy || activeCount === 0} onClick={editor.save}>Save</Button>
      </div>
    </div>
  );
}

// The lookup returns raw chain facts; the transferMethod is decided here at
// save time (the owner may supply the missing EIP-712 version).
type LookupResult = {
  ok: true;
  token: Omit<PaymentToken, "transferMethod">;
  eip3009: boolean;
  needsVersion: boolean;
};

/** Add a custom token by contract address: look it up on-chain, show the
 *  resolved metadata + settle badge, let the owner add it to the policy. */
function AddCustomToken({ existingSymbols, onAdd }: { existingSymbols: string[]; onAdd: (t: PaymentToken) => void }) {
  const [open, setOpen] = useState(false);
  // Default to the active payment network's chain so a testnet deployment
  // doesn't nudge owners into adding mainnet tokens (and vice versa).
  const [chain, setChain] = useState<"base" | "base-sepolia">(
    paymentNetwork() === "mainnet" ? "base" : "base-sepolia",
  );
  const [address, setAddress] = useState("");
  const [looking, setLooking] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [version, setVersion] = useState(""); // owner-supplied when the token doesn't publish version()
  const [error, setError] = useState<string | null>(null);

  async function lookup() {
    setError(null); setResult(null); setLooking(true);
    try {
      const r = await fetch("/api/token-lookup", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chain, address: address.trim() }),
      });
      const body = await r.json();
      if (!r.ok || !body.ok) { setError(body.error || "lookup failed"); return; }
      setResult(body as LookupResult);
      setVersion((body as LookupResult).token.version ?? "");
    } catch (e) {
      setError((e as Error).message || "lookup failed");
    } finally {
      setLooking(false);
    }
  }

  // Method decision: prefer eip3009 (no buyer approval step) when the
  // entrypoint AND the full EIP-712 domain (version resolved or supplied)
  // exist; everything else takes the universal permit2 path.
  const effectiveVersion = result ? (result.token.version ?? (version.trim() || null)) : null;
  const effectiveMethod: PaymentToken["transferMethod"] =
    result && result.eip3009 && result.token.name && effectiveVersion ? "eip3009" : "permit2";

  function add() {
    if (!result) return;
    const t: PaymentToken = { ...result.token, version: effectiveVersion, transferMethod: effectiveMethod };
    if (existingSymbols.includes(t.symbol)) { setError(`${t.symbol} is already in the policy`); return; }
    onAdd(t);
    setOpen(false); setAddress(""); setResult(null); setVersion(""); setError(null);
  }

  if (!open) {
    return (
      <Button variant="text" size="sm" icon={<Plus className="w-4 h-4" />} onClick={() => setOpen(true)}>
        Add custom token
      </Button>
    );
  }
  return (
    <div className="rounded-lg border border-drive-border bg-drive-sidebar/40 p-3 space-y-2.5">
      <div className="flex gap-2 items-end">
        {/* Mainnet deployment accepts ONLY mainnet-chain tokens (server
            rejects the rest) — no choice to render. Testnet keeps both so dev
            can exercise real mainnet tokens against a local build. */}
        <Select
          wrapClassName="w-32" label="Chain" value={chain}
          disabled={paymentNetwork() === "mainnet"}
          onChange={(e) => { setChain(e.target.value as "base" | "base-sepolia"); setResult(null); }}
        >
          <option value="base">base</option>
          {paymentNetwork() !== "mainnet" && <option value="base-sepolia">base-sepolia</option>}
        </Select>
        <Input wrapClassName="flex-1" label="Contract address" className="font-mono" placeholder="0x…" value={address}
          onChange={(e) => { setAddress(e.target.value.trim()); setResult(null); }} />
        <Button variant="tonal" loading={looking} disabled={looking || !/^0x[a-fA-F0-9]{40}$/.test(address.trim())} onClick={lookup}>
          {looking ? "" : "Look up"}
        </Button>
      </div>

      {error && <p className="text-caption text-red-600">{error}</p>}

      {result && (
        <div className="rounded-md border border-drive-border bg-drive-panel p-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <span className="font-medium text-drive-text">{result.token.symbol}</span>
            <span className="text-caption text-drive-muted">{result.token.name} · {result.token.decimals} decimals</span>
            <span className="ml-auto"><SettleBadge token={{ ...result.token, version: effectiveVersion, transferMethod: effectiveMethod }} /></span>
          </div>
          {result.eip3009 && result.needsVersion && (
            <Input label="EIP-712 version" placeholder="e.g. 2 (from the token's docs)" value={version}
              onChange={(e) => setVersion(e.target.value.trim())}
              helper="This token didn't publish version() on-chain. Enter the EIP-712 domain version to settle via EIP-3009 (no approval step for buyers); leave blank to settle via Permit2 instead." />
          )}
          {!result.eip3009 && (
            <p className="text-caption text-drive-muted">No EIP-3009 entrypoint — settles through Permit2: buyers approve the token once on-chain, then pay as usual.</p>
          )}
          <div className="flex justify-end">
            <Button variant="filled" size="sm" icon={<Plus className="w-4 h-4" />} onClick={add}>Add to policy</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Pretty path for a grant: "" → "drive root", else "/artists/alice". */
function prettyPath(p: string): string {
  return p ? `/${p}` : "drive root";
}

export function MembersSection({
  members, isOwner, currentUserEmail, currentPath, changeMemberRole, removeMember, busy,
}: {
  members: Member[];
  isOwner: boolean;
  currentUserEmail: string;
  /** Folder the dialog is scoped to — members are shown relative to THIS path. */
  currentPath: string;
  changeMemberRole: (id: string, role: "viewer" | "editor" | "owner") => void;
  removeMember: (id: string) => void;
  busy: boolean;
}) {
  // Scope the list to who can actually see THIS folder, split into:
  //  - direct:   granted at exactly this path → editable here.
  //  - inherited: granted at an ancestor (covers this folder) → read-only;
  //    removing them here would change their broader access, so it's managed at
  //    the ancestor. Members of *other* subfolders are hidden entirely — they
  //    have no access to this folder, and showing them was the source of the
  //    "everyone appears in every folder" confusion.
  const cur = normalizePath(currentPath);
  const direct: Member[] = [];
  const inherited: Member[] = [];
  for (const m of members) {
    const p = normalizePath(m.path);
    if (p === cur) direct.push(m);
    else if (isAncestorOrSelf(p, cur)) inherited.push(m);
  }
  if (direct.length === 0 && inherited.length === 0) return null;

  const total = direct.length + inherited.length;
  return (
    <SectionCard
      icon={<Users className="w-4 h-4" />}
      title="Members"
      description={`${total} ${total === 1 ? "person" : "people"} can access ${prettyPath(cur)}`}
    >
      {direct.length > 0 && (
        <ul className="space-y-1.5 max-h-44 overflow-auto scrollbar-thin">
          {direct.map((m) => (
            <ListRow key={m.id}>
              <span className="truncate flex-1 text-body text-drive-text">{m.name || m.email}</span>
              {isOwner ? (
                <Select
                  value={m.role}
                  disabled={busy}
                  wrapClassName="w-24"
                  className="h-8"
                  aria-label={`Role for ${m.email}`}
                  onChange={(e) => changeMemberRole(m.id, e.target.value as "viewer" | "editor" | "owner")}
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="owner">Owner</option>
                </Select>
              ) : (
                <Badge tone="neutral">{m.role}</Badge>
              )}
              {isOwner && m.email !== currentUserEmail && (
                <IconButton
                  size="sm"
                  variant="text"
                  aria-label={`Remove ${m.email}`}
                  disabled={busy}
                  onClick={() => removeMember(m.id)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </IconButton>
              )}
            </ListRow>
          ))}
        </ul>
      )}

      {inherited.length > 0 && (
        <div className={direct.length > 0 ? "mt-3" : ""}>
          <div className="text-label uppercase text-drive-muted mb-1.5">Inherited access</div>
          <ul className="space-y-1.5 max-h-32 overflow-auto scrollbar-thin">
            {inherited.map((m) => (
              <ListRow key={m.id}>
                <span className="truncate flex-1 text-body text-drive-text">{m.name || m.email}</span>
                <span className="text-caption text-drive-muted truncate shrink-0" title={`Granted at ${prettyPath(normalizePath(m.path))} — manage it there`}>
                  from {prettyPath(normalizePath(m.path))}
                </span>
                <Badge tone="neutral">{m.role}</Badge>
              </ListRow>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

export function EmailInviteSection({
  email, setEmail, role, setRole, invite, busy, currentPath,
}: {
  email: string;
  setEmail: (v: string) => void;
  role: "viewer" | "editor";
  setRole: (v: "viewer" | "editor") => void;
  invite: () => void;
  busy: boolean;
  /** Path the grant lands on — invites are scoped here. */
  currentPath: string;
}) {
  const cur = normalizePath(currentPath);
  const isRoot = cur === "";
  return (
    <SectionCard
      icon={<UserPlus className="w-4 h-4" />}
      title="Invite by email"
      description={<>Grants access to <span className="font-medium text-drive-text">{prettyPath(cur)}</span>{!isRoot && " only"}</>}
    >
      <div className="flex gap-2 items-end">
        <Input
          wrapClassName="flex-1"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="colleague@example.com"
        />
        <Select
          wrapClassName="w-28"
          value={role}
          onChange={(e) => setRole(e.target.value as "viewer" | "editor")}
          aria-label="Invite role"
        >
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
        </Select>
        <Button variant="filled" disabled={busy || !email} loading={busy} onClick={invite}>
          Invite
        </Button>
      </div>
      {isRoot && (
        <p className="mt-2 text-caption text-amber-700">
          This is the drive root — the collaborator will see every folder. Open a subfolder’s Share to scope access to just that folder.
        </p>
      )}
    </SectionCard>
  );
}

export function FreeLinkSection({
  shares, createFreeLink, busy, copyLink,
}: {
  shares: Share[];
  createFreeLink: () => void;
  busy: boolean;
  copyLink: (token: string) => void;
}) {
  const freeShares = shares.filter((s) => !s.price_usdc);
  return (
    <SectionCard
      icon={<LinkIcon className="w-4 h-4" />}
      title="Free share link"
      description="Anyone with the link gets access — no payment"
    >
      <Button variant="outline" className="w-full justify-center" disabled={busy} loading={busy} onClick={createFreeLink}>
        Create free share link
      </Button>
      {freeShares.length > 0 && (
        <ul className="mt-3 space-y-1.5 max-h-40 overflow-auto scrollbar-thin">
          {freeShares.map((s) => (
            <ListRow key={s.id}>
              <span className="truncate flex-1 text-drive-text">{s.path || "/"}</span>
              <Badge tone="neutral">{s.role}</Badge>
              <IconButton size="sm" variant="text" aria-label="Copy link" onClick={() => copyLink(s.token)}>
                <Copy className="w-3.5 h-3.5" />
              </IconButton>
            </ListRow>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// "$5.00 USDC" / "5.00 FANCO" — $ prefix only for the dollar-pegged default.
// null currency = legacy pre-policy share (USDC).
function priceLabel(price: number | null, currency: string | null): string {
  const sym = currency ?? "USDC";
  return `${sym === "USDC" ? "$" : ""}${price?.toFixed(2)} ${sym}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-caption text-drive-muted w-16 shrink-0">{label}</span>
      <span className="text-body font-medium text-drive-text">{value}</span>
    </div>
  );
}
