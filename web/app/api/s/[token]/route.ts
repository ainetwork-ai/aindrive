import { ainuiPayment } from "@/shared/a2ui/payment";
import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements, PaymentRequired, PaymentPayload } from "@x402/core/types";
import { canSettle, verifyAndSettle } from "@/lib/x402-facilitator";
import { db } from "@/lib/db";
import { setWalletCookie, resolveAccountForWallet } from "@/lib/wallet";
import { getUser } from "@/lib/session";
import { ACCOUNT_ACCESS_PREFIX, verifyAccountToken } from "@/lib/account-tokens";
import { bearerFrom } from "@/lib/mcp-http";
import { resolveRoleByUser, type Role } from "@/lib/access";
import { holdsPaidShare } from "@/lib/sale-access.js";
import { mergeRoleUpgradeOnly } from "@/lib/access-core.js";
import { getDriveNamespace, payoutWalletFor } from "@/lib/drives";
import { issueShareCap } from "@/lib/willow/cap-issue";
import { onPaymentSettled } from "@/lib/payment-hooks";
import { TOKEN_PRESETS, resolveDriveTokens, toAtomicAmount, toCaip2Network, paymentNetwork, policyChainViolation } from "@/lib/payment-tokens";
import { paymasterEnabled } from "@/lib/paymaster";

// The facilitator (resolution, verify→settle with timeouts and retries, the
// dev bypass) lives in lib/x402-facilitator.ts, shared with the x402_settle skill.

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

  // A relaying app (server-to-server, no cookie) may send the buyer's
  // account-grant token: the purchase is then credited to THAT account
  // instead of the payer wallet's. Other Authorization values are ignored. A
  // bad aind_aat_ token is refused before any payment moves, so a relayed
  // purchase is never silently credited to a different account.
  let bearerAccountId: string | null = null;
  const bearer = bearerFrom(req);
  if (bearer?.startsWith(ACCOUNT_ACCESS_PREFIX)) {
    const grant = verifyAccountToken(bearer);
    if (!grant) {
      return NextResponse.json(
        { error: "invalid_token", error_description: "account token is invalid, expired or revoked" },
        { status: 401 },
      );
    }
    bearerAccountId = grant.userId;
  }

  // The account this request buys for: the relayed bearer, else the session.
  const user = await getUser();
  const buyerId = bearerAccountId ?? user?.id ?? null;

  // Owner bypass
  if (buyerId && buyerId === share.owner_id) return NextResponse.json(okBody);

  // Free share: return okBody; the CONSUME flow (POST /accept) writes the
  // real drive_members grant. No cookie needed — login-first accept is the
  // canonical path.
  if (!share.price_usdc) {
    return NextResponse.json(okBody);
  }

  // Already-entitled member: nothing to pay for when the account already holds
  // what this link sells (holdsPaidShare) — share.role, not a viewer floor, so
  // a cheaper grant can't satisfy a higher tier; and past the paid read gate,
  // so a bare viewer of a parent folder still pays. Mirrors the accept gate.
  if (buyerId) {
    const role = resolveRoleByUser(share.drive_id, buyerId, share.path);
    if (holdsPaidShare(share.drive_id, share, role, buyerId)) return NextResponse.json({ ...okBody, role });
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
  // Flow hint for the gate UI (see paymentGate body): sponsored approves exist
  // for permit2 sales when a paymaster is configured. Computed here where `tok`
  // is narrowed — the hoisted paymentGate closure can't see the guard above.
  const gasSponsorship = paymasterEnabled() && tok.transferMethod === "permit2";

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
    const paymentRequiredHeader = encodePaymentRequiredHeader(paymentRequired);
    return NextResponse.json(
      // gasSponsorship: display/flow hint like `currency` — tells the gate UI a
      // sponsored (buyer pays no gas) approve MAY be available for this permit2
      // sale, if the buyer's wallet supports paymasterService (share-gate probes).
      {
        x402Version: 2,
        accepts: [requirements],
        currency: payCurrency,
        gasSponsorship,
        ...(req.headers.get("x-ainui") === "1" ? { messages: ainuiPayment({
          shareToken: token, title: "Unlock permanent access", required: paymentRequired,
          paymentRequired: paymentRequiredHeader, symbol: tok!.symbol, decimals: tok!.decimals,
        }) } : {}),
        error,
      },
      { status, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader } },
    );
  }

  // Fail fast when the server cannot settle (mainnet without a configured
  // facilitator): better a clear 503 on the FIRST hit than showing the paywall,
  // collecting a signed authorization, and only then failing. DEV_BYPASS skips
  // the facilitator entirely, so it stays exempt.
  if (!canSettle()) {
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

  const settled = await verifyAndSettle(payload, requirements, `share ${token} token=${tok.symbol} method=${tok.transferMethod}`);
  if (!settled.ok) {
    if (settled.status === 503) return NextResponse.json({ error: settled.reason }, { status: 503 });
    // Spec: missing Permit2 allowance is a precondition failure (412), not a
    // payment rejection — the gate UI answers it with the approve flow.
    return paymentGate(settled.status, settled.reason);
  }
  const payerWallet = settled.payer;
  const txHash = settled.transaction;

  // Resolve the account this payment credits: a relayed bearer account or a
  // logged-in user wins; else the wallet's linked account; else a freshly
  // minted wallet-only account.
  //
  // Crash-safe: the on-chain settle above is irreversible, so a throw here must
  // never surface as a 500 + partial state. We log and fall through so the
  // handler always returns 200 with the txHash; the receipt write below still
  // runs (account_id may stay null — the column is nullable).
  let settleAccountId: string | null = null;
  try {
    settleAccountId = buyerId ?? resolveAccountForWallet(payerWallet);
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
      "INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, currency, network, share_id, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(nanoid(12), share.drive_id, share.path, payerWallet, txHash, share.price_usdc, tok.symbol, tok.chain, share.id, settleAccountId);
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
    currency: tok.symbol,
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
