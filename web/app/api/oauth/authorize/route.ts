/**
 * POST /api/oauth/authorize — the consent page's Approve/Deny decision.
 * Body: the original authorization params + { decision, scope }. Requires
 * the session cookie and a same-origin Origin header (CSRF). Re-validates
 * everything, clamps a drive grant's scope to the user's role (an account
 * grant has no drive to clamp against), and returns { redirect } — the
 * client's redirect_uri with `code` or `error`.
 */
import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { isSameOrigin, issueAccountCode, issueCode, redirectWith, validateAuthorize, type AuthorizeParams } from "@/lib/oauth";
import { clampScope, isMcpScope } from "@/lib/mcp-tokens";

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as (AuthorizeParams & { decision?: string; scope_choice?: string }) | null;
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const v = validateAuthorize(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const { client, redirectUri, codeChallenge, state } = v.value;

  if (body.decision !== "approve") {
    return NextResponse.json({ redirect: redirectWith(redirectUri, { error: "access_denied", state }) });
  }
  if (v.value.driveId === null) {
    const code = issueAccountCode({ clientId: client.client_id, userId: user.id, scopes: v.value.accountScopes, redirectUri, codeChallenge });
    return NextResponse.json({ redirect: redirectWith(redirectUri, { code, state }) });
  }
  const { driveId } = v.value;
  const wanted = isMcpScope(body.scope_choice) ? body.scope_choice : v.value.requestedScope;
  const scope = clampScope(driveId, user.id, wanted);
  if (!scope) return NextResponse.json({ error: "You don't have access to this drive." }, { status: 403 });

  const code = issueCode({ clientId: client.client_id, userId: user.id, driveId, scope, redirectUri, codeChallenge });
  return NextResponse.json({ redirect: redirectWith(redirectUri, { code, state }) });
}
