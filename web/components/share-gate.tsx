"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { base, baseSepolia } from "viem/chains";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, createPermit2ApprovalTx, getPermit2AllowanceReadParams } from "@x402/evm/exact/client";
import { toast } from "sonner";
import { Lock, Loader2, HardDrive, AlertTriangle, ShieldCheck, Wallet } from "lucide-react";
import type { Account, Chain, Transport, WalletClient } from "viem";
import { Button } from "@/components/ui";

// v2 requirement as mirrored in the 402 body (the x402 client itself consumes
// the PAYMENT-REQUIRED header; this body copy only drives the gate UI).
type PaymentRequirements = {
  scheme: string;
  network: string; // CAIP-2, e.g. "eip155:8453"
  amount: string;  // atomic units
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  extra?: { assetTransferMethod?: string; name?: string; version?: string };
};

// Payment chains by CAIP-2 wire id. The allowance probe and the approve tx
// must run on the TOKEN's chain — the wallet may be connected elsewhere, and
// an approval mined on the wrong chain looks successful but settles nothing
// (the payer would loop approve → 412 while burning gas).
const CHAIN_BY_CAIP: Record<string, typeof base | typeof baseSepolia> = {
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
};

// wagmi WalletClient → the x402 ClientEvmSigner shape (address +
// signTypedData). Mirrors @x402/paywall's browserAdapter, which is not
// publicly exported from the SDK.
type ConnectedWalletClient = WalletClient<Transport, Chain, Account>;
function walletClientToSigner(wc: ConnectedWalletClient) {
  return {
    address: wc.account.address,
    signTypedData: (message: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }) =>
      wc.signTypedData({
        account: wc.account,
        domain: message.domain,
        types: message.types,
        primaryType: message.primaryType,
        message: message.message,
      } as Parameters<ConnectedWalletClient["signTypedData"]>[0]),
  };
}

type CheckResponse =
  | { ok: true; driveId: string; driveName: string; path: string; role: string; txHash?: string }
  | {
      x402Version: number;
      accepts: PaymentRequirements[];
      // Display-only token info from the drive's policy; absent on legacy
      // servers → USDC/6 fallback below.
      currency?: { symbol: string; decimals: number };
      error: string;
    };

type State = "loading" | "login" | "paywall" | "error";

export function ShareGate({ token }: { token: string }) {
  const [state, setState] = useState<State>("loading");
  const [data, setData] = useState<CheckResponse | null>(null);
  const [paying, setPaying] = useState(false);
  // Permit2 tokens need a one-time on-chain approval before the gasless pay
  // signature can settle: null = unknown/checking, true = approve step shown.
  const [approvalNeeded, setApprovalNeeded] = useState<boolean | null>(null);
  const [approving, setApproving] = useState(false);
  const router = useRouter();
  const { isConnected, address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();

  // Consume the share into a persistent drive_members grant, then hand the
  // visitor off to the real drive at the share's path (not root).
  async function accept(driveId: string, path: string) {
    const res = await fetch(`/api/s/${token}/accept`, { method: "POST" });
    // Login-first: CONSUME requires auth. A logged-out visitor is bounced to
    // /login with a next param so they return to this exact share; after
    // login check() re-runs and accept() succeeds (free share).
    if (res.status === 401) {
      router.replace(`/login?next=/s/${token}`);
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body.error || "could not open share");
      setState("error");
      setData(body);
      return;
    }
    const body = (await res.json()) as { driveId: string; path: string };
    router.replace(`/d/${body.driveId}?path=${encodeURIComponent(body.path)}`);
  }

  async function check() {
    setState("loading");
    const res = await fetch(`/api/s/${token}`);
    const body = await res.json();
    setData(body);
    if (res.ok && "driveId" in body) {
      // Free share (or already-covered paid share): consume + redirect.
      await accept(body.driveId, body.path);
    } else if (res.status === 402) {
      // Paid + not yet entitled. Establish identity BEFORE payment: signing a
      // gasless x402 authorization and only THEN hitting a login wall is a bad
      // buy flow, and logging in first means settle binds the grant straight to
      // user.id (not the fragile wallet→account fallback). Logged-out → login
      // gate; logged-in → paywall.
      const me = await fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null)).catch(() => null);
      setState(me?.user ? "paywall" : "login");
    } else {
      setState("error");
    }
  }
  useEffect(() => { check(); }, [token]);

  const requirement = useMemo(() => {
    if (data && "accepts" in data && data.accepts?.[0]) return data.accepts[0];
    return null;
  }, [data]);

  // Human price label, shared by the login gate + paywall. `$` prefix only for
  // the dollar-pegged USDC; other tokens (e.g. FANCO) show "<amount> <symbol>".
  const amountLabel = useMemo(() => {
    if (!requirement) return "";
    const currency = data && "accepts" in data ? data.currency : undefined;
    const symbol = currency?.symbol ?? "USDC";
    const amount = (Number(requirement.amount) / 10 ** (currency?.decimals ?? 6)).toFixed(2);
    return symbol === "USDC" ? `$${amount} USDC` : `${amount} ${symbol}`;
  }, [requirement, data]);

  const tokenSymbol = (data && "accepts" in data ? data.currency?.symbol : undefined) ?? "USDC";
  const isPermit2 = requirement?.extra?.assetTransferMethod === "permit2";
  // Everything on-chain below (allowance probe, approve tx, receipt wait)
  // is pinned to the TOKEN's chain, regardless of where the wallet sits.
  const requirementChain = requirement ? CHAIN_BY_CAIP[requirement.network] : undefined;
  const publicClient = usePublicClient({ chainId: requirementChain?.id });

  // Permit2 pre-check: read the payer's ERC-20 allowance to the Permit2
  // contract before they sign, so the approve step shows up front instead of
  // as a failed payment. The server's 412 stays as the authoritative fallback
  // (e.g. when this probe fails or the allowance races to spent).
  useEffect(() => {
    if (!isPermit2) { setApprovalNeeded(false); return; }
    if (!requirement || !address || !publicClient || !requirementChain) { setApprovalNeeded(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const allowance = await publicClient.readContract(
          getPermit2AllowanceReadParams({
            tokenAddress: requirement.asset as `0x${string}`,
            ownerAddress: address,
          }),
        );
        if (!cancelled) setApprovalNeeded(allowance < BigInt(requirement.amount));
      } catch {
        if (!cancelled) setApprovalNeeded(null); // unknown — 412 fallback covers us
      }
    })();
    return () => { cancelled = true; };
  }, [isPermit2, requirement, address, publicClient, requirementChain]);

  // One-time on-chain approval that lets the Permit2 contract move this token
  // for the payer (the pay signature itself stays gasless).
  async function approve() {
    if (!walletClient || !publicClient || !requirement) { toast.error("Connect your wallet first"); return; }
    if (!requirementChain) { toast.error("Unsupported payment network"); return; }
    setApproving(true);
    try {
      // The approval must mine on the token's chain; a wrong-chain approval
      // confirms fine but unlocks nothing. Switch first, then pass `chain` so
      // viem refuses to send if the wallet still disagrees.
      if (walletClient.chain?.id !== requirementChain.id) {
        await switchChainAsync({ chainId: requirementChain.id });
      }
      const tx = createPermit2ApprovalTx(requirement.asset as `0x${string}`);
      const hash = await walletClient.sendTransaction({ to: tx.to, data: tx.data, chain: requirementChain });
      await publicClient.waitForTransactionReceipt({ hash });
      setApprovalNeeded(false);
      toast.success(`${tokenSymbol} approved — you can pay now.`);
    } catch (e) {
      toast.error((e as Error).message || "approval failed");
    } finally {
      setApproving(false);
    }
  }

  async function pay() {
    if (!walletClient) { toast.error("Connect your wallet first"); return; }
    if (!requirement) return;
    setPaying(true);
    try {
      const displayed = requirement;
      const displayedMax = BigInt(displayed.amount);
      const client = new x402Client();
      client.register("eip155:*", new ExactEvmScheme(walletClientToSigner(walletClient)));
      // Replaces v1's maxValue guard, hardened: only sign a requirement that
      // matches what this paywall DISPLAYED — same network, asset and
      // recipient, amount no higher. A server re-quote that flips any of
      // these between render and retry gets no signature.
      client.registerPolicy((_version, reqs) =>
        reqs.filter((r) => {
          try {
            return (
              BigInt(r.amount) <= displayedMax &&
              r.network === displayed.network &&
              r.asset.toLowerCase() === displayed.asset.toLowerCase() &&
              r.payTo.toLowerCase() === displayed.payTo.toLowerCase()
            );
          } catch { return false; }
        }),
      );
      const fetchWithPay = wrapFetchWithPayment(globalThis.fetch, client);
      const res = await fetchWithPay(`/api/s/${token}`);
      // 412 = Permit2 allowance missing (raced past the pre-check): show the
      // approve step instead of a dead "payment failed".
      if (res.status === 412) {
        setApprovalNeeded(true);
        toast.error(`One-time ${tokenSymbol} approval needed before paying.`);
        return;
      }
      const body = await res.json();
      if (res.ok) {
        const okBody = body as { driveId: string; path: string };
        toast.success("Payment settled. Permanent access granted.");
        // Paid GET wrote the covering grant; CONSUME now upserts the
        // drive_members row and redirects into the drive.
        await accept(okBody.driveId, okBody.path);
      } else {
        toast.error(body.error || "payment failed");
      }
    } catch (e) {
      toast.error((e as Error).message || "payment failed");
    } finally {
      setPaying(false);
    }
  }

  // ── Loading: branded, so a visitor landing on a payment link sees trust
  //    chrome immediately rather than a bare spinner. ─────────────────────────
  if (state === "loading") {
    return (
      <GateShell>
        <div className="flex flex-col items-center gap-4 py-6 text-drive-muted">
          <Loader2 className="w-6 h-6 animate-spin text-drive-accent" />
          <p className="text-body">Checking access…</p>
        </div>
      </GateShell>
    );
  }

  // ── Error: a proper empty-state rather than bare text. ──────────────────────
  if (state === "error") {
    const msg = data && "error" in data ? data.error : "This share is unavailable.";
    return (
      <GateShell>
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-50 text-amber-500">
            <AlertTriangle className="w-7 h-7" />
          </span>
          <h1 className="text-title text-drive-text">Can’t open this share</h1>
          <p className="text-body text-drive-muted max-w-xs">{msg}</p>
          <Button variant="tonal" className="mt-1" onClick={() => router.replace("/")}>
            Go to aindrive
          </Button>
        </div>
      </GateShell>
    );
  }

  // ── Login gate: paid content, visitor not signed in. Establish identity
  //    BEFORE the wallet signature so the purchase binds to their account. ─────
  if (state === "login" && requirement) {
    return (
      <GateShell>
        <div className="flex flex-col items-center text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-drive-selected text-drive-accent">
            <Lock className="w-7 h-7" />
          </span>
          <h1 className="mt-4 text-title text-drive-text">Sign in to purchase</h1>
          <p className="mt-1 text-body text-drive-muted max-w-xs">
            This content costs {amountLabel}. Sign in (or create an account) to continue — your purchase then unlocks permanent access.
          </p>
        </div>
        <div className="mt-6 rounded-xl border border-drive-border bg-drive-panel px-5 py-4 text-center">
          <div className="text-label uppercase text-drive-muted">Price</div>
          <div className="mt-1 text-display text-drive-text tabular-nums">{amountLabel}</div>
        </div>
        <Button
          variant="filled"
          className="mt-6 w-full justify-center"
          onClick={() => router.push(`/login?next=/s/${token}`)}
        >
          Sign in to continue
        </Button>
        <p className="mt-3 text-caption text-drive-muted text-center">
          You’ll come right back here to pay after signing in.
        </p>
      </GateShell>
    );
  }

  if (state === "paywall" && requirement) {
    const payTo = requirement.payTo;
    const payToShort = payTo.length > 14 ? `${payTo.slice(0, 6)}…${payTo.slice(-4)}` : payTo;
    return (
      <GateShell>
        {/* Header: lock mark + what this is. The 402 deliberately carries no
            item name/type (anyone with the link hits this), so we frame the
            product as "permanent access" rather than inventing file metadata. */}
        <div className="flex flex-col items-center text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-drive-selected text-drive-accent">
            <Lock className="w-7 h-7" />
          </span>
          <h1 className="mt-4 text-title text-drive-text">Unlock permanent access</h1>
          <p className="mt-1 text-body text-drive-muted max-w-xs">
            One payment grants your wallet permanent access to this shared content.
          </p>
        </div>

        {/* Hero price — the single most important number on the page. */}
        <div className="mt-6 rounded-xl border border-drive-border bg-drive-panel px-5 py-4 text-center">
          <div className="text-label uppercase text-drive-muted">Price</div>
          <div className="mt-1 text-display text-drive-text tabular-nums">{amountLabel}</div>
          <div className="mt-1 text-caption text-drive-muted">on {CHAIN_BY_CAIP[requirement.network]?.name ?? requirement.network}</div>
        </div>

        {/* Recipient — secondary, mono, truncated. */}
        <div className="mt-4 flex items-center justify-between gap-4 text-caption">
          <span className="text-drive-muted">Recipient</span>
          <span className="font-mono text-drive-text truncate" title={payTo}>{payToShort}</span>
        </div>

        {/* Wallet connect + pay — clear primary action hierarchy. Permit2
            tokens insert a one-time approve step before the pay signature. */}
        <div className="mt-6 flex flex-col items-stretch gap-3">
          <div className="flex justify-center">
            <ConnectButton showBalance={false} chainStatus="icon" />
          </div>
          {isConnected && isPermit2 && approvalNeeded ? (
            <>
              <Button
                variant="filled"
                size="md"
                loading={approving}
                disabled={approving}
                icon={<ShieldCheck className="w-4 h-4" />}
                onClick={approve}
                className="w-full justify-center"
              >
                {approving ? "Approving…" : `Approve ${tokenSymbol} (one-time)`}
              </Button>
              <p className="text-caption text-drive-muted text-center">
                Step 1 of 2 — a one-time on-chain approval lets {tokenSymbol} be spent for this payment. You’ll pay right after.
              </p>
            </>
          ) : (
            <Button
              variant="filled"
              size="md"
              loading={paying}
              disabled={!isConnected || paying}
              icon={isConnected ? <Wallet className="w-4 h-4" /> : undefined}
              onClick={pay}
              className="w-full justify-center"
            >
              {paying ? "Signing & settling…" : isConnected ? `Pay ${amountLabel}` : "Connect wallet to pay"}
            </Button>
          )}
        </div>

        <p className="mt-4 flex items-center justify-center gap-1.5 text-caption text-drive-muted text-center">
          <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
          Permanent access for your wallet. No refunds.
        </p>
      </GateShell>
    );
  }
  return null;
}

/**
 * Centered card shell shared by every ShareGate state (loading / error /
 * paywall), with a brand wordmark at the top. A visitor often lands here from
 * an external link, so consistent, branded chrome builds payment trust.
 */
function GateShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen min-h-[100dvh] flex flex-col items-center justify-center px-4 bg-drive-sidebar">
      <div className="mb-5 flex items-center gap-2 text-subtitle font-semibold text-drive-text">
        <HardDrive className="w-5 h-5 text-drive-accent" /> aindrive
      </div>
      <div className="w-full max-w-md rounded-2xl border border-drive-border bg-white shadow-e3 p-6 sm:p-7">
        {children}
      </div>
    </main>
  );
}
