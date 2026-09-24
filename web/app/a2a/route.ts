/**
 * POST /a2a — root-level A2A v0.3 JSON-RPC endpoint.
 *
 * Uses @a2a-js/sdk's framework-agnostic `JsonRpcTransportHandler`. Each request:
 *   1. authenticate (lib/agent-auth: MCP/OAuth/account tokens, or session JWT)
 *   2. read requested extensions from `X-A2A-Extensions` (e.g. A2UI)
 *   3. hand body + ServerCallContext to the transport handler
 *   4. reply JSON (message/send, tasks/*) or SSE (message/stream), echoing the
 *      activated extensions in `X-A2A-Extensions`.
 * Card: /.well-known/agent-card.json. Guide: /docs/a2a.
 */

import { NextResponse } from "next/server";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  UnauthenticatedUser,
} from "@a2a-js/sdk/server";
import { aindriveAgentCard, AindriveExecutor, AindriveUser } from "@/lib/aindrive-agent";
import { resolveAgentAuth } from "@/lib/agent-auth";
import { A2UI_A2A_EXTENSION } from "@/shared/a2ui";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-A2A-Extensions",
  "Access-Control-Expose-Headers": "X-A2A-Extensions",
};

let cached: { transport: JsonRpcTransportHandler } | null = null;
function getTransport(): JsonRpcTransportHandler {
  if (cached) return cached.transport;
  const requestHandler = new DefaultRequestHandler(
    aindriveAgentCard(),
    new InMemoryTaskStore(),
    new AindriveExecutor(),
  );
  cached = { transport: new JsonRpcTransportHandler(requestHandler) };
  return cached.transport;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Activated extensions to echo. The SDK re-creates the ServerCallContext
 * internally (filtered to the card's extensions), so activations made in the
 * executor don't surface here; the executor activates A2UI whenever it is
 * requested, so echo the supported subset of what was asked.
 */
function extensionsHeader(requested: string[]): Record<string, string> {
  return requested.includes(A2UI_A2A_EXTENSION) ? { "X-A2A-Extensions": A2UI_A2A_EXTENSION } : {};
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
      { status: 400, headers: CORS },
    );
  }

  const auth = await resolveAgentAuth(req);
  const user = auth.ok ? new AindriveUser(auth.ctx) : new UnauthenticatedUser();
  const requested = (req.headers.get("x-a2a-extensions") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const callContext = new ServerCallContext(requested, user);

  const result = await getTransport().handle(body, callContext);

  // message/stream → AsyncGenerator of JSON-RPC responses, sent as SSE events.
  if (result && typeof (result as AsyncGenerator).next === "function") {
    const gen = result as AsyncGenerator<unknown>;
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { value, done } = await gen.next();
          if (done) { controller.close(); return; }
          controller.enqueue(enc.encode(`data: ${JSON.stringify(value)}\n\n`));
        } catch (e) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({
            jsonrpc: "2.0", id: (body as { id?: unknown })?.id ?? null,
            error: { code: -32603, message: (e as Error).message || "stream error" },
          })}\n\n`));
          controller.close();
        }
      },
      cancel() { void gen.return?.(undefined); },
    });
    return new Response(stream, {
      headers: {
        ...CORS,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...extensionsHeader(requested),
      },
    });
  }

  return NextResponse.json(result, { headers: { ...CORS, ...extensionsHeader(requested) } });
}
