/**
 * Skill catalog — names, descriptions and JSON-Schema inputs for every
 * aindrive skill (file tools + drive-scoped sale tools). Pure data (no IO),
 * so docs and clients can import it without pulling in the DB/agent stack;
 * the handlers live in ./agent-skills.ts, which re-exports this module.
 */
/** Owner-only selling tools: share links, payout wallets, token policy, receipts. */
export const SALE_SKILL_NAMES = [
  "list_shares",
  "create_share",
  "update_share",
  "delete_share",
  "get_sale_settings",
  "set_payout_wallet",
  "set_token_policy",
  "list_receipts",
] as const;

export const SKILL_NAMES = [
  "list_drives",
  "list_files",
  "read_file",
  "write_file",
  "delete_path",
  "stat",
  "search",
  ...SALE_SKILL_NAMES,
] as const;

/** Skills that change the drive: editor role, and never under a read scope. */
export const MUTATING: readonly string[] = ["write_file", "delete_path"];

export type SkillName = (typeof SKILL_NAMES)[number];
export type SaleSkillName = (typeof SALE_SKILL_NAMES)[number];

export function isSaleSkill(name: string): name is SaleSkillName {
  return (SALE_SKILL_NAMES as readonly string[]).includes(name);
}

/** What a skill needs from a grant: read, write (mutating file ops) or sell. */
export function skillGroup(name: SkillName): "read" | "write" | "sell" {
  if (isSaleSkill(name)) return "sell";
  return MUTATING.includes(name) ? "write" : "read";
}

export type SkillDescriptor = {
  name: SkillName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const SKILL_DESCRIPTORS: SkillDescriptor[] = [
  {
    name: "list_drives",
    description: "List the drives the authenticated user owns or is a member of.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_files",
    description: "List entries at a path inside a drive. Empty path = root.",
    inputSchema: {
      type: "object",
      required: ["drive_id"],
      properties: {
        drive_id: { type: "string", description: "drive id" },
        path: { type: "string", description: "drive-relative path (default '')" },
      },
    },
  },
  {
    name: "read_file",
    description: "Read a file. utf8 returns text; base64 returns binary as base64.",
    inputSchema: {
      type: "object",
      required: ["drive_id", "path"],
      properties: {
        drive_id: { type: "string" },
        path: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
      },
    },
  },
  {
    name: "write_file",
    description: "Write/overwrite a file. Creates intermediate folders.",
    inputSchema: {
      type: "object",
      required: ["drive_id", "path", "content"],
      properties: {
        drive_id: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
      },
    },
  },
  {
    name: "delete_path",
    description: "Delete a file, or a folder with everything in it. The drive root cannot be deleted.",
    inputSchema: {
      type: "object",
      required: ["drive_id", "path"],
      properties: {
        drive_id: { type: "string" },
        path: { type: "string" },
      },
    },
  },
  {
    name: "stat",
    description: "Metadata for a single path (name, isDir, size).",
    inputSchema: {
      type: "object",
      required: ["drive_id", "path"],
      properties: {
        drive_id: { type: "string" },
        path: { type: "string" },
      },
    },
  },
  {
    name: "search",
    description: "Search filenames (case-insensitive substring).",
    inputSchema: {
      type: "object",
      required: ["drive_id", "query"],
      properties: {
        drive_id: { type: "string" },
        query: { type: "string" },
        path: { type: "string", default: "" },
        limit: { type: "number", default: 50 },
      },
    },
  },
];

export const TOKEN_SCHEMA = {
  type: "object",
  required: ["symbol", "chain", "asset", "decimals", "transferMethod"],
  properties: {
    symbol: { type: "string", description: "e.g. USDC, FANCO" },
    chain: { type: "string", enum: ["base", "base-sepolia"] },
    asset: { type: "string", description: "token contract address on that chain" },
    name: { type: ["string", "null"], description: "EIP-712 domain name (needed for eip3009)" },
    version: { type: ["string", "null"], description: "EIP-712 domain version (needed for eip3009)" },
    decimals: { type: "integer", minimum: 2 },
    transferMethod: { type: "string", enum: ["eip3009", "permit2"] },
  },
};

/**
 * Sale tools — drive-scoped only (no drive_id), offered solely to an account
 * grant with `drives:sell`, and every call re-checks that the caller created
 * the drive. Prices are in units of the share's currency.
 */
export const SALE_SKILL_DESCRIPTORS: SkillDescriptor[] = [
  {
    name: "list_shares",
    description: "List every share link of the drive (free and paid), newest first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_share",
    description:
      "Put a file or folder up for sale: creates a paid share link (/s/<token>). Needs a payout wallet " +
      "covering the path and a currency from the drive's token policy; a non-root path must exist, so the " +
      "drive's agent must be online.",
    inputSchema: {
      type: "object",
      required: ["path", "price", "currency"],
      properties: {
        path: { type: "string", description: "drive-relative path; '' sells the whole drive" },
        price: { type: "number", exclusiveMinimum: 0, description: "price in `currency` units (2 decimals)" },
        currency: { type: "string", description: "token symbol from the drive's policy (get_sale_settings)" },
        listed: { type: "boolean", default: true, description: "show on the drive's storefront" },
        role: { type: "string", enum: ["viewer", "editor"], default: "viewer", description: "access a buyer gets" },
        expiresAt: { type: "string", format: "date-time", description: "link expiry (ISO 8601)" },
      },
    },
  },
  {
    name: "update_share",
    description: "Change a paid share's price, currency or storefront listing. The link and past sales are kept.",
    inputSchema: {
      type: "object",
      required: ["shareId"],
      properties: {
        shareId: { type: "string" },
        price: { type: "number", exclusiveMinimum: 0 },
        currency: { type: "string" },
        listed: { type: "boolean" },
      },
    },
  },
  {
    name: "delete_share",
    description: "Revoke a share link. Buyers keep the access they already paid for.",
    inputSchema: { type: "object", required: ["shareId"], properties: { shareId: { type: "string" } } },
  },
  {
    name: "get_sale_settings",
    description: "The drive's payout wallets (per path; the nearest ancestor's wallet is paid) and the tokens buyers can pay with.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_payout_wallet",
    description: "Set the wallet that receives payments for sales under a path ('' = the whole drive).",
    inputSchema: {
      type: "object",
      required: ["wallet"],
      properties: {
        path: { type: "string", default: "" },
        wallet: { type: "string", description: "EVM address" },
      },
    },
  },
  {
    name: "set_token_policy",
    description: "Replace the list of tokens sales can be priced in. Each must be a token contract on Base.",
    inputSchema: {
      type: "object",
      required: ["tokens"],
      properties: { tokens: { type: "array", minItems: 1, items: TOKEN_SCHEMA } },
    },
  },
  {
    name: "list_receipts",
    description:
      "Sales ledger, newest first. Page with `before` = the last receipt's settledAt " +
      "(a page may run past `limit` so a timestamp is never split across pages).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
        before: { type: "string", description: "settledAt of the previous page's last receipt" },
      },
    },
  },
];

/**
 * Descriptors for a drive-pinned surface: no list_drives, no drive_id
 * argument (the URL/token fixes the drive), no mutating skill (write_file,
 * delete_path) under a read scope, and the sale tools only with `sell` —
 * clients should not be offered a tool that always fails.
 */
export function driveScopedDescriptors(scope: "read" | "write", opts: { sell?: boolean } = {}): SkillDescriptor[] {
  const fileTools = SKILL_DESCRIPTORS
    .filter((d) => d.name !== "list_drives" && (scope === "write" || !MUTATING.includes(d.name)))
    .map((d) => {
      const schema = d.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      const { drive_id: _omit, ...properties } = schema.properties ?? {};
      return {
        ...d,
        inputSchema: {
          ...schema,
          properties,
          ...(schema.required ? { required: schema.required.filter((r) => r !== "drive_id") } : {}),
        },
      };
    });
  return opts.sell ? [...fileTools, ...SALE_SKILL_DESCRIPTORS] : fileTools;
}

export function isSkillName(s: string): s is SkillName {
  return (SKILL_NAMES as readonly string[]).includes(s);
}
