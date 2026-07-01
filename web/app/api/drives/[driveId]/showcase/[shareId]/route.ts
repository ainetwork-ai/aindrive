import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";

// Purchase entry point for a single showcase item. The showcase list DTO no
// longer carries the share token (URL slug) — buyers click through here, and
// the token is resolved server-side and turned into a 302 to /s/<token>. This
// keeps the token from being bulk-handed to members in the list payload while
// still letting them reach the share's payment gate.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ driveId: string; shareId: string }> },
) {
  const { driveId, shareId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  // Relationship gate: mirrors the showcase list endpoint exactly — owner, or
  // at least one drive_members row at any path. Without it this route would be
  // a shareId→token oracle for unrelated logged-in users.
  const related =
    drive.owner_id === user.id ||
    !!db.prepare(
      "SELECT 1 FROM drive_members WHERE drive_id = ? AND user_id = ? LIMIT 1"
    ).get(driveId, user.id);
  if (!related) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // Only listed paid shares are reachable here — not a general id→token lookup.
  const row = db.prepare(
    "SELECT token FROM shares WHERE id = ? AND drive_id = ? AND listed = 1 AND price_usdc IS NOT NULL"
  ).get(shareId, driveId) as { token: string } | undefined;
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Relative Location (mirrors app/api/auth/logout): the browser resolves it
  // against the public URL it requested. NextResponse.redirect(new URL(..., req.url))
  // would leak the container's internal bind host (localhost:3737) behind the
  // reverse proxy, sending buyers to an unreachable host ("can't connect").
  return new Response(null, { status: 303, headers: { Location: "/s/" + row.token } });
}
