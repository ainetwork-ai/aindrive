/**
 * Tool definitions for the aindrive MCP server.
 *
 * Each tool is { name, description, inputSchema (JSON Schema), handler }.
 * Handlers receive (args, ctx) where ctx = { client } from createClient().
 * They must return a value JSON-serializable as MCP `content` (string or object).
 */

const driveIdSchema = { type: "string", description: "drive id (e.g. 'aB3cD4...')" };
const pathSchema = { type: "string", description: "path inside the drive ('' = root)" };

function txt(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function err(message, hint) {
  return { isError: true, content: [{ type: "text", text: hint ? `${message}\n\nhint: ${hint}` : message }] };
}

function requireOwner(ctx, name) {
  if (!ctx.client.hasOwnerAuth) {
    return err(`tool '${name}' requires owner authentication`, "run `aindrive login` first or set AINDRIVE_SESSION");
  }
  return null;
}

export const TOOLS = [
  // ──────────────── A. Discovery ────────────────
  {
    name: "list_drives",
    description: "List all drives the current owner can access (or paired with the active wallet). Returns id, name, online status.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      const guard = requireOwner(ctx, "list_drives"); if (guard) return guard;
      const r = await ctx.client.get("/api/drives");
      return txt(r.body);
    },
  },
  {
    name: "drive_info",
    description: "Get metadata for a single drive (name, online status, hostname).",
    inputSchema: { type: "object", required: ["drive_id"], properties: { drive_id: driveIdSchema } },
    handler: async (args, ctx) => {
      const guard = requireOwner(ctx, "drive_info"); if (guard) return guard;
      const r = await ctx.client.get("/api/drives");
      const drive = r.body?.drives?.find((d) => d.id === args.drive_id);
      return drive ? txt(drive) : err(`drive ${args.drive_id} not found`);
    },
  },

  // ──────────────── B. File ops ────────────────
  {
    name: "list_files",
    description: "List entries at the given path of a drive.",
    inputSchema: {
      type: "object", required: ["drive_id"],
      properties: { drive_id: driveIdSchema, path: pathSchema },
    },
    handler: async (args, ctx) => {
      const r = await ctx.client.get(`/api/drives/${args.drive_id}/fs/list`, { query: { path: args.path ?? "" } });
      return txt(r.body);
    },
  },
  {
    name: "read_file",
    description: "Read a file from the drive. Encoding 'utf8' (default) returns text; 'base64' returns binary as base64.",
    inputSchema: {
      type: "object", required: ["drive_id", "path"],
      properties: {
        drive_id: driveIdSchema, path: pathSchema,
        encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
      },
    },
    handler: async (args, ctx) => {
      const r = await ctx.client.get(`/api/drives/${args.drive_id}/fs/read`, { query: { path: args.path, encoding: args.encoding || "utf8" } });
      return txt(r.body);
    },
  },
  {
    name: "write_file",
    description: "Write/overwrite a file on the drive. Pass content as utf8 text or base64 binary.",
    inputSchema: {
      type: "object", required: ["drive_id", "path", "content"],
      properties: {
        drive_id: driveIdSchema, path: pathSchema,
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
      },
    },
    handler: async (args, ctx) => {
      const r = await ctx.client.post(`/api/drives/${args.drive_id}/fs/write`, {
        path: args.path, content: args.content, encoding: args.encoding || "utf8",
      });
      return txt(r.body);
    },
  },
  {
    name: "rename",
    description: "Rename or move a file/folder within a drive.",
    inputSchema: {
      type: "object", required: ["drive_id", "from", "to"],
      properties: { drive_id: driveIdSchema, from: { type: "string" }, to: { type: "string" } },
    },
    handler: async (args, ctx) => {
      const r = await ctx.client.post(`/api/drives/${args.drive_id}/fs/rename`, { from: args.from, to: args.to });
      return txt(r.body);
    },
  },
  {
    name: "delete_path",
    description: "Delete a file or folder (recursive) from a drive.",
    inputSchema: {
      type: "object", required: ["drive_id", "path"],
      properties: { drive_id: driveIdSchema, path: pathSchema },
    },
    handler: async (args, ctx) => {
      const r = await ctx.client.post(`/api/drives/${args.drive_id}/fs/delete`, { path: args.path });
      return txt(r.body);
    },
  },
  {
    name: "stat",
    description: "Get metadata for a single path (size, mtime, isDir).",
    inputSchema: {
      type: "object", required: ["drive_id", "path"],
      properties: { drive_id: driveIdSchema, path: pathSchema },
    },
    handler: async (args, ctx) => {
      // No dedicated stat endpoint — use parent list + filter by name.
      const slash = args.path.lastIndexOf("/");
      const parent = slash >= 0 ? args.path.slice(0, slash) : "";
      const name = slash >= 0 ? args.path.slice(slash + 1) : args.path;
      const r = await ctx.client.get(`/api/drives/${args.drive_id}/fs/list`, { query: { path: parent } });
      const entry = r.body?.entries?.find((e) => e.name === name);
      return entry ? txt(entry) : err(`no entry at ${args.path}`);
    },
  },
  {
    name: "search",
    description: "Search filenames (and best-effort file contents) within a drive. Returns up to 'limit' matches.",
    inputSchema: {
      type: "object", required: ["drive_id", "query"],
      properties: {
        drive_id: driveIdSchema,
        query: { type: "string", description: "case-insensitive substring to search for" },
        path: { type: "string", description: "subtree to search (default '')", default: "" },
        limit: { type: "number", default: 50 },
      },
    },
    handler: async (args, ctx) => {
      const limit = Math.min(args.limit ?? 50, 500);
      const q = args.query.toLowerCase();
      const matches = [];
      async function walk(dir) {
        if (matches.length >= limit) return;
        const r = await ctx.client.get(`/api/drives/${args.drive_id}/fs/list`, { query: { path: dir } });
        for (const e of r.body?.entries ?? []) {
          if (matches.length >= limit) return;
          const full = dir ? `${dir}/${e.name}` : e.name;
          if (e.name.toLowerCase().includes(q)) matches.push({ path: full, isDir: e.isDir, hit: "name" });
          if (e.isDir) await walk(full);
        }
      }
      await walk(args.path ?? "");
      return txt({ matches, truncated: matches.length >= limit });
    },
  },

  // ──────────────── C. Sharing (owner) ────────────────
  {
    name: "create_share",
    description: "Create a share token for a drive path. Optional price_usdc enables x402 paid sharing.",
    inputSchema: {
      type: "object", required: ["drive_id", "role"],
      properties: {
        drive_id: driveIdSchema, path: pathSchema,
        role: { type: "string", enum: ["viewer", "commenter", "editor"] },
        expiresAt: { type: "string", description: "ISO 8601 datetime; absent = never" },
        password: { type: "string", minLength: 4 },
        price_usdc: { type: "number", description: "Price in USDC; absent = free share" },
      },
    },
    handler: async (args, ctx) => {
      const guard = requireOwner(ctx, "create_share"); if (guard) return guard;
      const body = { path: args.path ?? "", role: args.role };
      if (args.expiresAt) body.expiresAt = args.expiresAt;
      if (args.password) body.password = args.password;
      if (args.price_usdc) body.price_usdc = args.price_usdc;
      const r = await ctx.client.post(`/api/drives/${args.drive_id}/shares`, body);
      return txt(r.body);
    },
  },
  {
    name: "list_shares",
    description: "List existing shares for a drive (owner only).",
    inputSchema: { type: "object", required: ["drive_id"], properties: { drive_id: driveIdSchema } },
    handler: async (args, ctx) => {
      const guard = requireOwner(ctx, "list_shares"); if (guard) return guard;
      const r = await ctx.client.get(`/api/drives/${args.drive_id}/shares`);
      return txt(r.body);
    },
  },

  // ──────────────── D. Wallet allowlist (owner) ────────────────
  {
    name: "grant_access",
    description: "Add a wallet to a drive's allowlist for the given path. Returns a Meadowcap cap as portable proof.",
    inputSchema: {
      type: "object", required: ["drive_id", "wallet"],
      properties: { drive_id: driveIdSchema, path: pathSchema, wallet: { type: "string" } },
    },
    handler: async (args, ctx) => {
      const guard = requireOwner(ctx, "grant_access"); if (guard) return guard;
      const r = await ctx.client.post(`/api/drives/${args.drive_id}/access`, {
        wallet_address: args.wallet, path: args.path ?? "",
      });
      return txt(r.body);
    },
  },
  {
    name: "list_access",
    description: "List wallets/payments granted access to a drive.",
    inputSchema: {
      type: "object", required: ["drive_id"],
      properties: { drive_id: driveIdSchema, path: { type: "string", description: "filter by exact path; omit for all" } },
    },
    handler: async (args, ctx) => {
      const guard = requireOwner(ctx, "list_access"); if (guard) return guard;
      const r = await ctx.client.get(`/api/drives/${args.drive_id}/access`, args.path != null ? { query: { path: args.path } } : {});
      return txt(r.body);
    },
  },
  {
    name: "revoke_access",
    description: "Revoke a single access grant by id (from list_access).",
    inputSchema: {
      type: "object", required: ["drive_id", "access_id"],
      properties: { drive_id: driveIdSchema, access_id: { type: "string" } },
    },
    handler: async (args, ctx) => {
      const guard = requireOwner(ctx, "revoke_access"); if (guard) return guard;
      const r = await ctx.client.delete(`/api/drives/${args.drive_id}/access/${args.access_id}`);
      return txt(r.body ?? { ok: true });
    },
  },

  // ──────────────── E. Cap (Meadowcap) ────────────────
  {
    name: "verify_cap",
    description: "Verify a base64 Meadowcap cap and return its decoded subject + path prefix.",
    inputSchema: {
      type: "object", required: ["cap"],
      properties: { cap: { type: "string", description: "base64-encoded cap" } },
    },
    handler: async (args, ctx) => {
      const r = await ctx.client.post("/api/cap/verify", { cap: args.cap });
      return txt(r.body);
    },
  },

  // ──────────────── F. x402 paid shares ────────────────
  {
    name: "resolve_share",
    description:
      "Resolve a share token (from /s/<token>). Free shares return immediately. Paid shares trigger an X-PAYMENT flow: in DEV_BYPASS mode the server accepts a synthesised authorisation, otherwise the bound wallet (set AINDRIVE_WALLET_COOKIE) is used.",
    inputSchema: {
      type: "object", required: ["token"],
      properties: { token: { type: "string", description: "share token from URL /s/<token>" } },
    },
    handler: async (args, ctx) => {
      // First attempt: plain GET (free shares + wallets already on the allowlist).
      try {
        const r = await ctx.client.get(`/api/s/${args.token}`);
        return txt(r.body);
      } catch (e) {
        if (e.status !== 402) throw e;
      }
      // 402 → build a minimal X-PAYMENT envelope. In DEV_BYPASS the server only
      // checks the JSON shape; in prod a real wallet signature is required and
      // we can't synthesise one here.
      const fakePayer = process.env.AINDRIVE_DEMO_PAYER || "0xdemodemodemodemodemodemodemodemodemo0000";
      const xPayment = Buffer.from(JSON.stringify({
        x402Version: 1, scheme: "exact", network: "base-sepolia",
        payload: { authorization: { from: fakePayer } },
      })).toString("base64");
      const r2 = await ctx.client.get(`/api/s/${args.token}`, { headers: { "x-payment": xPayment } });
      return txt(r2.body);
    },
  },

  // ──────────────── G. Agent / A2A ────────────────
  {
    name: "list_agents",
    description: "List AI agents registered to a drive (A2A endpoints + capabilities).",
    inputSchema: { type: "object", required: ["drive_id"], properties: { drive_id: driveIdSchema } },
    handler: async (args, ctx) => {
      const r = await ctx.client.get(`/api/drives/${args.drive_id}/agents`);
      return txt(r.body);
    },
  },
  {
    name: "ask_agent",
    description: "Ask a question of an AI agent registered to a drive (A2A: identity → policy → CLI inference).",
    inputSchema: {
      type: "object", required: ["drive_id", "agent_id", "q"],
      properties: {
        drive_id: driveIdSchema,
        agent_id: { type: "string", description: "agent id from list_agents" },
        q: { type: "string", description: "the question to ask", maxLength: 2000 },
      },
    },
    handler: async (args, ctx) => {
      const r = await ctx.client.post(`/api/drives/${args.drive_id}/agents/${args.agent_id}/ask`, { q: args.q });
      return txt(r.body);
    },
  },
];
