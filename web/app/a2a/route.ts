/**
 * POST /a2a — root-level A2A v0.3 JSON-RPC endpoint.
 *
 * Uses @a2a-js/sdk's framework-agnostic `JsonRpcTransportHandler` so
 * we don't have to hand-roll envelope handling. Each request:
 *   1. authenticate (JWT in Authorization: Bearer, or session cookie)
 *   2. construct ServerCallContext with the User
 *   3. hand body + context to the transport handler
 *   4. return its JSON-RPC response
 *
 * v1: no streaming (capabilities.streaming = false in card). Streaming
 * methods (message/stream) would need the AsyncGenerator branch +
 * SSE-flavored Response — left for v1.1.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verify } from "@/lib/session";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  UnauthenticatedUser,
} from "@a2a-js/sdk/server";
import { aindriveAgentCard, AindriveExecutor, AindriveUser } from "@/lib/aindrive-agent";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

async function resolveUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) {
      const id = await verify(m[1]);
      if (id) return id;
    }
  }
  const c = await cookies();
  const sess = c.get("aindrive_session")?.value;
  if (sess) {
    const id = await verify(sess);
    if (id) return id;
  }
  return null;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
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

  const userId = await resolveUserId(req);
  const user = userId ? new AindriveUser(userId) : new UnauthenticatedUser();
  const callContext = new ServerCallContext(undefined, user);

  const result = await getTransport().handle(body, callContext);

  // Non-streaming methods return a JSONRPCResponse directly.
  // Streaming (message/stream) returns an AsyncGenerator — not in v1.
  if (result && typeof (result as AsyncGenerator).next === "function") {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32603, message: "streaming not supported in v1" } },
      { status: 501, headers: CORS },
    );
  }

  return NextResponse.json(result, { headers: CORS });
}
