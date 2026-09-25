/**
 * POST /api/oauth/token — authorization_code (PKCE) and refresh_token grants.
 * Accepts application/x-www-form-urlencoded (RFC 6749) or JSON. Issues
 * drive-bound MCP tokens via lib/mcp-tokens.ts, or account-grant tokens via
 * lib/account-tokens.ts — the kind follows the code's table / the refresh
 * token's prefix. Same response shape for both. See app/mcp/README.md.
 */
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { getClient, redeemAccountCode, redeemCode, scopeString } from "@/lib/oauth";
import { issueOAuthTokens, refreshOAuthTokens } from "@/lib/mcp-tokens";
import { ACCOUNT_REFRESH_PREFIX, issueAccountTokens, refreshAccountTokens } from "@/lib/account-tokens";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

function fail(error: string, description: string, status = 400) {
  return Response.json({ error, error_description: description }, { status, headers: { ...CORS, ...NO_STORE } });
}

async function readParams(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const j = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    return Object.fromEntries(Object.entries(j ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  }
  const text = await req.text().catch(() => "");
  return Object.fromEntries(new URLSearchParams(text));
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  const rl = tryConsume({ name: "oauth-token", key: clientKey(req, "oauth-token"), limit: 60, windowMs: 60 * 1000 });
  if (!rl.ok) return fail("slow_down", "too many token requests", 429);

  const p = await readParams(req);
  const client = getClient(p.client_id);
  if (!client) return fail("invalid_client", "unknown client_id", 401);

  if (p.grant_type === "authorization_code") {
    if (!p.code || !p.redirect_uri || !p.code_verifier) {
      return fail("invalid_request", "code, redirect_uri and code_verifier are required");
    }
    const exchange = {
      code: p.code,
      clientId: client.client_id,
      redirectUri: p.redirect_uri,
      codeVerifier: p.code_verifier,
    };
    const redeemed = redeemCode(exchange);
    // A code lives in exactly one table, so a drive miss falls through to the account table.
    const account = redeemed ? null : redeemAccountCode(exchange);
    if (account) {
      const pair = issueAccountTokens({
        userId: account.userId,
        clientId: client.client_id,
        clientName: client.client_name,
        scopes: account.scopes,
      });
      return Response.json({ ...pair, token_type: "Bearer" }, { headers: { ...CORS, ...NO_STORE } });
    }
    if (!redeemed) return fail("invalid_grant", "authorization code is invalid, expired, used, or the PKCE verifier does not match");
    const pair = issueOAuthTokens({
      userId: redeemed.userId,
      driveId: redeemed.driveId,
      clientId: client.client_id,
      clientName: client.client_name,
      scope: redeemed.scope,
    });
    return Response.json({ ...pair, token_type: "Bearer", scope: scopeString(pair.scope) }, { headers: { ...CORS, ...NO_STORE } });
  }

  if (p.grant_type === "refresh_token") {
    if (!p.refresh_token) return fail("invalid_request", "refresh_token is required");
    if (p.refresh_token.startsWith(ACCOUNT_REFRESH_PREFIX)) {
      const pair = refreshAccountTokens(p.refresh_token, client.client_id);
      if (!pair) return fail("invalid_grant", "refresh token is invalid, expired or revoked");
      return Response.json({ ...pair, token_type: "Bearer" }, { headers: { ...CORS, ...NO_STORE } });
    }
    const pair = refreshOAuthTokens(p.refresh_token, client.client_id);
    if (!pair) return fail("invalid_grant", "refresh token is invalid, expired or revoked");
    return Response.json({ ...pair, token_type: "Bearer", scope: scopeString(pair.scope) }, { headers: { ...CORS, ...NO_STORE } });
  }

  return fail("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}
