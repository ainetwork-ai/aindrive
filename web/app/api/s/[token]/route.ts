import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements, PaymentRequired, PaymentPayload } from "@x402/core/types";
import { createFacilitatorConfig } from "@coinbase/x402";
import { db } from "@/lib/db";
import { setWalletCookie, resolveAccountForWallet } from "@/lib/wallet";
import { getUser } from "@/lib/session";
import { resolveRoleByUser, atLeast, type Role } from "@/lib/access";
import { mergeRoleUpgradeOnly } from "@/lib/access-core.js";
import { getDriveNamespace, payoutWalletFor } from "@/lib/drives";
import { issueShareCap } from "@/lib/willow/cap-issue";
import { onPaymentSettled } from "@/lib/payment-hooks";
import { TOKEN_PRESETS, resolveDriveTokens, toAtomicAmount, toCaip2Network, paymentNetwork, policyChainViolation } from "@/lib/payment-tokens";

// Facilitator that verifies/settles the x402 payment, in priority order:
// explicit AINDRIVE_X402_FACILITATOR URL (self-hosted or any third party),
// CDP API keys (Coinbase facilitator — URL + per-request JWT auth built in),
// then the public x402.org default on testnet only. Mainnet has NO default —
// silently settling real money through a guessed facilitator is exactly the
// failure mode we refuse (503 below). Server-only env (never NEXT_PUBLIC).
function resolveFacilitatorConfig(): ConstructorParameters<typeof HTTPFacilitatorClient>[0] | null {
  if (process.env.AINDRIVE_X402_FACILITATOR) return { url: process.env.AINDRIVE_X402_FACILITATOR };
  if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) {
    return createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET);
  }
  return paymentNetwork() === "mainnet" ? null : { url: "https://x402.org/facilitator" };
}
const DEV_BYPASS = process.env.AINDRIVE_DEV_BYPASS_X402 === "1";

// Payer address from a v2 exact-evm payload: eip3009 payloads carry
// authorization.from, permit2 payloads permit2Authorization.from.
function payerFromPayload(payload: PaymentPayload): string | undefined {
  const p = payload?.payload as
    | { authorization?: { from?: string }; permit2Authorization?: { from?: string } }
    | undefined;
  return p?.authorization?.from ?? p?.permit2Authorization?.from;
}

type ShareRow = {
  id: string;
  drive_id: string;
  path: string;
  role: Role;
  expires_at: string | null;
  price_usdc: number | null;
  currency: string | null;
};

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const share = db.prepare(`
    SELECT s.id, s.drive_id, s.path, s.role, s.expires_at, s.price_usdc, s.currency,
           d.name AS drive_name, d.owner_id, d.payout_wallet, d.allowed_tokens
    FROM shares s JOIN drives d ON d.id = s.drive_id
    WHERE s.token = ?
  `).get(token) as (ShareRow & { drive_name: string; owner_id: string; payout_wallet: string | null; allowed_tokens: string | null }) | undefined;

  if (!share) return NextResponse.json({ error: "share not found" }, { status: 404 });
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return NextResponse.json({ error: "share expired" }, { status: 410 });
  }

  const okBody = {
    ok: true as const,
    driveId: share.drive_id,
    driveName: share.drive_name,
    path: share.path,
    role: share.role,
  };

  // Owner bypass
  const user = await getUser();
  if (user && user.id === share.owner_id) return NextResponse.json(okBody);

  // Free share: return okBody; the CONSUME flow (POST /accept) writes the
  // real drive_members grant. No cookie needed — login-first accept is the
  // canonical path.
  if (!share.price_usdc) {
    return NextResponse.json(okBody);
  }

  // Already-entitled member: a covering drive_members grant (from a prior
  // payment that settled, or an owner invite) means there's nothing to pay
  // for. Compare against share.role (not a viewer floor) so a cheaper/free
  // grant at this path can't satisfy a higher-tier paid share — mirrors the
  // CONSUME accept gate.
  if (user) {
    const role = resolveRoleByUser(share.drive_id, user.id, share.path);
    if (atLeast(role, share.role)) return NextResponse.json({ ...okBody, role });
  }

  // Resolve the share's payment token against the drive's policy.
  // [rev2-G] Legacy shares (currency NULL, pre-policy) fall back to the USDC
  // preset — byte-identical to the old hardcoded constants. A non-NULL
  // currency must still be allowed by the drive's policy; an unconditional
  // USDC fallback here would re-quote a removed currency's price in a
  // different unit, so a policy miss is a hard 410 instead.
  const tokens = resolveDriveTokens(share.allowed_tokens);
  const tok = share.currency == null
    ? TOKEN_PRESETS.USDC
    : tokens.find((t) => t.symbol === share.currency);
  if (!tok) {
    return NextResponse.json(
      { error: "share currency no longer allowed by drive policy" },
      { status: 410 }
    );
  }
  // Chain guard for policies stored before the PATCH-time check existed: a
  // mainnet deployment must never quote (or settle) on a testnet chain —
  // buyers would pay worthless coins for real content.
  if (policyChainViolation([tok])) {
    return NextResponse.json(
      { error: `this sale's token is on ${tok.chain}, which a mainnet deployment cannot settle` },
      { status: 503 },
    );
  }

  // Build x402 payment requirements. payTo resolves to the nearest ANCESTOR
  // folder's payout wallet for this share's path (set by the owner in the
  // folder's Share panel; falls back through parents to the drive root). A
  // wallet is required before a paid share can be created, so it's normally
  // present; the zero-address last resort only triggers for a legacy share
  // predating the gate — the facilitator rejects it rather than misrouting.
  const payTo = payoutWalletFor(share.drive_id, share.path) || "0x0000000000000000000000000000000000000000";
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: toCaip2Network(tok.chain),
    amount: toAtomicAmount(share.price_usdc, tok.decimals),
    payTo,
    maxTimeoutSeconds: 300,
    asset: tok.asset,
    // Asset-transfer method per the token's capability. eip3009 needs the
    // TOKEN's EIP-712 domain (name/version) so the client can sign
    // transferWithAuthorization; permit2 signs against the Permit2 contract's
    // own domain, so no token domain is sent — omitting name/version also
    // tells the client "no EIP-2612 gas-sponsored approval, payer approves
    // on-chain themselves".
    extra: tok.transferMethod === "permit2"
      ? { assetTransferMethod: "permit2" }
      : { assetTransferMethod: "eip3009", name: tok.name, version: tok.version },
  };
  // Display-only companion to `accepts`: share-gate reads symbol/decimals to
  // render the amount; the x402 client only consumes the PAYMENT-REQUIRED header.
  const payCurrency = { symbol: tok.symbol, decimals: tok.decimals };

  // 402/412 response: protocol payload travels in the v2 PAYMENT-REQUIRED
  // header; the JSON body is OUR gate UI's render data (v2 leaves bodies to
  // the server). 412 is the spec's status for permit2_allowance_required —
  // the client reacts by running the one-time approve flow, then retries.
  function paymentGate(status: 402 | 412, error: string) {
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      error,
      resource: { url: req.url, description: `aindrive: access to share ${token}`, mimeType: "application/json" },
      accepts: [requirements],
    };
    return NextResponse.json(
      { x402Version: 2, accepts: [requirements], currency: payCurrency, error },
      { status, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) } },
    );
  }

  // Fail fast when the server cannot settle (mainnet without a configured
  // facilitator): better a clear 503 on the FIRST hit than showing the paywall,
  // collecting a signed authorization, and only then failing. DEV_BYPASS skips
  // the facilitator entirely, so it stays exempt.
  const facilitatorConfig = resolveFacilitatorConfig();
  if (!DEV_BYPASS && !facilitatorConfig) {
    console.error("[x402] no facilitator configured for mainnet — set AINDRIVE_X402_FACILITATOR or CDP_API_KEY_ID/SECRET");
    return NextResponse.json(
      { error: "payments are not configured on this server" },
      { status: 503 },
    );
  }

  const paymentSig = req.headers.get("PAYMENT-SIGNATURE");
  if (!paymentSig) {
    return paymentGate(402, "PAYMENT-SIGNATURE header is required");
  }

  // Decode the payment payload (base64 JSON; no schema validation here — the
  // facilitator is the authority on payload validity, and DEV_BYPASS accepts
  // any well-formed JSON so local demos don't need real signatures).
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(paymentSig);
  } catch {
    return paymentGate(402, "invalid PAYMENT-SIGNATURE header");
  }

  let payerWallet: string;
  let txHash: string;

  if (DEV_BYPASS) {
    payerWallet = (
      payerFromPayload(payload) || "0xdemodemodemodemodemodemodemodemodemo0000"
    ).toLowerCase();
    txHash = "0xdev_bypass_" + nanoid(20);
    console.warn(`[x402 DEV BYPASS] accepting share ${token} from ${payerWallet}`);
  } else {
    // Run fn with an AbortController that fires after `ms` ms.
    async function withTimeout<T>(
      ms: number,
      fn: (signal: AbortSignal) => Promise<T>,
    ): Promise<{ ok: true; value: T } | { ok: false; timedOut: boolean; error: unknown }> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), ms);
      try {
        const value = await fn(ac.signal);
        return { ok: true, value };
      } catch (e) {
        return { ok: false, timedOut: ac.signal.aborted, error: e };
      } finally {
        clearTimeout(timer);
      }
    }

    // True for network/timeout errors that warrant a retry.
    function isFacilitatorUnavailable(e: unknown): boolean {
      if (e instanceof Error) {
        const n = e.name;
        return n === "AbortError" || n === "TimeoutError" || n === "TypeError";
      }
      return false;
    }

    // Strip wallet addresses and cap length for safe user-facing messages.
    function sanitizeSettleError(msg: string): string {
      return msg.replace(/0x[0-9a-fA-F]{40,}/g, "0x\u2026").slice(0, 200);
    }

    const facilitator = new HTTPFacilitatorClient(facilitatorConfig!);

    // --- verify: 10 s timeout, one retry on facilitator error ---
    type VerifyResult = Awaited<ReturnType<typeof facilitator.verify>>;
    let verifyRes: VerifyResult | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await withTimeout<VerifyResult>(10_000, (_signal) =>
        facilitator.verify(payload, requirements),
      );
      if (r.ok) { verifyRes = r.value; break; }
      if (!isFacilitatorUnavailable(r.error) || attempt === 1) {
        return paymentGate(402, "facilitator unavailable, please retry");
      }
    }
    if (!verifyRes) {
      return paymentGate(402, "facilitator unavailable, please retry");
    }
    if (!verifyRes.isValid) {
      const reason = verifyRes.invalidReason || "verification failed";
      // Spec: missing Permit2 allowance is a precondition failure (412), not a
      // payment rejection — the gate UI answers it with the approve flow.
      return paymentGate(reason === "permit2_allowance_required" ? 412 : 402, reason);
    }

    // --- settle: 15 s timeout, one retry on facilitator error ---
    type SettleResult = Awaited<ReturnType<typeof facilitator.settle>>;
    let settleRes: SettleResult | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await withTimeout<SettleResult>(15_000, (_signal) =>
        facilitator.settle(payload, requirements),
      );
      if (r.ok) { settleRes = r.value; break; }
      if (!isFacilitatorUnavailable(r.error) || attempt === 1) {
        return paymentGate(402, "facilitator unavailable, please retry");
      }
    }
    if (!settleRes) {
      return paymentGate(402, "facilitator unavailable, please retry");
    }
    if (!settleRes.success) {
      return paymentGate(402, sanitizeSettleError(settleRes.errorReason || "settlement failed"));
    }
    payerWallet = (settleRes.payer || payerFromPayload(payload) || "0x0").toLowerCase();
    txHash = settleRes.transaction;
  }

  // Resolve the account this payment credits: a logged-in user wins; else the
  // wallet's linked account; else a freshly minted wallet-only account.
  //
  // Crash-safe: the on-chain settle above is irreversible, so a throw here must
  // never surface as a 500 + partial state. We log and fall through so the
  // handler always returns 200 with the txHash; the receipt write below still
  // runs (account_id may stay null — the column is nullable).
  let settleAccountId: string | null = null;
  try {
    settleAccountId = user?.id ?? resolveAccountForWallet(payerWallet);
    // UPGRADE-ONLY grant: never downgrade a member who already holds a higher
    // role at this path (e.g. an owner-added editor paying through a viewer
    // share). mergeRoleUpgradeOnly returns the higher of current/incoming.
    // Safe read-then-merge-then-write: better-sqlite3 is synchronous and
    // single-process, so nothing interleaves between the resolveRoleByUser
    // read and the INSERT. Revisit if this moves to multi-process/pooled access.
    const currentRole = resolveRoleByUser(share.drive_id, settleAccountId, share.path);
    const mergedRole = mergeRoleUpgradeOnly(currentRole, share.role);
    db.prepare(
      `INSERT INTO drive_members (id, drive_id, user_id, path, role)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(drive_id, user_id, path) DO UPDATE SET role = excluded.role`
    ).run(nanoid(12), share.drive_id, settleAccountId, share.path, mergedRole);
  } catch (e) {
    console.error(`[paid-grant] post-settle drive_members write failed — tx=${txHash} payer=${payerWallet}`, e);
  }

  try {
    db.prepare(
      "INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, network, share_id, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(nanoid(12), share.drive_id, share.path, payerWallet, txHash, share.price_usdc, tok.chain, share.id, settleAccountId);
  } catch (e) {
    if (!/UNIQUE/i.test((e as Error).message)) throw e;
    // Same on-chain tx already recorded. Log so observability shows
    // replay-vs-bug — assume replay but make it auditable.
    console.warn(`[receipts] tx_hash UNIQUE collision — assuming replay: ${txHash} share=${share.id} payer=${payerWallet}`);
  }
  await setWalletCookie(payerWallet);

  await onPaymentSettled({
    driveId: share.drive_id,
    path: share.path,
    wallet: payerWallet,
    txHash,
    amountUsdc: share.price_usdc,
    network: tok.chain,
  });

  let capBase64: string | null = null;
  const ns = getDriveNamespace(share.drive_id);
  if (ns) {
    try {
      const issued = await issueShareCap({
        namespacePub: ns.pub,
        namespaceSecret: ns.secret,
        pathPrefix: share.path,
        accessMode: "read",
      });
      capBase64 = issued.capBase64;
    } catch (e) {
      console.warn("cap issuance failed:", (e as Error).message);
    }
  }

  return NextResponse.json({ ...okBody, txHash, cap: capBase64 });
}
