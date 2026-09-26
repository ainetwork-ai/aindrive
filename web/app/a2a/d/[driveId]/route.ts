/**
 * POST /a2a/d/[driveId] — the drive's on-device agent over A2A v0.3 JSON-RPC (lib/device-agent-a2a.ts).
 * Auth like /a2a: a bearer (session JWT, MCP/OAuth/account token) usable on this drive; the executor
 * then admits the drive's owner only. Card: ./.well-known/agent-card.json.
 *
 * Billing is the old ask's: the tier's asks per minute, and one question sent to several of the
 * account's drives (the same `message.metadata.askId`) is one ask (lib/ask-fanout.ts).
 */
import { NextResponse } from "next/server";
import { DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, ServerCallContext, UnauthenticatedUser } from "@a2a-js/sdk/server";
import { AindriveUser } from "@/lib/aindrive-agent";
import { resolveAgentAuth } from "@/lib/agent-auth";
import { DeviceAgentExecutor, deviceAgentCard } from "@/lib/device-agent-a2a";
import { getDrive } from "@/lib/drives";
import { env } from "@/lib/env";
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { getAccountTier, tierBudget } from "@/lib/tier";
import { ridesAlong } from "@/lib/ask-fanout";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-A2A-Extensions",
};
const ASK_BASE = { limit: 5, windowMs: 60_000 };
const rpcError = (id: unknown, code: number, message: string, status: number, headers: Record<string, string> = {}) =>
  NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status, headers: { ...CORS, ...headers } });

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const drive = getDrive(driveId);
  if (!drive) return rpcError(null, -32001, "drive not found", 404);
  let body: { id?: unknown; method?: string; params?: { message?: { metadata?: Record<string, unknown> } } };
  try { body = await req.json(); } catch { return rpcError(null, -32700, "parse error", 400); }

  const auth = await resolveAgentAuth(req, driveId);
  if (!auth.ok) return rpcError(body?.id, -32001, auth.error, auth.status);
  if (body?.method === "message/send" || body?.method === "message/stream") {
    const { tier } = getAccountTier(auth.ctx.userId);
    const budget = tierBudget(tier, ASK_BASE);
    const who = clientKey(req, `ask:${auth.ctx.userId}`);
    const askId = typeof body.params?.message?.metadata?.askId === "string" ? (body.params.message.metadata.askId as string) : null;
    const rl = ridesAlong(who, askId) ? { ok: true as const } : tryConsume({ name: `ask:${tier}`, key: who, limit: budget.limit, windowMs: budget.windowMs });
    if (!rl.ok) return rpcError(body.id, -32000, `rate limited (${tier}: ${budget.limit} asks per minute)`, 429, { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) });
  }

  const handler = new DefaultRequestHandler(deviceAgentCard(env.publicUrl, { id: drive.id, name: drive.name, hostname: drive.last_hostname }), new InMemoryTaskStore(), new DeviceAgentExecutor(driveId));
  const result = await new JsonRpcTransportHandler(handler).handle(body, new ServerCallContext([], auth.ok ? new AindriveUser(auth) : new UnauthenticatedUser()));
  if (result && typeof (result as AsyncGenerator).next === "function") return rpcError(body?.id, -32004, "streaming is not supported; use message/send", 400);
  return NextResponse.json(result, { headers: CORS });
}
