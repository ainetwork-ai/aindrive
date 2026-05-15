/**
 * Aindrive remote MCP endpoint — Streamable-HTTP-ish.
 *
 * Wire = JSON-RPC 2.0 over HTTP POST. Supports the MCP methods that
 * matter for file ops:
 *
 *   initialize         server handshake
 *   tools/list         enumerate tools
 *   tools/call         invoke a tool by name
 *   ping               keepalive
 *
 * SSE (GET) for server→client notifications is not implemented; file
 * ops don't need it yet. Add later if/when streaming tool output lands.
 *
 * Auth: `Authorization: Bearer <jwt>` (or the aindrive_session cookie
 * for browser-side callers). The JWT is the same session token web's
 * login mints — owners who want to wire an external A2A agent into
 * their drive copy that token from devtools and paste it server-side
 * as a config secret. v1 is owner-scoped only; per-drive caps land
 * in v1.1.
 *
 * Tools (v1, file ops only):
 *   list_drives
 *   list_files
 *   read_file
 *   write_file
 *   stat
 *
 * The shape mirrors `cli/src/mcp/tools.js` so a single tool name +
 * args object works against either the stdio CLI or this HTTP endpoint.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verify } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveAccess, atLeast, type Role } from "@/lib/access";
import { drizzleDb } from "@/lib/db";
import { drives as drivesTable } from "../../../drizzle/schema";
import { eq } from "drizzle-orm";
import { callAgent, AgentError } from "@/lib/rpc";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const SERVER_INFO = {
  name: "aindrive",
  version: "0.1.0",
};

const PROTOCOL_VERSION = "2025-06-18";

// ─── JSON-RPC error codes ────────────────────────────────────────────────
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNAUTHORIZED = -32001;
const FORBIDDEN = -32002;

// ─── OPTIONS (CORS preflight) ────────────────────────────────────────────
export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ─── Tool catalog ────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "list_drives",
    description:
      "List all drives the authenticated owner has access to. Returns id, name, owner_id.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_files",
    description: "List entries at the given path of a drive.",
    inputSchema: {
      type: "object",
      required: ["drive_id"],
      properties: {
        drive_id: { type: "string", description: "drive id" },
        path: { type: "string", description: "path inside the drive ('' = root)" },
      },
    },
  },
  {
    name: "read_file",
    description:
      "Read a file from the drive. Encoding 'utf8' returns text; 'base64' returns binary as base64.",
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
    description: "Write/overwrite a file on the drive. Content is utf8 text or base64 binary.",
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
    description: "Get metadata for a single path (size, mtime, isDir).",
    inputSchema: {
      type: "object",
      required: ["drive_id", "path"],
      properties: {
        drive_id: { type: "string" },
        path: { type: "string" },
      },
    },
  },
] as const;

// ─── Auth ────────────────────────────────────────────────────────────────
async function resolveUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) {
      const userId = await verify(m[1]);
      if (userId) return userId;
    }
  }
  const c = await cookies();
  const sess = c.get("aindrive_session")?.value;
  if (sess) {
    const userId = await verify(sess);
    if (userId) return userId;
  }
  return null;
}

// ─── Tool dispatch ───────────────────────────────────────────────────────
type ToolCtx = { userId: string };

async function runTool(
  ctx: ToolCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; code: number; message: string }> {
  if (name === "list_drives") {
    const rows = drizzleDb
      .select({
        id: drivesTable.id,
        name: drivesTable.name,
        owner_id: drivesTable.owner_id,
      })
      .from(drivesTable)
      .where(eq(drivesTable.owner_id, ctx.userId))
      .all();
    return { ok: true, result: { drives: rows } };
  }

  const driveId = arg(args, "drive_id");
  if (typeof driveId !== "string" || !driveId) {
    return { ok: false, code: INVALID_PARAMS, message: "drive_id required" };
  }
  const drive = getDrive(driveId);
  if (!drive) return { ok: false, code: INVALID_PARAMS, message: "drive not found" };

  const path = typeof arg(args, "path") === "string" ? (arg(args, "path") as string) : "";
  const need: Role = name === "write_file" ? "editor" : "viewer";
  const role = await resolveAccess(driveId, path, ctx.userId);
  if (!atLeast(role, need)) {
    return { ok: false, code: FORBIDDEN, message: `forbidden (need ${need}, have ${role})` };
  }

  try {
    switch (name) {
      case "list_files": {
        const r = await callAgent(driveId, drive.drive_secret, { method: "list", path });
        return { ok: true, result: { entries: r.entries ?? [] } };
      }
      case "read_file": {
        const encoding = (arg(args, "encoding") === "base64" ? "base64" : "utf8") as "utf8" | "base64";
        const r = await callAgent(driveId, drive.drive_secret, { method: "read", path, encoding });
        return { ok: true, result: r };
      }
      case "write_file": {
        const content = arg(args, "content");
        if (typeof content !== "string") {
          return { ok: false, code: INVALID_PARAMS, message: "content (string) required" };
        }
        const encoding = (arg(args, "encoding") === "base64" ? "base64" : "utf8") as "utf8" | "base64";
        const r = await callAgent(driveId, drive.drive_secret, {
          method: "write",
          path,
          content,
          encoding,
        });
        return { ok: true, result: r };
      }
      case "stat": {
        const slash = path.lastIndexOf("/");
        const parent = slash >= 0 ? path.slice(0, slash) : "";
        const base = slash >= 0 ? path.slice(slash + 1) : path;
        const r = await callAgent(driveId, drive.drive_secret, { method: "list", path: parent });
        const entry = (r.entries ?? []).find((e: { name: string }) => e.name === base);
        if (!entry) return { ok: false, code: INVALID_PARAMS, message: `no entry at ${path}` };
        return { ok: true, result: entry };
      }
      default:
        return { ok: false, code: METHOD_NOT_FOUND, message: `unknown tool: ${name}` };
    }
  } catch (e) {
    const err = e as AgentError;
    return { ok: false, code: INTERNAL_ERROR, message: err.message || String(e) };
  }
}

function arg(args: Record<string, unknown>, key: string): unknown {
  return args && typeof args === "object" ? args[key] : undefined;
}

// ─── JSON-RPC envelope helpers ───────────────────────────────────────────
type RpcReq = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: unknown };
type RpcOk = { jsonrpc: "2.0"; id: string | number | null; result: unknown };
type RpcErr = { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string; data?: unknown } };

function ok(id: RpcReq["id"], result: unknown): RpcOk {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcErr(id: RpcReq["id"], code: number, message: string, data?: unknown): RpcErr {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function jsonResp(body: unknown, init: ResponseInit = {}) {
  return new NextResponse(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...(init.headers ?? {}) },
  });
}

// ─── POST handler ────────────────────────────────────────────────────────
export async function POST(req: Request) {
  let body: RpcReq | RpcReq[];
  try {
    body = (await req.json()) as RpcReq | RpcReq[];
  } catch {
    return jsonResp(rpcErr(null, PARSE_ERROR, "parse error"), { status: 400 });
  }

  const isBatch = Array.isArray(body);
  const reqs: RpcReq[] = isBatch ? (body as RpcReq[]) : [body as RpcReq];

  const responses: (RpcOk | RpcErr)[] = [];
  for (const r of reqs) {
    responses.push(await handleOne(req, r));
  }

  // notifications (no id) get no response; if all were notifications, return 204.
  const out = responses.filter((r) => r.id !== null || ("error" in r && r.error.code === PARSE_ERROR));
  if (out.length === 0) return new NextResponse(null, { status: 204, headers: CORS_HEADERS });

  return jsonResp(isBatch ? out : out[0]);
}

async function handleOne(req: Request, r: RpcReq): Promise<RpcOk | RpcErr> {
  if (!r || r.jsonrpc !== "2.0" || typeof r.method !== "string") {
    return rpcErr(r?.id ?? null, INVALID_REQUEST, "invalid request");
  }

  switch (r.method) {
    case "initialize":
      return ok(r.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
    case "ping":
      return ok(r.id, {});

    case "tools/list":
      return ok(r.id, { tools: TOOLS });

    case "tools/call": {
      const userId = await resolveUserId(req);
      if (!userId) {
        return rpcErr(r.id, UNAUTHORIZED, "unauthorized — missing or invalid bearer/session");
      }
      const params = (r.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (typeof params.name !== "string") {
        return rpcErr(r.id, INVALID_PARAMS, "tools/call requires name");
      }
      const res = await runTool({ userId }, params.name, params.arguments ?? {});
      if (!res.ok) {
        // MCP convention: tool errors return result with isError=true rather than
        // JSON-RPC error, so the model can see the failure. Reserve JSON-RPC
        // errors for protocol-level (auth, bad params) issues.
        if (res.code === UNAUTHORIZED || res.code === FORBIDDEN || res.code === INVALID_PARAMS) {
          return rpcErr(r.id, res.code, res.message);
        }
        return ok(r.id, {
          isError: true,
          content: [{ type: "text", text: res.message }],
        });
      }
      return ok(r.id, {
        content: [{ type: "text", text: JSON.stringify(res.result, null, 2) }],
        structuredContent: res.result,
      });
    }

    default:
      return rpcErr(r.id, METHOD_NOT_FOUND, `unknown method: ${r.method}`);
  }
}
