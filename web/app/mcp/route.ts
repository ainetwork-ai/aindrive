/**
 * /mcp — root-level MCP endpoint.
 *
 * Uses @modelcontextprotocol/sdk's WebStandardStreamableHTTPServerTransport
 * — accepts a Web Request and returns a Web Response, so it drops into
 * Next.js route handlers without any Express adapter.
 *
 * Stateless mode (no sessionIdGenerator). Tools mirror the A2A skills
 * 1:1 via the shared runSkill, so MCP clients (Claude Desktop, ChatGPT
 * MCP connector, Cursor, Goose, VSCode) get the same surface external
 * A2A callers see — just expressed in MCP's tool-call envelope.
 *
 * Auth: Authorization: Bearer <jwt> or session cookie. Each tool call
 * resolves the user from the original Request via a per-request closure
 * on the runSkill ctx — we don't try to thread userId through the SDK
 * transport (which doesn't have a user concept), instead resolving at
 * tool-call time.
 */

import { cookies } from "next/headers";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { verify } from "@/lib/session";
import { runSkill, SKILL_DESCRIPTORS } from "@/shared/agent-skills";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

async function resolveUserIdFromRequest(req: Request): Promise<string | null> {
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

async function handle(req: Request) {
  // Resolve auth once per request, capture in closure for the tool handler.
  const userId = await resolveUserIdFromRequest(req);

  const server = new Server(
    { name: "aindrive", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: SKILL_DESCRIPTORS.map((s) => ({
      name: s.name,
      description: s.description,
      inputSchema: s.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (!userId) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "unauthorized — missing or invalid bearer/session" }],
      };
    }
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const result = await runSkill({ userId }, name, args);
    if (result.kind === "err") {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `[${result.code}] ${result.message}` }],
      };
    }
    return {
      content: [{ type: "text" as const, text: result.text }],
      structuredContent: (result.structured ?? {}) as Record<string, unknown>,
    };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,  // stateless
  });
  await server.connect(transport);

  const resp = await transport.handleRequest(req);

  // Merge our CORS headers on top of the transport's own.
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
