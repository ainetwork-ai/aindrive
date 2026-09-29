/**
 * POST /api/oauth/authorize — the consent page's Approve/Deny decision.
 * Body: the original authorization params + { decision, scope }. Requires
 * the session cookie and a same-origin Origin header (CSRF). Re-validates
 * everything, clamps a drive grant's scope to the user's role (an account
 * grant has no drive to clamp against), and returns { redirect } — the
 * client's redirect_uri with `code` or `error`. The approval itself is
 * lib/oauth-authorize.ts `approve`, shared with a trusted client's visit of
 * /oauth/authorize (no consent screen).
 */
import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { isSameOrigin, redirectWith, validateAuthorize, type AuthorizeParams } from "@/lib/oauth";
import { approve } from "@/lib/oauth-authorize";
import { isMcpScope } from "@/lib/mcp-tokens";

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as (AuthorizeParams & { decision?: string; scope_choice?: string }) | null;
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const v = validateAuthorize(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  if (body.decision !== "approve") {
    return NextResponse.json({ redirect: redirectWith(v.value.redirectUri, { error: "access_denied", state: v.value.state }) });
  }
  const approved = await approve(v.value, user.id, isMcpScope(body.scope_choice) ? body.scope_choice : undefined);
  if (!approved.ok) return NextResponse.json({ error: approved.error }, { status: 403 });
  return NextResponse.json({ redirect: approved.redirect });
}
