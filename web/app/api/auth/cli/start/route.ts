import { NextResponse } from "next/server";
import { randomBytes, createHash } from "node:crypto";
import { db } from "@/lib/db";
import { clientNameOf } from "@/lib/pairing-client";

const TTL_SEC = 10 * 60;

function token(bytes: number) {
  return randomBytes(bytes).toString("base64url");
}

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Starts a sign-in pairing. The CLI posts `{}`; another app pairing a
 * person's account (e.g. a web app linking their drives) may name itself with
 * `{ client_name }` so the approval page says who is asking — shown as
 * self-reported, like the OAuth consent screen.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { client_name?: unknown } | null;
  const clientName = clientNameOf(body?.client_name);
  const linkId = token(12);
  const deviceSecret = token(32);
  const expiresAt = new Date(Date.now() + TTL_SEC * 1000)
    .toISOString().replace("T", " ").replace("Z", "");

  db.prepare(
    "INSERT INTO cli_link_requests (link_id, device_secret_hash, expires_at, client_name) VALUES (?, ?, ?, ?)"
  ).run(linkId, sha256(deviceSecret), expiresAt, clientName);

  return NextResponse.json({ linkId, deviceSecret, expiresInSec: TTL_SEC });
}
