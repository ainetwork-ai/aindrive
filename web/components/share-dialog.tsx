"use client";
import { useEffect, useState } from "react";
import { X, Copy, Check, Link as LinkIcon, UserPlus, Wallet, Trash2 } from "lucide-react";

type Share = { id: string; token: string; path: string; role: string; expires_at: string | null; price_usdc: number | null };
type Access = { id: string; wallet_address: string; path: string; added_by: "owner" | "payment"; payment_tx: string | null; added_at: string };

export function ShareDialog({
  driveId, defaultPath, onClose,
}: { driveId: string; defaultPath: string; onClose: () => void }) {
  const [shares, setShares] = useState<Share[]>([]);
  const [access, setAccess] = useState<Access[]>([]);
  const [email, setEmail] = useState("");
  const [wallet, setWallet] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function load() {
    const [sRes, aRes] = await Promise.all([
      fetch(`/api/drives/${driveId}/shares`),
      fetch(`/api/drives/${driveId}/access`),
    ]);
    if (sRes.ok) setShares((await sRes.json()).shares);
    if (aRes.ok) setAccess((await aRes.json()).access);
  }
  useEffect(() => { load(); }, [driveId]);

  async function createLink() {
    setBusy(true);
    const body: Record<string, unknown> = { path: defaultPath, role };
    if (price) body.price_usdc = Number(price);
    const res = await fetch(`/api/drives/${driveId}/shares`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) alert((await res.json()).error);
    else {
      const { url } = await res.json();
      await navigator.clipboard.writeText(url).catch(() => {});
      setCopied(url); setTimeout(() => setCopied(null), 2000);
      load();
    }
  }

  async function invite() {
    if (!email) return;
    setBusy(true);
    const res = await fetch(`/api/drives/${driveId}/members`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, role, path: defaultPath }),
    });
    setBusy(false);
    if (!res.ok) alert((await res.json()).error);
    else { setEmail(""); alert("Collaborator added"); }
  }

  async function addWallet() {
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      alert("Wallet must be 0x + 40 hex chars");
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/drives/${driveId}/access`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet_address: wallet, path: defaultPath }),
    });
    setBusy(false);
    if (!res.ok) alert((await res.json()).error);
    else { setWallet(""); load(); }
  }

  async function removeAccess(id: string) {
    if (!confirm("Remove this wallet's access?")) return;
    const res = await fetch(`/api/drives/${driveId}/access/${id}`, { method: "DELETE" });
    if (!res.ok) alert((await res.json()).error); else load();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-drive max-h-[90vh] flex flex-col">
        <header className="flex items-center justify-between p-4 border-b border-drive-border shrink-0">
          <h2 className="font-semibold">Share &ldquo;{defaultPath || "/"}&rdquo;</h2>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-drive-hover"><X className="w-4 h-4" /></button>
        </header>
        <div className="p-4 space-y-5 overflow-y-auto scrollbar-thin">

          {/* Wallet allowlist */}
          <div>
            <div className="flex items-center gap-2 text-sm font-medium mb-2"><Wallet className="w-4 h-4" /> Wallet access</div>
            <div className="flex gap-2">
              <input
                value={wallet}
                onChange={(e) => setWallet(e.target.value.trim())}
                placeholder="0x… (any EVM wallet)"
                className="flex-1 rounded-lg border border-drive-border px-3 py-2 text-sm font-mono"
              />
              <button disabled={busy} onClick={addWallet} className="rounded-lg bg-drive-accent text-white px-3 text-sm hover:bg-drive-accentHover disabled:opacity-50">
                Add
              </button>
            </div>
            {access.length > 0 && (
              <ul className="mt-3 space-y-1.5 max-h-40 overflow-auto scrollbar-thin">
                {access.map((a) => (
                  <li key={a.id} className="text-xs flex items-center gap-2 bg-drive-sidebar rounded-lg px-2 py-1.5">
                    <span className="font-mono truncate flex-1">{a.wallet_address.slice(0, 8)}…{a.wallet_address.slice(-6)}</span>
                    <span className="text-drive-muted">{a.path || "/"}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${a.added_by === "payment" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"}`}>{a.added_by}</span>
                    <button onClick={() => removeAccess(a.id)} className="p-1 rounded hover:bg-drive-hover" title="Revoke">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Email invite */}
          <div>
            <div className="flex items-center gap-2 text-sm font-medium mb-2"><UserPlus className="w-4 h-4" /> Invite by email</div>
            <div className="flex gap-2">
              <input
                value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@example.com" type="email"
                className="flex-1 rounded-lg border border-drive-border px-3 py-2 text-sm"
              />
              <select
                value={role} onChange={(e) => setRole(e.target.value as "viewer" | "editor")}
                className="rounded-lg border border-drive-border px-2 text-sm"
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
              <button disabled={busy} onClick={invite} className="rounded-lg bg-drive-accent text-white px-3 text-sm hover:bg-drive-accentHover disabled:opacity-50">Invite</button>
            </div>
          </div>

          {/* Public/paid share link */}
          <div>
            <div className="flex items-center gap-2 text-sm font-medium mb-2"><LinkIcon className="w-4 h-4" /> Share link</div>
            <div className="flex gap-2 mb-2">
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="Price in USDC (blank = free)"
                type="number" step="0.01" min="0"
                className="flex-1 rounded-lg border border-drive-border px-3 py-2 text-sm"
              />
            </div>
            <button onClick={createLink} disabled={busy} className="w-full rounded-lg border border-drive-border px-3 py-2 text-sm hover:bg-drive-hover disabled:opacity-50">
              Create {price ? `paid ($${price} USDC)` : "free"} share link
            </button>
            {copied && <div className="text-xs text-green-700 mt-2 flex items-center gap-1"><Check className="w-3 h-3" /> copied: {copied}</div>}
            {shares.length > 0 && (
              <ul className="mt-3 space-y-2 max-h-40 overflow-auto scrollbar-thin">
                {shares.map((s) => {
                  const url = typeof window !== "undefined" ? `${window.location.origin}/s/${s.token}` : "";
                  return (
                    <li key={s.id} className="text-xs flex items-center gap-2 bg-drive-sidebar rounded-lg px-2 py-1.5">
                      <span className="truncate flex-1">{s.path || "/"} · {s.role}{s.price_usdc ? ` · $${s.price_usdc}` : ""}</span>
                      <button
                        onClick={() => { navigator.clipboard.writeText(url); setCopied(url); setTimeout(() => setCopied(null), 1500); }}
                        className="p-1 rounded hover:bg-drive-hover"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
