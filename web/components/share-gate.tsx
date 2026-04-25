"use client";
import { useEffect, useMemo, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { wrapFetchWithPayment } from "x402-fetch";
import { toast } from "sonner";
import { Lock, Loader2 } from "lucide-react";
import { DriveShell } from "./drive-shell";
import { PaidContentView } from "./paid-content-view";

type PaymentRequirements = {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  mimeType: string;
};

type CheckResponse =
  | { ok: true; driveId: string; driveName: string; path: string; role: string; txHash?: string; viaPayment?: boolean }
  | { x402Version: number; accepts: PaymentRequirements[]; error: string };

type State = "loading" | "ok" | "paywall" | "error";

export function ShareGate({ token }: { token: string }) {
  const [state, setState] = useState<State>("loading");
  const [data, setData] = useState<CheckResponse | null>(null);
  const [paying, setPaying] = useState(false);
  const { isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();

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

  const requirement = useMemo(() => {
    if (data && "accepts" in data && data.accepts?.[0]) return data.accepts[0];
    return null;
  }, [data]);

  async function pay() {
    if (!walletClient) { toast.error("Connect your wallet first"); return; }
    if (!requirement) return;
    setPaying(true);
    try {
      // wrapFetchWithPayment expects a Signer; viem WalletClient from wagmi is compatible at runtime.
      // maxValue is in atomic units (USDC = 6 decimals). Allow up to the required amount.
      const max = BigInt(requirement.maxAmountRequired);
      const fetchWithPay = wrapFetchWithPayment(
        globalThis.fetch,
        walletClient as unknown as Parameters<typeof wrapFetchWithPayment>[1],
        max,
      );
      const res = await fetchWithPay(`/api/s/${token}`);
      const body = await res.json();
      if (res.ok) {
        setData(body);
        setState("ok");
        toast.success("Payment settled. Permanent access granted.");
      } else {
        toast.error(body.error || "payment failed");
      }
    } catch (e) {
      toast.error((e as Error).message || "payment failed");
    } finally {
      setPaying(false);
    }
  }

  if (state === "loading") {
    return (
      <main className="min-h-screen flex items-center justify-center text-drive-muted">
        <Loader2 className="w-5 h-5 animate-spin" />
      </main>
    );
  }
  if (state === "error") {
    const msg = data && "error" in data ? data.error : "share unavailable";
    return <main className="p-10 text-center">{msg}</main>;
  }
  if (state === "ok" && data && "driveId" in data) {
    // Buyers (paid via x402) and free-share guests don't have full drive access —
    // they only have folder_access for the share's specific path. Render a scoped
    // view rather than DriveShell (which would try to list drive root and 401).
    return (
      <PaidContentView
        driveId={data.driveId}
        driveName={data.driveName}
        path={data.path}
        txHash={data.txHash}
      />
    );
  }
  if (state === "paywall" && requirement) {
    const usdc = (Number(requirement.maxAmountRequired) / 1_000_000).toFixed(2);
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-white border border-drive-border rounded-2xl shadow-drive p-6">
          <Lock className="w-8 h-8 text-drive-accent" />
          <h1 className="mt-3 text-xl font-semibold">Payment required</h1>
          <p className="mt-1 text-sm text-drive-muted">{requirement.description}</p>

          <div className="mt-5 rounded-xl border border-drive-border p-4 text-sm space-y-1">
            <Row label="Amount" value={`$${usdc} USDC`} />
            <Row label="Network" value={requirement.network} />
            <Row label="Recipient" value={requirement.payTo} mono truncate />
          </div>

          <div className="mt-5 flex justify-center">
            <ConnectButton showBalance={false} chainStatus="icon" />
          </div>

          <button
            onClick={pay}
            disabled={!isConnected || paying}
            className="mt-4 w-full rounded-lg bg-drive-accent text-white py-2.5 hover:bg-drive-accentHover disabled:opacity-50"
          >
            {paying ? "Signing & settling…" : isConnected ? `Pay $${usdc} USDC` : "Connect wallet to pay"}
          </button>

          <p className="mt-3 text-xs text-drive-muted text-center">
            One payment unlocks permanent access for your wallet. No refunds.
          </p>
        </div>
      </main>
    );
  }
  return null;
}

function Row({
  label, value, mono, truncate,
}: { label: string; value: string; mono?: boolean; truncate?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-drive-muted">{label}</span>
      <span className={`${mono ? "font-mono" : ""} ${truncate ? "truncate max-w-[200px]" : ""}`}>{value}</span>
    </div>
  );
}
