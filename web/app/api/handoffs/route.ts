/**
 * File handoff links (lib/handoff.ts) — owner side.
 *   POST { driveId, audience, ttlSeconds?, files: [{ deviceKey, name, mime, size }] }
 *        → { links: [{ id, url, name, deviceKey, expiresAt }] }. Session auth; the caller must own
 *        `driveId` (the carrier: the device's connected drive whose socket serves the bytes).
 *   GET  → the caller's links with fetch counts (the audit list).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { env } from "@/lib/env";
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { createHandoffs, listHandoffs, DEFAULT_TTL_SECONDS, MAX_FILES } from "@/lib/handoff";

const Body = z.object({
  driveId: z.string().min(1).max(64),
  audience: z.string().min(1).max(300),
  ttlSeconds: z.number().int().positive().optional(),
  files: z.array(z.object({
    deviceKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
    name: z.string().min(1).max(255),
    mime: z.string().min(1).max(120),
    size: z.number().int().nonnegative(),
  })).min(1).max(MAX_FILES),
});

export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rl = tryConsume({ name: "handoffs", key: clientKey(req, `handoffs:${user.id}`), limit: 30, windowMs: 60_000 });
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const drive = getDrive(body.data.driveId);
  if (!drive || drive.owner_id !== user.id) return NextResponse.json({ error: "not your drive" }, { status: 403 });
  const links = createHandoffs(user.id, drive.id, body.data.files, body.data.audience, body.data.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const base = env.publicUrl.replace(/\/+$/, "");
  return NextResponse.json({
    links: links.map((l) => ({ id: l.id, url: `${base}/api/h/${l.id}?k=${l.secret}`, name: l.name, deviceKey: l.deviceKey, expiresAt: l.expiresAt })),
  });
}

export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ handoffs: listHandoffs(user.id) });
}

/** DELETE ?audience=… → revoke every live link to that agent. */
export async function DELETE(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const audience = new URL(req.url).searchParams.get("audience");
  if (!audience) return NextResponse.json({ error: "audience required" }, { status: 400 });
  const { revokeHandoffs } = await import("@/lib/handoff");
  return NextResponse.json({ revoked: revokeHandoffs(user.id, { audience }) });
}
