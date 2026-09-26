import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { removeApp } from "@/lib/connected-apps";

/** DELETE → disconnect the app: its spaces leave the share sheet (what it already has stays on its side). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ appId: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { appId } = await params;
  if (!removeApp(user.id, appId)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
