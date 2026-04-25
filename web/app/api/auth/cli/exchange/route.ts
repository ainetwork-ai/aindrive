import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { sign } from "@/lib/session";

const Body = z.object({ code: z.string().min(4).max(32) });

export async function POST(req: Request) {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });

  const code = body.data.code.trim().toUpperCase();
  db.prepare(
    "DELETE FROM cli_auth_codes WHERE expires_at < datetime('now') OR consumed_at IS NOT NULL"
  ).run();

  const row = db
    .prepare(
      "SELECT user_id, expires_at, consumed_at FROM cli_auth_codes WHERE code = ?"
    )
    .get(code) as { user_id: string; expires_at: string; consumed_at: string | null } | undefined;

  if (!row) return NextResponse.json({ error: "invalid or expired code" }, { status: 401 });
  if (row.consumed_at) return NextResponse.json({ error: "code already used" }, { status: 401 });

  const consume = db.prepare(
    "UPDATE cli_auth_codes SET consumed_at = datetime('now') WHERE code = ? AND consumed_at IS NULL"
  );
  const r = consume.run(code);
  if (r.changes !== 1) return NextResponse.json({ error: "code already used" }, { status: 401 });

  const user = db
    .prepare("SELECT id, email, name FROM users WHERE id = ?")
    .get(row.user_id) as { id: string; email: string; name: string } | undefined;
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });

  const token = await sign(user.id);
  return NextResponse.json({ token, user: { id: user.id, email: user.email, name: user.name } });
}
