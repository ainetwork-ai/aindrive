import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast } from "@/lib/access";
import { ShareCreateBody, createShare, listShares } from "@/lib/sales";

/**
 * The drive's share links. Owners get the whole ledger; an editor (including
 * one through an organization) only their own links plus others' paid viewer
 * links for the sale badges — never another person's free link or an editor
 * link, whose token would be the grant itself (lib/sales.ts listShares).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const role = resolveRole(driveId, user.id, "");
  if (!atLeast(role, "editor")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ shares: listShares(driveId, atLeast(role, "owner") ? undefined : user.id) });
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
