/**
 * DELETE /api/oauth/account-tokens/[id] — disconnect an app from the account
 * (revokes its access + refresh token at once). Session cookie + same-origin
 * Origin (CSRF). Only the token's own user may revoke it.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { isSameOrigin } from "@/lib/oauth";
import { revokeAccountToken } from "@/lib/account-tokens";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const { id } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!revokeAccountToken(user.id, id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
