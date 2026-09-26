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
import { PAY_SKILL_DESCRIPTORS, SKILL_DESCRIPTORS } from "@/shared/agent-skills";
import { agentWalletsEnabled } from "@/lib/agent-wallets";

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
  // A session is the whole account, so its wallet comes with it — when the
  // server keeps agent wallets at all. Listed only then: a client that looks
  // for x402_* learns from tools/list whether it can pay here.
  const pay = agentWalletsEnabled();
  const tools = pay ? [...SKILL_DESCRIPTORS, ...PAY_SKILL_DESCRIPTORS] : SKILL_DESCRIPTORS;
  return serveMcp(req, userId ? { userId, pay } : null, tools);
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
