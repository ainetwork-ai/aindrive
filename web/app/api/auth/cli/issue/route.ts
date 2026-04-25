import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getUser } from "@/lib/session";
import { db } from "@/lib/db";

const TTL_MS = 10 * 60 * 1000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode() {
  const buf = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[buf[i] % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export async function POST() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const code = newCode();
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString().replace("T", " ").replace("Z", "");
  db.prepare(
    "INSERT INTO cli_auth_codes (code, user_id, expires_at) VALUES (?, ?, ?)"
  ).run(code, user.id, expiresAt);

  return NextResponse.json({ code, expiresInSec: TTL_MS / 1000 });
}
