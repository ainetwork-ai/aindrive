"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  X, Copy, LinkIcon, UserPlus, Wallet, Trash2, DollarSign, Lock,
} from "lucide-react";

type Share = {
  id: string;
  token: string;
  path: string;
  role: string;
  expires_at: string | null;
  price_usdc: number | null;
};
type Access = {
  id: string;
  wallet_address: string;
  path: string;
  added_by: "owner" | "payment";
  payment_tx: string | null;
  added_at: string;
};

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
  const [access, setAccess] = useState<Access[]>([]);
  const [email, setEmail] = useState("");
  const [wallet, setWallet] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [busy, setBusy] = useState(false);
  const [sellOn, setSellOn] = useState(false);
  const [price, setPrice] = useState("");

  async function load() {
    const [sRes, aRes] = await Promise.all([
      fetch(`/api/drives/${driveId}/shares`),
      fetch(`/api/drives/${driveId}/access`),
    ]);
    if (sRes.ok) setShares((await sRes.json()).shares);
    if (aRes.ok) setAccess((await aRes.json()).access);
  }
  useEffect(() => { load(); }, [driveId]);

  // Existing paid share for this exact path (most recent first)
  const paidShare = shares.find(s => s.path === defaultPath && s.price_usdc !== null);

  // If a paid share already exists, surface it as the active state
  useEffect(() => {
    if (paidShare) setSellOn(true);
  }, [paidShare]);

  // Auto-expand based on focusSection
  useEffect(() => {
    if (focusSection === "sell" && !paidShare) setSellOn(true);
  }, [focusSection, paidShare]);

  async function saveSell() {
    const num = Number(price);
    if (!num || num < 0.01 || num > 9999.99) {
      toast.error("Price must be between 0.01 and 9999.99 USDC");
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/drives/${driveId}/shares`, {
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
      toast.error((await res.json()).error || "Failed to save");
      return;
    }
    const { url } = await res.json();
    const copied = await navigator.clipboard.writeText(url).then(() => true).catch(() => false);
    if (copied) toast.success("Paid share link copied to clipboard");
    else toast.success(`Paid share link created: ${url}`, { duration: 8000 });
    setPrice("");
    load();
  }

  async function createFreeLink() {
    setBusy(true);
    const res = await fetch(`/api/drives/${driveId}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: defaultPath, role }),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error((await res.json()).error || "Failed to create link");
      return;
    }
    const { url } = await res.json();
    const copied = await navigator.clipboard.writeText(url).then(() => true).catch(() => false);
    if (copied) toast.success("Free share link copied");
    else toast.success(`Free share link created: ${url}`, { duration: 8000 });
    load();
  }

  async function invite() {
    if (!email) return;
    setBusy(true);
    const res = await fetch(`/api/drives/${driveId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, role, path: defaultPath }),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error((await res.json()).error);
    } else {
      setEmail("");
      toast.success("Collaborator added");
    }
  }

  async function addWallet() {
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      toast.error("Wallet must be 0x + 40 hex chars");
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/drives/${driveId}/access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet_address: wallet, path: defaultPath }),
    });
    setBusy(false);
    if (!res.ok) toast.error((await res.json()).error);
    else { setWallet(""); load(); }
  }

  async function removeAccess(id: string) {
    if (!confirm("Remove this wallet's access?")) return;
    const res = await fetch(`/api/drives/${driveId}/access/${id}`, { method: "DELETE" });
    if (!res.ok) toast.error((await res.json()).error);
    else load();
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

          {/* Sell — promoted top-of-mind section */}
          <section className={focusSection === "sell" ? "ring-2 ring-drive-accent/40 rounded-xl p-3 -m-3" : ""}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <DollarSign className="w-4 h-4" /> Sell this {defaultPath.includes("/") || defaultPath ? "item" : "drive"}
              </div>
              <Toggle on={sellOn} disabled={!!paidShare} onChange={setSellOn} />
            </div>

            {/* Active state: existing paid share (read-only) */}
            {paidShare && sellOn && (
              <div className="rounded-xl border border-drive-border p-3 space-y-2 bg-drive-sidebar/40">
                <Row label="Price" value={`$${paidShare.price_usdc?.toFixed(2)} USDC`} />
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

            {/* Editing state: no paid share yet, toggle on */}
            {!paidShare && sellOn && (
              <div className="rounded-xl border border-drive-border p-3 space-y-3">
                <div>
                  <label className="text-xs text-drive-muted block mb-1">Price (USDC)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max="9999.99"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    placeholder="0.50"
                    className="w-full rounded-lg border border-drive-border px-3 py-2 text-sm"
                    autoFocus
                  />
                  <p className="text-xs text-drive-muted mt-1">
                    Buyers pay once for permanent access.
                  </p>
                </div>
                <button
                  disabled={busy || !price}
                  onClick={saveSell}
                  className="w-full rounded-lg bg-drive-accent text-white px-3 py-2 text-sm hover:bg-drive-accentHover disabled:opacity-50"
                >
                  Save as paid
                </button>
              </div>
            )}
          </section>

          {/* Wallet allowlist */}
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

          {/* Email invite */}
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

          {/* Free share link */}
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
