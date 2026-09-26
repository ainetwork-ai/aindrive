/**
 * /mcp/d/[driveId] — drive-scoped remote MCP endpoint (Streamable HTTP).
 *
 * Auth: `Authorization: Bearer <token>` where token is an MCP PAT
 * (`aind_pat_…`, issued from the drive's MCP modal) or an OAuth access token
 * (`aind_oat_…`, from /api/oauth/token). The token must be bound to THIS
 * drive. A missing/invalid token → 401 + `WWW-Authenticate` pointing at the
 * RFC 9728 protected-resource metadata, which is how MCP clients (claude.ai,
 * ChatGPT, …) discover the OAuth flow. See ./README.md.
 *
 * Also accepted: an account-grant access token (`aind_aat_…`, lib/account-tokens)
 * on any drive the user is a member of. Each drives:* scope adds its tools:
 * drives:read the read tools, drives:write write_file + delete_path (still
 * editor+ per call), drives:sell the sale tools (creator-only per call).
 */

import { getDrive } from "@/lib/drives";
import { env } from "@/lib/env";
import { maxRoleInDrive, verifyMcpToken } from "@/lib/mcp-tokens";
import { ACCOUNT_ACCESS_PREFIX, verifyAccountToken } from "@/lib/account-tokens";
import { MCP_CORS, bearerFrom, serveMcp } from "@/lib/mcp-http";
import { driveScopedDescriptors, skillGroup } from "@/shared/agent-skills";
import { agentWalletsEnabled } from "@/lib/agent-wallets";

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

function forbidden(description: string): Response {
  return Response.json(
    { error: "insufficient_scope", error_description: description },
    { status: 403, headers: MCP_CORS },
  );
}

const GROUP_SCOPE = { read: "drives:read", write: "drives:write", sell: "drives:sell", pay: "wallet:pay" } as const;

/**
 * Account grant on any drive the user belongs to. Only the tools of the
 * granted drives:* scopes are listed — and serveMcp refuses any unlisted tool.
 */
function handleAccountToken(req: Request, driveId: string, bearer: string): Promise<Response> | Response {
  const token = verifyAccountToken(bearer);
  if (!token) return unauthorized(driveId, "invalid_token", "token is invalid, expired or revoked");
  const has = (g: keyof typeof GROUP_SCOPE) => token.scopes.includes(GROUP_SCOPE[g]);
  if (!has("read") && !has("write") && !has("sell") && !has("pay")) {
    return forbidden("token lacks a drives:read, drives:write, drives:sell or wallet:pay scope");
  }
  if (maxRoleInDrive(driveId, token.userId) === "none") return forbidden("the account has no access to this drive");
  const scope = has("write") ? "write" : "read";
  const pay = has("pay") && agentWalletsEnabled();
  const tools = driveScopedDescriptors(scope, { sell: has("sell"), pay }).filter((t) => has(skillGroup(t.name)));
  return serveMcp(req, { userId: token.userId, driveId, scope, sell: has("sell"), pay }, tools);
}

async function handle(req: Request, { params }: Ctx) {
  const { driveId } = await params;
  if (!getDrive(driveId)) {
    return Response.json({ error: "drive not found" }, { status: 404, headers: MCP_CORS });
  }
  const bearer = bearerFrom(req);
  if (!bearer) return unauthorized(driveId, "invalid_token", "missing bearer token");
  if (bearer.startsWith(ACCOUNT_ACCESS_PREFIX)) return handleAccountToken(req, driveId, bearer);
  const token = verifyMcpToken(bearer);
  if (!token) return unauthorized(driveId, "invalid_token", "token is invalid, expired or revoked");
  if (token.driveId !== driveId) return forbidden("token is bound to a different drive");
  return serveMcp(
    req,
    { userId: token.userId, driveId, scope: token.scope },
    driveScopedDescriptors(token.scope),
  );
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
