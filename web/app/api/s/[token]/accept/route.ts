import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { resolveRoleByUser, type Role } from "@/lib/access";
import { mergeRoleUpgradeOnly, atLeast } from "@/lib/access-core.js";

type ShareRow = {
  id: string;
  drive_id: string;
  path: string;
  role: Role;
  expires_at: string | null;
  price_usdc: number | null;
  owner_id: string;
};

export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // Auth is mandatory for CONSUME — anonymous link-only access is gone.
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const share = db.prepare(`
    SELECT s.id, s.drive_id, s.path, s.role, s.expires_at, s.price_usdc, d.owner_id
    FROM shares s JOIN drives d ON d.id = s.drive_id
    WHERE s.token = ?
  `).get(token) as ShareRow | undefined;

  if (!share) return NextResponse.json({ error: "share not found" }, { status: 404 });
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return NextResponse.json({ error: "share expired" }, { status: 410 });
  }

  // Drive creator already has authority everywhere — nothing to persist.
  if (user.id === share.owner_id) {
    return NextResponse.json({ driveId: share.drive_id, path: share.path });
  }

  // Paid share: CONSUME does not settle payment. The caller must already
  // hold a covering grant (written by the paid GET flow). Without one,
  // bounce them back to pay via GET /api/s/[token].
  if (share.price_usdc) {
    const role = resolveRoleByUser(share.drive_id, user.id, share.path);
    if (!atLeast(role, "viewer")) {
      return NextResponse.json({ error: "payment required" }, { status: 402 });
    }
  }

  // Free share (or paid-and-already-covered): upsert an upgrade-only member row.
  const existing = db.prepare(
    "SELECT role FROM drive_members WHERE drive_id = ? AND user_id = ? AND path = ?"
  ).get(share.drive_id, user.id, share.path) as { role: Role } | undefined;
  const nextRole = mergeRoleUpgradeOnly(existing?.role ?? "none", share.role);

  db.prepare(`
    INSERT INTO drive_members (id, drive_id, user_id, path, role)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(drive_id, user_id, path) DO UPDATE SET role = excluded.role
  `).run(nanoid(12), share.drive_id, user.id, share.path, nextRole);

  return NextResponse.json({ driveId: share.drive_id, path: share.path });
}
