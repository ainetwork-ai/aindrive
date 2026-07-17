"use client";
// Presentational sections for ShareDialog. State + actions stay in the shell
// (share-dialog.tsx); these are pure render functions that receive data and
// handlers as props.
//
// The drawer reads as ONE flat sheet: DrawerSection blocks separated by the
// shell's divide-y, list rows flush to the panel. Card chrome (SectionCard)
// belongs to wide audit surfaces like drive-manage — in a ~448px drawer,
// nested boxes read as noise.
import { Copy, Trash2, Plus, CheckCircle2, Clock } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Input, Select, Toggle, Button, Badge, IconButton, Avatar } from "@/components/ui";
import { walletDisplayLabel } from "@/shared/wallet-display";
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
  amount_usdc: number | null; // in `currency` units, not USD
  currency: string | null; // token symbol; null = legacy USDC
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
  // True when this grant belongs to the drive creator — the undeletable anchor
  // row (API blocks demoting/removing it). The UI locks its role dropdown +
  // remove button instead of offering controls that only 400.
  isCreator: boolean;
};

/** A pending (pre-account) invite — converts to a Member on signup. */
export type PendingInvite = {
  id: string;
  email: string;
  path: string;
  role: "viewer" | "editor" | "owner";
};

/** One flat section of the Share drawer: title row (+ optional right-aligned
 *  action) over the body. The shell separates sections with divide-y. */
function DrawerSection({
  title, description, action, children, sectionRef,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  /** For scroll-into-view deep links (e.g. row menu "Sell…"). */
  sectionRef?: Ref<HTMLElement>;
}) {
  return (
    <section ref={sectionRef} className="py-4 first:pt-1 last:pb-1">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-subtitle text-drive-text leading-tight">{title}</h3>
          {description && <p className="mt-0.5 text-caption text-drive-muted">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}

/** Borderless inline role select (same pattern as drive-manage's roster) — a
 *  bordered Select on every row reads as chrome in a flat list. */
function InlineRoleSelect({
  value, disabled, ariaLabel, onChange,
}: {
  value: "viewer" | "editor" | "owner";
  disabled: boolean;
  ariaLabel: string;
  onChange: (role: "viewer" | "editor" | "owner") => void;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value as "viewer" | "editor" | "owner")}
      className="shrink-0 rounded bg-transparent text-body text-drive-text focus:outline-none disabled:opacity-50"
    >
      <option value="viewer">Viewer</option>
      <option value="editor">Editor</option>
      <option value="owner">Owner</option>
    </select>
  );
}

// Token-policy mini-editor state + handlers, grouped to keep the editor's prop
// list readable. `sel` is keyed by fixed-preset symbol; custom tokens are
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
  currencyOptions, listed, setListed, isOwner, driveId, saveSell, saveShareEdit, busy,
  setEditingSell, copyLink,
}: {
  defaultPath: string;
  driveId: string;
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
  saveSell: () => void;
  saveShareEdit: () => void;
  busy: boolean;
  setEditingSell: (v: boolean) => void;
  copyLink: (token: string) => void;
}) {
  const itemWord = defaultPath ? "item" : "drive";
  // "Sell…" in the row menu deep-links here; the section sits last in the
  // drawer, so bring it into view (the form is already open via editingSell).
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusSection === "sell") ref.current?.scrollIntoView({ block: "nearest" });
  }, [focusSection]);

  return (
    <DrawerSection
      sectionRef={ref}
      title={`Sell this ${itemWord}`}
      description="One payment grants a buyer permanent access"
      action={<Toggle on={sellOn} disabled={!!paidShare} onChange={setEditingSell} aria-label={`Sell this ${itemWord}`} />}
    >
      {!sellOn ? null : (
        <div className="space-y-3">
          {/* Active state: the live share link to copy. The sale terms below are
              editable — saving PATCHes THIS share, so the link is preserved and
              prior buyers keep access; only NEW buyers see the changed terms. */}
          {paidShare && (
            <div>
              <div className="flex items-center gap-2 rounded-lg bg-drive-sidebar/60 px-3 py-2">
                <code className="flex-1 truncate font-mono text-caption text-drive-text">/s/{paidShare.token}</code>
                <IconButton size="sm" variant="text" aria-label="Copy link" onClick={() => copyLink(paidShare.token)}>
                  <Copy className="w-3.5 h-3.5" />
                </IconButton>
              </div>
              <p className="mt-1.5 text-caption text-drive-muted">
                Changing the price or currency affects new buyers only — people
                who already bought keep access.
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

          {/* Editable sale terms — create (no paid share yet) or edit (existing).
              The Save button PATCHes when editing, POSTs a new link otherwise. */}
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
              autoFocus={!paidShare}
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
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={listed}
                onChange={(e) => setListed(e.target.checked)}
                className="mt-0.5 accent-drive-accent"
              />
              <span className="text-caption text-drive-text">
                List on storefront
                <span className="block text-drive-muted">Members without access see it for sale.</span>
              </span>
            </label>
          )}
          {/* Per-sale currency is picked from the drive's accepted set above;
              EDITING that set lives in Settings → Payments ("create in context,
              audit in settings"). */}
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-caption text-drive-muted" title={currencyOptions.join(", ")}>
              Accepted here: {currencyOptions.join(" · ")}
              {isOwner && (
                <>
                  {" · "}
                  <a href={`/d/${driveId}/manage`} className="text-drive-accent hover:underline">Settings</a>
                </>
              )}
            </p>
            <Button
              variant="filled"
              disabled={busy || !price}
              loading={busy}
              onClick={paidShare ? saveShareEdit : saveSell}
            >
              {paidShare ? "Save changes" : "Save as paid"}
            </Button>
          </div>
        </div>
      )}
    </DrawerSection>
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
          <Trash2 className="w-3.5 h-3.5" />
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
            <Button variant="filled" size="sm" icon={<Plus className="w-4 h-4" />} onClick={add}>Add &amp; accept</Button>
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

/** Invite + who-can-access for THIS path as one flat "People" section — the
 *  invite row creates, the list right below shows the result, so the two read
 *  as a single concept instead of two stacked cards. */
export function PeopleSection({
  members, isOwner, currentUserEmail, currentPath, changeMemberRole, removeMember,
  email, setEmail, inviteRole, setInviteRole, invite, busy,
}: {
  members: Member[];
  isOwner: boolean;
  currentUserEmail: string;
  /** Folder the drawer is scoped to — members + invites are relative to THIS path. */
  currentPath: string;
  changeMemberRole: (id: string, role: "viewer" | "editor" | "owner") => void;
  removeMember: (id: string) => void;
  email: string;
  setEmail: (v: string) => void;
  inviteRole: "viewer" | "editor";
  setInviteRole: (v: "viewer" | "editor") => void;
  invite: () => void;
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
  const total = direct.length + inherited.length;
  // Non-owners can't invite (POST /members 403s); with nobody to list either,
  // there is nothing to render.
  if (!isOwner && total === 0) return null;
  const isRoot = cur === "";

  function memberRow(m: Member, opts: { editable: boolean }) {
    const label = walletDisplayLabel(m.email, m.name);
    return (
      <li key={m.id} className="flex items-center gap-2.5 py-1.5">
        <Avatar name={label} size="sm" />
        <span className="min-w-0 flex-1 truncate text-body text-drive-text">
          {label}
          {m.email === currentUserEmail && <span className="text-drive-muted"> (you)</span>}
        </span>
        {!opts.editable ? (
          <>
            <span
              className="max-w-32 shrink-0 truncate text-caption text-drive-muted"
              title={`Granted at ${prettyPath(normalizePath(m.path))} — manage it there`}
            >
              from {prettyPath(normalizePath(m.path))}
            </span>
            <Badge tone="neutral">{m.role}</Badge>
          </>
        ) : m.isCreator ? (
          // The creator's grant can't be demoted/removed (API 400s) — show a
          // fixed label instead of dead controls.
          <span className="flex shrink-0 items-center gap-1.5 text-body text-drive-text">
            owner <Badge tone="neutral">creator</Badge>
          </span>
        ) : isOwner ? (
          <>
            <InlineRoleSelect
              value={m.role}
              disabled={busy}
              ariaLabel={`Role for ${label}`}
              onChange={(r) => changeMemberRole(m.id, r)}
            />
            {m.email !== currentUserEmail && (
              <IconButton size="sm" variant="text" aria-label={`Remove ${label}`} disabled={busy} onClick={() => removeMember(m.id)}>
                <Trash2 className="w-3.5 h-3.5" />
              </IconButton>
            )}
          </>
        ) : (
          <Badge tone="neutral">{m.role}</Badge>
        )}
      </li>
    );
  }

  return (
    <DrawerSection
      title="People"
      description={
        total > 0
          ? `${total} ${total === 1 ? "person" : "people"} can access ${prettyPath(cur)}`
          : `No one else can access ${prettyPath(cur)} yet`
      }
    >
      {isOwner && (
        <div>
          <div className="flex gap-2">
            <Input
              wrapClassName="flex-1"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Invite by email"
            />
            <Select
              wrapClassName="w-28"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as "viewer" | "editor")}
              aria-label="Invite role"
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </Select>
            <Button variant="tonal" disabled={busy || !email} loading={busy} onClick={invite}>
              Invite
            </Button>
          </div>
          {isRoot && (
            <p className="mt-1.5 text-caption text-amber-700">
              This is the drive root — invited people see every folder. Open a subfolder’s Share to scope access to just that folder.
            </p>
          )}
        </div>
      )}

      {direct.length > 0 && (
        <ul className={`${isOwner ? "mt-2 " : ""}max-h-56 overflow-auto scrollbar-thin`}>
          {direct.map((m) => memberRow(m, { editable: true }))}
        </ul>
      )}

      {inherited.length > 0 && (
        <div className="mt-2">
          <div className="text-label uppercase text-drive-muted">Inherited access</div>
          <ul className="max-h-40 overflow-auto scrollbar-thin">
            {inherited.map((m) => memberRow(m, { editable: false }))}
          </ul>
        </div>
      )}
    </DrawerSection>
  );
}

export function FreeLinkSection({
  shares, currentPath, linkRole, setLinkRole, createFreeLink, busy, copyLink,
}: {
  shares: Share[];
  currentPath: string;
  /** Role a NEW link grants — deliberately its own state, not shared with the
   *  invite form (a hidden coupling that made link roles change by accident). */
  linkRole: "viewer" | "editor";
  setLinkRole: (v: "viewer" | "editor") => void;
  createFreeLink: () => void;
  busy: boolean;
  copyLink: (token: string) => void;
}) {
  // Scope to THIS item, like every other drawer section (create in context).
  // The drive-wide link ledger lives in Manage → Links.
  const cur = normalizePath(currentPath);
  const freeShares = shares.filter((s) => !s.price_usdc && normalizePath(s.path) === cur);
  return (
    <DrawerSection
      title="Link sharing"
      description="Anyone with a link gets access — no payment"
      action={
        <div className="flex items-center gap-1.5">
          <Select
            wrapClassName="w-24"
            className="h-8"
            value={linkRole}
            onChange={(e) => setLinkRole(e.target.value as "viewer" | "editor")}
            aria-label="New link role"
          >
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </Select>
          <Button variant="tonal" size="sm" disabled={busy} loading={busy} onClick={createFreeLink}>
            New link
          </Button>
        </div>
      }
    >
      {freeShares.length > 0 && (
        <ul className="max-h-40 overflow-auto scrollbar-thin">
          {freeShares.map((s) => (
            <li key={s.id} className="flex items-center gap-2 py-1.5">
              <Badge tone="neutral">{s.role}</Badge>
              <code className="flex-1 truncate font-mono text-caption text-drive-text">/s/{s.token}</code>
              <IconButton size="sm" variant="text" aria-label="Copy link" onClick={() => copyLink(s.token)}>
                <Copy className="w-3.5 h-3.5" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </DrawerSection>
  );
}
