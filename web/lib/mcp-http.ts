/**
 * Shared Streamable-HTTP MCP plumbing for the `/mcp` route handlers.
 *
 * Uses @modelcontextprotocol/sdk's WebStandardStreamableHTTPServerTransport
 * (Web Request → Web Response, no Express adapter) in stateless mode: a fresh
 * Server per request, tools backed 1:1 by shared/agent-skills runSkill.
 * Callers resolve auth first and pass the resulting SkillCtx (or null for an
 * anonymous request — tools/list still works, tool calls are refused).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { runSkill, type SkillCtx, type SkillDescriptor } from "@/shared/agent-skills";

export const MCP_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
};

export function withCors(resp: Response, extra: Record<string, string> = {}): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries({ ...MCP_CORS, ...extra })) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

export function bearerFrom(req: Request): string | null {
  const m = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export async function serveMcp(
  req: Request,
  ctx: SkillCtx | null,
  tools: SkillDescriptor[],
): Promise<Response> {
  const server = new Server(
    { name: "aindrive", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((s) => ({ name: s.name, description: s.description, inputSchema: s.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    if (!ctx) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "unauthorized — missing or invalid bearer/session" }],
      };
    }
    const name = call.params.name;
    if (!tools.some((t) => t.name === name)) {
      return { isError: true, content: [{ type: "text" as const, text: `unknown tool: ${name}` }] };
    }
    const args = (call.params.arguments ?? {}) as Record<string, unknown>;
    const result = await runSkill(ctx, name, args);
    if (result.kind === "err") {
      return { isError: true, content: [{ type: "text" as const, text: `[${result.code}] ${result.message}` }] };
    }
    return {
      content: [{ type: "text" as const, text: result.text }],
      structuredContent: (result.structured ?? {}) as Record<string, unknown>,
    };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return withCors(await transport.handleRequest(req));
}
