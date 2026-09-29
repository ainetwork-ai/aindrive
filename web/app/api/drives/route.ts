import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { createDrive, listUserDrives, adoptSignInPayoutWallet } from "@/lib/drives";
import { isOnline } from "@/lib/rpc";
import { getUserDriveLimit } from "@/lib/limits";
import { db } from "@/lib/db";
import { listOrgDrivesForUser } from "@/lib/orgs.js";

const Body = z.object({ name: z.string().min(1).max(120) });

export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  adoptSignInPayoutWallet(user.id);   // the sign-in wallet pays out on drives without one
  const drives = listUserDrives(user.id);
  // Drives reached through (or published to) an organization carry it, so a
  // client can group them and not offer "Leave" on the organization's drive.
  const orgOf = new Map(listOrgDrivesForUser(user.id).flatMap((o) => o.drives.map((d) => [d.id, { id: o.orgId, slug: o.slug, name: o.name }] as const)));
  return NextResponse.json({
    drives: drives.map((d) => ({
      id: d.id,
      name: d.name,
      hostname: d.last_hostname ?? null,
      lastSeenAt: d.last_seen_at,
      createdAt: d.created_at,
      online: isOnline(d.id),
      // Owned vs shared-with-me: the mobile app offers "Leave" only on the latter.
      owned: d.owner_id === user.id,
      org: orgOf.get(d.id) ?? null,
    })),
  });
}

export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const limit = getUserDriveLimit(user.id);
  const { count } = db.prepare("SELECT COUNT(*) as count FROM drives WHERE owner_id = ?").get(user.id) as { count: number };
  if (count >= limit) {
    return NextResponse.json({ error: "drive_limit_reached", limit, current: count }, { status: 429 });
  }
  const created = await createDrive(user.id, body.data.name);
  return NextResponse.json(created);
}
