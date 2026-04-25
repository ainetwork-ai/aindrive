import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { db } from "@/lib/db";

const Body = z.object({ linkId: z.string().min(8).max(64) });

export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });

  db.prepare("DELETE FROM cli_link_requests WHERE expires_at < datetime('now')").run();

  const row = db
    .prepare("SELECT user_id, consumed_at FROM cli_link_requests WHERE link_id = ?")
    .get(body.data.linkId) as { user_id: string | null; consumed_at: string | null } | undefined;
  if (!row) return NextResponse.json({ error: "expired or unknown link" }, { status: 410 });
  if (row.consumed_at) return NextResponse.json({ error: "already used" }, { status: 410 });
  if (row.user_id) return NextResponse.json({ ok: true, alreadyApproved: true });

  db.prepare(
    "UPDATE cli_link_requests SET user_id = ? WHERE link_id = ? AND user_id IS NULL"
  ).run(user.id, body.data.linkId);

  return NextResponse.json({ ok: true });
}
