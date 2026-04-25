import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/lib/db";
import { setCookie } from "@/lib/session";

const Body = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(80),
  password: z.string().min(8).max(200),
});

export async function POST(req: Request) {
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const { email, name, password } = body.data;

  const exists = db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(email);
  if (exists) return NextResponse.json({ error: "email already registered" }, { status: 409 });

  const isFirst = (db.prepare("SELECT count(*) as c FROM users").get() as { c: number }).c === 0;
  const id = nanoid(10);
  const hash = await bcrypt.hash(password, 10);
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)"
  ).run(id, email, name, hash, isFirst ? "admin" : "member");
  await setCookie(id);
  return NextResponse.json({ ok: true });
}
