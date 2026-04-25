import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { createDrive, listUserDrives } from "@/lib/drives";
import { isOnline } from "@/lib/rpc";

const Body = z.object({ name: z.string().min(1).max(120) });

export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drives = listUserDrives(user.id);
  return NextResponse.json({
    drives: drives.map((d) => ({
      id: d.id,
      name: d.name,
      lastSeenAt: d.last_seen_at,
      createdAt: d.created_at,
      online: isOnline(d.id),
    })),
  });
}

export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const created = await createDrive(user.id, body.data.name);
  return NextResponse.json(created);
}
