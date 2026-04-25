/**
 * aindrive MCP server entry. Exposed via `aindrive mcp` (stdio transport).
 *
 * IMPORTANT: stdout is the MCP wire protocol — never write logs there.
 * All diagnostics go to stderr.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createClient } from "./client.js";
import { TOOLS } from "./tools.js";
import { listResources, readResource, makeResourceTemplates } from "./resources.js";

const VERSION = "0.1.0";

export async function runMcpServer({ server: serverUrl } = {}) {
  const client = await createClient({ server: serverUrl });
  const ctx = { client };

  const server = new Server(
    { name: "aindrive", version: VERSION },
    {
      capabilities: {
        tools: {},
        resources: { listChanged: false, subscribe: false },
        logging: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return { isError: true, content: [{ type: "text", text: `unknown tool: ${name}` }] };
    }
    try {
      return await tool.handler(args, ctx);
    } catch (e) {
      const msg = e?.message || String(e);
      const status = e?.status ? ` [HTTP ${e.status}]` : "";
      return { isError: true, content: [{ type: "text", text: `${name} failed${status}: ${msg}` }] };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => listResources(ctx));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: makeResourceTemplates(),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => readResource(req.params.uri, ctx));

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Greeting on stderr so the user knows the server is alive (Claude Desktop
  // captures both streams; stdout MUST stay reserved for MCP frames).
  const authBits = [
    ctx.client.hasOwnerAuth ? "owner" : null,
    ctx.client.hasWallet ? "wallet" : null,
    ctx.client.hasCap ? "cap" : null,
  ].filter(Boolean);
  process.stderr.write(
    `aindrive-mcp ${VERSION} ready · server=${ctx.client.server} · auth=${authBits.join("+") || "none"}\n`,
  );
}
