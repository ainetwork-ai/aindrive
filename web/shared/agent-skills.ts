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

export type SkillCtx = { userId: string };

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
  "stat",
  "search",
] as const;

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

  const driveIdRaw = arg(args, "drive_id");
  if (typeof driveIdRaw !== "string" || !driveIdRaw) {
    return { kind: "err", code: "invalid_params", message: "drive_id required" };
  }
  const driveId: string = driveIdRaw;
  const drive = getDrive(driveId);
  if (!drive) return { kind: "err", code: "not_found", message: "drive_not_found" };
  const driveSecret: string = drive.drive_secret;

  const path = typeof arg(args, "path") === "string" ? (arg(args, "path") as string) : "";
  const need: Role = name === "write_file" ? "editor" : "viewer";
  const role = await resolveAccess(driveId, path, ctx.userId);
  if (!atLeast(role, need)) {
    return { kind: "err", code: "forbidden", message: `forbidden (need ${need}, have ${role})` };
  }

  try {
    switch (name) {
      case "list_files": {
        const r = await callAgent(driveId, driveSecret, { method: "list", path });
        const entries = (r.entries ?? []) as Array<{ name: string; isDir: boolean; size?: number }>;
        const text = entries.length === 0
          ? `(empty) ${path || "/"}`
          : entries.map((e) => `${e.isDir ? "📁" : "📄"} ${e.name}`).join("\n");
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
        const r = await callAgent(driveId, driveSecret, { method: "write", path, content, encoding });
        return { kind: "ok", structured: r, text: `wrote ${path}` };
      }
      case "stat": {
        if (!path) return { kind: "err", code: "invalid_params", message: "path required" };
        const slash = path.lastIndexOf("/");
        const parent = slash >= 0 ? path.slice(0, slash) : "";
        const base = slash >= 0 ? path.slice(slash + 1) : path;
        const r = await callAgent(driveId, driveSecret, { method: "list", path: parent });
        const entry = ((r.entries ?? []) as Array<{ name: string }>).find((e) => e.name === base);
        if (!entry) return { kind: "err", code: "not_found", message: `no entry at ${path}` };
        return { kind: "ok", structured: entry, text: JSON.stringify(entry) };
      }
      case "search": {
        const qRaw = arg(args, "query");
        if (typeof qRaw !== "string" || !qRaw) {
          return { kind: "err", code: "invalid_params", message: "query required" };
        }
        const q = qRaw.toLowerCase();
        const start = typeof arg(args, "path") === "string" ? (arg(args, "path") as string) : "";
        const lim = arg(args, "limit");
        const limit = Math.min(typeof lim === "number" ? lim : 50, 500);
        const matches: Array<{ path: string; isDir: boolean }> = [];
        const walk = async (dir: string): Promise<void> => {
          if (matches.length >= limit) return;
          const r = await callAgent(driveId, driveSecret, { method: "list", path: dir });
          for (const e of (r.entries ?? []) as Array<{ name: string; isDir: boolean }>) {
            if (matches.length >= limit) return;
            const full = dir ? `${dir}/${e.name}` : e.name;
            if (e.name.toLowerCase().includes(q)) matches.push({ path: full, isDir: e.isDir });
            if (e.isDir) await walk(full);
          }
        };
        await walk(start);
        const text = matches.length === 0
          ? `(no matches for "${qRaw}")`
          : matches.map((m) => `${m.isDir ? "📁" : "📄"} ${m.path}`).join("\n");
        return { kind: "ok", structured: { matches, truncated: matches.length >= limit }, text };
      }
    }
  } catch (e) {
    const err = e as AgentError;
    return { kind: "err", code: "internal", message: err.message || String(e) };
  }

  return { kind: "err", code: "internal", message: "unreachable" };
}
