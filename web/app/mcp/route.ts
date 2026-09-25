/**
 * /mcp — legacy account-wide MCP endpoint (all drives, session auth).
 *
 * Auth: Authorization: Bearer <session jwt> or the session cookie. Kept for
 * existing integrations; new clients should use the drive-scoped endpoint
 * `/mcp/d/[driveId]` with a revocable MCP token / OAuth (see ./README.md).
 * Tools mirror the A2A skills 1:1 via runSkill (lib/mcp-http.ts).
 */

import { cookies } from "next/headers";
import { verify } from "@/lib/session";
import { MCP_CORS, bearerFrom, serveMcp } from "@/lib/mcp-http";
import { SKILL_DESCRIPTORS } from "@/shared/agent-skills";

async function resolveUserIdFromRequest(req: Request): Promise<string | null> {
  const bearer = bearerFrom(req);
  if (bearer) {
    const id = await verify(bearer);
    if (id) return id;
  }
  const sess = (await cookies()).get("aindrive_session")?.value;
  return sess ? verify(sess) : null;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: MCP_CORS });
}

async function handle(req: Request) {
  const userId = await resolveUserIdFromRequest(req);
  return serveMcp(req, userId ? { userId } : null, SKILL_DESCRIPTORS);
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
