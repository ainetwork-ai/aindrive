import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { setCookie } from "@/lib/session";

const Body = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(req: Request) {
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const { email, password } = body.data;
  const user = db
    .prepare("SELECT id, password_hash FROM users WHERE lower(email) = lower(?)")
    .get(email) as { id: string; password_hash: string } | undefined;
  if (!user) return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  await setCookie(user.id);
  return NextResponse.json({ ok: true });
}
