import { NextResponse } from "next/server";
import { AgentError, callAgent } from "@/lib/rpc";
import { normalizePath } from "@/lib/path";
import { requireDriveRole } from "@/lib/require-access";
import { paidLocksForListing } from "@/lib/sale-access.js";

type Entry = { name: string; [k: string]: unknown };

export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const url = new URL(req.url);
  let path: string;
  try { path = normalizePath(url.searchParams.get("path") || ""); }
  catch { return NextResponse.json({ error: "invalid path" }, { status: 400 }); }
  const gate = await requireDriveRole(driveId, path, { min: "viewer" });
  if (gate instanceof NextResponse) return gate;
  const { drive, role, userId } = gate;
  try {
    const result = await callAgent(driveId, drive.drive_secret, { method: "list", path });
    // R-VIS-PAID-001: annotate paid children this viewer can't yet read as locked,
    // so the listing shows 🔒 + price + ticker (click → paywall) instead of letting
    // them open it and hit a 402. editor+ get no locks (paidLocksForListing).
    const entries: Entry[] = result.entries ?? [];
    const locks = paidLocksForListing(driveId, path, entries.map((e) => e.name), role, userId);
    const annotated = entries.map((e) =>
      locks[e.name] ? { ...e, locked: true, ...locks[e.name] } : e,
    );
    return NextResponse.json({ entries: annotated, role });
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
