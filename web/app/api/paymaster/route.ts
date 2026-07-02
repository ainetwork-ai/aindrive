import { verifySponsorGrant, validateSponsoredUserOp, paymasterEnabled } from "@/lib/paymaster";
import { tryConsume } from "@/lib/rate-limit.js";

// ERC-7677 paymaster proxy. The buyer's smart wallet (Base Account popup at
// keys.coinbase.com) calls THIS url — carrying a sponsor grant in ?g= — with
// pm_getPaymasterStubData / pm_getPaymasterData for the approve userOp; we
// validate the op against the grant (lib/paymaster) and forward to the real
// CDP Paymaster at AINDRIVE_PAYMASTER_URL, which stays server-side so its
// spend budget can't be driven from outside this gate.
//
// Responses are JSON-RPC: rejections are `error` objects with HTTP 200 (the
// wallet surfaces them as a failed sponsorship; share-gate then falls back to
// the buyer-paid approve). CORS is open — the caller is the wallet's own
// origin, cookies are never involved, and the ?g= grant is the credential.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

const ALLOWED_METHODS = new Set(["pm_getPaymasterStubData", "pm_getPaymasterData"]);
const UPSTREAM_TIMEOUT_MS = 10_000;

function rpcError(id: unknown, code: number, message: string, status = 200) {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { status, headers: CORS },
  );
}

export async function POST(req: Request) {
  if (!paymasterEnabled()) return rpcError(null, -32601, "gas sponsorship not configured", 503);

  const grantParam = new URL(req.url).searchParams.get("g");
  const grant = grantParam ? verifySponsorGrant(grantParam) : null;
  if (!grant) return rpcError(null, -32001, "invalid or expired sponsor grant");

  // Per-wallet call budget: one approve needs a stub + a final data call (plus
  // wallet retries). 12 per 10 min ≈ 5 attempts — plenty for a purchase, tight
  // for someone farming sponsored ops off one grant.
  const rl = tryConsume({ name: "paymaster-proxy", key: grant.wallet, limit: 12, windowMs: 10 * 60 * 1000 });
  if (!rl.ok) return rpcError(null, -32005, "sponsorship rate limit exceeded");

  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  if (!body?.method || !ALLOWED_METHODS.has(body.method)) {
    return rpcError(body?.id, -32601, "method not sponsored here");
  }
  // ERC-7677 params: [userOperation, entryPoint, chainId, context?]
  const [userOp, , chainIdRaw] = Array.isArray(body.params) ? body.params : [];
  const chainId = typeof chainIdRaw === "string" ? Number.parseInt(chainIdRaw, 16) : Number(chainIdRaw);
  if (chainId !== grant.chainId) {
    return rpcError(body.id, -32002, "chain does not match the sponsor grant");
  }
  const op = userOp as { sender?: string; callData?: string } | undefined;
  const check = validateSponsoredUserOp({
    grant,
    sender: op?.sender ?? "",
    callData: op?.callData ?? "",
  });
  if (!check.ok) {
    console.warn(`[paymaster] refused sponsorship for ${grant.wallet}: ${check.reason}`);
    return rpcError(body.id, -32003, `not sponsorable: ${check.reason}`);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(process.env.AINDRIVE_PAYMASTER_URL!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const json = await upstream.json().catch(() => null);
    if (!json) return rpcError(body.id, -32004, "paymaster returned a malformed response");
    return Response.json(json, { status: 200, headers: CORS });
  } catch {
    return rpcError(body.id, -32004, "paymaster unreachable");
  } finally {
    clearTimeout(timer);
  }
}
