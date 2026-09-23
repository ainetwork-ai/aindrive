/**
 * Shared skill handlers — single backing function used by the A2A
 * AgentExecutor (lib/aindrive-agent.ts) and the MCP tool handlers
 * (app/mcp/route.ts).
 *
 *   runSkill(ctx, name, args) →
 *     { kind: "ok",  structured, text }     happy path
 *     { kind: "err", code, message }         validation / auth / internal
 *
 * Auth: ctx.userId is supplied by the caller (route handlers extract
 * the JWT before invoking). resolveAccess + atLeast gate every drive
 * op per-path.
 *
 * Descriptors include JSON Schema for tool/skill inputs so MCP can
 * emit them verbatim in tools/list and A2A can use them to validate
 * DataParts in v1.1.
 */

import { eq } from "drizzle-orm";
import { getDrive } from "@/lib/drives";
import { resolveAccess, atLeast, type Role } from "@/lib/access";
import { drizzleDb } from "@/lib/db";
import { drives as drivesTable } from "../drizzle/schema";
import { callAgent, AgentError } from "@/lib/rpc";
import { paidAccessDenial, paidLocksForListing } from "@/lib/sale-access.js";
import { normalizePath } from "@/lib/path";
import { getUserTier, TIER_FILE_LIMIT } from "@/lib/tier";
import { getOwnerUsage, bumpOwnerUsage } from "@/lib/storage-usage.js";
import { isSystemPath } from "@/shared/domain/policy/system-paths";

// Mirrors fs/write/route.ts (AINDRIVE_MAX_WRITE_BYTES).
const MAX_WRITE_BYTES = parseInt(process.env.AINDRIVE_MAX_WRITE_BYTES ?? String(100 * 1024 * 1024), 10);

function splitPath(p: string): { parent: string; base: string } {
  const i = p.lastIndexOf("/");
  return i < 0 ? { parent: "", base: p } : { parent: p.slice(0, i), base: p.slice(i + 1) };
}

/**
 * `driveId` pins every call to one drive (drive-scoped MCP endpoint /
 * token): `drive_id` defaults to it, any other drive is forbidden, and
 * `list_drives` is unavailable. `scope` is the token's ceiling — "read"
 * forbids write_file regardless of the user's role. Both omitted = the
 * legacy account-wide surface (A2A executor, session-auth /mcp).
 */
export type SkillCtx = { userId: string; driveId?: string; scope?: "read" | "write" };

export type SkillOk = { kind: "ok"; structured: unknown; text: string };
export type SkillErr = {
  kind: "err";
  code: "invalid_params" | "forbidden" | "internal" | "not_found";
  message: string;
};
export type SkillResult = SkillOk | SkillErr;

const SKILL_NAMES = [
  "list_drives",
  "list_files",
  "read_file",
  "write_file",
  "delete_path",
  "stat",
  "search",
] as const;

/** Skills that change the drive: editor role, and never under a read scope. */
const MUTATING: readonly string[] = ["write_file", "delete_path"];

export type SkillName = (typeof SKILL_NAMES)[number];

export type SkillDescriptor = {
  name: SkillName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const SKILL_DESCRIPTORS: SkillDescriptor[] = [
  {
    name: "list_drives",
    description: "List drives the authenticated owner can access.",
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

/**
 * Descriptors for a drive-pinned surface: no list_drives, no drive_id
 * argument (the URL/token fixes the drive), and no mutating skill
 * (write_file, delete_path) under a read scope — clients should not be
 * offered a tool that always fails.
 */
export function driveScopedDescriptors(scope: "read" | "write"): SkillDescriptor[] {
  return SKILL_DESCRIPTORS
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
}

export function isSkillName(s: string): s is SkillName {
  return (SKILL_NAMES as readonly string[]).includes(s);
}

function arg(args: Record<string, unknown>, key: string): unknown {
  return args && typeof args === "object" ? args[key] : undefined;
}

export async function runSkill(
  ctx: SkillCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<SkillResult> {
  if (!isSkillName(name)) {
    return { kind: "err", code: "invalid_params", message: `unknown skill: ${name}` };
  }

  if (name === "list_drives") {
    if (ctx.driveId) {
      return { kind: "err", code: "forbidden", message: "list_drives is unavailable on a drive-scoped endpoint" };
    }
    const rows = drizzleDb
      .select({ id: drivesTable.id, name: drivesTable.name, owner_id: drivesTable.owner_id })
      .from(drivesTable)
      .where(eq(drivesTable.owner_id, ctx.userId))
      .all();
    const text = rows.length === 0
      ? "(no drives)"
      : rows.map((r) => `${r.id} — ${r.name}`).join("\n");
    return { kind: "ok", structured: { drives: rows }, text };
  }

  const driveIdRaw = arg(args, "drive_id") ?? ctx.driveId;
  if (ctx.driveId && driveIdRaw !== ctx.driveId) {
    return { kind: "err", code: "forbidden", message: "token is scoped to a different drive" };
  }
  if (typeof driveIdRaw !== "string" || !driveIdRaw) {
    return { kind: "err", code: "invalid_params", message: "drive_id required" };
  }
  const driveId: string = driveIdRaw;
  const drive = getDrive(driveId);
  if (!drive) return { kind: "err", code: "not_found", message: "drive_not_found" };
  const driveSecret: string = drive.drive_secret;

  // Canonicalize ONCE and use the same string for every check and the agent
  // call: access, paywall and system-path checks must all see the path the
  // agent will actually touch ("/paid/a.pdf" and "paid//a.pdf" are "paid/a.pdf").
  // (search walks from `path` too.)
  const rawPath = arg(args, "path");
  let path: string;
  try {
    path = normalizePath(typeof rawPath === "string" ? rawPath : "");
  } catch (e) {
    return { kind: "err", code: "invalid_params", message: `invalid path: ${(e as Error).message}` };
  }
  // `.aindrive/` holds the agent token, drive secret and agent API keys —
  // never reachable through a skill, whatever the caller's role.
  if (isSystemPath(path)) {
    return { kind: "err", code: "forbidden", message: "reserved path" };
  }

  const need: Role = MUTATING.includes(name) ? "editor" : "viewer";
  if (need === "editor" && ctx.scope === "read") {
    return { kind: "err", code: "forbidden", message: "forbidden (token scope is read-only)" };
  }
  const role = await resolveAccess(driveId, path, ctx.userId);
  if (!atLeast(role, need)) {
    return { kind: "err", code: "forbidden", message: `forbidden (need ${need}, have ${role})` };
  }
  // Paid carve-out, mirroring requireDriveRole on the fs/* routes: a bare
  // viewer can't open (read or list into) a priced subtree without an
  // entitlement. editor+ bypass inside paidAccessDenial.
  if (name !== "stat" && paidAccessDenial(driveId, path, role, ctx.userId)) {
    return { kind: "err", code: "forbidden", message: `payment required for ${path || "/"}` };
  }

  // R-VIS-PAID-001, as in fs/list: listed paid children show as locked,
  // unlisted (private, link-only) paid children are hidden entirely.
  type Entry = { name: string; isDir: boolean; size?: number; locked?: boolean };
  const visibleEntries = (dir: string, entries: Entry[]): Entry[] => {
    const locks = paidLocksForListing(driveId, dir, entries.map((e) => e.name), role, ctx.userId);
    return entries
      .filter((e) => !(locks[e.name] && !locks[e.name].listed))
      .map((e) => (locks[e.name] ? { ...e, locked: true } : e));
  };

  try {
    switch (name) {
      case "list_files": {
        const r = await callAgent(driveId, driveSecret, { method: "list", path });
        const entries = visibleEntries(path, (r.entries ?? []) as Entry[]);
        const text = entries.length === 0
          ? `(empty) ${path || "/"}`
          : entries.map((e) => `${e.isDir ? "📁" : "📄"} ${e.name}${e.locked ? " 🔒" : ""}`).join("\n");
        return { kind: "ok", structured: { entries }, text };
      }
      case "read_file": {
        if (!path) return { kind: "err", code: "invalid_params", message: "path required" };
        const encoding = (arg(args, "encoding") === "base64" ? "base64" : "utf8") as "utf8" | "base64";
        const r = await callAgent(driveId, driveSecret, { method: "read", path, encoding });
        const text = typeof r.content === "string"
          ? (encoding === "utf8" ? r.content : `[base64, ${r.content.length} chars]`)
          : "";
        return { kind: "ok", structured: r, text };
      }
      case "write_file": {
        if (!path) return { kind: "err", code: "invalid_params", message: "path required" };
        const content = arg(args, "content");
        if (typeof content !== "string") {
          return { kind: "err", code: "invalid_params", message: "content (string) required" };
        }
        const encoding = (arg(args, "encoding") === "base64" ? "base64" : "utf8") as "utf8" | "base64";
        // Same caps as fs/write: payload size + the owner's tiered file count on create.
        const byteLength = encoding === "base64" ? Math.ceil(content.length * 3 / 4) : Buffer.byteLength(content, "utf8");
        if (byteLength > MAX_WRITE_BYTES) {
          return { kind: "err", code: "invalid_params", message: `payload too large (limit ${MAX_WRITE_BYTES} bytes)` };
        }
        const { parent, base } = splitPath(path);
        let creating = true;
        try {
          const l = await callAgent(driveId, driveSecret, { method: "list", path: parent });
          creating = !((l.entries ?? []) as Entry[]).some((e) => e.name === base && !e.isDir);
        } catch { /* parent missing → create */ }
        const ownerId = drive.owner_id as string;
        if (creating) {
          const { tier } = await getUserTier();
          const limit = TIER_FILE_LIMIT[tier];
          if (Number.isFinite(limit) && getOwnerUsage(ownerId).files + 1 > limit) {
            return { kind: "err", code: "forbidden", message: `file_limit_reached (tier ${tier}, limit ${limit})` };
          }
        }
        const r = await callAgent(driveId, driveSecret, { method: "write", path, content, encoding });
        if (creating) bumpOwnerUsage(ownerId, { files: 1 });
        return { kind: "ok", structured: r, text: `wrote ${path}` };
      }
      case "delete_path": {
        // "" is the drive root — the whole shared folder, never a delete target
        if (!path) return { kind: "err", code: "invalid_params", message: "path required (the drive root cannot be deleted)" };
        // As fs/delete: learn file vs folder first so the owner's usage counter
        // moves the right way. Drift on recursive folder deletes is acceptable —
        // limits are upper bounds.
        const { parent, base } = splitPath(path);
        let kind: "file" | "folder" | "unknown" = "unknown";
        try {
          const l = await callAgent(driveId, driveSecret, { method: "list", path: parent });
          const entry = ((l.entries ?? []) as Entry[]).find((e) => e.name === base);
          if (!entry) return { kind: "err", code: "not_found", message: `no entry at ${path}` };
          kind = entry.isDir ? "folder" : "file";
        } catch { /* parent unlistable — let the agent decide */ }
        const r = await callAgent(driveId, driveSecret, { method: "delete", path });
        const ownerId = drive.owner_id as string;
        if (kind === "file") bumpOwnerUsage(ownerId, { files: -1 });
        else if (kind === "folder") bumpOwnerUsage(ownerId, { folders: -1 });
        return { kind: "ok", structured: { ...r, path, kind }, text: `deleted ${path}` };
      }
      case "stat": {
        if (!path) return { kind: "err", code: "invalid_params", message: "path required" };
        const { parent, base } = splitPath(path);
        const r = await callAgent(driveId, driveSecret, { method: "list", path: parent });
        const entry = visibleEntries(parent, (r.entries ?? []) as Entry[]).find((e) => e.name === base);
        if (!entry) return { kind: "err", code: "not_found", message: `no entry at ${path}` };
        return { kind: "ok", structured: entry, text: JSON.stringify(entry) };
      }
      case "search": {
        const qRaw = arg(args, "query");
        if (typeof qRaw !== "string" || !qRaw) {
          return { kind: "err", code: "invalid_params", message: "query required" };
        }
        const q = qRaw.toLowerCase();
        const lim = arg(args, "limit");
        const limit = Math.min(typeof lim === "number" ? lim : 50, 500);
        const matches: Array<{ path: string; isDir: boolean; locked?: boolean }> = [];
        const walk = async (dir: string): Promise<void> => {
          if (matches.length >= limit) return;
          const r = await callAgent(driveId, driveSecret, { method: "list", path: dir });
          for (const e of visibleEntries(dir, (r.entries ?? []) as Entry[])) {
            if (matches.length >= limit) return;
            const full = dir ? `${dir}/${e.name}` : e.name;
            if (e.name.toLowerCase().includes(q)) matches.push({ path: full, isDir: e.isDir, ...(e.locked ? { locked: true } : {}) });
            // Never descend into a subtree this caller hasn't paid for.
            if (e.isDir && !e.locked) await walk(full);
          }
        };
        await walk(path);
        const text = matches.length === 0
          ? `(no matches for "${qRaw}")`
          : matches.map((m) => `${m.isDir ? "📁" : "📄"} ${m.path}${m.locked ? " 🔒" : ""}`).join("\n");
        return { kind: "ok", structured: { matches, truncated: matches.length >= limit }, text };
      }
    }
  } catch (e) {
    const err = e as AgentError;
    return { kind: "err", code: "internal", message: err.message || String(e) };
  }

  return { kind: "err", code: "internal", message: "unreachable" };
}
