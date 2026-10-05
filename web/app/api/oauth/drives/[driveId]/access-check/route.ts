/**
 * POST /api/oauth/drives/<id>/access-check — account-grant token with
 * `drives:read`: what access each email has at a path of the drive,
 * { results: [{ email, access: owner|editor|viewer|pending|none }] }.
 * The token's user must see the path (viewer+), so an app learns nothing
 * about paths its user can't open. See app/mcp/README.md.
 */
import { z } from "zod";
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { ACCOUNT_API_HEADERS as BASE_HEADERS, authenticateAccountRequest } from "@/lib/account-tokens";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast } from "@/lib/access";
import { accessForEmails } from "@/lib/drive-sharing";
import { zPath } from "@/lib/zod-helpers";

const Body = z.object({
  path: zPath.default(""),
  emails: z.array(z.string().email().max(320)).min(1).max(100),
});

const ACCOUNT_API_HEADERS = { ...BASE_HEADERS, "Access-Control-Allow-Methods": "POST, OPTIONS" };

export function OPTIONS() {
  return new Response(null, { status: 204, headers: ACCOUNT_API_HEADERS });
}

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const rl = tryConsume({ name: "oauth-access-check", key: clientKey(req, "oauth-access-check"), limit: 120, windowMs: 60 * 1000 });
  if (!rl.ok) return Response.json({ error: "slow_down", error_description: "too many requests" }, { status: 429, headers: ACCOUNT_API_HEADERS });
  const auth = authenticateAccountRequest(req, "drives:read");
  if (!auth.ok) return auth.response;
  const { driveId } = await params;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "invalid_request", error_description: "path and 1–100 emails required" }, { status: 400, headers: ACCOUNT_API_HEADERS });
  if (!getDrive(driveId) || !atLeast(resolveRole(driveId, auth.token.userId, body.data.path), "viewer")) {
    return Response.json({ error: "forbidden", error_description: "no access to this path" }, { status: 403, headers: ACCOUNT_API_HEADERS });
  }
  return Response.json({ results: accessForEmails(driveId, body.data.path, body.data.emails) }, { headers: ACCOUNT_API_HEADERS });
}
