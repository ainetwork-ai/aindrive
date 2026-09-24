import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * GET → { clientName } for a pending pairing — what the approval page shows as
 * the requester (null = the aindrive CLI). The link id is the only key; the
 * name is self-reported by whoever started the pairing.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ linkId: string }> }) {
  const { linkId } = await params;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(linkId)) return NextResponse.json({ error: "invalid link" }, { status: 400 });
  const row = db
    .prepare("SELECT client_name, consumed_at FROM cli_link_requests WHERE link_id = ? AND expires_at >= datetime('now')")
    .get(linkId) as { client_name: string | null; consumed_at: string | null } | undefined;
  if (!row || row.consumed_at) return NextResponse.json({ error: "expired or unknown link" }, { status: 410 });
  return NextResponse.json({ clientName: row.client_name });
}
