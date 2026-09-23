/**
 * /mcp/d/[driveId] — drive-scoped remote MCP endpoint (Streamable HTTP).
 *
 * Auth: `Authorization: Bearer <token>` where token is an MCP PAT
 * (`aind_pat_…`, issued from the drive's MCP modal) or an OAuth access token
 * (`aind_oat_…`, from /api/oauth/token). The token must be bound to THIS
 * drive. A missing/invalid token → 401 + `WWW-Authenticate` pointing at the
 * RFC 9728 protected-resource metadata, which is how MCP clients (claude.ai,
 * ChatGPT, …) discover the OAuth flow. See ./README.md.
 */

import { getDrive } from "@/lib/drives";
import { env } from "@/lib/env";
import { verifyMcpToken } from "@/lib/mcp-tokens";
import { MCP_CORS, bearerFrom, serveMcp } from "@/lib/mcp-http";
import { driveScopedDescriptors } from "@/shared/agent-skills";

type Ctx = { params: Promise<{ driveId: string }> };

export function OPTIONS() {
  return new Response(null, { status: 204, headers: MCP_CORS });
}

function unauthorized(driveId: string, error: string, description: string): Response {
  const metadata = `${env.publicUrl.replace(/\/$/, "")}/.well-known/oauth-protected-resource/mcp/d/${driveId}`;
  return Response.json(
    { error, error_description: description },
    {
      status: 401,
      headers: {
        ...MCP_CORS,
        "WWW-Authenticate": `Bearer error="${error}", error_description="${description}", resource_metadata="${metadata}"`,
      },
    },
  );
}

async function handle(req: Request, { params }: Ctx) {
  const { driveId } = await params;
  if (!getDrive(driveId)) {
    return Response.json({ error: "drive not found" }, { status: 404, headers: MCP_CORS });
  }
  const bearer = bearerFrom(req);
  if (!bearer) return unauthorized(driveId, "invalid_token", "missing bearer token");
  const token = verifyMcpToken(bearer);
  if (!token) return unauthorized(driveId, "invalid_token", "token is invalid, expired or revoked");
  if (token.driveId !== driveId) {
    return Response.json(
      { error: "insufficient_scope", error_description: "token is bound to a different drive" },
      { status: 403, headers: MCP_CORS },
    );
  }
  return serveMcp(
    req,
    { userId: token.userId, driveId, scope: token.scope },
    driveScopedDescriptors(token.scope),
  );
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
