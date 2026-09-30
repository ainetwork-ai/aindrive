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

/** Base units → decimal string ("500000", 6 → "0.5"), without floating point. */
function formatUnits(amount, decimals) {
  const v = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${v / base}.${frac}` : `${v / base}`;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v ?? null;
}

/**
 * A paid share the caller has not bought (or a payment the server refused):
 * tell the agent what to pay and how, instead of pretending to pay. The
 * server only accepts an x402 v2 PAYMENT-SIGNATURE signed by the buyer's
 * wallet; the CLI holds no wallet key, so it never builds one itself.
 */
function paymentRequired(e, server, token, attempted) {
  const body = e.body && typeof e.body === "object" ? e.body : {};
  const req = (Array.isArray(body.accepts) && body.accepts[0]) || {};
  const cur = body.currency || {};
  const decimals = Number.isInteger(cur.decimals) ? cur.decimals : null;
  let price = null;
  try { if (decimals != null && req.amount != null) price = formatUnits(req.amount, decimals); } catch { /* non-integer amount */ }
  const out = {
    error: e.status === 412 ? "permit2_allowance_required" : "payment_required",
    reason: body.error ?? null,
    price: price != null ? `${price}${cur.symbol ? ` ${cur.symbol}` : ""}` : null,
    amount: req.amount ?? null,
    network: req.network ?? null,
    asset: req.asset ?? null,
    payTo: req.payTo ?? null,
    scheme: req.scheme ?? null,
    paymentRequired: headerValue(e.headers, "payment-required"),
    buyUrl: `${server}/s/${token}`,
    next: "sign paymentRequired with the buyer's wallet (x402 v2) and call resolve_share again with payment=<PAYMENT-SIGNATURE>, or open buyUrl in a browser",
  };
  const head = `resolve_share: ${attempted ? "payment not accepted" : "payment required"} [HTTP ${e.status}]`;
  return { isError: true, content: [{ type: "text", text: `${head}\n${JSON.stringify(out, null, 2)}` }] };
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
      "Resolve a share token (from /s/<token>). Free shares, and paid shares this account (or the AINDRIVE_WALLET_COOKIE wallet) already bought, " +
      "return the grant. An unpaid paid share returns `payment_required` with the price, network, asset, payee and the x402 v2 " +
      "PAYMENT-REQUIRED header: sign it with the buyer's wallet (x402 v2 — e.g. an @x402 client or the AIN-UI signX402Payment adapter) " +
      "and call again with `payment` = the base64 PAYMENT-SIGNATURE, or buy in the browser at `buyUrl`. Nothing is charged without a signature.",
    inputSchema: {
      type: "object", required: ["token"],
      properties: {
        token: { type: "string", description: "share token from URL /s/<token>" },
        payment: { type: "string", description: "base64 x402 v2 PAYMENT-SIGNATURE signed by the buyer's wallet for the returned PAYMENT-REQUIRED (optional)" },
      },
    },
    handler: async (args, ctx) => {
      const path = `/api/s/${encodeURIComponent(args.token)}`;
      try {
        const r = await ctx.client.get(path, args.payment ? { headers: { "PAYMENT-SIGNATURE": args.payment } } : {});
        return txt(r.body);
      } catch (e) {
        // 402 = pay first; 412 = permit2 allowance needed (the approve runs in the buyer's wallet).
        if (e.status !== 402 && e.status !== 412) throw e;
        return paymentRequired(e, ctx.client.server, args.token, !!args.payment);
      }
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
