/**
 * /mcp/h/[grantId] — the MCP view of one file handoff grant (lib/handoff-mcp.ts): an outside
 * agent lists and reads exactly the files the owner handed it, nothing else.
 * Auth: `Authorization: Bearer aind_hg_…` — the grant's token, returned once when the owner
 * minted the handoff (POST /api/handoffs). Revoke the links (or the audience) to close it.
 */
import { MCP_CORS, bearerFrom } from "@/lib/mcp-http";
import { openGrant } from "@/lib/handoff";
import { serveGrantMcp } from "@/lib/handoff-mcp";
import { tryConsume, clientKey } from "@/lib/rate-limit";

type Ctx = { params: Promise<{ grantId: string }> };

export function OPTIONS() {
  return new Response(null, { status: 204, headers: MCP_CORS });
}

async function handle(req: Request, { params }: Ctx) {
  const { grantId } = await params;
  const rl = tryConsume({ name: "handoff-mcp", key: clientKey(req, "handoff-mcp"), limit: 120, windowMs: 60_000 });
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: MCP_CORS });
  const opened = openGrant(grantId, bearerFrom(req) ?? "");
  if ("error" in opened) {
    return Response.json({ error: opened.error }, {
      status: opened.error === "not_found" ? 401 : 410,
      headers: { ...MCP_CORS, "WWW-Authenticate": `Bearer error="invalid_token", error_description="${opened.error}"` },
    });
  }
  return serveGrantMcp(req, grantId);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
