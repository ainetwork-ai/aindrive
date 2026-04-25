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

import pkg from "../../package.json" assert { type: "json" };
import { createClient } from "./client.js";
import { TOOLS } from "./tools.js";
import { listResources, readResource, makeResourceTemplates } from "./resources.js";

const cliVersion = pkg.version;

function err(line) {
  process.stderr.write(line + "\n");
}

export async function runMcpServer({ server: serverUrl } = {}) {
  const client = await createClient({ server: serverUrl });
  const ctx = { client };

  const server = new Server(
    { name: "aindrive", version: cliVersion },
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

  // --- Banner (stderr only — stdout is the MCP wire) ---
  const authBits = [
    ctx.client.hasOwnerAuth ? "owner" : null,
    ctx.client.hasWallet ? "wallet" : null,
    ctx.client.hasCap ? "cap" : null,
  ].filter(Boolean);
  const authLabel = authBits.join("+") || "none";
  err(`aindrive-mcp ${cliVersion} · server=${ctx.client.server} · auth=${authLabel}`);

  // --- Auth hint: no creds found ---
  if (authLabel === "none") {
    err("  No credentials found. To authenticate:");
    err("    aindrive login               # interactive login via browser");
    err("    export AINDRIVE_SESSION=...  # or set a raw session cookie");
    err("    export AINDRIVE_WALLET_COOKIE=...  # or set a wallet cookie");
    err("  Continuing anyway — cap-only tools (e.g. verify_cap) still work.");
  }

  // --- Connectivity probe with 5 s timeout ---
  try {
    const probe = ctx.client.get("/api/whoami");
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), 5000),
    );
    await Promise.race([probe, timeout]);
  } catch (e) {
    const code = e?.code || (e?.status ? `HTTP ${e.status}` : "ERR");
    let hint = "check --server or AINDRIVE_SERVER";
    if (code === "TIMEOUT") hint = "is the aindrive web running? (timed out after 5 s)";
    else if (code === "ECONNREFUSED") hint = "is the aindrive web running?";
    else if (code === "ENOTFOUND") hint = "check --server or AINDRIVE_SERVER (DNS lookup failed)";
    else if (e?.status >= 500) hint = "server returned an error — check web server logs";
    err(`cannot reach ${ctx.client.server} (${code}): ${hint}`);
    err("  Continuing — tools that don't need the server (e.g. verify_cap) still work.");
  }
}
