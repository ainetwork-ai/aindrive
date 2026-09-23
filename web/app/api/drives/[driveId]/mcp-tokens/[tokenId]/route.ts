/**
 * DELETE /api/drives/[driveId]/mcp-tokens/[tokenId] — revoke a PAT or
 * disconnect an OAuth app. Allowed for the token's holder or the drive owner.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { getToken, revokeToken } from "@/lib/mcp-tokens";

type Ctx = { params: Promise<{ driveId: string; tokenId: string }> };

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { driveId, tokenId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  const token = getToken(tokenId);
  if (!drive || !token || token.drive_id !== driveId || token.revoked_at) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (token.user_id !== user.id && drive.owner_id !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  revokeToken(tokenId);
  return NextResponse.json({ ok: true });
}
