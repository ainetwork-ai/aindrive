import { NextResponse } from "next/server";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { requireDriveRole } from "@/lib/require-access";
import { visibleChildren } from "@/lib/listing-visibility";
import { bearerOf, delegatedAgentErrorCode, delegatedAgentMessage, isResourceDelegationToken, resourceKey } from "@/lib/resource-delegation";
import { errorResponse, requestOrigin, sharedRevision } from "@/lib/shared-items";
import { ainIntegrationEnabled } from "@/lib/ain-integration.js";
import { generationFor, revisionWithGeneration } from "@/lib/path-generations.js";
import { contractErrorOf, logRoute, requestIdOf, withRequestId } from "@/lib/request-id";

type Entry = { name: string; mtimeMs?: number; size?: number; birthtimeMs?: number; [k: string]: unknown };

/**
 * GET /api/drives/:driveId/fs/list?path=...
 *
 * Also accepts `Authorization: Bearer <ain-rdlg+jwt>` + `X-AIN-PoP` (an agent
 * listing a granted folder on behalf of the delegated account; action `list`,
 * lib/resource-delegation.ts, R-DLG-READ-001) with contract error bodies.
 *
 * Which children appear is lib/listing-visibility.ts (the one rule every
 * listing surface shares). With AIN_INTEGRATION_ENABLED each entry also
 * carries `generation` + `revision` (lib/path-generations.js, task 10.2), and
 * the response an `X-Request-Id` (task 12.5).
 */
export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const requestId = requestIdOf(req);
  const delegated = isResourceDelegationToken(bearerOf(req));
  const done = async (res: Response, extra: { userId?: string | null; taskId?: string; resourceId?: string; error?: unknown } = {}) => {
    if (delegated) {
      logRoute({ requestId, route: "fs/list", status: res.status, ...(await contractErrorOf(res)), driveId, auth: "delegation", ...extra });
    }
    return withRequestId(res, requestId);
  };
  const url = new URL(req.url);
  let path: string;
  try { path = normalizePath(url.searchParams.get("path") || ""); }
  catch { return done(NextResponse.json({ error: "invalid path" }, { status: 400 })); }
  const gate = await requireDriveRole(driveId, path, { min: "viewer", delegation: { req, action: "list" } });
  if (gate instanceof NextResponse) return done(gate);
  const { drive, role, userId } = gate;
  const who = gate.delegation
    ? { userId, taskId: gate.delegation.claims.jti, resourceId: resourceKey(requestOrigin(req), driveId, path) }
    : {};
  try {
    const result = await callAgent(driveId, drive.drive_secret, { method: "list", path });
    // R-VIS-PAID-001: listed paid children this viewer can't yet read are shown
    // locked (🔒 + price + ticker, click → paywall); unlisted ones and the
    // reserved subtree are left out. editor+ get no locks.
    const withGeneration = ainIntegrationEnabled();
    const entries = visibleChildren(driveId, path, (result.entries ?? []) as Entry[], role, userId).map(({ entry, lock }) => {
      let e: Entry = lock ? { ...entry, locked: true, ...lock } : entry;
      if (withGeneration) {
        const generation = generationFor(driveId, path ? `${path}/${entry.name}` : entry.name, entry);
        e = { ...e, generation, revision: revisionWithGeneration(sharedRevision(entry), generation) };
      }
      return e;
    });
    return done(NextResponse.json({ entries, role }), who);
  } catch (e) {
    const err = e as AgentError;
    if (gate.delegation) {
      const code = delegatedAgentErrorCode(err);
      return done(errorResponse(code, delegatedAgentMessage(code)), who);
    }
    return done(NextResponse.json({ error: err.message }, { status: err.status ?? 500 }));
  }
}
