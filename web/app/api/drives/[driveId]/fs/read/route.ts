import { NextResponse } from "next/server";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { classifyKind } from "@/lib/mime";
import { bearerOf, delegatedAgentErrorCode, delegatedAgentMessage, isResourceDelegationToken, resourceKey } from "@/lib/resource-delegation";
import { errorResponse, requestOrigin } from "@/lib/shared-items";
import { ainIntegrationEnabled } from "@/lib/ain-integration.js";
import { GENERATION_RE, generationFor, generationOfRevision } from "@/lib/path-generations.js";
import { contractErrorOf, logRoute, requestIdOf, withRequestId } from "@/lib/request-id";

const MAX_READ_BYTES = parseInt(process.env.AINDRIVE_MAX_READ_BYTES ?? String(16 * 1024 * 1024), 10);

/**
 * GET /api/drives/:driveId/fs/read?path=...&encoding=auto|utf8|base64
 *
 * Default encoding is `auto`: the server inspects the file's mime type and
 * picks utf8 for text files / base64 for binary. The response body always
 * carries `{ content, encoding, mime }` so clients can branch on it without
 * having to repeat the same decision.
 *
 * `encoding=utf8` / `encoding=base64` force the transport, matching the
 * pre-existing API used by viewer.tsx.
 *
 * Also accepts `Authorization: Bearer <ain-rdlg+jwt>` + `X-AIN-PoP`: an agent
 * reading on behalf of the delegated account (lib/resource-delegation.ts,
 * R-DLG-READ-001). Such a caller gets contract error bodies
 * ({error:{code,message,retryable}}), including `source_offline` when the
 * drive's agent is not connected.
 *
 * With AIN_INTEGRATION_ENABLED (plan tasks 10.2, 12.5):
 *   `generation=<g>` or `revision=<…-g<g>>` (what a listing or a shared-file
 *   ref carries) pins the read to the file that generation named: when the
 *   path now holds another file, or nothing, the answer is 410
 *   resource_deleted — never the newer file. A ref without a generation
 *   reads as before. Every response carries `X-Request-Id`; a delegated call
 *   is logged (request id, account, resource id, jti — no token, no path).
 */
export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const requestId = requestIdOf(req);
  const delegated = isResourceDelegationToken(bearerOf(req));
  const done = async (res: Response, extra: { userId?: string | null; taskId?: string; resourceId?: string } = {}) => {
    if (delegated) {
      logRoute({ requestId, route: "fs/read", status: res.status, ...(await contractErrorOf(res)), driveId, auth: "delegation", ...extra });
    }
    return withRequestId(res, requestId);
  };
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) return done(NextResponse.json({ error: "path required" }, { status: 400 }));
  let path: string;
  try { path = normalizePath(rawPath); }
  catch { return done(NextResponse.json({ error: "invalid path" }, { status: 400 })); }

  const encodingParam = url.searchParams.get("encoding") ?? "auto";
  const classified = classifyKind(path);
  let encoding: "utf8" | "base64";
  if (encodingParam === "base64") encoding = "base64";
  else if (encodingParam === "utf8") encoding = "utf8";
  else encoding = classified.kind === "binary" ? "base64" : "utf8";

  // The generation a ref pins (flag on only; an old ref has none).
  let wantGeneration: string | null = null;
  if (ainIntegrationEnabled()) {
    const g = url.searchParams.get("generation");
    const r = url.searchParams.get("revision");
    if (g !== null) {
      if (!GENERATION_RE.test(g)) return done(errorResponse("unsupported_input", "generation is malformed"));
      wantGeneration = g;
    } else if (r !== null) {
      wantGeneration = generationOfRevision(r);
    }
  }

  const gate = await requireDriveRole(driveId, path, { min: "viewer", delegation: { req, action: "read" } });
  if (gate instanceof NextResponse) return done(gate);
  const { drive } = gate;
  const who = gate.delegation
    ? { userId: gate.userId, taskId: gate.delegation.claims.jti, resourceId: resourceKey(requestOrigin(req), driveId, path) }
    : {};
  try {
    if (wantGeneration) {
      // Checked only after the gate: an unauthorized caller learns nothing about the path.
      const stat = await callAgent(driveId, drive.drive_secret, { method: "stat", path }) as
        { entry: { isDir?: boolean; birthtimeMs?: number } | null };
      if (!stat.entry || stat.entry.isDir || generationFor(driveId, path, stat.entry) !== wantGeneration) {
        return done(errorResponse("resource_deleted", "the file this reference names is no longer there"), who);
      }
    }
    const result = await callAgent(driveId, drive.drive_secret, { method: "read", path, encoding });
    if (result && typeof result.content === "string") {
      const byteLength = encoding === "base64"
        ? Math.ceil(result.content.length * 3 / 4)
        : Buffer.byteLength(result.content, "utf8");
      if (byteLength > MAX_READ_BYTES) {
        return done(NextResponse.json(
          { error: "file too large to stream", limit: MAX_READ_BYTES, size: byteLength },
          { status: 413 },
        ), who);
      }
    }
    return done(NextResponse.json({ ...result, encoding, mime: classified.mime }), who);
  } catch (e) {
    const err = e as AgentError;
    if (gate.delegation) {
      const code = delegatedAgentErrorCode(err);
      return done(errorResponse(code, delegatedAgentMessage(code)), who);
    }
    return done(NextResponse.json({ error: err.message }, { status: err.status ?? 500 }));
  }
}
