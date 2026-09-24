import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { listPayoutWallets, setPayoutWallet } from "@/lib/drives";
import { applyPayoutWallet } from "@/lib/sales";
import { normalizePath } from "@/lib/path";
import { zPath } from "@/lib/zod-helpers";
import { z } from "zod";

/**
 * Path-scoped payout wallets (owner-only). A paid share's funds go to the
 * nearest ancestor folder's wallet — see lib/payout.ts. The drive-level
 * wallet is just the root ("") row, also settable via PATCH /api/drives/:id.
 *
 *   GET    → { wallets: [{path, wallet}] }
 *   PUT    { path, wallet } → set/replace one folder's wallet
 *   DELETE { path }          → clear one folder's wallet
 *
 * Creator-only (owner_id), matching the other payment settings. PUT's
 * validation (lib/sales.ts applyPayoutWallet) is shared with the MCP
 * set_payout_wallet tool.
 */
const DeleteBody = z.object({ path: zPath.default("") });

async function gate(driveId: string) {
  const user = await getUser();
  if (!user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const drive = getDrive(driveId);
  if (!drive || drive.owner_id !== user.id) {
    return { error: NextResponse.json({ error: "only the drive creator can change payouts" }, { status: 403 }) };
  }
  return { ok: true as const };
}

export async function GET(_req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const g = await gate(driveId);
  if ("error" in g) return g.error;
  return NextResponse.json({ wallets: listPayoutWallets(driveId) });
}

export async function PUT(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const g = await gate(driveId);
  if ("error" in g) return g.error;
  const r = applyPayoutWallet(driveId, await req.json().catch(() => null));
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const g = await gate(driveId);
  if ("error" in g) return g.error;
  const body = DeleteBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  setPayoutWallet(driveId, normalizePath(body.data.path), null);
  return NextResponse.json({ ok: true });
}
