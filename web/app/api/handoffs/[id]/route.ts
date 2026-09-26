/** DELETE /api/handoffs/:id — revoke one of the caller's handoff links (lib/handoff.ts). */
import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { revokeHandoffs } from "@/lib/handoff";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const n = revokeHandoffs(user.id, { id });
  return n ? NextResponse.json({ revoked: n }) : NextResponse.json({ error: "not found" }, { status: 404 });
}
