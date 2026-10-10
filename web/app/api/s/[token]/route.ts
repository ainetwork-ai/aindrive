import { ainuiPayment } from "@/shared/a2ui/payment";
import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements, PaymentRequired, PaymentPayload } from "@x402/core/types";
import { DEV_BYPASS, canSettle, verifyAndSettle, type SettleOutcome } from "@/lib/x402-facilitator";
import { db } from "@/lib/db";
import { setWalletCookie, resolveAccountForWallet } from "@/lib/wallet";
import { getUser } from "@/lib/session";
import { ACCOUNT_ACCESS_PREFIX, verifyAccountToken } from "@/lib/account-tokens";
import { bearerFrom } from "@/lib/mcp-http";
import { personalRoleByUser, resolveRoleByUser, type Role } from "@/lib/access";
import { holdsPaidShare } from "@/lib/sale-access.js";
import { mergeRoleUpgradeOnly } from "@/lib/access-core.js";
import { getDriveNamespace, payoutWalletFor } from "@/lib/drives";
import { issueShareCap } from "@/lib/willow/cap-issue";
import { onPaymentSettled } from "@/lib/payment-hooks";
import { TOKEN_PRESETS, resolveDriveTokens, toAtomicAmount, toCaip2Network, paymentNetwork, policyChainViolation } from "@/lib/payment-tokens";
import { paymasterEnabled } from "@/lib/paymaster";
import { onMemberGranted } from "@/lib/share-events";
import {
  creditSettlement, eip3009Authorization, findSettlement, getSettlement, isAmbiguousPayload, isSameSale, noteUncertain,
  openSettlementFor, recordBeforeSettle, releaseSettlement, supportUrl,
  type Eip3009Authorization, type RecordResult, type SaleRef, type SettlementRow,
} from "@/lib/x402-account-settlements.js";

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

  // A payload carrying both an EIP-3009 and a Permit2 authorization is
  // ambiguous: the facilitator picks its path from the payload's shape, so it
  // could settle a different authorization than the one checked here.
  if (isAmbiguousPayload(payload)) {
    return NextResponse.json(
      { error: "ambiguous_payment_payload", error_description: "the payment payload carries both an EIP-3009 and a Permit2 authorization; send exactly one" },
      { status: 400 },
    );
  }

  const label = `share ${token} token=${tok.symbol} method=${tok.transferMethod}`;

  // After a settle this request is answered for: the payment hook, the Willow
  // read cap, and the 200 body.
  async function granted(txHash: string, wallet: string) {
    await onPaymentSettled({
      driveId: share!.drive_id,
      path: share!.path,
      wallet,
      txHash,
      amountUsdc: share!.price_usdc!,
      currency: tok!.symbol,
      network: tok!.chain,
    });

    let capBase64: string | null = null;
    const ns = getDriveNamespace(share!.drive_id);
    if (ns) {
      try {
        const issued = await issueShareCap({
          namespacePub: ns.pub,
          namespaceSecret: ns.secret,
          pathPrefix: share!.path,
          accessMode: "read",
        });
        capBase64 = issued.capBase64;
      } catch (e) {
        console.warn("cap issuance failed:", (e as Error).message);
      }
    }
    return NextResponse.json({ ...okBody, txHash, cap: capBase64 });
  }

  // Authenticated accounts: no second charge while an earlier settle of theirs
  // for this sale has no known outcome (lib/x402-account-settlements.js,
  // docs/X402_PAYMENT_PENDING.md). Nothing here reads the chain or sets the
  // wallet cookie. Anonymous and wallet-cookie buyers: the flow below, unchanged.
  if (buyerId) {
    const sale: SaleRef = { shareId: share.id, driveId: share.drive_id, path: share.path, role: share.role };
    if (tok.transferMethod === "eip3009") {
      const auth = eip3009Authorization(payload);
      // Fail closed: an account's payment this parser cannot read never reaches
      // the unguarded flow. DEV_BYPASS (local demos, no money) accepts any JSON.
      if (auth || !DEV_BYPASS) return accountEip3009Purchase(buyerId, sale, auth);
    } else {
      // A Permit2 sale records nothing, but an unresolved EIP-3009 attempt for
      // the same sale (e.g. before the owner changed the currency) still blocks.
      const open = openSettlementFor(buyerId, sale);
      if (open) return paymentPending(open);
    }
  }

  function paymentPending(row: SettlementRow, reason?: string) {
    return NextResponse.json(
      {
        error: "payment_pending",
        error_description: "An earlier payment for this purchase has no confirmed result yet, so a new payment is not taken (you are not charged again). Resend the same payment, or contact support with this reference.",
        reference: row.id,
        support_url: supportUrl(row.id),
        payer: row.payer,
        nonce: row.nonce,
        ...(reason ? { reason } : {}),
      },
      { status: 409 },
    );
  }

  async function accountEip3009Purchase(accountId: string, sale: SaleRef, auth: Eip3009Authorization | null) {
    if (!auth) return paymentGate(402, "invalid PAYMENT-SIGNATURE payload: not an EIP-3009 authorization");
    const key = { network: requirements.network, asset: tok!.asset, payer: auth.from, nonce: auth.nonce };
    const inUse = () => NextResponse.json(
      { error: "authorization_in_use", error_description: "this payment authorization belongs to another purchase; sign a new one" },
      { status: 409 },
    );
    // This server's settle answered success: receipt + membership + credited, in one transaction.
    const creditAndGrant = async (rowId: string, settled: Extract<SettleOutcome, { ok: true }>) => {
      let c: ReturnType<typeof creditSettlement>;
      try {
        c = creditSettlement({ id: rowId, txHash: settled.transaction, wallet: settled.payer, actor: "server" });
      } catch (e) {
        // The transfer happened; the row stays unresolved (blocks a second charge) for support.
        console.error(`[x402-account] credit failed row=${rowId} tx=${settled.transaction} account=${accountId}`, e);
        c = { ok: false, reason: "the payment could not be recorded" };
      }
      if (!c.ok) {
        console.error(`[x402-account] settled but not credited row=${rowId} tx=${settled.transaction} account=${accountId} share=${share!.id}: ${c.reason}`);
        try { noteUncertain(rowId, `settled ${settled.transaction} but not credited: ${c.reason}`); } catch { /* logged above */ }
        return NextResponse.json(
          { error: "payment_conflict", error_description: `${c.reason} — contact support with this reference`, txHash: settled.transaction, reference: rowId, support_url: supportUrl(rowId) },
          { status: 409 },
        );
      }
      if (!c.already) onMemberGranted(c.row.drive_id, accountId, c.row.path);
      // No wallet cookie: the account's membership is the entitlement.
      return granted(c.txHash, settled.payer);
    };

    const existing = findSettlement(key);
    if (existing) {
      const mine = existing.account_id === accountId && isSameSale(existing, sale) && existing.envelope_hash === auth.envelopeHash;
      if (!mine) return inUse();
      if (existing.status === "credited") {
        return NextResponse.json(
          { error: "already_credited", error_description: "this payment was already credited to your account", txHash: existing.tx_hash, reference: existing.id },
          { status: 409 },
        );
      }
      if (existing.status === "released") {
        return NextResponse.json(
          { error: "authorization_released", error_description: "this payment attempt was closed without a charge; sign a new one", reference: existing.id },
          { status: 409 },
        );
      }
      // The same account resends the same envelope: settling it again cannot
      // move money twice (one nonce, one transfer). Success credits; anything
      // else leaves the row unresolved.
      const again = await verifyAndSettle(payload, requirements, label, {
        beforeSettle: () => (getSettlement(existing.id)?.status === "unresolved" ? null : "resolved"),
      });
      if (again.ok) return creditAndGrant(existing.id, again);
      const now = getSettlement(existing.id)!;
      if (now.status === "credited") return NextResponse.json({ ...okBody, txHash: now.tx_hash, cap: null });
      if (now.status === "released") {
        return NextResponse.json(
          { error: "authorization_released", error_description: "this payment attempt was closed without a charge; sign a new one", reference: now.id },
          { status: 409 },
        );
      }
      if (again.settle !== "not_sent") noteUncertain(now.id, again.reason);
      return paymentPending(now, again.reason);
    }

    // A new authorization.
    const open = openSettlementFor(accountId, sale);
    if (open) return paymentPending(open);
    let recorded: RecordResult | null = null;
    const settled = await verifyAndSettle(payload, requirements, label, {
      beforeSettle: () => {
        recorded = recordBeforeSettle(
          {
            ...key, accountId, envelopeHash: auth.envelopeHash, validBefore: auth.validBefore,
            sale: {
              ...sale, amountUsdc: share!.price_usdc!, currency: tok!.symbol, chain: tok!.chain,
              payTo: requirements.payTo, amountAtomic: requirements.amount,
            },
          },
          () => holdsPaidShare(share!.drive_id, share!, resolveRoleByUser(share!.drive_id, accountId, share!.path), accountId),
        );
        return recorded.kind === "recorded" ? null : recorded.kind;
      },
    });
    const rec = recorded as RecordResult | null;
    if (settled.ok) {
      if (rec?.kind !== "recorded") {
        // Unreachable: the hook runs before every settle. Never credit without a row.
        console.error(`[x402-account] settled without a recorded attempt tx=${settled.transaction} account=${accountId} share=${share!.id}`);
        return NextResponse.json(
          { error: "payment_conflict", error_description: "settled without a recorded attempt — contact support", txHash: settled.transaction, support_url: supportUrl(settled.transaction) },
          { status: 409 },
        );
      }
      return creditAndGrant(rec.row.id, settled);
    }
    if (rec?.kind === "conflict") return inUse();
    if (rec?.kind === "pending") return paymentPending(rec.row);
    if (rec?.kind === "held") return NextResponse.json({ ...okBody, role: resolveRoleByUser(share!.drive_id, accountId, share!.path) });
    if (rec?.kind === "recorded") {
      if (settled.settle === "refused") {
        // The facilitator refused the only settle request before broadcasting:
        // this authorization moved nothing, so a new one may be signed.
        releaseSettlement({ id: rec.row.id, actor: "server", reason: `settle refused before broadcast: ${settled.reason}` });
        return paymentGate(402, settled.reason);
      }
      noteUncertain(rec.row.id, settled.reason);
      return paymentPending(getSettlement(rec.row.id) ?? rec.row, settled.reason);
    }
    // No row: verify refused or the facilitator was unreachable (nothing was
    // sent to settle), or recording failed — today's answers.
    if (settled.status === 503) return NextResponse.json({ error: settled.reason }, { status: 503 });
    return paymentGate(settled.status === 412 ? 412 : 402, settled.reason);
  }

  const settled = await verifyAndSettle(payload, requirements, label);
  if (!settled.ok) {
    if (settled.status === 503) return NextResponse.json({ error: settled.reason }, { status: 503 });
    // Spec: missing Permit2 allowance is a precondition failure (412), not a
    // payment rejection — the gate UI answers it with the approve flow.
    return paymentGate(settled.status === 412 ? 412 : 402, settled.reason);
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
    // single-process, so nothing interleaves between the read and the INSERT.
    // Revisit if this moves to multi-process/pooled access. The merge reads
    // the buyer's OWN grants (personalRoleByUser): an organization's role is
    // live and must not be written down here as a durable member row that
    // outlives the membership.
    const currentRole = personalRoleByUser(share.drive_id, settleAccountId, share.path);
    const mergedRole = mergeRoleUpgradeOnly(currentRole, share.role);
    db.prepare(
      `INSERT INTO drive_members (id, drive_id, user_id, path, role)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(drive_id, user_id, path) DO UPDATE SET role = excluded.role`
    ).run(nanoid(12), share.drive_id, settleAccountId, share.path, mergedRole);
    // Change feed: the buyer's account hears `file.shared` (origin paid) for the sold path.
    onMemberGranted(share.drive_id, settleAccountId, share.path);
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
  return granted(txHash, payerWallet);
}
