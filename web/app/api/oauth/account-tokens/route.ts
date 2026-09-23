/**
 * GET /api/oauth/account-tokens — the signed-in user's connected apps
 * (account-grant tokens that are neither revoked nor past their refresh
 * lifetime). Session cookie. Revoke one with DELETE ./[id].
 */
import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { listAccountTokens } from "@/lib/account-tokens";

export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ tokens: listAccountTokens(user.id) });
}
