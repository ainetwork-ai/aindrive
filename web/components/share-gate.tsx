"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { base, baseSepolia } from "viem/chains";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, getPermit2AllowanceReadParams } from "@x402/evm/exact/client";
import { toast } from "sonner";
import { Lock, Loader2, HardDrive, AlertTriangle, ShieldCheck, Wallet } from "lucide-react";
import { encodeFunctionData, maxUint256, UserRejectedRequestError, type Account, type Chain, type Transport, type WalletClient } from "viem";
import { getCapabilities, sendCalls, waitForCallsStatus } from "viem/actions";
import { Button } from "@/components/ui";
import { getWagmiConfig } from "@/lib/wagmi-config";
import { walletDisplayLabel } from "@/shared/wallet-display";

// Canonical Uniswap Permit2 contract — same address on every EVM chain.
// (Mirrors @x402/evm's PERMIT2_ADDRESS, which isn't re-exported from the
// client entrypoint.) The payer approves THIS contract to pull the token,
// then the x402 proxy moves exactly the sale amount via the signed permit.
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
const ERC20_APPROVE_ABI = [{
  type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ type: "bool" }],
}] as const;

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
      // Server offers sponsored (buyer pays no gas) approves for this permit2
      // sale — realized only if the wallet also supports paymasterService.
      gasSponsorship?: boolean;
      error: string;
    };

type State = "loading" | "paywall" | "error";

export function ShareGate({ token }: { token: string }) {
  const [state, setState] = useState<State>("loading");
  const [data, setData] = useState<CheckResponse | null>(null);
  const [paying, setPaying] = useState(false);
  // Permit2 tokens need a one-time on-chain approval before the gasless pay
  // signature can settle: null = unknown/checking, true = approve step shown.
  const [approvalNeeded, setApprovalNeeded] = useState<boolean | null>(null);
  const [approving, setApproving] = useState(false);
  // Sponsored-approve availability: server offers it (402 gasSponsorship) AND
  // the connected wallet supports ERC-7677 paymasterService (probed below).
  // Drives both the sponsored send path and the "gas covered" UI copy.
  const [gasSponsored, setGasSponsored] = useState(false);
  const router = useRouter();
  // `isReconnecting` covers the gap after a wallet redirect/deeplink returns
  // (e.g. Coinbase Wallet / Base App): wagmi rehydrates the connection over a
  // few seconds before `isConnected` flips, during which the UI must read as
  // "connecting", not "not connected" (else users think it failed and bail).
  const { isConnected, address, isConnecting, isReconnecting } = useAccount();
  const walletConnecting = (isConnecting || isReconnecting) && !isConnected;
  const { data: walletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();
  // The signed-in account, shown on the paywall so the buyer knows which
  // account this purchase will bind to (and can switch).
  const [user, setUser] = useState<{ email: string; name: string } | null>(null);
  // A wallet request can hang forever (popup blocked, request landed in a
  // different extension, wallet closed). Each attempt gets an epoch; Cancel
  // bumps it so a late resolution is ignored instead of mutating UI state,
  // and the user is never stuck staring at an un-cancellable spinner.
  const walletEpoch = useRef(0);
  function cancelWalletWait() {
    walletEpoch.current += 1;
    setPaying(false);
    setApproving(false);
    toast("Stopped waiting. If a request is open in your wallet, dismiss it there.");
  }
  // The chain-switch invalidates the closure-captured wallet client (it stays
  // bound to the previous chain — some wallets then queue the next request
  // without ever showing a popup). Always sign with a freshly resolved client.
  async function freshWalletClient(chainId: number) {
    if (walletClient && walletClient.chain?.id !== chainId) {
      await switchChainAsync({ chainId });
    }
    return (await getWalletClient(getWagmiConfig(), { chainId })) ?? walletClient ?? null;
  }

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
      if (me?.user) { setUser(me.user); setState("paywall"); }
      // Logged out → the normal login page (email + password + "wallet
      // instead" + create-account), then back to this exact share. A general
      // drive buyer gets the consistent login experience; a wallet-only user
      // still reaches SIWE via /login → "Sign in with a wallet instead".
      else router.replace(`/login?next=/s/${token}`);
    } else {
      setState("error");
    }
  }
  useEffect(() => { check(); }, [token]);

  // "Use a different account" on the paywall: sign out, then to /login so the
  // buyer can sign in as someone else and return to this exact share.
  async function switchAccount() {
    // Redirect even if the logout request errors — /login is a fresh page and a
    // stale cookie there just lands the buyer back on the paywall as themselves.
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch { /* ignore */ }
    router.replace(`/login?next=/s/${token}`);
  }

  const requirement = useMemo(() => {
    if (data && "accepts" in data && data.accepts?.[0]) return data.accepts[0];
    return null;
  }, [data]);

  // Human price label for the paywall. `$` prefix only for
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

  // Wallet capability probe: does the connected wallet accept an app-provided
  // ERC-7677 paymaster (Base Account passkey does; EOA extensions don't)? Only
  // probed when the server offered sponsorship, so EOA users never see a
  // capability request. Failure of any kind = not sponsored (self-paid path).
  const sponsorshipOffered = !!(data && "accepts" in data && data.gasSponsorship);
  useEffect(() => {
    if (!isPermit2 || !sponsorshipOffered || !walletClient || !requirementChain) {
      setGasSponsored(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const caps = await getCapabilities(walletClient, {
          account: walletClient.account,
          chainId: requirementChain.id,
        });
        const pm = (caps as { paymasterService?: { supported?: boolean } })?.paymasterService;
        if (!cancelled) setGasSponsored(pm?.supported === true);
      } catch {
        if (!cancelled) setGasSponsored(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isPermit2, sponsorshipOffered, walletClient, requirementChain]);

  // Sponsored approve: mint a sponsor grant for this sale, then send the
  // approve as an EIP-5792 call bundle whose gas the app's paymaster pays
  // (proxied through /api/paymaster, which enforces the grant). Returns true
  // when the approval landed; false = fall back to the self-paid path.
  async function approveSponsored(wc: ConnectedWalletClient, chain: Chain, epoch: number): Promise<boolean> {
    const grantRes = await fetch("/api/paymaster/grant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, wallet: wc.account.address }),
    });
    if (!grantRes.ok) return false;
    const g = (await grantRes.json()) as { grant: string; asset: string; amount: string; chainId: number };
    // The grant reflects the sale's CURRENT server-side quote; if it no longer
    // matches what this paywall displayed (owner repriced/re-tokened between
    // render and click), don't silently approve something else.
    if (
      !requirement ||
      g.asset.toLowerCase() !== requirement.asset.toLowerCase() ||
      g.chainId !== chain.id
    ) return false;
    const data = encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [PERMIT2_ADDRESS, BigInt(g.amount)],
    });
    const { id } = await sendCalls(wc, {
      account: wc.account,
      chain,
      calls: [{ to: g.asset as `0x${string}`, data }],
      capabilities: {
        paymasterService: { url: `${location.origin}/api/paymaster?g=${encodeURIComponent(g.grant)}` },
      },
    });
    const status = await waitForCallsStatus(wc, { id });
    if (epoch !== walletEpoch.current) return true; // cancelled — swallow, don't fall through to a second wallet prompt
    return status.status === "success";
  }

  // One-time on-chain approval that lets the Permit2 contract move this token
  // for the payer (the pay signature itself stays gasless).
  async function approve() {
    if (!walletClient || !publicClient || !requirement) { toast.error("Connect your wallet first"); return; }
    if (!requirementChain) { toast.error("Unsupported payment network"); return; }
    const epoch = ++walletEpoch.current;
    const hint = setTimeout(() => {
      if (epoch === walletEpoch.current) {
        toast("Wallet not showing a prompt? Check the popup blocker, or open the wallet extension manually.");
      }
    }, 15_000);
    setApproving(true);
    try {
      // The approval must mine on the token's chain; a wrong-chain approval
      // confirms fine but unlocks nothing. Switch first, then sign with a
      // fresh client (see freshWalletClient) and pass `chain` so viem refuses
      // to send if the wallet still disagrees.
      const wc = await freshWalletClient(requirementChain.id);
      if (!wc) { toast.error("Wallet connection lost — reconnect and retry"); return; }
      if (epoch !== walletEpoch.current) return; // cancelled during the switch
      // Sponsored path first (wallet + server both said yes): buyer needs zero
      // ETH. Any failure — grant refused, paymaster down/over budget, wallet
      // balking — degrades to the self-paid approve below with an honest toast,
      // never a dead button.
      if (gasSponsored) {
        try {
          if (await approveSponsored(wc, requirementChain, epoch)) {
            if (epoch !== walletEpoch.current) return;
            setApprovalNeeded(false);
            toast.success(`${tokenSymbol} approved — gas covered by aindrive. You can pay now.`);
            return;
          }
        } catch (e) {
          // A user who explicitly declined the sponsored (free) approve must NOT
          // be immediately re-prompted for a gas-costing one — surface it and
          // stop. Any other failure degrades to the self-paid path below.
          if (e instanceof UserRejectedRequestError) throw e;
        }
        if (epoch !== walletEpoch.current) return;
        toast(`Sponsored approval unavailable right now — approving normally instead (needs a little ETH for gas).`);
      }
      // Approve MaxUint256 to Permit2 (the x402 SDK default). Permit2 uses
      // SignatureTransfer, so this ERC-20 allowance is DRAWN DOWN by each
      // settle: an exact-amount approve hits 0 and forces a fresh approve tx
      // (and gas) on EVERY purchase, whereas a max approve is a ONE-TIME step —
      // every later purchase skips it (allowance pre-check above stays false).
      // Safe despite the wallet's "can withdraw all" warning: Permit2 still
      // requires the buyer's per-purchase EIP-712 signature (nonce+deadline+
      // amount) for any actual transfer, so the standing allowance moves nothing
      // on its own. This is the canonical Uniswap/Permit2 pattern.
      const data = encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [PERMIT2_ADDRESS, maxUint256],
      });
      const hash = await wc.sendTransaction({
        to: requirement.asset as `0x${string}`, data, chain: requirementChain,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      if (epoch !== walletEpoch.current) return; // cancelled while mining
      setApprovalNeeded(false);
      toast.success(`${tokenSymbol} approved — you can pay now.`);
    } catch (e) {
      if (epoch === walletEpoch.current) toast.error((e as Error).message || "approval failed");
    } finally {
      clearTimeout(hint);
      if (epoch === walletEpoch.current) setApproving(false);
    }
  }

  async function pay() {
    if (!walletClient) { toast.error("Connect your wallet first"); return; }
    if (!requirement) return;
    const epoch = ++walletEpoch.current;
    const hint = setTimeout(() => {
      if (epoch === walletEpoch.current) {
        toast("Wallet not showing a prompt? Check the popup blocker, or open the wallet extension manually.");
      }
    }, 15_000);
    setPaying(true);
    try {
      // Sign on the requirement's chain. The pay signature settles on
      // requirement.network regardless of the wallet's connected chain (the
      // EIP-712 domain carries it), but the wallet's CONFIRM popup shows its
      // *connected* network — if the bundle defaulted the wallet to the wrong
      // network (e.g. a testnet-built bundle on a mainnet server), the prompt
      // misleadingly reads "Base Sepolia". Switching first keeps the prompt
      // honest, and signing happens on a FRESH client — the closure-captured
      // one stays bound to the pre-switch chain, which some wallets handle by
      // silently queueing the request (reported as "pay popup never shows").
      const wc = requirementChain ? await freshWalletClient(requirementChain.id) : walletClient;
      if (!wc) { toast.error("Wallet connection lost — reconnect and retry"); return; }
      if (epoch !== walletEpoch.current) return; // cancelled during the switch
      const displayed = requirement;
      const displayedMax = BigInt(displayed.amount);
      const client = new x402Client();
      client.register("eip155:*", new ExactEvmScheme(walletClientToSigner(wc)));
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
      if (epoch !== walletEpoch.current) return; // cancelled — ignore the late result
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
      if (epoch === walletEpoch.current) toast.error((e as Error).message || "payment failed");
    } finally {
      clearTimeout(hint);
      if (epoch === walletEpoch.current) setPaying(false);
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

  // ── Paywall: paid content, visitor signed in. The purchase binds to the
  //    session account (shown below, with a "use a different account" switch);
  //    logged-out visitors are redirected to /login by check() before here. ───
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
            One payment grants your account permanent access to this shared content.
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
            {/* No chain switcher: the paywall pins on-chain work to the sale's
                chain (pay/approve switch before signing) and shows the network
                in the price card, so a chooser here is an inert no-op. */}
            <ConnectButton showBalance={false} chainStatus="none" />
          </div>
          {walletConnecting ? (
            // Post-redirect rehydration gap (wallet app → back to aindrive):
            // an explicit "connecting" state so the ~seconds before the
            // address resolves don't read as a failed connect.
            <Button variant="filled" size="md" loading disabled className="w-full justify-center">
              Connecting your wallet…
            </Button>
          ) : isConnected && isPermit2 && approvalNeeded ? (
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
                {approving ? "Approving…" : `Approve ${tokenSymbol}`}
              </Button>
              <p className="text-caption text-drive-muted text-center">
                Step 1 of 2 — a one-time approval of {tokenSymbol} to Permit2 (the standard payment router). You’ll never approve again, and every purchase still needs your signature, so nothing moves without you.
                {gasSponsored && (
                  <>
                    {" "}
                    <span className="text-drive-accent font-medium">
                      Gas is covered by aindrive — you only need {tokenSymbol}.
                    </span>
                  </>
                )}
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
          {(paying || approving) && (
            <button
              onClick={cancelWalletWait}
              className="text-caption text-drive-muted hover:text-drive-text underline underline-offset-2 self-center"
            >
              Waiting for your wallet… Cancel
            </button>
          )}
        </div>

        <p className="mt-4 flex items-center justify-center gap-1.5 text-caption text-drive-muted text-center">
          <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
          Permanent access on your account. No refunds.
        </p>
        {user && (
          <p className="mt-2 text-caption text-drive-muted text-center">
            Signed in as {walletDisplayLabel(user.email, user.name)}.{" "}
            <button onClick={switchAccount} className="underline underline-offset-2 hover:text-drive-text">
              Use a different account
            </button>
          </p>
        )}
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
