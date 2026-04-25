"use client";
import { useEffect, useState } from "react";
import { Lock, Wallet, Loader2 } from "lucide-react";
import { DriveShell } from "./drive-shell";

type CheckResponse =
  | { ok: true; driveId: string; driveName: string; path: string }
  | { error: string; paymentRequirements?: PaymentRequirements; walletConnected?: boolean };

type PaymentRequirements = {
  scheme: string;
  network: string;
  asset: string;
  amount: number;
  recipient: string;
  description: string;
  facilitator: string;
  payTo: string;
};

export function ShareGate({ token }: { token: string }) {
  const [state, setState] = useState<"loading" | "ok" | "paywall" | "error">("loading");
  const [data, setData] = useState<CheckResponse | null>(null);
  const [paying, setPaying] = useState(false);

  async function check() {
    setState("loading");
    const res = await fetch(`/api/s/${token}`);
    const body = await res.json();
    setData(body);
    if (res.ok) setState("ok");
    else if (res.status === 402) setState("paywall");
    else setState("error");
  }
  useEffect(() => { check(); }, [token]);

  async function pay(opts: { skip?: boolean } = {}) {
    if (!data || !("paymentRequirements" in data) || !data.paymentRequirements) return;
    setPaying(true);
    const txHash = opts.skip ? "0xDEMO_SKIP" : "0xDEV" + Math.random().toString(16).slice(2, 18);
    const res = await fetch(`/api/s/${token}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash }),
    });
    setPaying(false);
    if (res.ok) await check();
    else alert((await res.json()).error || "payment failed");
  }

  if (state === "loading") {
    return (
      <main className="min-h-screen flex items-center justify-center text-drive-muted">
        <Loader2 className="w-5 h-5 animate-spin" />
      </main>
    );
  }
  if (state === "error") {
    const msg = (data && "error" in data && data.error) || "share unavailable";
    return <main className="p-10 text-center">{msg}</main>;
  }
  if (state === "paywall" && data && "paymentRequirements" in data && data.paymentRequirements) {
    const req = data.paymentRequirements;
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-white border border-drive-border rounded-2xl shadow-drive p-6">
          <Lock className="w-8 h-8 text-drive-accent" />
          <h1 className="mt-3 text-xl font-semibold">Payment required</h1>
          <p className="mt-1 text-sm text-drive-muted">{req.description}</p>
          <div className="mt-5 rounded-xl border border-drive-border p-4 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-drive-muted">Amount</span><span className="font-mono">${req.amount} {req.asset}</span></div>
            <div className="flex justify-between"><span className="text-drive-muted">Network</span><span className="font-mono">{req.network}</span></div>
            <div className="flex justify-between"><span className="text-drive-muted">Recipient</span><span className="font-mono text-xs truncate max-w-[200px]">{req.recipient}</span></div>
          </div>
          {!data.walletConnected && (
            <p className="mt-3 text-xs text-amber-600 flex items-center gap-1">
              <Wallet className="w-3.5 h-3.5" /> Connect a wallet first (real wallets coming soon — dev bypass for now)
            </p>
          )}
          <button
            onClick={() => pay()}
            disabled={paying}
            className="mt-5 w-full rounded-lg bg-drive-accent text-white py-2.5 hover:bg-drive-accentHover disabled:opacity-60"
          >
            {paying ? "Processing…" : `Pay $${req.amount} ${req.asset}`}
          </button>
          <button
            onClick={() => pay({ skip: true })}
            disabled={paying}
            className="mt-2 w-full rounded-lg border border-drive-border text-drive-muted py-2 text-sm hover:bg-drive-hover disabled:opacity-60"
          >
            Skip for demo
          </button>
          <p className="mt-3 text-xs text-drive-muted text-center">
            One payment unlocks this folder permanently for your wallet.
          </p>
        </div>
      </main>
    );
  }
  if (state === "ok" && data && "driveId" in data) {
    return <DriveShell driveId={data.driveId} driveName={data.driveName} />;
  }
  return null;
}
