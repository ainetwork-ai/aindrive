import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { sign } from "@/lib/session";

const Body = z.object({
  linkId: z.string().min(8).max(64),
  deviceSecret: z.string().min(16).max(128),
});

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

function safeEqualHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export async function POST(req: Request) {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });

  db.prepare("DELETE FROM cli_link_requests WHERE expires_at < datetime('now')").run();

  const row = db
    .prepare(
      "SELECT device_secret_hash, user_id, consumed_at FROM cli_link_requests WHERE link_id = ?"
    )
    .get(body.data.linkId) as
    | { device_secret_hash: string; user_id: string | null; consumed_at: string | null }
    | undefined;

  if (!row) return NextResponse.json({ status: "expired" }, { status: 410 });
  if (!safeEqualHex(row.device_secret_hash, sha256(body.data.deviceSecret))) {
    return NextResponse.json({ error: "bad device secret" }, { status: 401 });
  }
  if (row.consumed_at) return NextResponse.json({ status: "expired" }, { status: 410 });
  if (!row.user_id) return NextResponse.json({ status: "pending" }, { status: 202 });

  const consume = db.prepare(
    "UPDATE cli_link_requests SET consumed_at = datetime('now') WHERE link_id = ? AND consumed_at IS NULL"
  );
  if (consume.run(body.data.linkId).changes !== 1) {
    return NextResponse.json({ status: "expired" }, { status: 410 });
  }

  const user = db
    .prepare("SELECT id, email, name FROM users WHERE id = ?")
    .get(row.user_id) as { id: string; email: string; name: string } | undefined;
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  const token = await sign(user.id);
  return NextResponse.json({ status: "approved", token, user });
}
