/**
 * /api/drives/[driveId]/mcp-tokens — remote-MCP token management.
 *
 *   GET  → { mcpUrl, canWrite, isOwner, tokens } — the caller's active tokens
 *          (PATs + OAuth-connected apps). The owner sees every member's.
 *   POST → issue a PAT. Body: { name, scope: "read"|"write", ttlDays: 30|90|null }.
 *          Returns { token, row } — the raw token is shown exactly once.
 *
 * Any member may issue; the scope is clamped to the caller's highest role in
 * the drive (no write token without an editor+ grant). See app/mcp/README.md.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { isSameOrigin } from "@/lib/oauth";
import { getDrive } from "@/lib/drives";
import { clampScope, issuePat, listActiveTokens, mcpUrlFor } from "@/lib/mcp-tokens";

type Ctx = { params: Promise<{ driveId: string }> };

const MAX_ACTIVE_PER_USER = 50;

const Body = z.object({
  name: z.string().trim().min(1).max(80),
  scope: z.enum(["read", "write"]).default("read"),
  ttlDays: z.union([z.literal(30), z.literal(90), z.null()]).default(90),
});

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  const ceiling = clampScope(driveId, user.id, "write");
  if (!ceiling) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const isOwner = drive.owner_id === user.id;
  return NextResponse.json({
    mcpUrl: mcpUrlFor(driveId),
    canWrite: ceiling === "write",
    isOwner,
    tokens: listActiveTokens(driveId, isOwner ? null : user.id).map((t) => ({
      ...t,
      mine: t.user_id === user.id,
    })),
  });
}

export async function POST(req: NextRequest, { params }: Ctx) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!getDrive(driveId)) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request", issues: parsed.error.issues }, { status: 400 });
  }
  const scope = clampScope(driveId, user.id, parsed.data.scope);
  if (!scope) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (scope !== parsed.data.scope) {
    return NextResponse.json({ error: "write scope requires editor access" }, { status: 403 });
  }
  if (listActiveTokens(driveId, user.id).length >= MAX_ACTIVE_PER_USER) {
    return NextResponse.json({ error: "too many active tokens — revoke some first" }, { status: 429 });
  }
  const { token, row } = issuePat({
    userId: user.id,
    driveId,
    name: parsed.data.name,
    scope,
    ttlDays: parsed.data.ttlDays,
  });
  return NextResponse.json({ token, row, mcpUrl: mcpUrlFor(driveId) }, { status: 201 });
}
