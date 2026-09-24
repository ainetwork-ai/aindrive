import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast } from "@/lib/access";
import { ShareCreateBody, createShare, listShares } from "@/lib/sales";

export async function GET(_req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const role = resolveRole(driveId, user.id, "");
  if (!atLeast(role, "editor")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ shares: listShares(driveId) });
}

/**
 * Mint a share link. All gates (editor-at-path, owner-only listing and editor
 * links, payout wallet + currency policy for paid shares, agent stat probe
 * for non-root paths) live in lib/sales.ts createShare, shared with the
 * remote-MCP create_share tool.
 */
export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = ShareCreateBody.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  const r = await createShare(drive, user.id, body.data);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ id: r.id, token: r.token, url: r.url });
}
