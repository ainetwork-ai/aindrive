import { NextResponse } from "next/server";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { requireDriveRole } from "@/lib/require-access";
import { paidLocksForListing } from "@/lib/sale-access.js";
import { delegatedAgentErrorCode } from "@/lib/resource-delegation";
import { errorResponse } from "@/lib/shared-items";

type Entry = { name: string; [k: string]: unknown };

/**
 * GET /api/drives/:driveId/fs/list?path=...
 *
 * Also accepts `Authorization: Bearer <ain-rdlg+jwt>` + `X-AIN-PoP` (an agent
 * listing a granted folder on behalf of the delegated account; action `list`,
 * lib/resource-delegation.ts, R-DLG-READ-001) with contract error bodies.
 */
export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const url = new URL(req.url);
  let path: string;
  try { path = normalizePath(url.searchParams.get("path") || ""); }
  catch { return NextResponse.json({ error: "invalid path" }, { status: 400 }); }
  const gate = await requireDriveRole(driveId, path, { min: "viewer", delegation: { req, action: "list" } });
  if (gate instanceof NextResponse) return gate;
  const { drive, role, userId } = gate;
  try {
    const result = await callAgent(driveId, drive.drive_secret, { method: "list", path });
    // R-VIS-PAID-001: annotate paid children this viewer can't yet read as locked,
    // so the listing shows 🔒 + price + ticker (click → paywall) instead of letting
    // them open it and hit a 402. editor+ get no locks (paidLocksForListing).
    const entries: Entry[] = result.entries ?? [];
    const locks = paidLocksForListing(driveId, path, entries.map((e) => e.name), role, userId);
    const annotated = entries
      .map((e) => (locks[e.name] ? { ...e, locked: true, ...locks[e.name] } : e))
      // Listed paid item → shown locked (advertise the sale). Unlisted paid item
      // → HIDDEN: it's a private (link-only) sale, so a non-entitled viewer must
      // not even learn it exists. editor+ have no locks, so they see everything.
      .filter((e) => !(e.locked && e.listed === false));
    return NextResponse.json({ entries: annotated, role });
  } catch (e) {
    const err = e as AgentError;
    if (gate.delegation) return errorResponse(delegatedAgentErrorCode(err), err.message);
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
