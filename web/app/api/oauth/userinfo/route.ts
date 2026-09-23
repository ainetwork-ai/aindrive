/**
 * GET /api/oauth/userinfo — the signed-in account behind an account-grant
 * token (`aind_aat_…` with the `profile` scope): { sub, email, email_verified,
 * name, wallet_address }. See lib/account-tokens.ts and app/mcp/README.md.
 */
import { ACCOUNT_API_HEADERS, accountUserinfo, authenticateAccountRequest } from "@/lib/account-tokens";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: ACCOUNT_API_HEADERS });
}

export function GET(req: Request) {
  const auth = authenticateAccountRequest(req, "profile");
  if (!auth.ok) return auth.response;
  const info = accountUserinfo(auth.token.userId);
  // The token row cascades with its user, so this is only a deletion race.
  if (!info) return Response.json({ error: "invalid_token", error_description: "account not found" }, { status: 401, headers: ACCOUNT_API_HEADERS });
  return Response.json(info, { headers: ACCOUNT_API_HEADERS });
}
