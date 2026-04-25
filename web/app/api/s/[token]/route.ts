import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { useFacilitator } from "x402/verify";
import { safeBase64Decode } from "x402/shared";
import { PaymentPayloadSchema, type PaymentRequirements } from "x402/types";
import { db } from "@/lib/db";
import { getWallet, setWalletCookie } from "@/lib/wallet";
import { getUser } from "@/lib/session";
import { resolveRoleByWallet, atLeast, type Role } from "@/lib/access";
import { getDriveNamespace } from "@/lib/drives";
import { issueShareCap } from "@/lib/willow/cap-issue";
import { onPaymentSettled } from "@/lib/payment-hooks";

const X402_NETWORK = "base-sepolia" as const;
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FACILITATOR_URL = (process.env.AINDRIVE_X402_FACILITATOR ||
  "https://x402.org/facilitator") as `${string}://${string}`;
const DEV_BYPASS = process.env.AINDRIVE_DEV_BYPASS_X402 === "1";

type ShareRow = {
  id: string;
  drive_id: string;
  path: string;
  role: Role;
  expires_at: string | null;
  price_usdc: number | null;
  payment_chain: string | null;
};

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const share = db.prepare(`
    SELECT s.id, s.drive_id, s.path, s.role, s.expires_at, s.price_usdc, s.payment_chain,
           d.name AS drive_name, d.owner_id
    FROM shares s JOIN drives d ON d.id = s.drive_id
    WHERE s.token = ?
  `).get(token) as (ShareRow & { drive_name: string; owner_id: string }) | undefined;

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

  // Free share
  if (!share.price_usdc) return NextResponse.json(okBody);

  // Paid share — check existing wallet allowlist with prefix matching
  const wallet = await getWallet();
  if (wallet) {
    const role = resolveRoleByWallet(share.drive_id, wallet, share.path);
    if (atLeast(role, "viewer")) return NextResponse.json({ ...okBody, role });
  }

  // Build x402 payment requirements
  const payTo = process.env.AINDRIVE_PAYOUT_WALLET || "0x0000000000000000000000000000000000000000";
  const microAmount = Math.round(share.price_usdc * 1_000_000).toString();
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: X402_NETWORK,
    maxAmountRequired: microAmount,
    resource: req.url as `${string}://${string}`,
    description: `aindrive: access to share ${token}`,
    mimeType: "application/json",
    payTo,
    maxTimeoutSeconds: 300,
    asset: USDC_BASE_SEPOLIA,
    // ERC-3009 EIP-712 domain for the asset above. Required by the x402
    // exact-evm scheme so the client can sign transferWithAuthorization;
    // facilitator rejects the request as `invalid_exact_evm_missing_eip712_domain`
    // when this is absent.
    extra: {
      name: "USDC",
      version: "2",
    },
  };

  const xPayment = req.headers.get("X-PAYMENT");
  if (!xPayment) {
    return NextResponse.json(
      { x402Version: 1, accepts: [requirements], error: "X-PAYMENT header is required" },
      { status: 402 }
    );
  }

  // Decode + validate payment payload.
  // In DEV_BYPASS we accept any well-formed JSON so local demos / scenarios
  // don't need to construct a real EIP-3009 authorisation.
  let payload;
  try {
    const raw = JSON.parse(safeBase64Decode(xPayment));
    payload = DEV_BYPASS ? raw : PaymentPayloadSchema.parse(raw);
  } catch {
    return NextResponse.json(
      { x402Version: 1, accepts: [requirements], error: "invalid X-PAYMENT header" },
      { status: 402 }
    );
  }

  let payerWallet: string;
  let txHash: string;

  if (DEV_BYPASS) {
    payerWallet = (
      (payload.payload as { authorization?: { from?: string } }).authorization?.from
        || "0xdemodemodemodemodemodemodemodemodemo0000"
    ).toLowerCase();
    txHash = "0xdev_bypass_" + nanoid(20);
    console.log(`[x402 DEV BYPASS] accepting share ${token} from ${payerWallet}`);
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

    const facilitator = useFacilitator({ url: FACILITATOR_URL });

    // --- verify: 10 s timeout, one retry on facilitator error ---
    type VerifyResult = Awaited<ReturnType<typeof facilitator.verify>>;
    let verifyRes: VerifyResult | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await withTimeout<VerifyResult>(10_000, (_signal) =>
        facilitator.verify(payload, requirements),
      );
      if (r.ok) { verifyRes = r.value; break; }
      if (!isFacilitatorUnavailable(r.error) || attempt === 1) {
        return NextResponse.json(
          { x402Version: 1, accepts: [requirements], error: "facilitator unavailable, please retry" },
          { status: 402 },
        );
      }
    }
    if (!verifyRes) {
      return NextResponse.json(
        { x402Version: 1, accepts: [requirements], error: "facilitator unavailable, please retry" },
        { status: 402 },
      );
    }
    if (!verifyRes.isValid) {
      return NextResponse.json(
        { x402Version: 1, accepts: [requirements], error: verifyRes.invalidReason || "verification failed" },
        { status: 402 }
      );
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
        return NextResponse.json(
          { x402Version: 1, accepts: [requirements], error: "facilitator unavailable, please retry" },
          { status: 402 },
        );
      }
    }
    if (!settleRes) {
      return NextResponse.json(
        { x402Version: 1, accepts: [requirements], error: "facilitator unavailable, please retry" },
        { status: 402 },
      );
    }
    if (!settleRes.success) {
      return NextResponse.json(
        { x402Version: 1, accepts: [requirements], error: sanitizeSettleError(settleRes.errorReason || "settlement failed") },
        { status: 402 }
      );
    }
    payerWallet = (settleRes.payer
      || (payload.payload as { authorization?: { from?: string } }).authorization?.from
      || "0x0").toLowerCase();
    txHash = settleRes.transaction;
  }

  // Persist permanent access
  try {
    db.prepare(
      "INSERT INTO folder_access (id, drive_id, path, wallet_address, added_by, payment_tx, role) VALUES (?, ?, ?, ?, 'payment', ?, ?)"
    ).run(nanoid(12), share.drive_id, share.path, payerWallet, txHash, share.role);
  } catch (e) {
    if (!/UNIQUE/i.test((e as Error).message)) throw e;
    db.prepare(
      "UPDATE folder_access SET role = ? WHERE drive_id = ? AND path = ? AND wallet_address = ?"
    ).run(share.role, share.drive_id, share.path, payerWallet);
  }
  await setWalletCookie(payerWallet);

  await onPaymentSettled({
    driveId: share.drive_id,
    path: share.path,
    wallet: payerWallet,
    txHash,
    amountUsdc: share.price_usdc,
    network: X402_NETWORK,
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
