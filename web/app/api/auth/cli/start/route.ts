import { NextResponse } from "next/server";
import { randomBytes, createHash } from "node:crypto";
import { db } from "@/lib/db";

const TTL_SEC = 10 * 60;

function token(bytes: number) {
  return randomBytes(bytes).toString("base64url");
}

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

export async function POST() {
  const linkId = token(12);
  const deviceSecret = token(32);
  const expiresAt = new Date(Date.now() + TTL_SEC * 1000)
    .toISOString().replace("T", " ").replace("Z", "");

  db.prepare(
    "INSERT INTO cli_link_requests (link_id, device_secret_hash, expires_at) VALUES (?, ?, ?)"
  ).run(linkId, sha256(deviceSecret), expiresAt);

  return NextResponse.json({ linkId, deviceSecret, expiresInSec: TTL_SEC });
}
