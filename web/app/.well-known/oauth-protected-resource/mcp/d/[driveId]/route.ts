/**
 * GET /.well-known/oauth-protected-resource/mcp/d/[driveId] — RFC 9728
 * metadata for the drive's MCP endpoint; `/mcp/d/[driveId]` 401s point here
 * via WWW-Authenticate. See app/mcp/README.md.
 */
import { getDrive } from "@/lib/drives";
import { protectedResourceMetadata } from "@/lib/oauth";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(_req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const drive = getDrive(driveId);
  if (!drive) return Response.json({ error: "drive not found" }, { status: 404, headers: CORS });
  return Response.json(protectedResourceMetadata(driveId, drive.name), { headers: CORS });
}
