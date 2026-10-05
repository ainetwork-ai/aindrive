/**
 * POST /api/oauth/drives/<id>/members — account-grant token with
 * `drives:share`: give viewer or editor access at a path to an email
 * ({ email, path?, role }) → { ok, pending }. Same rules as the session route
 * POST /api/drives/<id>/members (lib/drive-sharing.ts): owner-only, upgrade-only,
 * unknown address → pending invite (202). The owner role is never granted
 * through OAuth. See app/mcp/README.md.
 */
import { z } from "zod";
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { ACCOUNT_API_HEADERS as BASE_HEADERS, authenticateAccountRequest } from "@/lib/account-tokens";
import { grantByEmail } from "@/lib/drive-sharing";
import { zPath } from "@/lib/zod-helpers";

const Body = z.object({
  email: z.string().email().max(320),
  path: zPath.default(""),
  role: z.enum(["viewer", "editor"]),
});

const ACCOUNT_API_HEADERS = { ...BASE_HEADERS, "Access-Control-Allow-Methods": "POST, OPTIONS" };

export function OPTIONS() {
  return new Response(null, { status: 204, headers: ACCOUNT_API_HEADERS });
}

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const rl = tryConsume({ name: "oauth-share", key: clientKey(req, "oauth-share"), limit: 60, windowMs: 60 * 1000 });
  if (!rl.ok) return Response.json({ error: "slow_down", error_description: "too many requests" }, { status: 429, headers: ACCOUNT_API_HEADERS });
  const auth = authenticateAccountRequest(req, "drives:share");
  if (!auth.ok) return auth.response;
  const { driveId } = await params;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "invalid_request", error_description: "email, path and role (viewer|editor) required" }, { status: 400, headers: ACCOUNT_API_HEADERS });
  const r = grantByEmail({ driveId, actorId: auth.token.userId, ...body.data });
  if (r.status < 300) console.log(`[oauth] share granted drive=${driveId} by=${auth.token.userId} client=${auth.token.clientId} role=${body.data.role} pending=${r.status === 202}`);
  return Response.json(r.body, { status: r.status, headers: ACCOUNT_API_HEADERS });
}
