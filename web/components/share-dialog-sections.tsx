"use client";
// Presentational sections for ShareDialog. State + actions stay in the shell
// (share-dialog.tsx); these are pure render functions that receive data and
// handlers as props. Extracting markup only — behavior is unchanged because
// state ownership is unchanged.
import {
  Copy, LinkIcon, UserPlus, Wallet, Trash2, DollarSign, TrendingUp, ExternalLink, Users,
} from "lucide-react";

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
export type Access = {
  id: string;
  wallet_address: string;
  path: string;
  role: "viewer" | "editor";
  added_by: "owner" | "payment";
  payment_tx: string | null;
  added_at: string;
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

export function EarningsSection({ receipts, totalEarned }: { receipts: Receipt[]; totalEarned: number }) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TrendingUp className="w-4 h-4" /> Earnings
        </div>
        <span className="text-sm font-semibold text-green-700">
          ${totalEarned.toFixed(2)} USDC
        </span>
      </div>
      <ul className="space-y-1.5 max-h-40 overflow-auto scrollbar-thin">
        {receipts.map((r) => (
          <li
            key={r.id}
            className="text-xs flex items-center gap-2 bg-drive-sidebar rounded-lg px-2 py-1.5"
          >
            <span className="font-mono truncate w-20 shrink-0">
              {r.wallet.slice(0, 6)}…{r.wallet.slice(-4)}
            </span>
            <span className="text-drive-muted truncate flex-1">{r.path || "/"}</span>
            <span className="shrink-0">
              {r.amount_usdc != null ? `$${r.amount_usdc.toFixed(2)}` : "—"}
            </span>
            {r.tx_hash.startsWith("0x") && !r.tx_hash.startsWith("0xdev_bypass") ? (
              <a
                href={`https://sepolia.basescan.org/tx/${r.tx_hash}`}
                target="_blank"
                rel="noreferrer"
                className="p-0.5 rounded hover:bg-drive-hover shrink-0"
                title="View tx"
              >
                <ExternalLink className="w-3 h-3" />
              </a>
            ) : (
              <span className="w-4 shrink-0" />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// Token-policy mini-editor state + handlers, grouped to keep SellSection's
// prop list readable. `sel` is keyed by preset symbol (USDC/FANCO/…).
export type TokenEditorProps = {
  sel: Record<string, boolean>;
  toggle: (symbol: string) => void;
  fancoAsset: string;
  setFancoAsset: (v: string) => void;
  save: () => void;
};

export function SellSection({
  defaultPath, focusSection, sellOn, paidShare, payoutWallet, payoutInput,
  setPayoutInput, savePayoutWallet, price, setPrice, currency, setCurrency,
  currencyOptions, listed, setListed, isOwner, tokenEditor, saveSell, busy,
  setEditingSell, copyLink,
}: {
  defaultPath: string;
  focusSection?: "sell" | "share";
  sellOn: boolean;
  paidShare: Share | undefined;
  payoutWallet: string;
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
  return (
    <section className={focusSection === "sell" ? "ring-2 ring-drive-accent/40 rounded-xl p-3 -m-3" : ""}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <DollarSign className="w-4 h-4" /> Sell this {defaultPath.includes("/") || defaultPath ? "item" : "drive"}
        </div>
        <Toggle on={sellOn} disabled={!!paidShare} onChange={setEditingSell} />
      </div>

      {/* Active state: existing paid share (read-only) */}
      {paidShare && sellOn && (
        <div className="rounded-xl border border-drive-border p-3 space-y-2 bg-drive-sidebar/40">
          <Row label="Price" value={priceLabel(paidShare.price_usdc, paidShare.currency)} />
          <div className="flex items-center gap-2">
            <span className="text-xs text-drive-muted w-16 shrink-0">Link</span>
            <code className="flex-1 text-xs truncate font-mono">/s/{paidShare.token}</code>
            <button
              onClick={() => copyLink(paidShare.token)}
              className="p-1.5 rounded hover:bg-drive-hover" title="Copy link"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="text-xs text-drive-muted">
            Buyers pay once for permanent access. Send this link to them.
          </p>
        </div>
      )}

      {/* Payout wallet — where x402 payments for THIS drive land.
          Shown whenever the Sell section is open (editing or active). */}
      {sellOn && (
        <div className="rounded-xl border border-drive-border p-3 space-y-2 mb-3">
          <label className="text-xs text-drive-muted block">
            Payout wallet {payoutWallet ? "" : "(not set — payments use the server default)"}
          </label>
          <div className="flex gap-2">
            <input
              value={payoutInput}
              onChange={(e) => setPayoutInput(e.target.value.trim())}
              placeholder="0x… (where you receive USDC)"
              className="flex-1 rounded-lg border border-drive-border px-3 py-2 text-sm font-mono"
            />
            <button
              disabled={busy || payoutInput.trim() === payoutWallet}
              onClick={savePayoutWallet}
              className="rounded-lg bg-drive-accent text-white px-3 text-sm hover:bg-drive-accentHover disabled:opacity-50"
            >
              Save
            </button>
          </div>
          {!payoutWallet && (
            <p className="text-xs text-amber-700">
              ⚠ Set this before selling, or earnings route to the instance operator&rsquo;s wallet.
            </p>
          )}
        </div>
      )}

      {/* Editing state: no paid share yet, toggle on */}
      {!paidShare && sellOn && (
        <div className="rounded-xl border border-drive-border p-3 space-y-3">
          <div>
            <label className="text-xs text-drive-muted block mb-1">Price</label>
            <div className="flex gap-2">
              <input
                type="number"
                step="0.01"
                min="0.01"
                max="9999.99"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0.50"
                className="flex-1 rounded-lg border border-drive-border px-3 py-2 text-sm"
                autoFocus
              />
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="rounded-lg border border-drive-border px-2 text-sm"
                aria-label="Currency"
              >
                {currencyOptions.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <p className="text-xs text-drive-muted mt-1">
              Buyers pay once for permanent access.
            </p>
          </div>
          {/* [rev2-D] Listing is owner-only (API 403s listed:true otherwise) */}
          {isOwner && (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={listed}
                onChange={(e) => setListed(e.target.checked)}
              />
              List in drive
              <span className="text-drive-muted">— members without access see it for sale</span>
            </label>
          )}
          <button
            disabled={busy || !price}
            onClick={saveSell}
            className="w-full rounded-lg bg-drive-accent text-white px-3 py-2 text-sm hover:bg-drive-accentHover disabled:opacity-50"
          >
            Save as paid
          </button>
        </div>
      )}

      {/* Drive-wide payment-token policy (spec D3): which currencies shares
          may be priced in. Owner-only, like the PATCH behind it. */}
      {isOwner && sellOn && (
        <PaymentTokensEditor editor={tokenEditor} busy={busy} />
      )}
    </section>
  );
}

function PaymentTokensEditor({ editor, busy }: { editor: TokenEditorProps; busy: boolean }) {
  return (
    <div className="rounded-xl border border-drive-border p-3 space-y-2 mt-3">
      <label className="text-xs text-drive-muted block">Payment tokens (drive policy)</label>
      <div className="flex items-center gap-4">
        {Object.keys(editor.sel).map((sym) => (
          <label key={sym} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={editor.sel[sym]}
              onChange={() => editor.toggle(sym)}
            />
            {sym}
          </label>
        ))}
        <button
          disabled={busy}
          onClick={editor.save}
          className="ml-auto rounded-lg bg-drive-accent text-white px-3 py-1.5 text-sm hover:bg-drive-accentHover disabled:opacity-50"
        >
          Save
        </button>
      </div>
      {editor.sel.FANCO && (
        <div>
          <input
            value={editor.fancoAsset}
            onChange={(e) => editor.setFancoAsset(e.target.value.trim())}
            placeholder="0x… (FANCO contract address on Base)"
            className="w-full rounded-lg border border-drive-border px-3 py-2 text-sm font-mono"
          />
          <p className="text-xs text-drive-muted mt-1">
            FANCO on-chain settlement arrives with Phase 2b; address needed for the 402 policy.
          </p>
        </div>
      )}
    </div>
  );
}

export function WalletAccessSection({
  wallet, setWallet, walletRole, setWalletRole, addWallet, busy, access, removeAccess,
}: {
  wallet: string;
  setWallet: (v: string) => void;
  walletRole: "viewer" | "editor";
  setWalletRole: (v: "viewer" | "editor") => void;
  addWallet: () => void;
  busy: boolean;
  access: Access[];
  removeAccess: (id: string) => void;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 text-sm font-medium mb-2">
        <Wallet className="w-4 h-4" /> Wallet access
      </div>
      <div className="flex gap-2">
        <input
          value={wallet}
          onChange={(e) => setWallet(e.target.value.trim())}
          placeholder="0x… (any EVM wallet)"
          className="flex-1 rounded-lg border border-drive-border px-3 py-2 text-sm font-mono"
        />
        <select
          value={walletRole}
          onChange={(e) => setWalletRole(e.target.value as "viewer" | "editor")}
          className="rounded-lg border border-drive-border px-2 text-sm"
        >
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
        </select>
        <button
          disabled={busy}
          onClick={addWallet}
          className="rounded-lg bg-drive-accent text-white px-3 text-sm hover:bg-drive-accentHover disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {access.length > 0 && (
        <ul className="mt-3 space-y-1.5 max-h-40 overflow-auto scrollbar-thin">
          {access.map((a) => (
            <li
              key={a.id}
              className="text-xs flex items-center gap-2 bg-drive-sidebar rounded-lg px-2 py-1.5"
            >
              <span className="font-mono truncate flex-1">
                {a.wallet_address.slice(0, 8)}…{a.wallet_address.slice(-6)}
              </span>
              <span className="text-drive-muted">{a.path || "/"}</span>
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-700">
                {a.role}
              </span>
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] ${
                  a.added_by === "payment"
                    ? "bg-green-100 text-green-700"
                    : "bg-blue-100 text-blue-700"
                }`}
              >
                {a.added_by === "payment" ? "💰 paid" : "owner"}
              </span>
              <button
                onClick={() => removeAccess(a.id)}
                className="p-1 rounded hover:bg-drive-hover"
                title="Revoke"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function MembersSection({
  members, isOwner, currentUserEmail, changeMemberRole, removeMember, busy,
}: {
  members: Member[];
  isOwner: boolean;
  currentUserEmail: string;
  changeMemberRole: (id: string, role: "viewer" | "editor" | "owner") => void;
  removeMember: (id: string) => void;
  busy: boolean;
}) {
  if (members.length === 0) return null;
  return (
    <section>
      <div className="flex items-center gap-2 text-sm font-medium mb-2">
        <Users className="w-4 h-4" /> Members
      </div>
      <ul className="space-y-1.5 max-h-40 overflow-auto scrollbar-thin">
        {members.map((m) => (
          <li
            key={m.id}
            className="text-xs flex items-center gap-2 bg-drive-sidebar rounded-lg px-2 py-1.5"
          >
            <span className="truncate flex-1">{m.name || m.email}</span>
            <span className="text-drive-muted truncate w-16 shrink-0">{m.path || "/"}</span>
            {isOwner ? (
              <select
                value={m.role}
                disabled={busy}
                onChange={(e) =>
                  changeMemberRole(m.id, e.target.value as "viewer" | "editor" | "owner")
                }
                className="rounded-lg border border-drive-border px-1.5 py-0.5 text-[11px] disabled:opacity-50"
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                <option value="owner">Owner</option>
              </select>
            ) : (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-700">
                {m.role}
              </span>
            )}
            {isOwner && m.email !== currentUserEmail && (
              <button
                onClick={() => removeMember(m.id)}
                disabled={busy}
                className="p-1 rounded hover:bg-drive-hover disabled:opacity-50"
                title="Remove member"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function EmailInviteSection({
  email, setEmail, role, setRole, invite, busy,
}: {
  email: string;
  setEmail: (v: string) => void;
  role: "viewer" | "editor";
  setRole: (v: "viewer" | "editor") => void;
  invite: () => void;
  busy: boolean;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 text-sm font-medium mb-2">
        <UserPlus className="w-4 h-4" /> Invite by email
      </div>
      <div className="flex gap-2">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="colleague@example.com"
          type="email"
          className="flex-1 rounded-lg border border-drive-border px-3 py-2 text-sm"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as "viewer" | "editor")}
          className="rounded-lg border border-drive-border px-2 text-sm"
        >
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
        </select>
        <button
          disabled={busy}
          onClick={invite}
          className="rounded-lg bg-drive-accent text-white px-3 text-sm hover:bg-drive-accentHover disabled:opacity-50"
        >
          Invite
        </button>
      </div>
    </section>
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
  return (
    <section>
      <div className="flex items-center gap-2 text-sm font-medium mb-2">
        <LinkIcon className="w-4 h-4" /> Free share link
      </div>
      <button
        onClick={createFreeLink}
        disabled={busy}
        className="w-full rounded-lg border border-drive-border px-3 py-2 text-sm hover:bg-drive-hover disabled:opacity-50"
      >
        Create free share link
      </button>
      {shares.filter(s => !s.price_usdc).length > 0 && (
        <ul className="mt-3 space-y-2 max-h-40 overflow-auto scrollbar-thin">
          {shares.filter(s => !s.price_usdc).map((s) => (
            <li
              key={s.id}
              className="text-xs flex items-center gap-2 bg-drive-sidebar rounded-lg px-2 py-1.5"
            >
              <span className="truncate flex-1">{s.path || "/"} · {s.role}</span>
              <button
                onClick={() => copyLink(s.token)}
                className="p-1 rounded hover:bg-drive-hover" title="Copy link"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
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
      <span className="text-xs text-drive-muted w-16 shrink-0">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

function Toggle({
  on, disabled, onChange,
}: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-60 ${
        on ? "bg-drive-accent" : "bg-drive-border"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow transition transform ${
          on ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}
