/**
 * Shared Streamable-HTTP MCP plumbing for the `/mcp` route handlers.
 *
 * Uses @modelcontextprotocol/sdk's WebStandardStreamableHTTPServerTransport
 * (Web Request → Web Response, no Express adapter) in stateless mode: a fresh
 * Server per request, tools backed 1:1 by shared/agent-skills runSkill.
 * Callers resolve auth first and pass the resulting SkillCtx (or null for an
 * anonymous request — tools/list still works, tool calls are refused).
 *
 * UI: every tool advertises the MCP Apps view (lib/mcp-ui.ts) and every result
 * carries its A2UI surface in `_meta` (UI-only, not shown to the model). With
 * `X-A2UI: 1` (or `?a2ui=1`) results also embed that surface as an
 * `application/a2ui+json` resource for A2UI-over-MCP clients. Clicks come back
 * as the app-only `a2ui_action` tool. See app/mcp/README.md.
 *
 * AINUI (docs/AINUI.md): with `X-AINUI: 1` every surface — tool results and
 * `a2ui_action` replies — is built with the AINUI catalog (grid, tiles, asset
 * references, file viewer, write actions; lib/ainui.ts). Without the header the
 * output is exactly the basic A2UI above.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema, ErrorCode, ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { runSkill, type SkillCtx, type SkillDescriptor, type SkillResult } from "@/shared/agent-skills";
import { A2UI_META_KEY, A2UI_MIME, a2uiForSkill, actionToSkill, parseA2uiAction, type A2uiMessage } from "@/shared/a2ui";
import { AINUI_HEADER } from "@/shared/a2ui/ainui";
import { ainuiAction, ainuiSurface } from "./ainui";
import {
  MCP_APP_MIME, MCP_APP_ONLY_META, MCP_APP_RESOURCE_META, MCP_APP_TOOL_META, MCP_APP_URI, mcpAppHtml,
} from "./mcp-ui";

export const MCP_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, X-A2UI, X-AINUI",
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

/** Clients opt in to the embedded A2UI resource (A2UI-over-MCP) per request. */
function wantsA2uiResource(req: Request): boolean {
  if (req.headers.get("x-a2ui") === "1") return true;
  try { return new URL(req.url).searchParams.get("a2ui") === "1"; } catch { return false; }
}

/** Clients opt in to AINUI surfaces per request (`X-AINUI: 1`). */
function wantsAinui(req: Request): boolean {
  return req.headers.get(AINUI_HEADER) === "1";
}

const A2UI_ACTION_TOOL = {
  name: "a2ui_action",
  description:
    "Handle an A2UI user action from an aindrive surface (a button click in the rendered UI). " +
    "Pass the renderer's action object; returns the next surface.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "object",
        description: "A2UI v0.9 action: {name, surfaceId, sourceComponentId, timestamp, context}",
      },
    },
  },
};

export async function serveMcp(
  req: Request,
  ctx: SkillCtx | null,
  tools: SkillDescriptor[],
): Promise<Response> {
  const server = new Server(
    { name: "aindrive", version: "0.2.0" },
    { capabilities: { tools: { listChanged: false }, resources: { listChanged: false } } },
  );
  const embedA2ui = wantsA2uiResource(req);
  const ainui = wantsAinui(req);
  const allowed = (skill: string) => tools.some((t) => t.name === skill);
  // Every surface starts from browsing, so the action tool is offered only with a read tool.
  // (AINUI write actions still need write_file / delete_path on this same list.)
  const offerAction = tools.some((t) => ["list_files", "read_file", "search"].includes(t.name));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...tools.map((s) => ({ name: s.name, description: s.description, inputSchema: s.inputSchema, _meta: MCP_APP_TOOL_META })),
      ...(offerAction ? [{ ...A2UI_ACTION_TOOL, _meta: MCP_APP_ONLY_META }] : []),
    ],
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{
      uri: MCP_APP_URI,
      name: "aindrive browser",
      description: "Interactive file browser, preview and search for aindrive tool results (MCP Apps).",
      mimeType: MCP_APP_MIME,
      _meta: MCP_APP_RESOURCE_META,
    }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (r) => {
    if (r.params.uri !== MCP_APP_URI) throw new McpError(ErrorCode.InvalidParams, `unknown resource: ${r.params.uri}`);
    return { contents: [{ uri: MCP_APP_URI, mimeType: MCP_APP_MIME, text: mcpAppHtml(), _meta: MCP_APP_RESOURCE_META }] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    if (!ctx) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "unauthorized — missing or invalid bearer/session" }],
      };
    }
    let name = call.params.name;
    let args = (call.params.arguments ?? {}) as Record<string, unknown>;
    if (name === A2UI_ACTION_TOOL.name && offerAction) {
      const action = parseA2uiAction(args.action ?? args);
      if (ainui) {
        // AINUI actions may run several skills; each passes `allowed` (this token's tools) + runSkill.
        if (!action) return { isError: true, content: [{ type: "text" as const, text: "missing action" }] };
        const reply = await ainuiAction({ ctx, allowed }, action);
        if (reply.kind === "invalid") return { isError: true, content: [{ type: "text" as const, text: reply.error }] };
        if (reply.kind === "refused") return { isError: true, content: [{ type: "text" as const, text: `unknown tool: ${reply.skill}` }] };
        return toolResult(reply.final.result, reply.surface);
      }
      const mapped = action ? actionToSkill(action, ctx.driveId) : { error: "missing action" };
      if ("error" in mapped) return { isError: true, content: [{ type: "text" as const, text: mapped.error }] };
      ({ skill: name, args } = mapped);
    }
    // Same allow-list as tools/list: an action can't reach a tool this token doesn't expose.
    if (!allowed(name)) {
      return { isError: true, content: [{ type: "text" as const, text: `unknown tool: ${name}` }] };
    }
    const result = await runSkill(ctx, name, args);
    const surface = ainui
      ? await ainuiSurface({ ctx, allowed }, name, args, result)
      : a2uiForSkill(name, args, result, ctx.driveId);
    return toolResult(result, surface);
  });

  function toolResult(result: SkillResult, surface: A2uiMessage[]) {
    const surfaceId = (surface[0] as { createSurface?: { surfaceId: string } }).createSurface?.surfaceId ?? "surface";
    const a2uiResource = embedA2ui
      ? [{ type: "resource" as const, resource: { uri: `a2ui://aindrive/${surfaceId}`, mimeType: A2UI_MIME, text: JSON.stringify(surface) } }]
      : [];
    const _meta = { [A2UI_META_KEY]: surface };
    if (result.kind === "err") {
      return { isError: true, content: [{ type: "text" as const, text: `[${result.code}] ${result.message}` }, ...a2uiResource], _meta };
    }
    return {
      content: [{ type: "text" as const, text: result.text }, ...a2uiResource],
      structuredContent: (result.structured ?? {}) as Record<string, unknown>,
      _meta,
    };
  }

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return withCors(await transport.handleRequest(req));
}
